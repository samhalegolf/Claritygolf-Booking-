import Foundation

// The small amount of 2D maths the whole lab stands on.
//
// Conventions used everywhere in the core:
//   - World plane units are millimetres. Image units are buffer pixels.
//   - The world plane is seen from above: +y runs down the physical target
//     line (toward the hole), +x is to the right of it.
//   - A direction angle is measured from +y toward +x, so POSITIVE MEANS RIGHT
//     of the reference line and negative means left. Face, path and start all
//     use it, which is what makes face-to-path a plain subtraction.
//   - Internally angles are radians. Degrees only appear at the edges (display,
//     the bridge, validation reports).

public struct Vec2: Equatable, Codable, Sendable {
    public var x: Double
    public var y: Double

    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }

    public static let zero = Vec2(0, 0)

    public static func + (a: Vec2, b: Vec2) -> Vec2 { Vec2(a.x + b.x, a.y + b.y) }
    public static func - (a: Vec2, b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
    public static func * (a: Vec2, s: Double) -> Vec2 { Vec2(a.x * s, a.y * s) }
    public static func * (s: Double, a: Vec2) -> Vec2 { Vec2(a.x * s, a.y * s) }
    public static func / (a: Vec2, s: Double) -> Vec2 { Vec2(a.x / s, a.y / s) }
    public static prefix func - (a: Vec2) -> Vec2 { Vec2(-a.x, -a.y) }

    public func dot(_ b: Vec2) -> Double { x * b.x + y * b.y }
    /// z of the 3D cross product: positive when `b` is counter-clockwise of self.
    public func cross(_ b: Vec2) -> Double { x * b.y - y * b.x }
    public var length: Double { (x * x + y * y).squareRoot() }
    public var normalized: Vec2 {
        let l = length
        return l > 0 ? self / l : .zero
    }
    public func distance(to b: Vec2) -> Double { (self - b).length }

    /// Counter-clockwise rotation (standard maths sense, viewed from above).
    public func rotated(by radians: Double) -> Vec2 {
        let c = cos(radians), s = sin(radians)
        return Vec2(c * x - s * y, s * x + c * y)
    }

    /// Unit vector for a direction angle (0 = +y, positive = toward +x).
    public static func direction(_ angle: Double) -> Vec2 { Vec2(sin(angle), cos(angle)) }

    /// Direction angle of this vector: 0 along +y, positive toward +x.
    public var directionAngle: Double { atan2(x, y) }
}

public enum Angle {
    public static func degrees(_ radians: Double) -> Double { radians * 180 / .pi }
    public static func radians(_ degrees: Double) -> Double { degrees * .pi / 180 }

    /// Wrap into (-pi, pi].
    public static func wrap(_ a: Double) -> Double {
        var r = a.truncatingRemainder(dividingBy: 2 * .pi)
        if r <= -.pi { r += 2 * .pi }
        if r > .pi { r -= 2 * .pi }
        return r
    }
}

// MARK: - 3x3 matrices (homographies and planar transforms)

/// Row-major 3x3 matrix acting on homogeneous 2D points.
public struct Mat3: Equatable, Codable, Sendable {
    public var m: [Double]

    public init(_ m: [Double]) {
        precondition(m.count == 9)
        self.m = m
    }

    public static let identity = Mat3([1, 0, 0, 0, 1, 0, 0, 0, 1])

    public subscript(r: Int, c: Int) -> Double {
        get { m[r * 3 + c] }
        set { m[r * 3 + c] = newValue }
    }

    public static func * (a: Mat3, b: Mat3) -> Mat3 {
        var out = [Double](repeating: 0, count: 9)
        for r in 0..<3 {
            for c in 0..<3 {
                out[r * 3 + c] = a.m[r * 3] * b.m[c] + a.m[r * 3 + 1] * b.m[3 + c] + a.m[r * 3 + 2] * b.m[6 + c]
            }
        }
        return Mat3(out)
    }

