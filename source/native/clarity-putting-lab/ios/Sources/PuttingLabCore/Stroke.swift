import Foundation

/// When the putter met the ball, from two independent witnesses.
public struct ImpactEstimate: Codable, Sendable {
    public var time: Double
    /// Ball displacement extrapolated back to zero.
    public var fromBall: Double?
    /// Face reaching the back of the ball.
    public var fromPutter: Double?
    public var confidence: Double
}

public enum ImpactDetector {
    /// The impact instant. The ball's departure is the steadier witness (a
    /// white ball on green is easy to see, and it moves in a straight line at
    /// first); the putter's arrival at the ball confirms it. Neither depends on
    /// the one blurred frame nearest contact.
    public static func estimate(ballRest: Vec2, roll: [BallSample], putter: [PutterSample],
                                ballRadius: Double = CalibrationTemplate.ballDiameterMM / 2) -> ImpactEstimate? {
        var fromBall: Double?
        let early = roll.filter {
            let d = $0.position.distance(to: ballRest)
            return d >= 2 && d <= 120
        }.prefix(8)
        if early.count >= 2 {
            let ts = early.map(\.timestamp), ds = early.map { $0.position.distance(to: ballRest) }
            if let f = PolyFit.fit(t: ts, y: ds, degree: 1, about: ts[0]), f.rate(at: ts[0]) > 50 {
                fromBall = ts[0] - f.value(at: ts[0]) / f.rate(at: ts[0])
            }
        }

        var fromPutter: Double?
        let reference = fromBall ?? roll.first?.timestamp ?? putter.last?.timestamp ?? 0
        // Signed gap between the face and the back of the ball, along the face normal.
        func gap(_ s: PutterSample) -> Double {
            let n = Vec2.direction(s.faceAngleWorld)
            return n.dot(ballRest - s.position) - ballRadius
        }
        let window = putter.filter { $0.timestamp <= reference + 0.03 && $0.timestamp >= reference - 0.3 && $0.confidence > 0.3 }
        if window.count >= 2 {
            for i in stride(from: window.count - 1, to: 0, by: -1) {
                let a = window[i - 1], b = window[i]
                let ga = gap(a), gb = gap(b)
                if ga > 0 && gb <= 0 {
                    fromPutter = a.timestamp + (b.timestamp - a.timestamp) * ga / (ga - gb)
                    break
                }
            }
        }

        switch (fromBall, fromPutter) {
        case let (b?, p?) where abs(b - p) < 0.012:
            return ImpactEstimate(time: 0.6 * b + 0.4 * p, fromBall: b, fromPutter: p, confidence: 0.95)
        case let (b?, p):
            return ImpactEstimate(time: b, fromBall: b, fromPutter: p, confidence: p == nil ? 0.75 : 0.6)
        case let (nil, p?):
            return ImpactEstimate(time: p, fromBall: nil, fromPutter: p, confidence: 0.5)
        default:
            return nil
        }
    }
}

/// One detected putt, with the raw samples kept so every number can be
/// recalculated later (different aim, better analysis) without the video.
public struct PuttingStroke: Codable, Sendable {
    public var id: String
    public var startedAt: Double
    public var impact: ImpactEstimate
    /// Where the ball sat before it was struck, world mm.
    public var ballRest: Vec2
    public var putterSamples: [PutterSample]
    public var ballSamples: [BallSample]
    public var trackingMode: PutterTrackingMode
    public var handedness: Handedness
    /// The aim when the putt was hit (the metrics below are against it).
    public var target: PracticeTarget
    public var metrics: PuttingStrokeMetrics

    public var impactTime: Double { impact.time }
}

/// A value with how far it can be trusted. Nil value = not measured.
public struct Measured: Codable, Equatable, Sendable {
    public var value: Double
    public var confidence: Double

    public init(_ value: Double, confidence: Double) {
        self.value = value
        self.confidence = confidence
    }
}

public struct GateResult: Codable, Equatable, Sendable {
    public var gate: PracticeGate
    public var passed: Bool
    /// Where the start line crosses the gate, mm right (+) or left (-) of the aim line.
    public var lateral: Double
}

/// Everything derived from a stroke. Angles are DEGREES against the aim line,
/// positive = right. Face-to-path is face minus path.
public struct PuttingStrokeMetrics: Codable, Sendable {
    public var face: Measured?
    public var path: Measured?
    public var faceToPath: Measured?
    public var start: Measured?
    /// m/s, just after the ball leaves the face.
    public var ballSpeed: Measured?
    /// Ball centre relative to face centre at impact, mm, positive = toward the toe.
    public var strikePoint: Measured?
    /// Face angle change from address to impact, degrees (positive = opened).
    public var faceRotation: Measured?
    /// Face rotation rate at impact, degrees per second (positive = opening).
    public var faceRotationRate: Measured?
    /// Side-to-side range of the face centre through the stroke, mm.
    public var lateralMovement: Measured?
    public var backswingLength: Measured?
    public var backswingTime: Double?
    public var downswingTime: Double?
    public var gates: [GateResult]
    public var confidence: Double
}

