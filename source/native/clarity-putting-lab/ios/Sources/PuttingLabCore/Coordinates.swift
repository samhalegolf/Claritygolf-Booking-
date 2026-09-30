import Foundation

// Three coordinate systems, one direction of travel:
//
//   image pixels  --(surface calibration)-->  world plane (mm)
//   world plane   --(practice target)----->  target plane (mm)
//
// The surface calibration is physical: it only changes when the camera is set
// up again. The practice target is a software choice: the coach can swing the
// aim line around the ball as often as they like and nothing is recalibrated.
// Stored samples are always WORLD coordinates, so a stroke can be re-read
// against any aim after the fact.

/// The surface calibration: how the camera sees the putting plane.
public struct SurfaceCalibration: Codable, Sendable {
    /// Buffer pixels -> world millimetres.
    public var imageToWorld: Mat3
    /// World millimetres -> buffer pixels.
    public var worldToImage: Mat3
    /// Pixel size of the frames the calibration was solved on.
    public var imageWidth: Int
    public var imageHeight: Int
    /// The calibrated ball centre. The world origin by construction.
    public var ballOrigin: Vec2
    /// Unit vector of the physical target line in the world plane (+y by construction).
    public var targetLine: Vec2
    /// Millimetres per pixel at the ball.
    public var mmPerPixelAtBall: Double
    /// RMS residual of the template points after the solve, in millimetres.
    public var reprojectionErrorMM: Double
    /// How many template references were used.
    public var referenceCount: Int
    /// 0...1: how much the solve is worth trusting.
    public var confidence: Double
    /// Device attitude when the solve was accepted, for the movement guard.
    public var attitude: DeviceAttitude?
    /// Seconds (capture clock) when the solve was accepted.
    public var timestamp: Double

    public init(imageToWorld: Mat3, worldToImage: Mat3, imageWidth: Int, imageHeight: Int, ballOrigin: Vec2 = .zero,
                targetLine: Vec2 = Vec2(0, 1), mmPerPixelAtBall: Double, reprojectionErrorMM: Double,
                referenceCount: Int, confidence: Double, attitude: DeviceAttitude?, timestamp: Double) {
        self.imageToWorld = imageToWorld
        self.worldToImage = worldToImage
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.ballOrigin = ballOrigin
        self.targetLine = targetLine
        self.mmPerPixelAtBall = mmPerPixelAtBall
        self.reprojectionErrorMM = reprojectionErrorMM
        self.referenceCount = referenceCount
        self.confidence = confidence
        self.attitude = attitude
        self.timestamp = timestamp
    }
}

/// A digital gate: two virtual pegs straddling the aim line at `distance` mm
/// from the ball, `width` mm apart (inside edge to inside edge).
public struct PracticeGate: Codable, Equatable, Sendable {
    public var distance: Double
    public var width: Double

    public init(distance: Double, width: Double) {
        self.distance = distance
        self.width = width
    }
}

/// The virtual aim: a rotation of the target line about the calibrated ball.
public struct PracticeTarget: Codable, Equatable, Sendable {
    /// Radians, positive = aim right of the physical calibration line.
    public var aimOffset: Double
    public var gates: [PracticeGate]

    public init(aimOffset: Double = 0, gates: [PracticeGate] = []) {
        self.aimOffset = aimOffset
        self.gates = gates
    }

    public var aimOffsetDegrees: Double {
        get { Angle.degrees(aimOffset) }
        set { aimOffset = Angle.radians(newValue) }
    }
}

/// image -> world -> target, with the inverse directions for drawing.
public struct PuttingCoordinateSystem: Sendable {
    public var surface: SurfaceCalibration
    public var target: PracticeTarget

    public init(surface: SurfaceCalibration, target: PracticeTarget) {
        self.surface = surface
        self.target = target
    }

    // Image <-> world

    public func world(fromImage p: Vec2) -> Vec2? { surface.imageToWorld.apply(p) }
    public func image(fromWorld p: Vec2) -> Vec2? { surface.worldToImage.apply(p) }

    // World <-> target. The target frame keeps the ball at its origin and turns
    // the aim line onto +y.

    /// Unit vector of the current aim line, in world coordinates.
    public var aimDirection: Vec2 { Vec2.direction(target.aimOffset) }

    public func target(fromWorld p: Vec2) -> Vec2 {
        // A direction angle is clockwise-positive, so turning the aim back onto
        // +y is a counter-clockwise rotation by the aim offset.
        (p - surface.ballOrigin).rotated(by: target.aimOffset)
    }

    public func world(fromTarget p: Vec2) -> Vec2 {
        p.rotated(by: -target.aimOffset) + surface.ballOrigin
    }

    /// A world direction angle expressed against the aim line.
    public func targetAngle(fromWorldAngle a: Double) -> Double { Angle.wrap(a - target.aimOffset) }
}
