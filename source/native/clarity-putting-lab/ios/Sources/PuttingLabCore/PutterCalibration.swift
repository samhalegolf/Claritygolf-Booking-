import Foundation

// The putter is never "found" from scratch. At calibration the coach sets the
// face square on the printed line, and that one moment teaches the lab how
// whatever it can see on this putter (stickers, texture, the face's top edge)
// sits relative to the true face. From then on tracking is a rigid-body
// problem: where has that known shape moved to, and how far has it turned?
//
// The putter's LOCAL frame is the world frame at calibration, moved so the
// face centre is the origin: +x runs along the face, +y is the face normal
// (toward the target). A pose carries local -> world, so at calibration the
// pose is a pure translation to the face centre and its rotation is zero.
// Face angle is the negative of the pose rotation (rotation is counter-
// clockwise, face angle is positive to the right).

public enum PutterTrackingMode: String, Codable, Sendable {
    /// Shape and texture only.
    case markerless
    /// Stickers found at calibration and used as the strongest witness.
    case enhanced
}

public enum Handedness: String, Codable, Sendable { case right, left }

/// A textured point on the putter's top, with where it sat in the calibration frame.
public struct PutterFeature: Codable, Sendable {
    public var local: Vec2
    public var calibrationPixel: Vec2
}

public struct PutterCalibration: Sendable {
    /// Local -> world at calibration: rotation 0, translation = face centre.
    public var pose: RigidTransform2D
    /// Half the heel-to-toe span of the face seen from above, mm.
    public var faceHalfWidth: Double
    /// Where the visible front edge sits along the face normal, local mm.
    public var edgeOffset: Double
    /// The visible edge's angle at calibration (counter-clockwise radians).
    /// The face was square by definition, so this is subtracted from every edge reading.
    public var edgeAngle: Double
    /// Where the toe end of the head shows, local mm along the face (signed, toe side),
    /// measured just behind the edge. Pins the head's slide along the face line.
    public var toeEnd: Double?
    /// Mean luma of the head's top at calibration.
    public var headLuma: Double
    /// Sticker centres, local mm. Three or more switch on enhanced tracking.
    public var markers: [Vec2]
    public var markerRadiusMM: Double
    /// Luma between head and sticker, used to pick stickers out during tracking.
    public var markerThreshold: Int
    public var features: [PutterFeature]
    /// The head as the camera saw it at calibration, for predicted-appearance matching.
    public var reference: LumaImage?
    public var handedness: Handedness
    public var timestamp: Double

    public var mode: PutterTrackingMode { markers.count >= 3 ? .enhanced : .markerless }

    /// +1 when the toe is on the +x side (a right-hander), -1 otherwise.
    public var toeSign: Double { handedness == .right ? 1 : -1 }

    /// Face centre and face-line end points in world mm for a given pose.
    public func faceLine(for pose: RigidTransform2D) -> (heel: Vec2, center: Vec2, toe: Vec2) {
        return (pose.apply(Vec2(-toeSign * faceHalfWidth, 0)), pose.apply(.zero), pose.apply(Vec2(toeSign * faceHalfWidth, 0)))
    }
}

public enum PutterCalibrationError: Error, Equatable {
    case putterNotOnLine
    case faceTooNarrow
    case noEdge
}

/// Reads the putter while its face sits on the template's square line.
public final class PutterCalibrator {
    public var template: CalibrationTemplate
    private let blobs = BlobDetector()

    public init(template: CalibrationTemplate = .a3) {
        self.template = template
    }

    /// Cheap presence test for the prompt loop: is something dark covering the
    /// square line on both sides of the ball? Returns the fraction covered.
    public func lineCoverage(_ plane: LumaPlane, coordinates c: PuttingCoordinateSystem) -> Double {
        let (paper, _) = paperLevel(plane, c)
        var covered = 0, total = 0
        var x = -template.faceLineHalfLength
        while x <= template.faceLineHalfLength {
            // The ball disc is black; skip the columns where it touches the line.
            if abs(x) > template.ballDisc.radius + 2, let p = c.image(fromWorld: Vec2(x, template.faceLineY - 4)) {
                total += 1
                if plane.sample(p) < paper * 0.6 { covered += 1 }
            }
            x += 2
        }
        return total > 0 ? Double(covered) / Double(total) : 0
    }