public enum PuttingStrokeAnalysis {
    /// Time either side of impact used to read the face, and (wider) the
    /// path, which a longer run of positions reads more steadily. At least
    /// these, and never fewer frames than a fit needs: the same rule as the
    /// browser engine (src/modules/putting-lab/engine/stroke.ts).
    static func impactWindows(_ putter: [PutterSample]) -> (face: (Double, Double), path: (Double, Double)) {
        var gaps: [Double] = []
        for i in putter.indices.dropFirst() { gaps.append(putter[i].timestamp - putter[i - 1].timestamp) }
        gaps.sort()
        let dt = gaps.isEmpty ? 1.0 / 240 : gaps[gaps.count / 2]
        return ((max(0.025, 3.5 * dt), max(0.008, 1.5 * dt)), (max(0.04, 4.5 * dt), max(0.015, 2 * dt)))
    }

    public static func analyse(putter: [PutterSample], roll: [BallSample], ballRest: Vec2, impact: ImpactEstimate,
                               target: PracticeTarget, handedness: Handedness, startedAt: Double) -> PuttingStrokeMetrics {
        let aim = target.aimOffset
        let ti = impact.time
        let r = CalibrationTemplate.ballDiameterMM / 2

        // Face and path at impact, from a local fit through the surrounding frames.
        let windows = impactWindows(putter)
        let near = putter.filter { $0.timestamp >= ti - windows.face.0 && $0.timestamp <= ti + windows.face.1 && $0.confidence > 0.2 }
        var face: Measured?, path: Measured?, rate: Measured?, strike: Measured?
        var faceAtImpactWorld: Double?
        if near.count >= 4 {
            let ts = near.map(\.timestamp), w = near.map(\.confidence)
            let conf = w.reduce(0, +) / Double(w.count) * min(1, Double(near.count) / 5)
            if let f = PolyFit.fit(t: ts, y: near.map(\.faceAngleWorld), weights: w, degree: 2, about: ti) {
                faceAtImpactWorld = f.value(at: ti)
                face = Measured(Angle.degrees(Angle.wrap(f.value(at: ti) - aim)), confidence: conf * impact.confidence)
                rate = Measured(Angle.degrees(f.rate(at: ti)), confidence: conf)
            }
            let wide = putter.filter { $0.timestamp >= ti - windows.path.0 && $0.timestamp <= ti + windows.path.1 && $0.confidence > 0.2 }
            let wt = wide.map(\.timestamp), ww = wide.map(\.confidence)
            if let fx = PolyFit.fit(t: wt, y: wide.map(\.x), weights: ww, degree: 2, about: ti),
               let fy = PolyFit.fit(t: wt, y: wide.map(\.y), weights: ww, degree: 2, about: ti) {
                let v = Vec2(fx.rate(at: ti), fy.rate(at: ti))
                if v.length > 100 {
                    path = Measured(Angle.degrees(Angle.wrap(v.directionAngle - aim)), confidence: conf * clampUnit(v.length / 400))
                }
                if let fa = faceAtImpactWorld {
                    let centre = Vec2(fx.value(at: ti), fy.value(at: ti))
                    let along = Vec2.direction(fa).rotated(by: -.pi / 2)  // local +x in world
                    let toeSign: Double = handedness == .right ? 1 : -1
                    strike = Measured((ballRest - centre).dot(along) * toeSign, confidence: conf * 0.8)
                }
            }
        }
        var faceToPath: Measured?
        if let face, let path {
            faceToPath = Measured(face.value - path.value, confidence: min(face.confidence, path.confidence))
        }

        // Start line and speed from the first part of the roll, once clear of the face.
        var start: Measured?, speed: Measured?
        let clear = roll.filter {
            let d = $0.position.distance(to: ballRest)
            return $0.timestamp > ti && d >= r * 0.5 && d <= 300
        }
        if clear.count >= 4, let line = LineFit.fit(clear.map(\.position), weights: clear.map(\.confidence),
                                                    hint: clear.last!.position - ballRest) {
            let travelled = clear.last!.position.distance(to: clear.first!.position)
            let conf = clampUnit(Double(clear.count) / 8) * clampUnit(travelled / 60) * clampUnit(line.rms < 0.5 ? 1 : 0.5 / line.rms)
            start = Measured(Angle.degrees(Angle.wrap(line.direction.directionAngle - aim)), confidence: conf)
            let early = clear.filter { $0.position.distance(to: ballRest) <= 180 }
            // A curve, read at impact: a straight line would average away the ball slowing.
            if early.count >= 3,
               let f = PolyFit.fit(t: early.map(\.timestamp), y: early.map { $0.position.distance(to: ballRest) },
                                   degree: early.count >= 6 ? 2 : 1, about: ti) {
                speed = Measured(f.rate(at: ti) / 1000, confidence: conf * clampUnit(Double(early.count) / 6) * clampUnit(f.rms < 1 ? 1 : 1 / f.rms))
            }
        }

        // The stroke as a whole, in target coordinates.
        let stroke = putter.filter { $0.timestamp >= startedAt && $0.timestamp <= ti + 0.15 && $0.confidence > 0.2 }
        let coords = stroke.map { ($0.position - ballRest).rotated(by: aim) }
        var lateral: Measured?, backswing: Measured?, rotation: Measured?
        var backswingTime: Double?, downswingTime: Double?
        if coords.count >= 5 {
            let xs = coords.map(\.x)
            lateral = Measured(xs.max()! - xs.min()!, confidence: 0.8)
            let address = stroke.filter { $0.timestamp <= startedAt + 0.05 }
            if let a = address.first, let fa = faceAtImpactWorld {
                let addressFace = address.map(\.faceAngleWorld).reduce(0, +) / Double(address.count)
                rotation = Measured(Angle.degrees(Angle.wrap(fa - addressFace)), confidence: a.confidence)
            }
            let pre = stroke.indices.filter { stroke[$0].timestamp <= ti }
            if let top = pre.min(by: { coords[$0].y < coords[$1].y }) {
                backswing = Measured(coords[0].y - coords[top].y, confidence: 0.8)
                backswingTime = stroke[top].timestamp - stroke[0].timestamp
                downswingTime = ti - stroke[top].timestamp
            }
        }

        // Gates, from the start line extended out from the ball.
        var gates: [GateResult] = []
        if let start {
            let startAim = Angle.radians(start.value)
            // Gates stand on the aim line through the calibrated ball (the world origin).
            let restInTarget = ballRest.rotated(by: aim)
            for g in target.gates {
                let lateralAt = restInTarget.x + tan(startAim) * g.distance
                gates.append(GateResult(gate: g, passed: abs(lateralAt) <= g.width / 2 - r, lateral: lateralAt))
            }
        }

        let core = [face?.confidence, path?.confidence, start?.confidence].compactMap { $0 }
        return PuttingStrokeMetrics(face: face, path: path, faceToPath: faceToPath, start: start, ballSpeed: speed,
                                    strikePoint: strike, faceRotation: rotation, faceRotationRate: rate,
                                    lateralMovement: lateral, backswingLength: backswing,
                                    backswingTime: backswingTime, downswingTime: downswingTime, gates: gates,
                                    confidence: core.count == 3 ? core.min()! : 0)
    }

