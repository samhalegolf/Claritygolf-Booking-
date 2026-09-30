import Foundation
@testable import PuttingLabCore

/// A pinhole camera over the putting plane. Built like a real camera (a
/// rotation and a projection), so left/right and every perspective effect are
/// what a phone would see, not what the code under test assumes.
struct SyntheticCamera {
    var width = 800
    var height = 600
    var worldToImage: Mat3
    var imageToWorld: Mat3

    /// - Parameters:
    ///   - height: lens height above the green, mm.
    ///   - above: the world point the camera sits over.
    ///   - tilt: degrees the camera leans off vertical.
    ///   - yaw: degrees the picture is turned about the lens axis.
    init(width: Int = 800, height pixelsHigh: Int = 600, mmPerPixel: Double = 0.9, height: Double = 1300,
         above: Vec2 = Vec2(0, 150), tilt: Double = 6, yaw: Double = 3) {
        self.width = width
        self.height = pixelsHigh
        let f = height / mmPerPixel
        // Camera axes in world coordinates: x right, y "down" the image = world -y, z down the lens.
        var r: [[Double]] = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
        func rotateRows(_ m: [[Double]], _ axis: Int, _ deg: Double) -> [[Double]] {
            // Rotate the camera about one of its own axes.
            let a = Angle.radians(deg), c = cos(a), s = sin(a)
            var rot: [[Double]]
            switch axis {
            case 0: rot = [[1, 0, 0], [0, c, -s], [0, s, c]]
            default: rot = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
            }
            var out = [[Double]](repeating: [0, 0, 0], count: 3)
            for i in 0..<3 { for j in 0..<3 { for k in 0..<3 { out[i][j] += rot[i][k] * m[k][j] } } }
            return out
        }
        r = rotateRows(r, 2, yaw)
        r = rotateRows(r, 0, tilt)
        let p = [above.x, above.y, height]
        var t = [0.0, 0, 0]
        for i in 0..<3 { t[i] = -(r[i][0] * p[0] + r[i][1] * p[1] + r[i][2] * p[2]) }
        let cx = Double(width) / 2, cy = Double(pixelsHigh) / 2
        let k = Mat3([f, 0, cx, 0, f, cy, 0, 0, 1])
        let rt = Mat3([r[0][0], r[0][1], t[0], r[1][0], r[1][1], t[1], r[2][0], r[2][1], t[2]])
        worldToImage = (k * rt).normalized
        imageToWorld = worldToImage.inverse!.normalized
    }
}

/// What is on the green, in world millimetres.
struct SyntheticScene {
    var templateDown = false
    var ball: Vec2?
    var putterPose: RigidTransform2D?
    var putterMarkers = false
    /// A plain black head: no sight line or engraving, only its outline.
    var plainHead = false
    var template = CalibrationTemplate.a3

    static let green = 105.0
    static let paper = 232.0
    static let ink = 22.0
    static let ballLuma = 228.0
    static let head = 38.0

    /// Luma at one world point.
    func luma(_ p: Vec2) -> Double {
        var v = Self.green
        if templateDown {
            if p.x >= template.sheetMin.x, p.x <= template.sheetMax.x, p.y >= template.sheetMin.y, p.y <= template.sheetMax.y {
                v = Self.paper
                // The square line for the face, faint grey.
                if abs(p.y - template.faceLineY) < 0.25, abs(p.x) < template.faceLineHalfLength,
                   abs(p.x) > template.ballDisc.radius + 2 { v = 150 }
                for r in template.references where p.distance(to: r.position) <= r.radius { v = Self.ink }
            }
        }
        if let b = ball {
            let d = p.distance(to: b)
            let radius = CalibrationTemplate.ballDiameterMM / 2
            if d <= radius { v = Self.ballLuma - 25 * (d / radius) * (d / radius) }
        }
        if let pose = putterPose {
            let l = pose.inverse.apply(p)
            // Shaft/hosel stub reaching back toward a right-hander's hands.
            if l.x >= -140, l.x <= -44, l.y >= -20, l.y <= -13 { v = 30 }
            if l.x >= -55, l.x <= 55, l.y >= -32, l.y <= 0 {
                v = Self.head
                if plainHead { return v }
                // Sight line and a little engraving: texture for the feature tracker.
                if abs(l.x) <= 1, l.y >= -26, l.y <= -5 { v = 205 }
                if Vec2(l.x - 30, l.y + 14).length <= 2.5 || Vec2(l.x + 30, l.y + 14).length <= 2.5 { v = 150 }
                if l.x >= -47, l.x <= -39, l.y >= -22, l.y <= -9 { v = 110 }
                if l.x >= 40, l.x <= 46, l.y >= -24, l.y <= -18 { v = 95 }
                if putterMarkers {
                    for m in [Vec2(-40, -12), Vec2(40, -12), Vec2(14, -22)] where l.distance(to: m) <= 4 { v = 245 }
                }
            }
        }
        return v
    }
}

