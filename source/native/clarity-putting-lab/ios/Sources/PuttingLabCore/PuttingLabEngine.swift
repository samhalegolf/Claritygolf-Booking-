import Foundation

/// Where a session is.
public enum PuttingLabPhase: String, Codable, Sendable {
    case findingTemplate
    case placingBall
    case placingPutter
    /// Calibrated. Waiting for the template to be lifted away.
    case removeTemplate
    case live
    /// The camera moved after calibration. Nothing is measured until recalibrated.
    case cameraMoved
}

/// The digital gate's own loop, while live.
public enum PuttingGateState: String, Codable, Sendable {
    case waitingForBall
    case ready
    case inStroke
    case showingResult
}

/// What the screen needs, copied out once per frame. Plain values only, so the
/// UI thread can read it while the next frame is being measured.
public struct PuttingLabSnapshot: Sendable {
    public var timestamp: Double = 0
    public var phase: PuttingLabPhase = .findingTemplate
    public var gate: PuttingGateState = .waitingForBall
    public var prompt: String = ""
    public var warning: String?

    public var surface: SurfaceCalibration?
    public var target = PracticeTarget()
    public var templatePoints: [Vec2] = []
    public var templateStableFrames = 0

    public var ball: BallSample?
    public var ballStatus: BallTracker.Status = .absent
    public var ballRest: Vec2?
    public var ballSearch: (center: Vec2, radius: Double)?

    public var putter: PutterSample?
    public var putterStatus: PutterTracker.Status = .lost
    public var putterCalibration: PutterCalibration?
    public var trackingMode: PutterTrackingMode?
    /// Image points each source used this frame, for the debug overlay.
    public var sourcePoints: [PutterSource: [Vec2]] = [:]
    public var sourceConfidence: [PutterSource: Double] = [:]

    /// The putter's journey: the live stroke while one is under way, else the last putt's.
    public var trace: [PutterSample] = []
    public var ballTrace: [BallSample] = []
    public var lastStroke: PuttingStroke?
    public var strokeCount = 0
    public var consistency: PuttingConsistency?

    public var level: CameraMotionGuard.Level?
    public var movement: CameraMotionGuard.Movement?
    public var cameraTiltDegrees: Double?

    public var validation: ValidationSummary?

    /// Frames per second arriving, and how long the core took on the last one.
    public var inputFPS: Double = 0
    public var processingMilliseconds: Double = 0

    public init() {}
}

public struct PuttingLabConfiguration: Sendable {
    public var handedness: Handedness = .right
    public var target = PracticeTarget()
    /// How long a result stays frozen on screen before the gate re-arms.
    public var resultHoldSeconds = 2.5
    /// A ball that travels less than this within the stroke window was nudged, not putted.
    public var minimumPuttTravel = 60.0

    public init() {}
}

/// The Putting Lab, minus the camera and the screen: feed it frames, read
/// snapshots. Owns calibration, both trackers, impact detection and the
/// stroke list. Not thread-safe: call it from the one capture queue.
public final class PuttingLabEngine {
    public private(set) var configuration: PuttingLabConfiguration
    public private(set) var phase: PuttingLabPhase = .findingTemplate
    public private(set) var strokes: [PuttingStroke] = []
    public private(set) var snapshot = PuttingLabSnapshot()

    /// Called on the capture queue when a putt has been measured.
    public var onStroke: ((PuttingStroke) -> Void)?
    /// Called when a phase changes (calibration progress, camera moved, ...).
    public var onPhase: ((PuttingLabPhase) -> Void)?

    public let template: CalibrationTemplate
    private let templateDetector: TemplateDetector
    private let putterCalibrator: PutterCalibrator
    private let motionGuard = CameraMotionGuard()

    private var surface: SurfaceCalibration?
    private var coordinates: PuttingCoordinateSystem?
    private var ballTracker: BallTracker?
    private var putterTracker: PutterTracker?
    private var putterCalibration: PutterCalibration?