    /// Projective map of a point. Nil only for a point on the line at infinity.
    public func apply(_ p: Vec2) -> Vec2? {
        let w = m[6] * p.x + m[7] * p.y + m[8]
        guard abs(w) > 1e-12 else { return nil }
        return Vec2((m[0] * p.x + m[1] * p.y + m[2]) / w, (m[3] * p.x + m[4] * p.y + m[5]) / w)
    }

    public var determinant: Double {
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
    }

    public var inverse: Mat3? {
        let d = determinant
        guard abs(d) > 1e-18 else { return nil }
        let i = 1 / d
        return Mat3([
            (m[4] * m[8] - m[5] * m[7]) * i, (m[2] * m[7] - m[1] * m[8]) * i, (m[1] * m[5] - m[2] * m[4]) * i,
            (m[5] * m[6] - m[3] * m[8]) * i, (m[0] * m[8] - m[2] * m[6]) * i, (m[2] * m[3] - m[0] * m[5]) * i,
            (m[3] * m[7] - m[4] * m[6]) * i, (m[1] * m[6] - m[0] * m[7]) * i, (m[0] * m[4] - m[1] * m[3]) * i
        ])
    }

    /// Scale so m[8] == 1 (when possible), purely for readable storage.
    public var normalized: Mat3 {
        guard abs(m[8]) > 1e-15 else { return self }
        return Mat3(m.map { $0 / m[8] })
    }
}

// MARK: - Rigid transforms in the plane

/// Rotation then translation: world = R(rotation) * local + translation.
/// `rotation` is counter-clockwise radians. For a putter this is the pose that
/// carries its calibrated (square) geometry to where it is now.
public struct RigidTransform2D: Equatable, Codable, Sendable {
    public var rotation: Double
    public var translation: Vec2

    public init(rotation: Double, translation: Vec2) {
        self.rotation = rotation
        self.translation = translation
    }

    public static let identity = RigidTransform2D(rotation: 0, translation: .zero)

    public func apply(_ p: Vec2) -> Vec2 { p.rotated(by: rotation) + translation }
    public func applyToVector(_ v: Vec2) -> Vec2 { v.rotated(by: rotation) }

    public var inverse: RigidTransform2D {
        RigidTransform2D(rotation: -rotation, translation: (-translation).rotated(by: -rotation))
    }

    public var matrix: Mat3 {
        let c = cos(rotation), s = sin(rotation)
        return Mat3([c, -s, translation.x, s, c, translation.y, 0, 0, 1])
    }

    /// Weighted least-squares rigid fit (2D Kabsch), carrying `from` onto `to`.
    /// Returns the transform and the weighted RMS residual, or nil when the
    /// points cannot pin a rotation (fewer than two, or all coincident).
    public static func fit(from: [Vec2], to: [Vec2], weights: [Double]? = nil) -> (transform: RigidTransform2D, rms: Double)? {
        let n = min(from.count, to.count)
        guard n >= 2 else { return nil }
        let w = weights ?? [Double](repeating: 1, count: n)
        var sw = 0.0
        var ca = Vec2.zero, cb = Vec2.zero
        for i in 0..<n {
            sw += w[i]
            ca = ca + from[i] * w[i]
            cb = cb + to[i] * w[i]
        }
        guard sw > 0 else { return nil }
        ca = ca / sw
        cb = cb / sw
        var sDot = 0.0, sCross = 0.0
        for i in 0..<n {
            let a = from[i] - ca, b = to[i] - cb
            sDot += w[i] * a.dot(b)
            sCross += w[i] * a.cross(b)
        }
        guard abs(sDot) + abs(sCross) > 1e-12 else { return nil }
        let rotation = atan2(sCross, sDot)
        let t = cb - ca.rotated(by: rotation)
        let transform = RigidTransform2D(rotation: rotation, translation: t)
        var se = 0.0
        for i in 0..<n {
            let d = transform.apply(from[i]) - to[i]
            se += w[i] * d.dot(d)
        }
        return (transform, (se / sw).squareRoot())
    }
}

// MARK: - Homography

