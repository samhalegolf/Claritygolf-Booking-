import Foundation

// Everything the lab measures is measured on the luma (brightness) plane.
// The camera delivers bi-planar YCbCr, whose first plane IS luma, so the iOS
// layer hands the core a pointer straight into the capture buffer: no copy, no
// colour conversion.
//
// Pixel convention: pixel (i, j) covers [i, i+1) x [j, j+1), so its centre is
// (i + 0.5, j + 0.5). Every centroid, sample and homography in the core uses
// these continuous coordinates.

/// A borrowed view of an 8-bit luma plane. Only valid inside the call that made it.
public struct LumaPlane {
    public let base: UnsafePointer<UInt8>
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int

    public init(base: UnsafePointer<UInt8>, width: Int, height: Int, bytesPerRow: Int) {
        self.base = base
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
    }

    @inline(__always)
    public func pixel(_ x: Int, _ y: Int) -> UInt8 { base[y * bytesPerRow + x] }

    public var bounds: IntRect { IntRect(x: 0, y: 0, width: width, height: height) }

    /// Bilinear sample at a continuous point (pixel centres at +0.5). Clamps at the border.
    @inline(__always)
    public func sample(_ p: Vec2) -> Double {
        let fx = p.x - 0.5, fy = p.y - 0.5
        let x0 = Int(fx.rounded(.down)), y0 = Int(fy.rounded(.down))
        let ax = fx - Double(x0), ay = fy - Double(y0)
        let xa = min(max(x0, 0), width - 1), xb = min(max(x0 + 1, 0), width - 1)
        let ya = min(max(y0, 0), height - 1), yb = min(max(y0 + 1, 0), height - 1)
        let r0 = base + ya * bytesPerRow, r1 = base + yb * bytesPerRow
        let top = Double(r0[xa]) * (1 - ax) + Double(r0[xb]) * ax
        let bottom = Double(r1[xa]) * (1 - ax) + Double(r1[xb]) * ax
        return top * (1 - ay) + bottom * ay
    }

    /// Mean luma over a rectangle (clipped).
    public func mean(in rect: IntRect) -> Double {
        let r = rect.clipped(to: bounds)
        guard r.area > 0 else { return 0 }
        var s = 0
        for y in r.minY..<r.maxY {
            let row = base + y * bytesPerRow
            for x in r.minX..<r.maxX { s += Int(row[x]) }
        }
        return Double(s) / Double(r.area)
    }

    /// Copy a rectangle out into an owned image (for references kept across frames).
    public func copy(_ rect: IntRect) -> LumaImage {
        let r = rect.clipped(to: bounds)
        let out = LumaImage(width: r.width, height: r.height, fill: 0)
        for y in 0..<r.height {
            let row = base + (r.minY + y) * bytesPerRow + r.minX
            for x in 0..<r.width { out.pixels[y * r.width + x] = row[x] }
        }
        out.origin = (r.minX, r.minY)
        return out
    }
}

/// An owned luma image. Used for references the core keeps (the putter as it
/// looked at calibration) and by the tests to synthesise frames.
public final class LumaImage: @unchecked Sendable {
    public var pixels: [UInt8]
    public let width: Int
    public let height: Int
    /// Where this image sat in the frame it was cut from, if it was cut from one.
    public var origin: (x: Int, y: Int) = (0, 0)

    public init(width: Int, height: Int, fill: UInt8) {
        self.width = width
        self.height = height
        pixels = [UInt8](repeating: fill, count: width * height)
    }

    public func withPlane<R>(_ body: (LumaPlane) throws -> R) rethrows -> R {
        try pixels.withUnsafeBufferPointer { buffer in
            try body(LumaPlane(base: buffer.baseAddress!, width: width, height: height, bytesPerRow: width))
        }
    }

    /// Bilinear sample in the coordinates of the frame it was cut from.
    public func sampleInFrame(_ p: Vec2) -> Double? {
        let local = Vec2(p.x - Double(origin.x), p.y - Double(origin.y))
        guard local.x >= 0.5, local.y >= 0.5, local.x <= Double(width) - 0.5, local.y <= Double(height) - 0.5 else { return nil }
        return withPlane { $0.sample(local) }
    }
}

public struct IntRect: Equatable, Codable, Sendable {
    public var x: Int
    public var y: Int
    public var width: Int
    public var height: Int

    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x
        self.y = y
        self.width = max(0, width)
        self.height = max(0, height)
    }

    /// The smallest pixel rect holding every point, grown by `margin` pixels.
    public init(covering points: [Vec2], margin: Double) {
        guard let first = points.first else {
            self.init(x: 0, y: 0, width: 0, height: 0)
            return
        }
        var lo = first, hi = first
        for p in points {
            lo = Vec2(min(lo.x, p.x), min(lo.y, p.y))
            hi = Vec2(max(hi.x, p.x), max(hi.y, p.y))
        }
        let x0 = Int((lo.x - margin).rounded(.down)), y0 = Int((lo.y - margin).rounded(.down))
        let x1 = Int((hi.x + margin).rounded(.up)), y1 = Int((hi.y + margin).rounded(.up))
        self.init(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    public var minX: Int { x }
    public var minY: Int { y }
    public var maxX: Int { x + width }
    public var maxY: Int { y + height }
    public var area: Int { width * height }
    public var center: Vec2 { Vec2(Double(x) + Double(width) / 2, Double(y) + Double(height) / 2) }

    public func clipped(to b: IntRect) -> IntRect {
        let x0 = max(minX, b.minX), y0 = max(minY, b.minY)
        let x1 = min(maxX, b.maxX), y1 = min(maxY, b.maxY)
        return IntRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    public func contains(_ p: Vec2) -> Bool {
        p.x >= Double(minX) && p.x < Double(maxX) && p.y >= Double(minY) && p.y < Double(maxY)
    }
}

/// The 256-bin luma histogram of a region and Otsu's split of it.
public enum Histogram {
    public static func of(_ plane: LumaPlane, in rect: IntRect, step: Int = 1) -> [Int] {
        var h = [Int](repeating: 0, count: 256)
        let r = rect.clipped(to: plane.bounds)
        guard r.area > 0 else { return h }
        var y = r.minY
        while y < r.maxY {
            let row = plane.base + y * plane.bytesPerRow
            var x = r.minX
            while x < r.maxX {
                h[Int(row[x])] += 1
                x += step
            }
            y += step
        }
        return h
    }

    /// Otsu threshold and its separability (between-class / total variance, 0...1).
    public static func otsu(_ h: [Int]) -> (threshold: Int, separability: Double) {
        var total = 0, sum = 0.0
        for i in 0..<256 {
            total += h[i]
            sum += Double(i * h[i])
        }
        guard total > 0 else { return (128, 0) }
        let mean = sum / Double(total)
        var variance = 0.0
        for i in 0..<256 { variance += Double(h[i]) * (Double(i) - mean) * (Double(i) - mean) }
        variance /= Double(total)
        var wB = 0, sumB = 0.0, best = -1.0, threshold = 128
        for t in 0..<256 {
            wB += h[t]
            if wB == 0 { continue }
            let wF = total - wB
            if wF == 0 { break }
            sumB += Double(t * h[t])
            let mB = sumB / Double(wB), mF = (sum - sumB) / Double(wF)
            let between = Double(wB) * Double(wF) * (mB - mF) * (mB - mF) / Double(total) / Double(total)
            if between > best {
                best = between
                threshold = t
            }
        }
        return (threshold, variance > 0 ? min(1, best / variance) : 0)
    }
}
