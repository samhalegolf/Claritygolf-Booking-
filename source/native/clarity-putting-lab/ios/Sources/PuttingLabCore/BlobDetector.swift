import Foundation

/// One connected region of foreground pixels.
public struct Blob: Sendable {
    public var area: Int
    /// Plain centroid in frame pixels (pixel centres at +0.5).
    public var centroid: Vec2
    public var bounds: IntRect
    /// Central second moments per unit area.
    public var mxx: Double
    public var myy: Double
    public var mxy: Double
    /// True when the blob reached the edge of the region searched, so it may be cut off.
    public var touchesEdge: Bool

    /// area / bounding-box area: ~0.785 for a filled disc, far lower for a ring or a line.
    public var fillRatio: Double {
        bounds.area > 0 ? Double(area) / Double(bounds.area) : 0
    }

    /// Ratio of the principal axes (1 for a disc, large for a bar).
    public var elongation: Double {
        let (a, b) = axes
        return b > 1e-9 ? (a / b).squareRoot() : .infinity
    }

    /// Principal-axis variances (major, minor).
    public var axes: (Double, Double) {
        let tr = mxx + myy
        let det = mxx * myy - mxy * mxy
        let disc = max(0, tr * tr / 4 - det).squareRoot()
        return (tr / 2 + disc, max(0, tr / 2 - disc))
    }

    /// Orientation of the major axis in image coordinates (radians, x toward y).
    public var orientation: Double { 0.5 * atan2(2 * mxy, mxx - myy) }

    /// Radius of a disc with the same area.
    public var equivalentRadius: Double { (Double(area) / .pi).squareRoot() }
}

/// How a pixel is classed as foreground.
public enum BlobThreshold: Sendable {
    case darkerThan(Int)
    case brighterThan(Int)
    /// Darker than the local mean of a `window`-pixel box by at least `offset`.
    /// Survives uneven light across a whole frame.
    case adaptiveDark(window: Int, offset: Int)
    case adaptiveBright(window: Int, offset: Int)
}

/// Connected components over a region, with buffers kept between calls so the
/// per-frame path allocates nothing once warm.
public final class BlobDetector {
    private var mask: [UInt8] = []
    private var labels: [Int32] = []
    private var stack: [Int32] = []
    private var integral: [UInt32] = []

    public init() {}

    /// Find blobs in `roi`. With `step > 1` the region is sampled every `step`
    /// pixels (a cheap preview for big searches); positions still come back in
    /// full-frame pixels. Blobs outside `minArea...maxArea` (in sampled pixels)
    /// are dropped.
    public func detect(_ plane: LumaPlane, roi: IntRect, threshold: BlobThreshold, step: Int = 1,
                       minArea: Int = 1, maxArea: Int = .max) -> [Blob] {
        let r = roi.clipped(to: plane.bounds)
        let s = max(1, step)
        let w = r.width / s, h = r.height / s
        guard w > 0, h > 0 else { return [] }
        let n = w * h
        if mask.count < n { mask = [UInt8](repeating: 0, count: n) }
        if labels.count < n { labels = [Int32](repeating: 0, count: n) }

        buildMask(plane, r, s, w, h, threshold)

        for i in 0..<n { labels[i] = 0 }
        var blobs: [Blob] = []
        var next: Int32 = 1
        stack.removeAll(keepingCapacity: true)

        for start in 0..<n where mask[start] != 0 && labels[start] == 0 {
            labels[start] = next
            stack.append(Int32(start))
            var area = 0
            var sx = 0.0, sy = 0.0, sxx = 0.0, syy = 0.0, sxy = 0.0
            var x0 = Int.max, y0 = Int.max, x1 = Int.min, y1 = Int.min
            var edge = false
            while let top = stack.popLast() {
                let i = Int(top)
                let px = i % w, py = i / w
                area += 1
                let fx = Double(px), fy = Double(py)
                sx += fx
                sy += fy
                sxx += fx * fx
                syy += fy * fy
                sxy += fx * fy
                x0 = min(x0, px)
                x1 = max(x1, px)
                y0 = min(y0, py)
                y1 = max(y1, py)
                if px == 0 || py == 0 || px == w - 1 || py == h - 1 { edge = true }
                // 4-connected: diagonal touches do not merge separate dots.
                if px > 0 { visit(i - 1, next) }
                if px < w - 1 { visit(i + 1, next) }
                if py > 0 { visit(i - w, next) }
                if py < h - 1 { visit(i + w, next) }
            }
            next += 1
            guard area >= minArea, area <= maxArea else { continue }
            let a = Double(area)
            let mx = sx / a, my = sy / a
            let ss = Double(s)
            let centroid = Vec2(Double(r.minX) + (mx + 0.5) * ss, Double(r.minY) + (my + 0.5) * ss)
            blobs.append(Blob(
                area: area,
                centroid: centroid,
                bounds: IntRect(x: r.minX + x0 * s, y: r.minY + y0 * s, width: (x1 - x0 + 1) * s, height: (y1 - y0 + 1) * s),
                mxx: (sxx / a - mx * mx) * ss * ss,
                myy: (syy / a - my * my) * ss * ss,
                mxy: (sxy / a - mx * my) * ss * ss,
                touchesEdge: edge))
        }
        return blobs
    }