    // Calibration progress.
    private var stableDetections: [TemplateDetection] = []
    private var lastTemplateCheck: Double = -.infinity
    private var templateMissing = 0
    private var putterOnLineSince: Double?
    private var putterRegionMean: Double?
    private var calibrationWarning: String?

    // Live loop.
    private var gate: PuttingGateState = .waitingForBall
    private var putterHistory: [PutterSample] = []
    private var departureTime: Double?
    private var resultUntil: Double = 0
    private var liveTrace: [PutterSample] = []

    private var validationRun: ValidationRun?
    private var stillHold = StillHoldDetector()

    private var lastAttitude: DeviceAttitude?
    private var movementTracker: CameraMovementTracker?
    private var frameTimes: [Double] = []

    public init(configuration: PuttingLabConfiguration = PuttingLabConfiguration(), template: CalibrationTemplate = .a3) {
        self.configuration = configuration
        self.template = template
        templateDetector = TemplateDetector(template: template)
        putterCalibrator = PutterCalibrator(template: template)
        snapshot.target = configuration.target
    }

    // MARK: - Controls

    /// Throw away all calibration and start again from the template.
    public func recalibrate() {
        surface = nil
        movementTracker = nil
        coordinates = nil
        ballTracker = nil
        putterTracker = nil
        putterCalibration = nil
        stableDetections = []
        putterOnLineSince = nil
        putterRegionMean = nil
        calibrationWarning = nil
        putterHistory = []
        liveTrace = []
        gate = .waitingForBall
        departureTime = nil
        setPhase(.findingTemplate)
    }

    /// Skip waiting for the template to be lifted (practise with it down).
    public func startLive() {
        guard phase == .removeTemplate else { return }
        goLive()
    }

    /// Swing the virtual aim about the ball. Nothing is recalibrated; every
    /// stored putt is re-read against the new aim.
    public func setTarget(_ target: PracticeTarget) {
        configuration.target = target
        coordinates?.target = target
        ballTracker?.coordinates.target = target
        putterTracker?.coordinates.target = target
        strokes = strokes.map { stroke in
            var s = stroke
            s.target = target
            s.metrics = PuttingStrokeAnalysis.analyse(putter: s.putterSamples, roll: s.ballSamples, ballRest: s.ballRest,
                                                      impact: s.impact, target: target, handedness: s.handedness,
                                                      startedAt: s.startedAt)
            return s
        }
        snapshot.target = target
        snapshot.lastStroke = strokes.last
        snapshot.consistency = PuttingConsistency(strokes: strokes)
    }

    public func setHandedness(_ handedness: Handedness) {
        configuration.handedness = handedness
    }

    public func beginValidation(_ kind: ValidationRun.Kind, known: Double) {
        validationRun = ValidationRun(kind: kind, known: known)
        stillHold = StillHoldDetector()
        snapshot.validation = validationRun?.summary
    }

    public func endValidation() -> ValidationRun? {
        defer {
            validationRun = nil
            snapshot.validation = nil
        }
        return validationRun
    }

    public func clearStrokes() {
        strokes = []
        snapshot.lastStroke = nil
        snapshot.strokeCount = 0
        snapshot.consistency = nil
    }

    // MARK: - Frames

