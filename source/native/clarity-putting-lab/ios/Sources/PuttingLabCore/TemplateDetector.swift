import Foundation

/// One sighting of the whole calibration template.
public struct TemplateDetection: Sendable {
    /// Matched references, image pixels and template millimetres, in the same order.
    public var imagePoints: [Vec2]
    public var worldPoints: [Vec2]
    public var imageToWorld: Mat3
    /// RMS residual of the references after the solve, millimetres.
    public var rmsMM: Double
}

/// Finds the printed template in a frame and solves image -> world from it.
///
/// It looks for the three kinds of black mark by shape and relative size, uses
/// the ball disc and the aim dot to guess where the other dots must be, and
/// accepts only a sighting where every reference is where it should be. There
/// is no learned model here: the template's geometry is the model.
public final class TemplateDetector {
    public let template: CalibrationTemplate
    /// The back camera never mirrors. Only a front camera or a mirrored feed would set this.
    public var imageIsMirrored = false
    /// Reject a solve whose references disagree by more than this.
    public var maxRMSMM = 2.0

    private let blobs = BlobDetector()

    public init(template: CalibrationTemplate = .a3) {
        self.template = template
    }

    public func detect(_ plane: LumaPlane) -> TemplateDetection? {
        // Half resolution is plenty to find the marks; centres are refined at full resolution.
        let step = plane.width >= 1000 ? 2 : 1
        let window = max(48, plane.width / 6)
        let found = blobs.detect(plane, roi: plane.bounds, threshold: .adaptiveDark(window: window, offset: 30),
                                 step: step, minArea: 4)
        let candidates = found.filter { !$0.touchesEdge && $0.fillRatio > 0.55 && $0.fillRatio < 0.95 && $0.elongation < 1.8 }
        guard candidates.count >= template.references.count else { return nil }

        let disc = template.ballDisc, aim = template.aimDot, dots = template.dots
        let aimSpan = aim.position.distance(to: disc.position)
        let expectedDiscRatio = (disc.radius / aim.radius) * (disc.radius / aim.radius)
        let expectedDotRatio = (dots[0].radius / aim.radius) * (dots[0].radius / aim.radius)
        let minSpacing = minimumSpacing()

        var best: (indices: [Int], rms: Double, h: Mat3)?
        let byArea = candidates.indices.sorted { candidates[$0].area > candidates[$1].area }
        for di in byArea.prefix(6) {
            for ai in byArea where ai != di {
                let ratio = Double(candidates[di].area) / Double(candidates[ai].area)
                guard ratio > expectedDiscRatio * 0.45, ratio < expectedDiscRatio * 2.2 else { continue }
                let d = candidates[di].centroid, a = candidates[ai].centroid
                let s = d.distance(to: a) / aimSpan
                guard s > 0 else { continue }
                // Template -> image similarity from the two anchors. Image y runs
                // down, template y runs toward the target: a non-mirrored camera
                // looking down sees the template reflected in y.
                let flip: Double = imageIsMirrored ? 1 : -1
                let anchorDir = aim.position - disc.position
                let imageDir = a - d
                let phi = atan2(imageDir.y, imageDir.x) - atan2(anchorDir.y * flip, anchorDir.x)
                func predict(_ p: Vec2) -> Vec2 { d + Vec2(p.x, p.y * flip).rotated(by: phi) * s }

                var indices = [di, ai]
                var used = Set(indices)
                let tolerance = 0.3 * minSpacing * s
                for dot in dots {
                    let q = predict(dot.position)
                    var pick: Int?
                    var pickDistance = tolerance
                    for ci in candidates.indices where !used.contains(ci) {
                        let r = Double(candidates[ci].area) / Double(candidates[ai].area)
                        guard r > expectedDotRatio * 0.4, r < expectedDotRatio * 2.0 else { continue }
                        let dist = candidates[ci].centroid.distance(to: q)
                        if dist < pickDistance {
                            pickDistance = dist
                            pick = ci
                        }
                    }
                    guard let pick else { break }
                    indices.append(pick)
                    used.insert(pick)
                }
                guard indices.count == template.references.count else { continue }

                let image = indices.map { SpotRefiner.refine(plane, around: candidates[$0], dark: true) }
                let world = [disc.position, aim.position] + dots.map(\.position)
                guard let h = Homography.solve(from: image, to: world) else { continue }
                let rms = Homography.rmsError(h, from: image, to: world)
                if rms < (best?.rms ?? .infinity) { best = (indices, rms, h) }
            }
        }
        guard let best, best.rms <= maxRMSMM else { return nil }
        let image = best.indices.map { SpotRefiner.refine(plane, around: candidates[$0], dark: true) }
        return TemplateDetection(imagePoints: image,
                                 worldPoints: [disc.position, aim.position] + dots.map(\.position),
                                 imageToWorld: best.h, rmsMM: best.rms)
    }

    private func minimumSpacing() -> Double {
        var m = Double.infinity
        let pts = template.references.map(\.position)
        for i in pts.indices {
            for j in pts.indices where j > i { m = min(m, pts[i].distance(to: pts[j])) }
        }
        return m
    }
}
