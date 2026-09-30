import Foundation

/// The putter at one instant, in WORLD coordinates. Target-relative values are
/// derived on read (see `PuttingStrokeAnalysis`) so a stroke can be re-read
/// against a different aim.
public struct PutterSample: Codable, Sendable {
    public var timestamp: Double
    /// Face centre, world mm.
    public var x: Double
    public var y: Double
    /// Face angle against the PHYSICAL calibration line, radians, positive = right/open.
    public var faceAngleWorld: Double
    /// mm/s
    public var velocityX: Double
    public var velocityY: Double
    /// Face angle rate, rad/s, positive = opening (turning right).
    public var angularVelocity: Double
    public var confidence: Double
    public var sources: [PutterSource]

    public var position: Vec2 { Vec2(x, y) }
    public var velocity: Vec2 { Vec2(velocityX, velocityY) }
    public var pose: RigidTransform2D { RigidTransform2D(rotation: -faceAngleWorld, translation: position) }
}

/// Confidence-weighted fusion ("bidding"). No source wins by being a certain
/// kind of source: every reading is weighed by its own confidence and
/// precision against where the putter was heading, and a reading that
/// disagrees with that prediction is refused unless it keeps disagreeing,
/// agrees with its peers, and is confident. Then, and only then, the track
/// re-anchors on it. This is what stops the face snapping to a stray edge for
/// one frame, and what lets it recover when the prediction really was wrong.
public struct PuttingObservationFusion: Sendable {
    /// Readings further than this many standard errors from the prediction are refused.
    public var gate = 4.5
    /// Consecutive frames of confident, mutually consistent disagreement before re-anchoring.
    public var reanchorFrames = 3
    public var reanchorConfidence = 0.8

    public init() {}

    /// Split readings into those consistent with the prediction and those not.
    func partition(_ observations: [PutterObservation], filter: PoseFilter) -> (accepted: [PutterObservation], refused: [PutterObservation]) {
        var accepted: [PutterObservation] = [], refused: [PutterObservation] = []
        for o in observations {
            var ok = true
            if let r = o.rotation {
                let nu = Angle.wrap(r - filter.theta[0])
                let s = filter.thetaP[0] + o.rotationSigma * o.rotationSigma
                if nu * nu / s > gate * gate { ok = false }
            }
            for c in o.constraints where ok {
                let (nu, s) = filter.positionInnovation(c)
                if nu * nu / s > gate * gate { ok = false }
            }
            if ok { accepted.append(o) } else { refused.append(o) }
        }
        return (accepted, refused)
    }

    /// Do the refused readings agree with EACH OTHER well enough to be believed over the prediction?
    func consistentChallenger(_ refused: [PutterObservation]) -> PutterObservation? {
        let full = refused.filter { $0.pose != nil }.sorted { $0.confidence > $1.confidence }
        guard let lead = full.first, let leadPose = lead.pose, lead.confidence >= reanchorConfidence else { return nil }
        for other in refused where other.source != lead.source {
            if let r = other.rotation, abs(Angle.wrap(r - leadPose.rotation)) > Angle.radians(1.5) { return nil }
        }
        return lead
    }
}

/// Constant-velocity Kalman filter over the face centre (x, y, vx, vy) and the
/// pose rotation (theta, omega), updated one scalar reading at a time so a
/// source that only pins one direction (the edge) adds exactly that.
struct PoseFilter: Sendable {
    var s = [0.0, 0, 0, 0]            // x, y, vx, vy
    var P = [Double](repeating: 0, count: 16)
    var theta = [0.0, 0]              // rotation, rate
    var thetaP = [0.0, 0, 0, 0]
    /// Acceleration noise: a putter head can change speed by metres per second in a tenth of a second.
    var accelSigma = 12_000.0         // mm/s^2
    var angularAccelSigma = 25.0      // rad/s^2