    public func calibrate(_ plane: LumaPlane, coordinates c: PuttingCoordinateSystem, handedness: Handedness,
                          timestamp: Double) -> Result<PutterCalibration, PutterCalibrationError> {
        let (paper, _) = paperLevel(plane, c)
        let faceY = template.faceLineY
        let mmpp = c.surface.mmPerPixelAtBall

        // 1. Heel and toe: the columns where a sharp dark edge sits right on the square line.
        let columnStep = 1.0
        var edgeColumns: [Double] = []
        var x = -140.0
        while x <= 140 {
            if hasFaceEdge(plane, c, x: x, faceY: faceY, paper: paper) { edgeColumns.append(x) }
            x += columnStep
        }
        guard !edgeColumns.isEmpty else { return .failure(.putterNotOnLine) }
        // Grow a run outward from the column nearest the ball, bridging the
        // middle where the black ball disc hides the edge.
        let maxGap = 2 * template.ballDisc.radius
        let sorted = edgeColumns.sorted()
        guard let seed = sorted.min(by: { abs($0) < abs($1) }), abs(seed) < 70 else { return .failure(.putterNotOnLine) }
        var lo = seed, hi = seed
        for v in sorted where v > hi { if v - hi <= maxGap { hi = v } else { break } }
        for v in sorted.reversed() where v < lo { if lo - v <= maxGap { lo = v } else { break } }
        // A column only counts when the edge is on it, so the true end is half a step out.
        lo -= columnStep / 2
        hi += columnStep / 2
        let halfWidth = (hi - lo) / 2
        guard halfWidth > 20 else { return .failure(.faceTooNarrow) }
        let centre = Vec2((lo + hi) / 2, faceY)
        let pose = RigidTransform2D(rotation: 0, translation: centre)

        // 2. The visible edge relative to the true face line.
        var draft = PutterCalibration(pose: pose, faceHalfWidth: halfWidth, edgeOffset: 0, edgeAngle: 0, toeEnd: nil, headLuma: 0,
                                      markers: [], markerRadiusMM: 0, markerThreshold: 255, features: [], reference: nil,
                                      handedness: handedness, timestamp: timestamp)
        // Only the ends of the face have clean paper in front at calibration; the ball disc hides the middle.
        let outer = { (u: Double) in abs(u + centre.x) > self.template.ballDisc.radius + 3 }
        guard let edge = EdgeSource.measure(plane, coordinates: c, calibration: draft, pose: pose, searchMM: 6,
                                            columnFilter: outer, raw: true) else { return .failure(.noEdge) }
        draft.edgeOffset = edge.offset
        draft.edgeAngle = edge.rotation
        draft.toeEnd = EdgeSource.toeEnd(plane, coordinates: c, calibration: draft, pose: pose, expected: draft.toeSign * halfWidth)

        // 3. Head brightness, just behind the face.
        var sum = 0.0, n = 0.0
        for u in stride(from: -halfWidth * 0.7, through: halfWidth * 0.7, by: 2) {
            for v in stride(from: -9.0, through: -4.0, by: 1.5) {
                if let p = c.image(fromWorld: pose.apply(Vec2(u, v))) {
                    sum += plane.sample(p)
                    n += 1
                }
            }
        }
        draft.headLuma = n > 0 ? sum / n : 0

        // 4. The head region in the image, and a reference copy of it.
        let depth = 110.0
        let corners = [Vec2(-halfWidth - 10, -depth), Vec2(halfWidth + 10, -depth), Vec2(halfWidth + 10, 4), Vec2(-halfWidth - 10, 4)]
            .compactMap { c.image(fromWorld: pose.apply($0)) }
        let roi = IntRect(covering: corners, margin: 4).clipped(to: plane.bounds)
        draft.reference = plane.copy(roi)

        // 5. Stickers: small round bright spots on the dark head.
        let stickerR = 4.0 / mmpp
        let markerThreshold = Int((draft.headLuma + paper) / 2)
        let spots = blobs.detect(plane, roi: roi, threshold: .brighterThan(markerThreshold),
                                 minArea: max(3, Int(Double.pi * stickerR * stickerR * 0.25)),
                                 maxArea: Int(Double.pi * stickerR * stickerR * 6))
        var markers: [(local: Vec2, area: Int)] = []
        for s in spots where !s.touchesEdge && s.elongation < 1.6 && s.fillRatio > 0.5 {
            let ring = IntRect(x: s.bounds.minX - 3, y: s.bounds.minY - 3, width: s.bounds.width + 6, height: s.bounds.height + 6)
            // Surrounded by head, not by paper.
            guard ringMean(plane, ring, inner: s.bounds) < Double(markerThreshold) - 10 else { continue }
            let centreImage = SpotRefiner.refine(plane, around: s, dark: false)
            guard let w = c.world(fromImage: centreImage) else { continue }
            let local = pose.inverse.apply(w)
            guard local.y < -2, abs(local.x) < halfWidth + 5 else { continue }
            markers.append((local, s.area))
        }
        if markers.count >= 3 {
            let best = Self.widestTriangle(markers.map(\.local))
            draft.markers = best
            let meanArea = Double(markers.map(\.area).reduce(0, +)) / Double(markers.count)
            draft.markerRadiusMM = (meanArea / .pi).squareRoot() * mmpp
            draft.markerThreshold = markerThreshold
        }

        // 6. Texture features inside the head, away from its outline.
        draft.features = FeatureSource.selectFeatures(plane, coordinates: c, pose: pose, roi: roi,
                                                      headLuma: draft.headLuma, paper: paper, halfWidth: halfWidth)
        return .success(draft)
    }