    /// Measure one frame. `timestamp` is the capture clock in seconds.
    @discardableResult
    public func process(_ plane: LumaPlane, timestamp t: Double, attitude: DeviceAttitude? = nil) -> PuttingLabSnapshot {
        let started = ProcessInfo.processInfo.systemUptime
        frameTimes.append(t)
        frameTimes.removeAll { $0 < t - 1 }
        if let attitude { lastAttitude = attitude }

        var snap = snapshot
        snap.timestamp = t
        snap.warning = nil
        snap.sourcePoints = [:]
        snap.sourceConfidence = [:]
        if let attitude {
            snap.level = motionGuard.level(attitude)
            snap.cameraTiltDegrees = Angle.degrees(attitude.cameraTilt)
            if var tracker = movementTracker {
                let movement = tracker.update(attitude, at: t)
                movementTracker = tracker
                snap.movement = movement
                if movement == .moved, phase != .findingTemplate, phase != .cameraMoved {
                    setPhase(.cameraMoved)
                } else if movement == .nudged {
                    snap.warning = "Camera nudged. Results are flagged until it settles."
                }
            }
        }
        snapshot = snap

        switch phase {
        case .findingTemplate: stepFindTemplate(plane, t)
        case .placingBall: stepPlaceBall(plane, t)
        case .placingPutter: stepPlacePutter(plane, t)
        case .removeTemplate: stepRemoveTemplate(plane, t)
        case .live: stepLive(plane, t)
        case .cameraMoved: snapshot.prompt = "Camera moved. Recalibrate to keep measuring."
        }

        snapshot.phase = phase
        snapshot.gate = gate
        snapshot.surface = surface
        snapshot.putterCalibration = putterCalibration
        snapshot.trackingMode = putterCalibration?.mode
        snapshot.validation = validationRun?.summary
        if let first = frameTimes.first, t > first { snapshot.inputFPS = Double(frameTimes.count - 1) / (t - first) }
        snapshot.processingMilliseconds = (ProcessInfo.processInfo.systemUptime - started) * 1000
        return snapshot
    }

    // MARK: - Calibration steps

    private func stepFindTemplate(_ plane: LumaPlane, _ t: Double) {
        if snapshot.level == .tooSteep {
            snapshot.prompt = "The camera is tilted too far. Point it straight down at the ball."
            stableDetections = []
            return
        }
        snapshot.prompt = snapshot.level == .tilted
            ? "Lay the calibration template down. (Camera is tilted: straighter is better.)"
            : "Lay the calibration template down with the ball off the black disc."
        // Whole-frame search, so throttled.
        guard t - lastTemplateCheck >= 1.0 / 12 else { return }
        lastTemplateCheck = t
        guard let d = templateDetector.detect(plane) else {
            stableDetections = []
            snapshot.templatePoints = []
            snapshot.templateStableFrames = 0
            return
        }
        if let previous = stableDetections.last {
            let moved = zip(previous.imagePoints, d.imagePoints).map { $0.distance(to: $1) }.max() ?? 0
            if moved > 0.8 { stableDetections = [] }
        }
        stableDetections.append(d)
        snapshot.templatePoints = d.imagePoints
        snapshot.templateStableFrames = stableDetections.count
        snapshot.prompt = "Template found. Hold still…"
        guard stableDetections.count >= 6 else { return }

        // Average the steady sightings, then solve once.
        let n = Double(stableDetections.count)
        var image = [Vec2](repeating: .zero, count: d.imagePoints.count)
        for det in stableDetections {
            for i in image.indices { image[i] = image[i] + det.imagePoints[i] / n }
        }
        guard let h = Homography.solve(from: image, to: d.worldPoints), let inverse = h.inverse,
              let ballPixel = inverse.apply(.zero), let scale = Homography.localScale(h, at: ballPixel) else {
            stableDetections = []
            return
        }
        let rms = Homography.rmsError(h, from: image, to: d.worldPoints)
        let calibration = SurfaceCalibration(
            imageToWorld: h, worldToImage: inverse.normalized, imageWidth: plane.width, imageHeight: plane.height,
            mmPerPixelAtBall: scale, reprojectionErrorMM: rms, referenceCount: image.count,
            confidence: clampUnit(1 - rms / 2), attitude: lastAttitude, timestamp: t)
        surface = calibration
        movementTracker = lastAttitude.map { CameraMovementTracker(reference: $0, at: t) }
        let c = PuttingCoordinateSystem(surface: calibration, target: configuration.target)
        coordinates = c
        ballTracker = BallTracker(coordinates: c)
        stableDetections = []
        setPhase(.placingBall)
    }

