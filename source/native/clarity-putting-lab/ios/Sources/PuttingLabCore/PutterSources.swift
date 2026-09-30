import Foundation

// Three lightweight witnesses to where the putter is. None of them owns the
// truth: each reports what it saw, how sure it is, and how precise that
// reading is, and PutterTracker weighs them against each other and against
// where the putter was heading.
//
//   markers   sticker centroids -> rigid fit. Strongest when present.
//   features  texture on the head, matched against how calibration says it
//             should look at the predicted pose. Rotation and position.
//   edge      the face's top edge, scanned across the face. Rotation and
//             how far forward the face is; blind to sliding along the face.
//
// Every search is confined to where the prediction says the putter is.

public enum PutterSource: String, Codable, CaseIterable, Sendable {
    case markers
    case features
    case edge
    case reacquire
}

/// A scalar statement about the face centre: normal . position == value.
public struct PositionConstraint: Sendable {
    public var normal: Vec2
    public var value: Double
    public var sigma: Double
}

public struct PutterObservation: Sendable {
    public var source: PutterSource
    public var timestamp: Double
    /// Pose rotation (counter-clockwise radians) and its standard error.
    public var rotation: Double?
    public var rotationSigma: Double
    /// What this source pins down about the face centre, in world mm.
    public var constraints: [PositionConstraint]
    /// 0...1: how good a witness this was, this frame.
    public var confidence: Double
    /// Image points the source used, for the debug overlay.
    public var debugPoints: [Vec2]

    /// The full pose, when the source pinned both axes.
    public var pose: RigidTransform2D? {
        guard let rotation, constraints.count >= 2 else { return nil }
        var ata = [0.0, 0, 0, 0], atb = [0.0, 0]
        for c in constraints {
            let w = 1 / (c.sigma * c.sigma)
            ata[0] += w * c.normal.x * c.normal.x
            ata[1] += w * c.normal.x * c.normal.y
            ata[2] += w * c.normal.y * c.normal.x
            ata[3] += w * c.normal.y * c.normal.y
            atb[0] += w * c.normal.x * c.value
            atb[1] += w * c.normal.y * c.value
        }
        guard let p = LinearSolve.solve(ata, atb, size: 2) else { return nil }
        return RigidTransform2D(rotation: rotation, translation: Vec2(p[0], p[1]))
    }

    static func full(_ source: PutterSource, _ t: Double, _ pose: RigidTransform2D, rotationSigma: Double,
                     positionSigma: Double, confidence: Double, debug: [Vec2]) -> PutterObservation {
        PutterObservation(source: source, timestamp: t, rotation: pose.rotation, rotationSigma: rotationSigma,
                          constraints: [PositionConstraint(normal: Vec2(1, 0), value: pose.translation.x, sigma: positionSigma),
                                        PositionConstraint(normal: Vec2(0, 1), value: pose.translation.y, sigma: positionSigma)],
                          confidence: confidence, debugPoints: debug)
    }
}

// MARK: - Edge

public enum EdgeSource {
    public struct Reading {
        /// Pose rotation implied by the edge, before subtracting the calibrated edge angle when `raw`.
        public var rotation: Double
        /// Edge position along the face normal, local mm (relative to the pose it was measured about).
        public var offset: Double
        public var rms: Double
        public var used: Int
        public var tried: Int
        public var worldPoints: [Vec2]
        public var imagePoints: [Vec2]
        public var meanGradient: Double
    }