    @inline(__always)
    private func visit(_ j: Int, _ label: Int32) {
        if mask[j] != 0 && labels[j] == 0 {
            labels[j] = label
            stack.append(Int32(j))
        }
    }

    private func buildMask(_ plane: LumaPlane, _ r: IntRect, _ s: Int, _ w: Int, _ h: Int, _ threshold: BlobThreshold) {
        switch threshold {
        case .darkerThan(let t):
            fill(plane, r, s, w, h) { v, _, _ in Int(v) <= t }
        case .brighterThan(let t):
            fill(plane, r, s, w, h) { v, _, _ in Int(v) > t }
        case .adaptiveDark(let window, let offset), .adaptiveBright(let window, let offset):
            let dark: Bool
            if case .adaptiveDark = threshold { dark = true } else { dark = false }
            // Integral image over the sampled grid, with a zero row and column.
            let iw = w + 1
            let needed = iw * (h + 1)
            if integral.count < needed { integral = [UInt32](repeating: 0, count: needed) }
            for x in 0..<iw { integral[x] = 0 }
            for y in 0..<h {
                integral[(y + 1) * iw] = 0
                var rowSum: UInt32 = 0
                let row = plane.base + (r.minY + y * s) * plane.bytesPerRow + r.minX
                for x in 0..<w {
                    rowSum &+= UInt32(row[x * s])
                    integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] &+ rowSum
                }
            }
            let half = max(1, window / s / 2)
            for y in 0..<h {
                let ya = max(0, y - half), yb = min(h, y + half + 1)
                let row = plane.base + (r.minY + y * s) * plane.bytesPerRow + r.minX
                for x in 0..<w {
                    let xa = max(0, x - half), xb = min(w, x + half + 1)
                    let sum = Int(integral[yb * iw + xb]) - Int(integral[ya * iw + xb]) - Int(integral[yb * iw + xa]) + Int(integral[ya * iw + xa])
                    let count = (yb - ya) * (xb - xa)
                    let v = Int(row[x * s]) * count
                    mask[y * w + x] = dark ? (v < sum - offset * count ? 1 : 0) : (v > sum + offset * count ? 1 : 0)
                }
            }
        }
    }

    @inline(__always)
    private func fill(_ plane: LumaPlane, _ r: IntRect, _ s: Int, _ w: Int, _ h: Int, _ test: (UInt8, Int, Int) -> Bool) {
        for y in 0..<h {
            let row = plane.base + (r.minY + y * s) * plane.bytesPerRow + r.minX
            for x in 0..<w { mask[y * w + x] = test(row[x * s], x, y) ? 1 : 0 }
        }
    }
}

/// Sub-pixel centre of a dark or bright spot: an intensity-weighted centroid
/// against the local background, measured at full resolution. Much steadier
/// than a thresholded centroid, which moves in whole pixels as the edge flickers.
public enum SpotRefiner {
    public static func refine(_ plane: LumaPlane, around blob: Blob, dark: Bool) -> Vec2 {
        let pad = max(3, Int(blob.equivalentRadius * 0.8))
        let rect = IntRect(x: blob.bounds.minX - pad, y: blob.bounds.minY - pad,
                           width: blob.bounds.width + 2 * pad, height: blob.bounds.height + 2 * pad).clipped(to: plane.bounds)
        guard rect.area > 0 else { return blob.centroid }
        // Background: the ring outside the blob's box.
        var bg = 0, bgCount = 0, lo = 255, hi = 0
        for y in rect.minY..<rect.maxY {
            let row = plane.base + y * plane.bytesPerRow
            for x in rect.minX..<rect.maxX {
                let v = Int(row[x])
                lo = min(lo, v)
                hi = max(hi, v)
                let inside = x >= blob.bounds.minX && x < blob.bounds.maxX && y >= blob.bounds.minY && y < blob.bounds.maxY
                if !inside {
                    bg += v
                    bgCount += 1
                }
            }
        }
        guard bgCount > 0 else { return blob.centroid }
        let background = Double(bg) / Double(bgCount)
        let core = Double(dark ? lo : hi)
        guard abs(background - core) > 8 else { return blob.centroid }
        var sw = 0.0, sx = 0.0, sy = 0.0
        for y in rect.minY..<rect.maxY {
            let row = plane.base + y * plane.bytesPerRow
            for x in rect.minX..<rect.maxX {
                let v = Double(row[x])
                // Weight = how far toward the spot's core this pixel is, 0...1.
                let wgt = clampUnit((dark ? background - v : v - background) / abs(background - core))
                // Suppress the faint tail of noise in the background ring.
                guard wgt > 0.15 else { continue }
                sw += wgt
                sx += wgt * (Double(x) + 0.5)
                sy += wgt * (Double(y) + 0.5)
            }
        }
        return sw > 0 ? Vec2(sx / sw, sy / sw) : blob.centroid
    }
}