    private func stepPlaceBall(_ plane: LumaPlane, _ t: Double) {
        guard let ball = ballTracker else { return }
        ball.update(plane, timestamp: t)
        snapshot.ball = ball.last
        snapshot.ballStatus = ball.status
        snapshot.ballSearch = ball.lastSearch
        snapshot.prompt = "Put a ball in the black circle."
        guard ball.status == .atRest, let rest = ball.restPosition, let sample = ball.last else { return }
        let offset = rest.length
        if offset > 6 {
            snapshot.prompt = "Centre the ball in the circle (it is \(Int(offset.rounded())) mm off)."
            return
        }
        // The ball is a known size: a second check on the solve and the print scale.
        let diameter = sample.radiusMM * 2
        if abs(diameter / CalibrationTemplate.ballDiameterMM - 1) > 0.1 {
            calibrationWarning = "The ball measures \(String(format: "%.1f", diameter)) mm. Check the template printed at actual size."
        }
        snapshot.ballRest = rest
        setPhase(.placingPutter)
    }

    private func stepPlacePutter(_ plane: LumaPlane, _ t: Double) {
        guard let c = coordinates else { return }
        snapshot.prompt = "Set the putter face square on the line, touching the ball, and hold it still."
        snapshot.warning = calibrationWarning
        let coverage = putterCalibrator.lineCoverage(plane, coordinates: c)
        guard coverage > 0.35 else {
            putterOnLineSince = nil
            putterRegionMean = nil
            return
        }
        // Still: the region behind the line has stopped changing.
        let corners = [Vec2(-90, template.faceLineY - 60), Vec2(90, template.faceLineY + 2)].compactMap { c.image(fromWorld: $0) }
        let mean = plane.mean(in: IntRect(covering: corners, margin: 0))
        if let previous = putterRegionMean, abs(mean - previous) > 1.5 { putterOnLineSince = nil }
        putterRegionMean = mean
        if putterOnLineSince == nil { putterOnLineSince = t }
        guard let since = putterOnLineSince, t - since >= 0.6 else {
            snapshot.prompt = "Hold the putter still…"
            return
        }
        switch putterCalibrator.calibrate(plane, coordinates: c, handedness: configuration.handedness, timestamp: t) {
        case .success(let cal):
            putterCalibration = cal
            let tracker = PutterTracker(calibration: cal, coordinates: c)
            tracker.seed(cal.pose, at: t)
            putterTracker = tracker
            templateMissing = 0
            setPhase(.removeTemplate)
        case .failure(let error):
            putterOnLineSince = nil
            switch error {
            case .putterNotOnLine: snapshot.prompt = "Put the putter face right on the line, behind the ball."
            case .faceTooNarrow: snapshot.prompt = "Could not see the whole face. Keep hands and shaft clear of the line."
            case .noEdge: snapshot.prompt = "Could not see the face edge. Check the light on the putter."
            }
        }
    }

    private func stepRemoveTemplate(_ plane: LumaPlane, _ t: Double) {
        snapshot.prompt = "Calibration complete. Lift the template away."
        snapshot.warning = calibrationWarning
        guard t - lastTemplateCheck >= 1.0 / 4 else { return }
        lastTemplateCheck = t
        if templateDetector.detect(plane) == nil {
            templateMissing += 1
            if templateMissing >= 3 { goLive() }
        } else {
            templateMissing = 0
        }
    }

    private func goLive() {
        ballTracker?.rearm()
        putterTracker?.reset()
        gate = .waitingForBall
        setPhase(.live)
    }

    // MARK: - Live