    /// Scan across the face along its normal and fit a line to the strongest edges.
    /// With `raw`, the reading is the edge itself (used at calibration);
    /// otherwise the calibrated edge angle and offset are taken off it.
    public static func measure(_ plane: LumaPlane, coordinates c: PuttingCoordinateSystem, calibration cal: PutterCalibration,
                               pose: RigidTransform2D, searchMM: Double, columns: Int = 15,
                               columnFilter: ((Double) -> Bool)? = nil, raw: Bool = false) -> Reading? {
        let step = max(0.2, c.surface.mmPerPixelAtBall * 0.5)
        let centre = raw ? 0 : cal.edgeOffset
        let lo = centre - searchMM, hi = centre + searchMM
        var world: [Vec2] = [], image: [Vec2] = [], strengths: [Double] = []
        var tried = 0
        for k in 0..<columns {
            let u = -cal.faceHalfWidth * 0.8 + cal.faceHalfWidth * 1.6 * Double(k) / Double(max(1, columns - 1))
            if let columnFilter, !columnFilter(u) { continue }
            tried += 1
            // Sample one step beyond each end so the central difference covers the range.
            var values: [Double] = []
            var v = lo - step
            while v <= hi + step * 1.01 {
                guard let p = c.image(fromWorld: pose.apply(Vec2(u, v))), plane.bounds.contains(p) else { break }
                values.append(plane.sample(p))
                v += step
            }
            guard values.count >= 5 else { continue }
            var best = 0, bestG = 0.0
            for i in 1..<(values.count - 1) {
                let g = abs(values[i + 1] - values[i - 1])
                if g > bestG {
                    bestG = g
                    best = i
                }
            }
            // An edge worth fitting: a clear step over about a millimetre.
            guard bestG / (2 * step) > 8, best > 1, best < values.count - 2 else { continue }
            let gm = abs(values[best] - values[best - 2]), gp = abs(values[best + 2] - values[best])
            let denom = gm - 2 * bestG + gp
            let frac = abs(denom) > 1e-9 ? 0.5 * (gm - gp) / denom : 0
            let at = lo - step + (Double(best) + max(-0.5, min(0.5, frac))) * step
            let local = Vec2(u, at)
            let w = pose.apply(local)
            world.append(w)
            image.append(c.image(fromWorld: w) ?? .zero)
            strengths.append(bestG / (2 * step))
        }
        guard world.count >= 4 else { return nil }
        let along = pose.applyToVector(Vec2(1, 0))
        guard var fit = LineFit.fit(world, weights: strengths, hint: along) else { return nil }
        // One pass of outlier rejection: a scan that caught the shaft or the ball's far side.
        let normal = Vec2(-fit.direction.y, fit.direction.x)
        let residuals = world.map { abs(($0 - fit.point).dot(normal)) }
        let median = residuals.sorted()[residuals.count / 2]
        let keep = residuals.indices.filter { residuals[$0] <= max(0.6, 3 * median) }
        if keep.count >= 4, keep.count < world.count,
           let refit = LineFit.fit(keep.map { world[$0] }, weights: keep.map { strengths[$0] }, hint: along) {
            fit = refit
            world = keep.map { world[$0] }
            image = keep.map { image[$0] }
            strengths = keep.map { strengths[$0] }
        }
        let edgeRotation = atan2(fit.direction.y, fit.direction.x)
        let rotation = raw ? edgeRotation : Angle.wrap(edgeRotation - cal.edgeAngle)
        // Offset of the fitted line from the pose's face centre, along the fitted normal.
        let n = Vec2(-fit.direction.y, fit.direction.x)
        let offset = (fit.point - pose.translation).dot(n)
        return Reading(rotation: rotation, offset: offset, rms: fit.rms, used: world.count, tried: tried,
                       worldPoints: world, imagePoints: image,
                       meanGradient: strengths.reduce(0, +) / Double(strengths.count))
    }