    init(pose: RigidTransform2D, positionSigma: Double, rotationSigma: Double) {
        s = [pose.translation.x, pose.translation.y, 0, 0]
        P = [Double](repeating: 0, count: 16)
        P[0] = positionSigma * positionSigma
        P[5] = positionSigma * positionSigma
        P[10] = 800 * 800
        P[15] = 800 * 800
        theta = [pose.rotation, 0]
        thetaP = [rotationSigma * rotationSigma, 0, 0, 4]
    }

    var pose: RigidTransform2D { RigidTransform2D(rotation: theta[0], translation: Vec2(s[0], s[1])) }
    var positionSigma: Double { max(P[0], P[5]).squareRoot() }
    var rotationSigma: Double { thetaP[0].squareRoot() }

    mutating func predict(_ dt: Double) {
        guard dt > 0 else { return }
        s[0] += s[2] * dt
        s[1] += s[3] * dt
        // P = F P F^T + Q for each axis pair (x,vx) and (y,vy).
        let q = accelSigma * accelSigma
        for (p, v) in [(0, 2), (1, 3)] {
            let pp = P[p * 4 + p], pv = P[p * 4 + v], vv = P[v * 4 + v]
            P[p * 4 + p] = pp + 2 * dt * pv + dt * dt * vv + q * dt * dt * dt * dt / 4
            P[p * 4 + v] = pv + dt * vv + q * dt * dt * dt / 2
            P[v * 4 + p] = P[p * 4 + v]
            P[v * 4 + v] = vv + q * dt * dt
        }
        theta[0] += theta[1] * dt
        let qa = angularAccelSigma * angularAccelSigma
        let tt = thetaP[0], tw = thetaP[1], ww = thetaP[3]
        thetaP[0] = tt + 2 * dt * tw + dt * dt * ww + qa * dt * dt * dt * dt / 4
        thetaP[1] = tw + dt * ww + qa * dt * dt * dt / 2
        thetaP[2] = thetaP[1]
        thetaP[3] = ww + qa * dt * dt
    }

    func positionInnovation(_ c: PositionConstraint) -> (Double, Double) {
        let h = [c.normal.x, c.normal.y, 0, 0]
        let predicted = h[0] * s[0] + h[1] * s[1]
        var hph = 0.0
        for i in 0..<4 { for j in 0..<4 { hph += h[i] * P[i * 4 + j] * h[j] } }
        return (c.value - predicted, hph + c.sigma * c.sigma)
    }

    mutating func update(_ c: PositionConstraint) {
        let h = [c.normal.x, c.normal.y, 0, 0]
        let (nu, sv) = positionInnovation(c)
        var ph = [0.0, 0, 0, 0]
        for i in 0..<4 { for j in 0..<4 { ph[i] += P[i * 4 + j] * h[j] } }
        let k = ph.map { $0 / sv }
        for i in 0..<4 { s[i] += k[i] * nu }
        var newP = P
        for i in 0..<4 { for j in 0..<4 { newP[i * 4 + j] -= k[i] * ph[j] } }
        P = newP
    }

    mutating func update(rotation r: Double, sigma: Double) {
        let nu = Angle.wrap(r - theta[0])
        let sv = thetaP[0] + sigma * sigma
        let k0 = thetaP[0] / sv, k1 = thetaP[2] / sv
        theta[0] += k0 * nu
        theta[1] += k1 * nu
        let p00 = thetaP[0], p01 = thetaP[1], p10 = thetaP[2], p11 = thetaP[3]
        thetaP = [p00 - k0 * p00, p01 - k0 * p01, p10 - k1 * p00, p11 - k1 * p01]
    }
}

/// Multi-source rigid tracker for the putter head.
public final class PutterTracker {
    public enum Status: String, Codable, Sendable { case lost, tracking }

    public let calibration: PutterCalibration
    public var coordinates: PuttingCoordinateSystem
    public var fusion = PuttingObservationFusion()
    /// Frames without an accepted reading before the track is dropped.
    public var maxPredictedSeconds = 0.06

    public private(set) var status: Status = .lost
    public private(set) var lastObservations: [PutterObservation] = []
    public private(set) var confidence = 0.0

