import Foundation

/// One sighting of the ball in one frame.
public struct BallObservation: Sendable {
    public var imageCenter: Vec2
    public var imageRadius: Double
    /// Dark marks inside the ball outline (a three-dot ball shows up to three).
    /// Recorded for later identity and spin work; nothing in v1 depends on them.
    public var dots: [Vec2]
    public var confidence: Double
}

/// Finds a white ball in a small region. The lab always knows roughly where the
/// ball is (the calibrated start, or where the roll predicts it next), so this
/// never scans the frame: it thresholds one window and picks the round bright
/// thing of the right size.
public final class BallDetector {
    private let blobs = BlobDetector()
    private let dotBlobs = BlobDetector()

    public init() {}

    /// - Parameters:
    ///   - center: where the ball is expected, image pixels.
    ///   - expectedRadius: apparent radius in pixels.
    ///   - searchRadius: how far from `center` the ball may be.
    public func detect(_ plane: LumaPlane, center: Vec2, expectedRadius: Double, searchRadius: Double) -> BallObservation? {
        let half = searchRadius + expectedRadius * 1.6
        let roi = IntRect(covering: [center], margin: half).clipped(to: plane.bounds)
        guard roi.area > 16 else { return nil }
        let (threshold, separability) = Histogram.otsu(Histogram.of(plane, in: roi, step: roi.area > 40_000 ? 2 : 1))
        guard separability > 0.3 else { return nil }
        let expectedArea = Double.pi * expectedRadius * expectedRadius
        let found = blobs.detect(plane, roi: roi, threshold: .brighterThan(threshold),
                                 minArea: Int(expectedArea * 0.35), maxArea: Int(expectedArea * 3.0))
        var best: (blob: Blob, score: Double)?
        for b in found {
            // Motion blur stretches a rolling ball; the short axis still gives its size.
            let minorRadius = 2 * b.axes.1.squareRoot()
            let sizeMatch = 1 - min(1, abs(minorRadius / expectedRadius - 1) * 2.5)
            let roundness = 1 - min(1, (b.elongation - 1) / 2)
            let fill = min(1, b.fillRatio / 0.7)
            let distance = b.centroid.distance(to: center)
            guard distance <= searchRadius + expectedRadius * 0.5 else { continue }
            let nearness = 1 - min(1, distance / max(1, searchRadius + expectedRadius))
            let score = sizeMatch * 0.4 + roundness * 0.25 + fill * 0.15 + nearness * 0.2
            if b.touchesEdge { continue }
            if score > (best?.score ?? 0.45) { best = (b, score) }
        }
        guard let best else { return nil }
        let b = best.blob
        let radius = 2 * b.axes.1.squareRoot()
        let dots = findDots(plane, ball: b, radius: radius, threshold: threshold)
        return BallObservation(imageCenter: b.centroid, imageRadius: radius, dots: dots,
                               confidence: clampUnit(best.score * min(1, separability / 0.6)))
    }

    private func findDots(_ plane: LumaPlane, ball: Blob, radius: Double, threshold: Int) -> [Vec2] {
        guard radius > 6 else { return [] }
        let found = dotBlobs.detect(plane, roi: ball.bounds, threshold: .darkerThan(threshold),
                                    minArea: 2, maxArea: Int(radius * radius * 0.4))
        return found
            .filter { !$0.touchesEdge && $0.centroid.distance(to: ball.centroid) < radius * 0.85 }
            .map(\.centroid)
    }
}