    public static func observe(_ plane: LumaPlane, coordinates c: PuttingCoordinateSystem, calibration cal: PutterCalibration,
                               predicted pose: RigidTransform2D, searchMM: Double, timestamp: Double) -> PutterObservation? {
        guard let r = measure(plane, coordinates: c, calibration: cal, pose: pose, searchMM: searchMM) else { return nil }
        // The face line is `edgeOffset` behind the edge along the (measured) normal.
        let n = Vec2.direction(-r.rotation)  // face normal of a pose with this rotation
        let edgePoint = r.worldPoints.reduce(Vec2.zero, +) / Double(r.worldPoints.count)
        let value = n.dot(edgePoint) - cal.edgeOffset
        let spread = r.worldPoints.map { ($0 - edgePoint).length }.reduce(0, +) / Double(r.worldPoints.count)
        let n2 = Double(r.used)
        let posSigma = max(0.15, r.rms / n2.squareRoot())
        let rotSigma = max(Angle.radians(0.03), r.rms / (max(5, spread) * n2.squareRoot()))
        let coverage = Double(r.used) / Double(max(1, r.tried))
        let crispness = clampUnit(r.rms < 0.3 ? 1 : 0.3 / r.rms)
        let confidence = clampUnit(coverage * 0.6 + crispness * 0.4) * clampUnit(r.meanGradient / 30)
        var constraints = [PositionConstraint(normal: n, value: value, sigma: posSigma)]
        var debug = r.imagePoints
        // The toe end pins how far the head has slid along its own face line.
        if let reference = cal.toeEnd {
            let measuredPose = RigidTransform2D(rotation: r.rotation, translation: pose.translation)
            if let u = toeEnd(plane, coordinates: c, calibration: cal, pose: measuredPose, expected: reference) {
                let along = Vec2(-n.y, n.x) * -1  // local +x in world, for this rotation
                let toeWorld = measuredPose.apply(Vec2(u, cal.edgeOffset))
                constraints.append(PositionConstraint(normal: along, value: along.dot(toeWorld) - reference, sigma: 0.3))
                if let p = c.image(fromWorld: toeWorld) { debug.append(p) }
            }
        }
        return PutterObservation(source: .edge, timestamp: timestamp, rotation: r.rotation, rotationSigma: rotSigma,
                                 constraints: constraints, confidence: confidence, debugPoints: debug)
    }

    /// Scan along the head behind its edge, across where the toe should end,
    /// on a few lines at different depths, and return where it actually ends
    /// (local mm along the face). Several lines, because one line's end moves
    /// in whole-pixel steps as the head slides.
    public static func toeEnd(_ plane: LumaPlane, coordinates c: PuttingCoordinateSystem, calibration cal: PutterCalibration,
                              pose: RigidTransform2D, expected: Double) -> Double? {
        let step = max(0.2, c.surface.mmPerPixelAtBall * 0.5)
        let sign: Double = expected >= 0 ? 1 : -1
        let from = abs(expected) - 15, to = abs(expected) + 15
        var ends: [Double] = []
        for depth in [3.0, 6, 9, 12] {
            let v = cal.edgeOffset - depth
            var values: [Double] = []
            var u = from - step
            var inside = true
            while u <= to + step * 1.01 {
                guard let p = c.image(fromWorld: pose.apply(Vec2(sign * u, v))), plane.bounds.contains(p) else {
                    inside = false
                    break
                }
                values.append(plane.sample(p))
                u += step
            }
            guard inside, values.count >= 5 else { continue }
            var best = 0, bestG = 0.0
            for i in 1..<(values.count - 1) {
                let g = abs(values[i + 1] - values[i - 1])
                if g > bestG {
                    bestG = g
                    best = i
                }
            }
            guard bestG / (2 * step) > 8, best > 1, best < values.count - 2 else { continue }
            let gm = abs(values[best] - values[best - 2]), gp = abs(values[best + 2] - values[best])
            let denom = gm - 2 * bestG + gp
            let frac = abs(denom) > 1e-9 ? 0.5 * (gm - gp) / denom : 0
            ends.append(from - step + (Double(best) + max(-0.5, min(0.5, frac))) * step)
        }
        guard ends.count >= 2 else { return nil }
        // Median-ish: drop the line furthest from the rest when there are enough.
        if ends.count >= 3 {
            let mean = ends.reduce(0, +) / Double(ends.count)
            if let worst = ends.indices.max(by: { abs(ends[$0] - mean) < abs(ends[$1] - mean) }) { ends.remove(at: worst) }
        }
        return sign * ends.reduce(0, +) / Double(ends.count)
    }
}

// MARK: - Features

public final class FeatureSource {
    public var patchRadius = 5
    public var minScore = 0.72
    private var template: [Double] = []

    public init() {}