    private var filter: PoseFilter?
    private var lastTimestamp: Double?
    private var lastAccepted: Double = -.infinity
    private var disagreement = 0
    private var lastReacquireAttempt: Double = -.infinity
    private let features = FeatureSource()
    private let markers = MarkerSource()

    public init(calibration: PutterCalibration, coordinates: PuttingCoordinateSystem) {
        self.calibration = calibration
        self.coordinates = coordinates
    }

    /// Start tracking from a known pose (used right after calibration).
    public func seed(_ pose: RigidTransform2D, at timestamp: Double) {
        filter = PoseFilter(pose: pose, positionSigma: 1, rotationSigma: Angle.radians(0.5))
        status = .tracking
        lastTimestamp = timestamp
        lastAccepted = timestamp
        disagreement = 0
    }

    public func reset() {
        filter = nil
        status = .lost
        confidence = 0
        lastObservations = []
    }

    /// One frame. `address` is where the ball is (world mm): the only place a
    /// lost putter is looked for, because that is where the golfer will set it.
    @discardableResult
    public func update(_ plane: LumaPlane, timestamp t: Double, address: Vec2) -> PutterSample? {
        defer { lastTimestamp = t }
        if status == .lost {
            // Reacquisition is the only wide search, so it is throttled.
            guard t - lastReacquireAttempt >= 1.0 / 20 else { return nil }
            lastReacquireAttempt = t
            guard let pose = reacquire(plane, timestamp: t, address: address) else { return nil }
            filter = PoseFilter(pose: pose, positionSigma: 0.8, rotationSigma: Angle.radians(0.3))
            status = .tracking
            lastAccepted = t
            disagreement = 0
        } else if var f = filter, let last = lastTimestamp {
            f.predict(t - last)
            filter = f
        }
        guard var f = filter else { return nil }

        let predicted = f.pose
        let mmpp = coordinates.surface.mmPerPixelAtBall
        let sigmaPx = f.positionSigma / mmpp
        let search = Int(min(14, max(3, (3 * sigmaPx).rounded(.up) + 2)))
        var observations: [PutterObservation] = []
        if calibration.mode == .enhanced,
           let o = markers.observe(plane, coordinates: coordinates, calibration: calibration, predicted: predicted,
                                   searchPixels: Double(search), timestamp: t) {
            observations.append(o)
        }
        if let o = features.observe(plane, coordinates: coordinates, calibration: calibration, predicted: predicted,
                                    searchPixels: search, timestamp: t) {
            observations.append(o)
        }
        let edgeSearch = min(10, max(3, 3 * f.positionSigma + 2))
        if let o = EdgeSource.observe(plane, coordinates: coordinates, calibration: calibration, predicted: predicted,
                                      searchMM: edgeSearch, timestamp: t), o.confidence > 0.2 {
            observations.append(o)
        }
        lastObservations = observations

        var (accepted, refused) = fusion.partition(observations, filter: f)
        if accepted.isEmpty, let challenger = fusion.consistentChallenger(refused) {
            disagreement += 1
            if disagreement >= fusion.reanchorFrames, let pose = challenger.pose {
                // The challenger clearly wins: re-anchor on it rather than keep believing a stale prediction.
                let velocity = Vec2(f.s[2], f.s[3])
                f = PoseFilter(pose: pose, positionSigma: 1, rotationSigma: challenger.rotationSigma * 2)
                f.s[2] = velocity.x
                f.s[3] = velocity.y
                accepted = [challenger]
                refused = []
                disagreement = 0
            }
        } else if !accepted.isEmpty {
            disagreement = 0
        }

        // Rotations first (they fix which way the edge constraint points), then positions.
        for o in accepted {
            if let r = o.rotation { f.update(rotation: r, sigma: o.rotationSigma / max(0.05, o.confidence).squareRoot()) }
        }
        for o in accepted {
            for c in o.constraints {
                var scaled = c
                scaled.sigma = c.sigma / max(0.05, o.confidence).squareRoot()
                f.update(scaled)
            }
        }
        filter = f

        if accepted.isEmpty {
            confidence *= 0.85
            if t - lastAccepted > maxPredictedSeconds {
                reset()
                return nil
            }
        } else {
            lastAccepted = t
            confidence = 1 - accepted.reduce(1.0) { $0 * (1 - $1.confidence) }
        }
        return PutterSample(timestamp: t, x: f.s[0], y: f.s[1], faceAngleWorld: -f.theta[0],
                            velocityX: f.s[2], velocityY: f.s[3], angularVelocity: -f.theta[1],
                            confidence: confidence, sources: accepted.map(\.source))
    }

