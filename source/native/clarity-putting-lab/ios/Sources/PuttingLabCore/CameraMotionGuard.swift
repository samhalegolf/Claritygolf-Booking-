import Foundation

/// What the motion sensors say about the phone, reduced to what the lab uses.
/// The iOS layer fills it from Core Motion; tests fill it by hand.
public struct DeviceAttitude: Codable, Equatable, Sendable {
    /// Unit quaternion of the device attitude (w, x, y, z).
    public var w: Double
    public var x: Double
    public var y: Double
    public var z: Double
    /// Gravity in the device frame, in g. (0, 0, -1) is a phone lying screen-up,
    /// i.e. the back camera looking straight down.
    public var gravity: Vec3

    public init(w: Double, x: Double, y: Double, z: Double, gravity: Vec3) {
        self.w = w
        self.x = x
        self.y = y
        self.z = z
        self.gravity = gravity
    }

    /// Angle in radians between two attitudes.
    public func angle(to other: DeviceAttitude) -> Double {
        let d = abs(w * other.w + x * other.x + y * other.y + z * other.z)
        return 2 * acos(min(1, d))
    }

    /// How far the back camera's axis is from looking straight down, radians.
    public var cameraTilt: Double {
        let g = gravity
        let l = (g.x * g.x + g.y * g.y + g.z * g.z).squareRoot()
        guard l > 0 else { return 0 }
        return acos(min(1, max(-1, -g.z / l)))
    }
}

public struct Vec3: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double

    public init(_ x: Double, _ y: Double, _ z: Double) {
        self.x = x
        self.y = y
        self.z = z
    }
}

/// Setup help and a tripwire. Camera level never defines the measurement
/// frame (the template does); it only says "that looks badly tilted" before
/// calibration and "the camera moved" after it.
public struct CameraMotionGuard: Sendable {
    public enum Level: String, Codable, Sendable {
        case good
        /// Usable, but the coach should straighten it if they can.
        case tilted
        /// Too steep for the template to be trusted.
        case tooSteep
    }

    public enum Movement: String, Codable, Sendable {
        case still
        /// A nudge. Measurements continue but are flagged.
        case nudged
        /// Calibration is stale. Measurements stop until recalibrated.
        case moved
    }

    public var tiltWarning = Angle.radians(12)
    public var tiltLimit = Angle.radians(30)
    public var nudgeThreshold = Angle.radians(0.25)
    public var movedThreshold = Angle.radians(0.6)

    public init() {}

    public func level(_ attitude: DeviceAttitude) -> Level {
        let t = attitude.cameraTilt
        if t > tiltLimit { return .tooSteep }
        if t > tiltWarning { return .tilted }
        return .good
    }

    public func movement(from reference: DeviceAttitude, to now: DeviceAttitude) -> Movement {
        classify(reference.angle(to: now))
    }

    func classify(_ a: Double) -> Movement {
        if a > movedThreshold { return .moved }
        if a > nudgeThreshold { return .nudged }
        return .still
    }
}

/// Movement since calibration, robust to sensor drift.
///
/// A fused attitude's heading creeps by itself over minutes, so comparing
/// against the calibration attitude would eventually report a still tripod as
/// moved. Instead: tilt is read from gravity (which does not drift), and
/// rotation is only counted while the phone is actually turning, i.e. while
/// it has rotated measurably within the last second.
public struct CameraMovementTracker: Sendable {
    public var motionGuard = CameraMotionGuard()
    public let reference: DeviceAttitude
    /// Rotation within one second that counts as "being moved" rather than drift.
    public var activeRotation = Angle.radians(0.08)

    private var history: [(t: Double, attitude: DeviceAttitude)] = []
    public private(set) var accumulated = 0.0

    public init(reference: DeviceAttitude, at t: Double) {
        self.reference = reference
        history = [(t, reference)]
    }

    public mutating func update(_ attitude: DeviceAttitude, at t: Double) -> CameraMotionGuard.Movement {
        if let previous = history.last?.attitude, let secondAgo = history.first(where: { $0.t >= t - 1 })?.attitude,
           secondAgo.angle(to: attitude) > activeRotation {
            accumulated += previous.angle(to: attitude)
        }
        history.append((t, attitude))
        history.removeAll { $0.t < t - 1.2 }
        let tilt = Self.angleBetween(reference.gravity, attitude.gravity)
        return motionGuard.classify(max(tilt, accumulated))
    }

    static func angleBetween(_ a: Vec3, _ b: Vec3) -> Double {
        let la = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot(), lb = (b.x * b.x + b.y * b.y + b.z * b.z).squareRoot()
        guard la > 0, lb > 0 else { return 0 }
        return acos(min(1, max(-1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb))))
    }
}