    /// Corners (Shi-Tomasi) inside the head's outline, far enough in that a
    /// patch around them is all putter: the background changes when the
    /// template is lifted, the putter does not.
    public static func selectFeatures(_ plane: LumaPlane, coordinates c: PuttingCoordinateSystem, pose: RigidTransform2D,
                                      roi: IntRect, headLuma: Double, paper: Double, halfWidth: Double,
                                      maxCount: Int = 24) -> [PutterFeature] {
        let r = roi.clipped(to: plane.bounds)
        guard r.width > 16, r.height > 16 else { return [] }
        let headCut = (headLuma + paper) / 2
        let margin = 7
        var candidates: [(score: Double, x: Int, y: Int)] = []
        for y in stride(from: r.minY + margin, to: r.maxY - margin, by: 1) {
            for x in stride(from: r.minX + margin, to: r.maxX - margin, by: 1) {
                // Whole neighbourhood must be head, not paper.
                if Double(plane.pixel(x - margin, y - margin)) > headCut || Double(plane.pixel(x + margin, y - margin)) > headCut ||
                    Double(plane.pixel(x - margin, y + margin)) > headCut || Double(plane.pixel(x + margin, y + margin)) > headCut {
                    continue
                }
                var sxx = 0.0, syy = 0.0, sxy = 0.0
                for dy in -3...3 {
                    for dx in -3...3 {
                        let gx = Double(Int(plane.pixel(x + dx + 1, y + dy)) - Int(plane.pixel(x + dx - 1, y + dy)))
                        let gy = Double(Int(plane.pixel(x + dx, y + dy + 1)) - Int(plane.pixel(x + dx, y + dy - 1)))
                        sxx += gx * gx
                        syy += gy * gy
                        sxy += gx * gy
                    }
                }
                let tr = sxx + syy, det = sxx * syy - sxy * sxy
                let minEig = tr / 2 - max(0, tr * tr / 4 - det).squareRoot()
                if minEig > 4000 { candidates.append((minEig, x, y)) }
            }
        }
        candidates.sort { $0.score > $1.score }
        var chosen: [PutterFeature] = []
        let inverse = pose.inverse
        for cand in candidates {
            let p = Vec2(Double(cand.x) + 0.5, Double(cand.y) + 0.5)
            if chosen.contains(where: { $0.calibrationPixel.distance(to: p) < 8 }) { continue }
            guard let w = c.world(fromImage: p) else { continue }
            let local = inverse.apply(w)
            guard local.y < -2, abs(local.x) < halfWidth + 10 else { continue }
            chosen.append(PutterFeature(local: local, calibrationPixel: p))
            if chosen.count >= maxCount { break }
        }
        return chosen
    }