    // MARK: - Reacquisition

    /// Look for the putter set up behind the ball: stickers by shape if there
    /// are any, otherwise the best face-edge hypothesis near the address,
    /// confirmed by the full sources before it is believed.
    private func reacquire(_ plane: LumaPlane, timestamp t: Double, address: Vec2) -> RigidTransform2D? {
        let c = coordinates
        let r = CalibrationTemplate.ballDiameterMM / 2
        if calibration.mode == .enhanced {
            let zone = [Vec2(-120, -180), Vec2(120, -180), Vec2(120, 20), Vec2(-120, 20)]
                .compactMap { c.image(fromWorld: address + $0) }
            if let o = markers.observe(plane, coordinates: c, calibration: calibration, predicted: nil, searchPixels: 0,
                                       searchROI: IntRect(covering: zone, margin: 4).clipped(to: plane.bounds), timestamp: t),
               let pose = o.pose, o.confidence > 0.7 {
                return pose
            }
        }
        // Coarse: contrast across the expected edge, head luma behind it.
        var hypotheses: [(score: Double, pose: RigidTransform2D)] = []
        let columns = stride(from: -calibration.faceHalfWidth * 0.8, through: calibration.faceHalfWidth * 0.8,
                             by: calibration.faceHalfWidth * 0.2).map { $0 }
        for dx in stride(from: -50.0, through: 50, by: 5) {
            for dy in stride(from: -100.0, through: 2, by: 4) {
                for deg in stride(from: -8.0, through: 8, by: 2) {
                    let pose = RigidTransform2D(rotation: Angle.radians(deg), translation: address + Vec2(dx, -r + dy))
                    var sum = 0.0, head = 0
                    for u in columns {
                        guard let b = c.image(fromWorld: pose.apply(Vec2(u, calibration.edgeOffset - 2.5))),
                              let fr = c.image(fromWorld: pose.apply(Vec2(u, calibration.edgeOffset + 2.5))),
                              plane.bounds.contains(b), plane.bounds.contains(fr) else { continue }
                        let behind = plane.sample(b)
                        if abs(behind - calibration.headLuma) < 35 {
                            head += 1
                            sum += plane.sample(fr) - behind
                        }
                    }
                    guard head >= columns.count - 1 else { continue }
                    hypotheses.append((abs(sum) / Double(columns.count), pose))
                }
            }
        }
        hypotheses.sort { $0.score > $1.score }
        for h in hypotheses.prefix(4) where h.score > 20 {
            let edge = EdgeSource.observe(plane, coordinates: c, calibration: calibration, predicted: h.pose, searchMM: 6, timestamp: t)
            guard let edge, edge.confidence > 0.5, let er = edge.rotation else { continue }
            var pose = h.pose
            pose.rotation = er
            if let n = edge.constraints.first {
                // Slide the hypothesis onto the measured edge.
                let off = n.value - n.normal.dot(pose.translation)
                pose.translation = pose.translation + n.normal * off
            }
            if calibration.features.count >= 3 {
                guard let fo = features.observe(plane, coordinates: c, calibration: calibration, predicted: pose,
                                                searchPixels: 8, timestamp: t),
                      fo.confidence > 0.5, let fp = fo.pose,
                      abs(Angle.wrap(fp.rotation - er)) < Angle.radians(1.5) else { continue }
                return fp
            }
            return pose
        }
        return nil
    }
}