    // MARK: - helpers

    /// Luma of clean template paper: the median of samples around the sheet's middle band.
    private func paperLevel(_ plane: LumaPlane, _ c: PuttingCoordinateSystem) -> (Double, Double) {
        var values: [Double] = []
        for x in stride(from: -135.0, through: 135.0, by: 15) {
            for y in [120.0, 140.0, -60.0, -90.0] where abs(x) < 95 || abs(x) > 125 {
                if let p = c.image(fromWorld: Vec2(x, y)), plane.bounds.contains(p) { values.append(plane.sample(p)) }
            }
        }
        values.sort()
        guard !values.isEmpty else { return (200, 0) }
        return (values[values.count * 3 / 4], values[values.count / 4])
    }

    private func hasFaceEdge(_ plane: LumaPlane, _ c: PuttingCoordinateSystem, x: Double, faceY: Double, paper: Double) -> Bool {
        func luma(_ y: Double) -> Double? { c.image(fromWorld: Vec2(x, y)).map { plane.sample($0) } }
        guard let front = luma(faceY + 3), let back = luma(faceY - 3), let behind = luma(faceY - 7) else { return false }
        // Paper (or ball) just in front, head just behind.
        return front > paper * 0.7 && back < paper * 0.55 && behind < paper * 0.55
    }

    private func ringMean(_ plane: LumaPlane, _ outer: IntRect, inner: IntRect) -> Double {
        let r = outer.clipped(to: plane.bounds)
        var s = 0, n = 0
        for y in r.minY..<r.maxY {
            for x in r.minX..<r.maxX where !(x >= inner.minX && x < inner.maxX && y >= inner.minY && y < inner.maxY) {
                s += Int(plane.pixel(x, y))
                n += 1
            }
        }
        return n > 0 ? Double(s) / Double(n) : 255
    }

    /// The three points spanning the largest triangle: the most leverage on rotation.
    static func widestTriangle(_ pts: [Vec2]) -> [Vec2] {
        guard pts.count > 3 else { return pts }
        var best: [Vec2] = Array(pts.prefix(3))
        var bestArea = 0.0
        for i in 0..<pts.count {
            for j in (i + 1)..<pts.count {
                for k in (j + 1)..<pts.count {
                    let a = abs((pts[j] - pts[i]).cross(pts[k] - pts[i]))
                    if a > bestArea {
                        bestArea = a
                        best = [pts[i], pts[j], pts[k]]
                    }
                }
            }
        }
        return best
    }
}
