import AVFoundation
import CoreMedia
import Foundation

/// What a capture source is delivering.
struct PuttingCaptureFormat {
    var width: Int
    var height: Int
    var framesPerSecond: Double
    var deviceName: String
}

/// Anything that can feed the lab frames: the built-in camera today, perhaps
/// an external high-speed camera later. Frames arrive on the source's own
/// queue, one at a time; a source should drop frames rather than queue them
/// when the consumer is still busy, because latency matters more than
/// completeness.
protocol PuttingFrameSource: AnyObject {
    /// Pixel buffer (bi-planar YCbCr, luma first) and its capture time in seconds.
    var onFrame: ((CVPixelBuffer, Double) -> Void)? { get set }
    var format: PuttingCaptureFormat? { get }
    var droppedFrames: Int { get }
    func start(completion: @escaping (Result<PuttingCaptureFormat, Error>) -> Void)
    func stop()
    /// Freeze focus, exposure and white balance so every frame is measured under the same conditions.
    func lockForMeasurement()
    /// Back to automatic (before recalibrating).
    func unlock()
}

enum PuttingCameraError: LocalizedError {
    case noCamera
    case noUsableFormat
    case cannotAddInput
    case cannotAddOutput

    var errorDescription: String? {
        switch self {
        case .noCamera: return "No back camera is available."
        case .noUsableFormat: return "The camera offers no format the Putting Lab can use."
        case .cannotAddInput, .cannotAddOutput: return "The camera could not be set up."
        }
    }
}