public enum Homography {
    /// Least-squares homography carrying `from` onto `to` (at least 4 points,
    /// no three collinear). Hartley-normalised DLT with h33 fixed to 1, solved
    /// through the normal equations. Nil when the geometry is degenerate.
    public static func solve(from: [Vec2], to: [Vec2]) -> Mat3? {
        let n = min(from.count, to.count)
        guard n >= 4 else { return nil }
        guard let (tf, a) = normalisation(Array(from.prefix(n))),
              let (tt, b) = normalisation(Array(to.prefix(n))) else { return nil }

        // Rows: [x y 1 0 0 0 -u x -u y] h = u, and the v row likewise.
        var ata = [Double](repeating: 0, count: 64)
        var atb = [Double](repeating: 0, count: 8)
        func accumulate(_ row: [Double], _ rhs: Double) {
            for i in 0..<8 {
                atb[i] += row[i] * rhs
                for j in 0..<8 { ata[i * 8 + j] += row[i] * row[j] }
            }
        }
        for i in 0..<n {
            let p = a[i], q = b[i]
            accumulate([p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y], q.x)
            accumulate([0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y], q.y)
        }
        guard let h = LinearSolve.solve(ata, atb, size: 8) else { return nil }
        let hn = Mat3([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1])
        guard let ttInv = tt.inverse else { return nil }
        return (ttInv * hn * tf).normalized
    }

    /// RMS distance between `to` and `h(from)`.
    public static func rmsError(_ h: Mat3, from: [Vec2], to: [Vec2]) -> Double {
        let n = min(from.count, to.count)
        guard n > 0 else { return .infinity }
        var se = 0.0
        for i in 0..<n {
            guard let p = h.apply(from[i]) else { return .infinity }
            let d = p - to[i]
            se += d.dot(d)
        }
        return (se / Double(n)).squareRoot()
    }

    /// Translate to the centroid, scale to mean distance sqrt(2).
    private static func normalisation(_ pts: [Vec2]) -> (Mat3, [Vec2])? {
        var c = Vec2.zero
        for p in pts { c = c + p }
        c = c / Double(pts.count)
        var mean = 0.0
        for p in pts { mean += p.distance(to: c) }
        mean /= Double(pts.count)
        guard mean > 1e-12 else { return nil }
        let s = 2.0.squareRoot() / mean
        let t = Mat3([s, 0, -s * c.x, 0, s, -s * c.y, 0, 0, 1])
        return (t, pts.map { ($0 - c) * s })
    }

    /// The local linear scale of a homography at a point: how many target
    /// units one source unit becomes there (geometric mean of the two axes).
    public static func localScale(_ h: Mat3, at p: Vec2) -> Double? {
        guard let o = h.apply(p), let ax = h.apply(p + Vec2(1, 0)), let ay = h.apply(p + Vec2(0, 1)) else { return nil }
        return ((ax - o).length * (ay - o).length).squareRoot()
    }
}

// MARK: - Small dense linear algebra

public enum LinearSolve {
    /// Solve A x = b for a square row-major A by Gaussian elimination with
    /// partial pivoting. Nil when A is (numerically) singular.
    public static func solve(_ aIn: [Double], _ bIn: [Double], size n: Int) -> [Double]? {
        var a = aIn, b = bIn
        for col in 0..<n {
            var pivot = col
            var best = abs(a[col * n + col])
            for r in (col + 1)..<max(col + 1, n) where abs(a[r * n + col]) > best {
                best = abs(a[r * n + col])
                pivot = r
            }
            guard best > 1e-14 else { return nil }
            if pivot != col {
                for c in 0..<n { a.swapAt(col * n + c, pivot * n + c) }
                b.swapAt(col, pivot)
            }
            let d = a[col * n + col]
            for r in (col + 1)..<max(col + 1, n) {
                let f = a[r * n + col] / d
                if f == 0 { continue }
                for c in col..<n { a[r * n + c] -= f * a[col * n + c] }
                b[r] -= f * b[col]
            }
        }
        var x = [Double](repeating: 0, count: n)
        for r in stride(from: n - 1, through: 0, by: -1) {
            var s = b[r]
            for c in (r + 1)..<max(r + 1, n) { s -= a[r * n + c] * x[c] }
            x[r] = s / a[r * n + r]
        }
        return x
    }
}