/// Renders scenes through a camera with anti-aliasing, then adds sensor noise.
final class SyntheticRenderer {
    let camera: SyntheticCamera
    private var seed: UInt64 = 0x9E3779B97F4A7C15

    init(camera: SyntheticCamera) {
        self.camera = camera
    }

    /// Clean luma values, one per pixel.
    func render(_ scene: SyntheticScene) -> [Double] {
        let w = camera.width, h = camera.height
        let h2w = camera.imageToWorld
        // Luma at every pixel corner; a pixel whose corners agree is flat.
        var corners = [Double](repeating: 0, count: (w + 1) * (h + 1))
        for y in 0...h {
            for x in 0...w {
                corners[y * (w + 1) + x] = scene.luma(h2w.apply(Vec2(Double(x), Double(y)))!)
            }
        }
        var out = [Double](repeating: 0, count: w * h)
        let n = 4
        for y in 0..<h {
            for x in 0..<w {
                let a = corners[y * (w + 1) + x], b = corners[y * (w + 1) + x + 1]
                let c = corners[(y + 1) * (w + 1) + x], d = corners[(y + 1) * (w + 1) + x + 1]
                if a == b && a == c && a == d {
                    out[y * w + x] = a
                    continue
                }
                var sum = 0.0
                for sy in 0..<n {
                    for sx in 0..<n {
                        let p = Vec2(Double(x) + (Double(sx) + 0.5) / Double(n), Double(y) + (Double(sy) + 0.5) / Double(n))
                        sum += scene.luma(h2w.apply(p)!)
                    }
                }
                out[y * w + x] = sum / Double(n * n)
            }
        }
        return out
    }

    /// A frame with fresh noise (plus or minus `noise` luma, uniform).
    func frame(_ clean: [Double], noise: Double = 3) -> LumaImage {
        let img = LumaImage(width: camera.width, height: camera.height, fill: 0)
        for i in clean.indices {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            let u = Double(seed >> 11) / Double(1 << 53)
            img.pixels[i] = UInt8(max(0, min(255, (clean[i] + (u * 2 - 1) * noise).rounded())))
        }
        return img
    }
}

/// A putt with known truth, all angles in degrees against the physical line.
struct SyntheticPutt {
    var face = 1.0
    var path = -0.5
    var start = 0.7
    var ballRest = Vec2(1.5, -0.8)
    /// Face centre sits this far behind the ball at address.
    var addressGap = 5.0
    var backswing = 170.0
    var downswingSeconds = 0.30
    var backswingSeconds = 0.55
    var addressSeconds = 0.6
    var smash = 1.3
    /// Face opening per mm the head is behind impact (degrees/mm).
    var faceRotationPerMM = 0.012
    var arc = 0.0004

    let radius = CalibrationTemplate.ballDiameterMM / 2

    var omega: Double { .pi / 2 / downswingSeconds }
    var sImpact: Double { addressGap }
    var topTime: Double { addressSeconds + backswingSeconds }
    var impactTime: Double { topTime + acos(-sImpact / backswing) / omega }
    var direction: Vec2 { Vec2.direction(Angle.radians(path)) }
    var address: Vec2 {
        // Face centre behind the ball along the path, so the face meets the ball's back.
        ballRest - Vec2(0, radius + addressGap)
    }

    func s(_ t: Double) -> Double {
        if t <= addressSeconds { return 0 }
        if t <= topTime {
            let u = (t - addressSeconds) / backswingSeconds
            return -backswing * (1 - cos(.pi * u)) / 2
        }
        return -backswing * cos(omega * (t - topTime))
    }

    func putterPose(_ t: Double) -> RigidTransform2D {
        let sv = s(t)
        // Travel along the path line through the impact point, with an arc inside it.
        let impactPoint = address + Vec2(0, sImpact)
        let perp = direction.rotated(by: .pi / 2)
        let along = sv - sImpact
        let position = impactPoint + direction * along + perp * (arc * along * along)
        let faceAngle = face + faceRotationPerMM * (sImpact - sv)
        return RigidTransform2D(rotation: -Angle.radians(faceAngle), translation: position)
    }

    var putterSpeedAtImpact: Double { backswing * omega * sin(acos(-sImpact / backswing)) }
    var ballSpeed: Double { putterSpeedAtImpact * smash }

    func ballPosition(_ t: Double) -> Vec2 {
        guard t > impactTime else { return ballRest }
        let tau = t - impactTime
        let d = ballSpeed * tau - 0.5 * 600 * tau * tau
        return ballRest + Vec2.direction(Angle.radians(start)) * d
    }
}
