import CoreVideo
import Foundation
import PuttingLabCore

/// One Putting Lab session on the phone: the camera, the motion sensors and
/// the measurement engine, joined up.
///
/// Threading: frames arrive on the camera's queue and are measured there,
/// synchronously, so a slow frame makes the camera drop the next one instead
/// of building a backlog. The engine is only ever touched on that queue;
/// controls from the screen are queued and applied before the next frame. The
/// screen reads a copied snapshot under a lock.
final class PuttingLabSession {
    let camera: PuttingFrameSource
    let motion = PuttingMotionMonitor()

    /// Main thread.
    var onStroke: ((PuttingStroke) -> Void)?
    var onPhase: ((PuttingLabPhase) -> Void)?

    private let engine: PuttingLabEngine
    private let lock = NSLock()
    private var latest = PuttingLabSnapshot()
    private var pending: [(PuttingLabEngine) -> Void] = []

    init(configuration: PuttingLabConfiguration, camera: PuttingFrameSource = PuttingCameraSession()) {
        self.camera = camera
        engine = PuttingLabEngine(configuration: configuration)
        engine.onStroke = { [weak self] stroke in
            DispatchQueue.main.async { self?.onStroke?(stroke) }
        }
        engine.onPhase = { [weak self] phase in
            DispatchQueue.main.async { self?.onPhase?(phase) }
        }
        camera.onFrame = { [weak self] buffer, time in self?.process(buffer, time) }
    }

    func start(completion: @escaping (Result<PuttingCaptureFormat, Error>) -> Void) {
        motion.start()
        camera.start { [weak self] result in
            if case .success = result { self?.lockCameraSoon() }
            completion(result)
        }
    }

    func stop() {
        camera.stop()
        motion.stop()
    }

    /// The latest snapshot (any thread).
    var snapshot: PuttingLabSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return latest
    }

    /// Run something against the engine on the frame queue, before the next frame.
    func perform(_ command: @escaping (PuttingLabEngine) -> Void) {
        lock.lock()
        pending.append(command)
        lock.unlock()
    }

    func recalibrate() {
        camera.unlock()
        perform { $0.recalibrate() }
        lockCameraSoon()
    }

    /// Let auto focus and exposure settle on the scene, then freeze them so
    /// calibration and every putt see identical brightness.
    private func lockCameraSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.camera.lockForMeasurement()
        }
    }

    // MARK: - Frames

    private func process(_ buffer: CVPixelBuffer, _ time: Double) {
        lock.lock()
        let commands = pending
        pending.removeAll()
        lock.unlock()
        for command in commands { command(engine) }

        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard CVPixelBufferGetPlaneCount(buffer) >= 1, let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return }
        // Plane 0 of bi-planar YCbCr is luma: measured in place, no copy.
        let plane = LumaPlane(base: UnsafePointer(base.assumingMemoryBound(to: UInt8.self)),
                              width: CVPixelBufferGetWidthOfPlane(buffer, 0),
                              height: CVPixelBufferGetHeightOfPlane(buffer, 0),
                              bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(buffer, 0))
        let snapshot = engine.process(plane, timestamp: time, attitude: motion.attitude)

        lock.lock()
        latest = snapshot
        lock.unlock()
    }
}