    private func stepLive(_ plane: LumaPlane, _ t: Double) {
        guard let ball = ballTracker, let putter = putterTracker else { return }
        let ballSample = ball.update(plane, timestamp: t)
        let address = ball.restPosition ?? surface?.ballOrigin ?? .zero
        let putterSample = putter.update(plane, timestamp: t, address: address)
        if let s = putterSample {
            putterHistory.append(s)
            if gate == .ready || gate == .inStroke || gate == .waitingForBall { liveTrace.append(s) }
        }
        putterHistory.removeAll { $0.timestamp < t - 3 }
        liveTrace.removeAll { $0.timestamp < t - 3 }

        if let run = validationRun, run.kind == .faceAngle, let s = putterSample, let reading = stillHold.add(s) {
            validationRun?.readings.append(reading)
        }

        switch gate {
        case .showingResult:
            if t >= resultUntil {
                ball.rearm()
                liveTrace = []
                gate = .waitingForBall
            }
        case .waitingForBall, .ready:
            if ball.status == .rolling {
                departureTime = t
                gate = .inStroke
            } else {
                gate = ball.status == .atRest ? .ready : .waitingForBall
                if gate == .waitingForBall { liveTrace = [] }
            }
        case .inStroke:
            let rest = ball.restPosition ?? address
            let travelled = ball.last.map { $0.position.distance(to: rest) } ?? 0
            let elapsed = t - (departureTime ?? t)
            if ball.status == .finished || elapsed >= 0.45 {
                if travelled >= configuration.minimumPuttTravel {
                    finishStroke(ball: ball, rest: rest, t: t)
                } else {
                    // A nudge at address, or the ball picked up: not a putt.
                    ball.rearm()
                    gate = .waitingForBall
                }
            }
        }

        snapshot.ball = ballSample ?? ball.last
        snapshot.ballStatus = ball.status
        snapshot.ballRest = ball.restPosition
        snapshot.ballSearch = ball.lastSearch
        snapshot.putter = putterSample
        snapshot.putterStatus = putter.status
        for o in putter.lastObservations {
            snapshot.sourcePoints[o.source] = o.debugPoints
            snapshot.sourceConfidence[o.source] = o.confidence
        }
        if gate != .showingResult {
            snapshot.trace = liveTrace
            snapshot.ballTrace = gate == .inStroke ? ball.roll : []
        }
        snapshot.prompt = livePrompt(ball: ball, putter: putter)
    }

    private func livePrompt(ball: BallTracker, putter: PutterTracker) -> String {
        switch gate {
        case .waitingForBall: return "Place a ball on the spot."
        case .ready: return putter.status == .tracking ? "Ready" : "Ready. Set the putter behind the ball."
        case .inStroke: return "…"
        case .showingResult: return "Result"
        }
    }

    private func finishStroke(ball: BallTracker, rest: Vec2, t: Double) {
        let roll = ball.roll
        guard let impact = ImpactDetector.estimate(ballRest: rest, roll: roll, putter: putterHistory) else {
            ball.rearm()
            gate = .waitingForBall
            return
        }
        let startedAt = PuttingStrokeAnalysis.strokeStart(putterHistory, impact: impact.time)
        let samples = putterHistory.filter { $0.timestamp >= startedAt - 0.1 && $0.timestamp <= impact.time + 0.5 }
        let metrics = PuttingStrokeAnalysis.analyse(putter: samples, roll: roll, ballRest: rest, impact: impact,
                                                    target: configuration.target, handedness: configuration.handedness,
                                                    startedAt: startedAt)
        let stroke = PuttingStroke(id: UUID().uuidString, startedAt: startedAt, impact: impact, ballRest: rest,
                                   putterSamples: samples, ballSamples: roll,
                                   trackingMode: putterCalibration?.mode ?? .markerless,
                                   handedness: configuration.handedness, target: configuration.target, metrics: metrics)
        strokes.append(stroke)
        if validationRun?.kind == .startDirection, let s = metrics.start {
            // Validation is against the physical line: undo the aim.
            validationRun?.readings.append(s.value + configuration.target.aimOffsetDegrees)
        }
        snapshot.lastStroke = stroke
        snapshot.strokeCount = strokes.count
        snapshot.consistency = PuttingConsistency(strokes: strokes)
        snapshot.trace = samples
        snapshot.ballTrace = roll
        gate = .showingResult
        resultUntil = t + configuration.resultHoldSeconds
        onStroke?(stroke)
    }

    private func setPhase(_ p: PuttingLabPhase) {
        guard p != phase else { return }
        phase = p
        snapshot.phase = p
        onPhase?(p)
    }
}