    /// Match every feature against its predicted appearance near its predicted
    /// position, then fit one rigid pose to the matches.
    public func observe(_ plane: LumaPlane, coordinates c: PuttingCoordinateSystem, calibration cal: PutterCalibration,
                        predicted pose: RigidTransform2D, searchPixels: Int, timestamp: Double) -> PutterObservation? {
        guard let reference = cal.reference, cal.features.count >= 3 else { return nil }
        // current pixel -> world now -> local -> world at calibration -> calibration pixel
        let warp = c.surface.worldToImage * cal.pose.matrix * pose.inverse.matrix * c.surface.imageToWorld
        let pr = patchRadius, side = 2 * pr + 1, count = side * side
        if template.count != count { template = [Double](repeating: 0, count: count) }
        var locals: [Vec2] = [], worlds: [Vec2] = [], weights: [Double] = [], debug: [Vec2] = []
        let s = max(1, searchPixels)
        for f in cal.features {
            guard let predicted = c.image(fromWorld: pose.apply(f.local)) else { continue }
            let cx = Int(predicted.x.rounded(.down)), cy = Int(predicted.y.rounded(.down))
            guard cx - pr - s - 1 >= 0, cy - pr - s - 1 >= 0, cx + pr + s + 1 < plane.width, cy + pr + s + 1 < plane.height else { continue }
            // The predicted appearance, sampled from the calibration image through the warp.
            var ok = true
            var tMean = 0.0
            for dy in -pr...pr {
                for dx in -pr...pr {
                    let here = Vec2(Double(cx + dx) + 0.5, Double(cy + dy) + 0.5)
                    guard let src = warp.apply(here), let v = reference.sampleInFrame(src) else {
                        ok = false
                        break
                    }
                    template[(dy + pr) * side + dx + pr] = v
                    tMean += v
                }
                if !ok { break }
            }
            guard ok else { continue }
            tMean /= Double(count)
            var tVar = 0.0
            for i in 0..<count {
                template[i] -= tMean
                tVar += template[i] * template[i]
            }
            guard tVar > Double(count) * 16 else { continue }  // flat patch: nothing to lock onto
            let tNorm = tVar.squareRoot()

            var scores = [Double](repeating: -1, count: (2 * s + 1) * (2 * s + 1))
            var best = -1.0, bx = 0, by = 0
            for oy in -s...s {
                for ox in -s...s {
                    var sum = 0.0, sumSq = 0.0, cross = 0.0
                    for dy in -pr...pr {
                        let row = plane.base + (cy + oy + dy) * plane.bytesPerRow + cx + ox
                        let tRow = (dy + pr) * side + pr
                        for dx in -pr...pr {
                            let v = Double(row[dx])
                            sum += v
                            sumSq += v * v
                            cross += v * template[tRow + dx]
                        }
                    }
                    let variance = sumSq - sum * sum / Double(count)
                    let ncc = variance > 1 ? cross / (variance.squareRoot() * tNorm) : -1
                    scores[(oy + s) * (2 * s + 1) + ox + s] = ncc
                    if ncc > best {
                        best = ncc
                        bx = ox
                        by = oy
                    }
                }
            }
            guard best >= minScore, abs(bx) < s, abs(by) < s else { continue }
            func sc(_ x: Int, _ y: Int) -> Double { scores[(y + s) * (2 * s + 1) + x + s] }
            let fx = Self.parabola(sc(bx - 1, by), best, sc(bx + 1, by))
            let fy = Self.parabola(sc(bx, by - 1), best, sc(bx, by + 1))
            let matched = Vec2(Double(cx + bx) + 0.5 + fx, Double(cy + by) + 0.5 + fy)
            // The patch centre carried the local point of pixel (cx, cy) under the predicted pose.
            guard let centreWorld = c.world(fromImage: Vec2(Double(cx) + 0.5, Double(cy) + 0.5)),
                  let matchedWorld = c.world(fromImage: matched) else { continue }
            locals.append(pose.inverse.apply(centreWorld))
            worlds.append(matchedWorld)
            weights.append((best - minScore) / (1 - minScore) + 0.05)
            debug.append(matched)
        }
        guard locals.count >= 3, var fit = RigidTransform2D.fit(from: locals, to: worlds, weights: weights) else { return nil }
        // Drop matches the others disagree with, then refit.
        let residuals = locals.indices.map { fit.transform.apply(locals[$0]).distance(to: worlds[$0]) }
        let median = residuals.sorted()[residuals.count / 2]
        let keep = residuals.indices.filter { residuals[$0] <= max(0.5, 3 * median) }
        if keep.count >= 3, keep.count < locals.count,
           let refit = RigidTransform2D.fit(from: keep.map { locals[$0] }, to: keep.map { worlds[$0] }, weights: keep.map { weights[$0] }) {
            fit = refit
            locals = keep.map { locals[$0] }
            debug = keep.map { debug[$0] }
        }
        var spread = 0.0
        let mean = locals.reduce(Vec2.zero, +) / Double(locals.count)
        for l in locals { spread += l.distance(to: mean) }
        spread /= Double(locals.count)
        let n = Double(locals.count)
        let posSigma = max(0.12, fit.rms / n.squareRoot())
        let rotSigma = max(Angle.radians(0.03), fit.rms / (max(5, spread) * n.squareRoot()))
        let coverage = n / Double(cal.features.count)
        let confidence = clampUnit(0.35 + coverage * 0.65) * clampUnit(fit.rms < 0.35 ? 1 : 0.35 / fit.rms)
        return .full(.features, timestamp, fit.transform, rotationSigma: rotSigma, positionSigma: posSigma,
                     confidence: confidence, debug: debug)
    }

    static func parabola(_ a: Double, _ b: Double, _ c: Double) -> Double {
        let d = a - 2 * b + c
        guard abs(d) > 1e-9 else { return 0 }
        return max(-0.5, min(0.5, 0.5 * (a - c) / d))
    }
}

// MARK: - Markers

public final class MarkerSource {
    private let blobs = BlobDetector()

    public init() {}