/// AVFoundation capture for the Putting Lab.
///
/// Picks the fastest format the back camera has (240 fps where the phone
/// offers it, 120 otherwise), keeps buffers in the sensor's own orientation
/// and pixel format so nothing is rotated or converted, and delivers them to
/// one serial queue with late frames discarded.
final class PuttingCameraSession: NSObject, PuttingFrameSource, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    var onFrame: ((CVPixelBuffer, Double) -> Void)?
    private(set) var format: PuttingCaptureFormat?
    private(set) var droppedFrames = 0

    private let sessionQueue = DispatchQueue(label: "app.claritygolf.putting.session")
    private let frameQueue = DispatchQueue(label: "app.claritygolf.putting.frames", qos: .userInteractive)
    private let output = AVCaptureVideoDataOutput()
    private var device: AVCaptureDevice?

    /// Never below 120 fps if the phone can do it; never above 1080p, which is
    /// already finer than the lab needs and costs time per frame.
    static let maxWidth: Int32 = 1920
    static let minWidth: Int32 = 1280
    /// The shutter the lab asks for while measuring: a putter at 2 m/s moves 2 mm in 1/1000 s.
    static let measuringShutter = 1.0 / 1000

    func start(completion: @escaping (Result<PuttingCaptureFormat, Error>) -> Void) {
        sessionQueue.async {
            do {
                let format = try self.configure()
                self.session.startRunning()
                DispatchQueue.main.async { completion(.success(format)) }
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    func stop() {
        sessionQueue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    // MARK: - Format selection

    private struct Candidate {
        var format: AVCaptureDevice.Format
        var range: AVFrameRateRange
        var width: Int32
        var fullRange: Bool
        var binned: Bool
        var fps: Double { min(range.maxFrameRate, 240) }
    }

    struct Choice {
        var format: AVCaptureDevice.Format
        var fps: Double
        /// Exactly what the format supports (a reported 239.76 must not be rounded to 240).
        var frameDuration: CMTime
        var pixelFormat: OSType
    }

    /// Enumerate the formats and take the best: frame rate first (capped at
    /// 240), then resolution, then full-range luma, then unbinned.
    static func bestFormat(for device: AVCaptureDevice) -> Choice? {
        var candidates: [Candidate] = []
        for format in device.formats {
            let description = format.formatDescription
            let subtype = CMFormatDescriptionGetMediaSubType(description)
            let fullRange = subtype == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            guard fullRange || subtype == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange else { continue }
            let dims = CMVideoFormatDescriptionGetDimensions(description)
            guard dims.width >= minWidth, dims.width <= maxWidth else { continue }
            guard let range = format.videoSupportedFrameRateRanges.max(by: { $0.maxFrameRate < $1.maxFrameRate }),
                  range.maxFrameRate >= 30 else { continue }
            candidates.append(Candidate(format: format, range: range, width: dims.width, fullRange: fullRange,
                                        binned: format.isVideoBinned))
        }
        let best = candidates.max { a, b in
            if a.fps != b.fps { return a.fps < b.fps }
            if a.width != b.width { return a.width < b.width }
            if a.fullRange != b.fullRange { return !a.fullRange }
            return a.binned && !b.binned
        }
        guard let best else { return nil }
        let duration = best.range.maxFrameRate <= 240 ? best.range.minFrameDuration : CMTime(value: 1, timescale: 240)
        return Choice(format: best.format, fps: best.fps, frameDuration: duration,
                      pixelFormat: CMFormatDescriptionGetMediaSubType(best.format.formatDescription))
    }

    private func configure() throws -> PuttingCaptureFormat {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw PuttingCameraError.noCamera
        }
        guard let choice = Self.bestFormat(for: device) else { throw PuttingCameraError.noUsableFormat }
        self.device = device

        session.beginConfiguration()
        defer { session.commitConfiguration() }
        for input in session.inputs { session.removeInput(input) }
        for output in session.outputs { session.removeOutput(output) }

        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw PuttingCameraError.cannotAddInput }
        session.addInput(input)

        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: choice.pixelFormat]
        // Latency beats completeness: if a frame is still being measured, drop the next.
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: frameQueue)
        guard session.canAddOutput(output) else { throw PuttingCameraError.cannotAddOutput }
        session.addOutput(output)
        // No rotation, no mirroring: buffers stay in sensor orientation and the
        // overlay converts through the preview layer instead.
        if let connection = output.connection(with: .video) {
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = false
            }
            if connection.isVideoStabilizationSupported { connection.preferredVideoStabilizationMode = .off }
        }

        try device.lockForConfiguration()
        device.activeFormat = choice.format
        device.activeVideoMinFrameDuration = choice.frameDuration
        device.activeVideoMaxFrameDuration = choice.frameDuration
        if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
        if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
        device.unlockForConfiguration()

        let dims = CMVideoFormatDescriptionGetDimensions(choice.format.formatDescription)
        let format = PuttingCaptureFormat(width: Int(dims.width), height: Int(dims.height), framesPerSecond: choice.fps,
                                          deviceName: device.localizedName)
        self.format = format
        return format
    }

    // MARK: - Locking

    func lockForMeasurement() {
        sessionQueue.async {
            guard let device = self.device, (try? device.lockForConfiguration()) != nil else { return }
            defer { device.unlockForConfiguration() }
            if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
            if device.isWhiteBalanceModeSupported(.locked) { device.whiteBalanceMode = .locked }
            guard device.isExposureModeSupported(.custom) else {
                if device.isExposureModeSupported(.locked) { device.exposureMode = .locked }
                return
            }
            // Short shutter against blur, ISO raised to keep the picture as bright as auto had it.
            let current = device.exposureDuration.seconds
            let frame = device.activeVideoMinFrameDuration.seconds
            let shutter = min(Self.measuringShutter, frame, current > 0 ? current : Self.measuringShutter)
            let minShutter = device.activeFormat.minExposureDuration.seconds
            let finalShutter = max(shutter, minShutter)
            let gain = current > 0 ? current / finalShutter : 1
            let iso = min(device.activeFormat.maxISO, max(device.activeFormat.minISO, device.iso * Float(gain)))
            device.setExposureModeCustom(duration: CMTime(seconds: finalShutter, preferredTimescale: 1_000_000),
                                         iso: iso, completionHandler: nil)
        }
    }

    func unlock() {
        sessionQueue.async {
            guard let device = self.device, (try? device.lockForConfiguration()) != nil else { return }
            defer { device.unlockForConfiguration() }
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
            if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
        }
    }

    // MARK: - Frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        onFrame?(pixelBuffer, time)
    }

    func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        droppedFrames += 1
    }
}