// MARK: - Line fits

public struct LineFit: Sendable {
    /// A point on the line (the weighted centroid).
    public var point: Vec2
    /// Unit direction of the line.
    public var direction: Vec2
    /// RMS perpendicular residual.
    public var rms: Double

    /// Total least squares line through weighted points. The direction's sign
    /// is chosen to agree with `hint` when given.
    public static func fit(_ pts: [Vec2], weights: [Double]? = nil, hint: Vec2? = nil) -> LineFit? {
        guard pts.count >= 2 else { return nil }
        let w = weights ?? [Double](repeating: 1, count: pts.count)
        var sw = 0.0
        var c = Vec2.zero
        for (i, p) in pts.enumerated() {
            sw += w[i]
            c = c + p * w[i]
        }
        guard sw > 0 else { return nil }
        c = c / sw
        var sxx = 0.0, syy = 0.0, sxy = 0.0
        for (i, p) in pts.enumerated() {
            let d = p - c
            sxx += w[i] * d.x * d.x
            syy += w[i] * d.y * d.y
            sxy += w[i] * d.x * d.y
        }
        // Principal axis of the scatter.
        let theta = 0.5 * atan2(2 * sxy, sxx - syy)
        var dir = Vec2(cos(theta), sin(theta))
        if let hint, dir.dot(hint) < 0 { dir = -dir }
        let normal = Vec2(-dir.y, dir.x)
        var se = 0.0
        for (i, p) in pts.enumerated() {
            let r = (p - c).dot(normal)
            se += w[i] * r * r
        }
        return LineFit(point: c, direction: dir, rms: (se / sw).squareRoot())
    }
}

/// Weighted polynomial (degree 1 or 2) fit of y(t), evaluated where needed.
/// Used to read a value and its rate at an instant from the frames around it,
/// rather than trusting the one (often blurred) frame nearest that instant.
public struct PolyFit: Sendable {
    public var coefficients: [Double]  // c0 + c1 (t - t0) + c2 (t - t0)^2
    public var t0: Double
    public var rms: Double

    public static func fit(t: [Double], y: [Double], weights: [Double]? = nil, degree: Int, about t0: Double) -> PolyFit? {
        let n = min(t.count, y.count)
        let k = degree + 1
        guard n >= k, degree >= 0, degree <= 2 else { return nil }
        let w = weights ?? [Double](repeating: 1, count: n)
        var ata = [Double](repeating: 0, count: k * k)
        var atb = [Double](repeating: 0, count: k)
        for i in 0..<n {
            let dt = t[i] - t0
            var row = [Double](repeating: 1, count: k)
            for j in 1..<max(1, k) { row[j] = row[j - 1] * dt }
            for a in 0..<k {
                atb[a] += w[i] * row[a] * y[i]
                for b in 0..<k { ata[a * k + b] += w[i] * row[a] * row[b] }
            }
        }
        guard let c = LinearSolve.solve(ata, atb, size: k) else { return nil }
        var fit = PolyFit(coefficients: c, t0: t0, rms: 0)
        var se = 0.0, sw = 0.0
        for i in 0..<n {
            let r = fit.value(at: t[i]) - y[i]
            se += w[i] * r * r
            sw += w[i]
        }
        fit.rms = sw > 0 ? (se / sw).squareRoot() : 0
        return fit
    }

    public func value(at t: Double) -> Double {
        let dt = t - t0
        var v = 0.0, p = 1.0
        for c in coefficients {
            v += c * p
            p *= dt
        }
        return v
    }

    public func rate(at t: Double) -> Double {
        let dt = t - t0
        var v = 0.0
        if coefficients.count > 1 { v += coefficients[1] }
        if coefficients.count > 2 { v += 2 * coefficients[2] * dt }
        return v
    }
}

public func clampUnit(_ v: Double) -> Double { min(1, max(0, v)) }