    /// Where the stroke began: the end of the last still moment before impact.
    public static func strokeStart(_ putter: [PutterSample], impact: Double, maxLookback: Double = 2.5) -> Double {
        let before = putter.filter { $0.timestamp <= impact && $0.timestamp >= impact - maxLookback }
        var stillSince: Double?
        var lastStillEnd = before.first?.timestamp ?? impact
        for s in before {
            if s.velocity.length < 40 {
                if stillSince == nil { stillSince = s.timestamp }
                if let since = stillSince, s.timestamp - since >= 0.12 { lastStillEnd = s.timestamp }
            } else {
                stillSince = nil
            }
        }
        return lastStillEnd
    }
}

/// Repeatability across a set of putts.
public struct PuttingConsistency: Codable, Sendable {
    public struct Spread: Codable, Sendable {
        public var mean: Double
        public var standardDeviation: Double
        public var count: Int
    }

    public var face: Spread?
    public var path: Spread?
    public var faceToPath: Spread?
    public var start: Spread?

    public init(strokes: [PuttingStroke]) {
        func spread(_ values: [Double]) -> Spread? {
            guard values.count >= 2 else { return nil }
            let m = values.reduce(0, +) / Double(values.count)
            let v = values.map { ($0 - m) * ($0 - m) }.reduce(0, +) / Double(values.count - 1)
            return Spread(mean: m, standardDeviation: v.squareRoot(), count: values.count)
        }
        face = spread(strokes.compactMap { $0.metrics.face?.value })
        path = spread(strokes.compactMap { $0.metrics.path?.value })
        faceToPath = spread(strokes.compactMap { $0.metrics.faceToPath?.value })
        start = spread(strokes.compactMap { $0.metrics.start?.value })
    }
}