    /// Stickers near where the prediction puts them, then a rigid fit.
    /// With `predicted == nil` (reacquiring) the stickers are matched by shape
    /// alone inside `searchROI`.
    public func observe(_ plane: LumaPlane, coordinates c: PuttingCoordinateSystem, calibration cal: PutterCalibration,
                        predicted pose: RigidTransform2D?, searchPixels: Double, searchROI: IntRect? = nil,
                        timestamp: Double) -> PutterObservation? {
        guard cal.markers.count >= 3 else { return nil }
        let mmpp = c.surface.mmPerPixelAtBall
        let rPx = cal.markerRadiusMM / mmpp
        let expectedArea = Double.pi * rPx * rPx
        let predictedPixels: [Vec2]? = pose.map { p in cal.markers.compactMap { c.image(fromWorld: p.apply($0)) } }
        let roi: IntRect
        if let predictedPixels, predictedPixels.count == cal.markers.count {
            roi = IntRect(covering: predictedPixels, margin: searchPixels + rPx * 2)
        } else if let searchROI {
            roi = searchROI
        } else {
            return nil
        }
        let spots = blobs.detect(plane, roi: roi, threshold: .brighterThan(cal.markerThreshold),
                                 minArea: max(2, Int(expectedArea * 0.3)), maxArea: Int(expectedArea * 3))
            .filter { !$0.touchesEdge && $0.elongation < 2.5 }
        guard spots.count >= 2 else { return nil }
        let centres = spots.map { SpotRefiner.refine(plane, around: $0, dark: false) }
        let worlds = centres.compactMap { c.world(fromImage: $0) }
        guard worlds.count == centres.count else { return nil }

        var matchedLocal: [Vec2] = [], matchedWorld: [Vec2] = [], matchedImage: [Vec2] = []
        if let predictedPixels, predictedPixels.count == cal.markers.count {
            var used = Set<Int>()
            for (i, q) in predictedPixels.enumerated() {
                var pick: Int?, bestD = searchPixels + rPx
                for (j, p) in centres.enumerated() where !used.contains(j) {
                    let d = p.distance(to: q)
                    if d < bestD {
                        bestD = d
                        pick = j
                    }
                }
                if let pick {
                    used.insert(pick)
                    matchedLocal.append(cal.markers[i])
                    matchedWorld.append(worlds[pick])
                    matchedImage.append(centres[pick])
                }
            }
        } else {
            // Shape match: the triple of spots that best fits the sticker triangle.
            guard worlds.count >= 3 else { return nil }
            var best: (rms: Double, idx: [Int])?
            let n = min(worlds.count, 8)
            for i in 0..<n {
                for j in 0..<n where j != i {
                    for k in 0..<n where k != i && k != j {
                        guard let f = RigidTransform2D.fit(from: cal.markers, to: [worlds[i], worlds[j], worlds[k]]) else { continue }
                        // Mirror-image triangles fit badly, so a wrong ordering loses on rms.
                        if f.rms < (best?.rms ?? 1.5) { best = (f.rms, [i, j, k]) }
                    }
                }
            }
            guard let best else { return nil }
            matchedLocal = cal.markers
            matchedWorld = best.idx.map { worlds[$0] }
            matchedImage = best.idx.map { centres[$0] }
        }
        guard matchedLocal.count >= 2, let fit = RigidTransform2D.fit(from: matchedLocal, to: matchedWorld) else { return nil }
        guard fit.rms < 1.5 else { return nil }
        var spread = 0.0
        let mean = matchedLocal.reduce(Vec2.zero, +) / Double(matchedLocal.count)
        for l in matchedLocal { spread += l.distance(to: mean) }
        spread /= Double(matchedLocal.count)
        let n = Double(matchedLocal.count)
        // Centroids of clean stickers are good to a tenth of a pixel or so.
        let pointSigma = max(0.08, fit.rms, mmpp * 0.1)
        let posSigma = pointSigma / n.squareRoot()
        let rotSigma = max(Angle.radians(0.02), pointSigma / (max(5, spread) * n.squareRoot()))
        let confidence = (n >= 3 ? 0.99 : 0.8) * clampUnit(fit.rms < 0.4 ? 1 : 0.4 / fit.rms)
        return .full(.markers, timestamp, fit.transform, rotationSigma: rotSigma, positionSigma: posSigma,
                     confidence: confidence, debug: matchedImage)
    }
}
