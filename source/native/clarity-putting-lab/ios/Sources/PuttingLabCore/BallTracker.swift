import Foundation

public struct BallSample: Codable, Sendable {
    public var timestamp: Double
    /// Ball centre, world mm.
    public var x: Double
    public var y: Double
    /// mm/s
    public var velocityX: Double
    public var velocityY: Double
    public var radiusMM: Double
    public var confidence: Double
    /// Dark marks seen on the ball (three-dot ball), world mm. Kept for later spin work.
    public var dots: [Vec2]

    public var position: Vec2 { Vec2(x, y) }
    public var velocity: Vec2 { Vec2(velocityX, velocityY) }
}

/// Follows the ball: at rest near the calibrated start, then, once it goes,
/// frame to frame along its predicted path. Never scans the frame.
public final class BallTracker {
    public enum Status: String, Codable, Sendable {
        /// No ball near the start.
        case absent
        /// Ball seen near the start, settling.
        case settling
        /// Ball at rest: ready for a putt.
        case atRest
        /// Ball moving away from its rest position.
        case rolling
        /// Rolled out of view or lost.
        case finished
    }

    public var coordinates: PuttingCoordinateSystem
    /// How far from the calibrated ball position a ball may sit and still be "the ball".
    public var placementTolerance = 30.0
    /// Seconds the ball must be still before it counts as at rest.
    public var settleSeconds = 0.3
    /// Movement from rest that means the ball has been struck.
    public var departureThreshold = 2.5

    public private(set) var status: Status = .absent
    public private(set) var restPosition: Vec2?
    public private(set) var last: BallSample?
    /// Samples since the ball left its rest position.
    public private(set) var roll: [BallSample] = []
    public private(set) var lastSearch: (center: Vec2, radius: Double)?

    private let detector = BallDetector()
    private var settleSamples: [BallSample] = []
    private var restNoise = 0.3
    private var departureCount = 0
    private var misses = 0

    public init(coordinates: PuttingCoordinateSystem) {
        self.coordinates = coordinates
    }

    public func reset() {
        status = .absent
        restPosition = nil
        last = nil
        roll = []
        settleSamples = []
        departureCount = 0
        misses = 0
    }

    /// Forget the finished putt and look for the next ball at the start.
    public func rearm() { reset() }

    @discardableResult
    public func update(_ plane: LumaPlane, timestamp t: Double) -> BallSample? {
        let c = coordinates
        let mmpp = c.surface.mmPerPixelAtBall
        let expectedRadius = CalibrationTemplate.ballDiameterMM / 2 / mmpp

        switch status {
        case .absent, .settling, .atRest:
            let centreWorld = restPosition ?? c.surface.ballOrigin
            // At rest the window must still catch a firmly struck ball two frames in at 120 fps.
            let searchMM = status == .atRest ? 45.0 : placementTolerance
            guard let centre = c.image(fromWorld: centreWorld) else { return nil }
            lastSearch = (centre, searchMM / mmpp)
            guard let o = detector.detect(plane, center: centre, expectedRadius: expectedRadius, searchRadius: searchMM / mmpp),
                  let sample = makeSample(o, t) else {
                if status == .atRest {
                    // Gone between frames: either struck hard or picked up. Let the roll search decide.
                    misses += 1
                    if misses > 3 { reset() }
                } else {
                    reset()
                }
                return nil
            }
            misses = 0
            guard status == .atRest || sample.position.distance(to: c.surface.ballOrigin) <= placementTolerance + 5 else {
                reset()
                return nil
            }
            if status == .atRest, let rest = restPosition {
                let moved = sample.position.distance(to: rest)
                if moved > max(departureThreshold, 4 * restNoise) {
                    departureCount += 1
                    if departureCount >= 2 {
                        status = .rolling
                        roll = [sample]
                        last = sample
                        return sample
                    }
                } else {
                    departureCount = 0
                    // Follow a slow creep, keep the rest position steady otherwise.
                    restPosition = rest + (sample.position - rest) * 0.1
                }
                last = sample
                return sample
            }
            settleSamples.append(sample)
            settleSamples.removeAll { $0.timestamp < t - settleSeconds - 0.05 }
            status = .settling
            if let first = settleSamples.first, t - first.timestamp >= settleSeconds {
                let mean = settleSamples.map(\.position).reduce(.zero, +) / Double(settleSamples.count)
                let spread = settleSamples.map { $0.position.distance(to: mean) }.max() ?? 0
                if spread < 1.0 {
                    let rms = (settleSamples.map { $0.position.distance(to: mean) * $0.position.distance(to: mean) }
                        .reduce(0, +) / Double(settleSamples.count)).squareRoot()
                    restNoise = max(0.15, rms)
                    restPosition = mean
                    status = .atRest
                    departureCount = 0
                }
            }
            last = sample
            return sample

        case .rolling:
            guard let prev = last else {
                status = .finished
                return nil
            }
            let dt = t - prev.timestamp
            let predicted = prev.position + prev.velocity * dt
            // Early on the velocity is a guess, so look wider.
            let searchMM = max(10, (prev.velocity * dt).length * 0.6 + 6) + (roll.count < 3 ? 20 : 0)
            guard let centre = c.image(fromWorld: predicted), plane.bounds.contains(centre) else {
                status = .finished
                return nil
            }
            lastSearch = (centre, searchMM / mmpp)
            guard let o = detector.detect(plane, center: centre, expectedRadius: expectedRadius, searchRadius: searchMM / mmpp),
                  var sample = makeSample(o, t) else {
                misses += 1
                if misses > 4 { status = .finished }
                return nil
            }
            misses = 0
            // Velocity from a short least-squares window: steadier than one difference.
            let window: [BallSample] = Array(roll.suffix(4)) + [sample]
            if window.count >= 2 {
                let ts = window.map(\.timestamp)
                if let fx = PolyFit.fit(t: ts, y: window.map(\.x), degree: 1, about: t),
                   let fy = PolyFit.fit(t: ts, y: window.map(\.y), degree: 1, about: t) {
                    sample.velocityX = fx.rate(at: t)
                    sample.velocityY = fy.rate(at: t)
                }
            }
            roll.append(sample)
            last = sample
            return sample

        case .finished:
            return nil
        }
    }

    private func makeSample(_ o: BallObservation, _ t: Double) -> BallSample? {
        let c = coordinates
        guard let w = c.world(fromImage: o.imageCenter),
              let edge = c.world(fromImage: o.imageCenter + Vec2(o.imageRadius, 0)) else { return nil }
        return BallSample(timestamp: t, x: w.x, y: w.y, velocityX: 0, velocityY: 0, radiusMM: w.distance(to: edge),
                          confidence: o.confidence, dots: o.dots.compactMap { c.world(fromImage: $0) })
    }
}
