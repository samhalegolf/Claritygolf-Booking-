import XCTest
@testable import PuttingLabCore

final class GeometryTests: XCTestCase {
    func testDirectionAnglesArePositiveToTheRight() {
        XCTAssertEqual(Vec2(0, 1).directionAngle, 0, accuracy: 1e-12)
        XCTAssertGreaterThan(Vec2(0.1, 1).directionAngle, 0)
        XCTAssertLessThan(Vec2(-0.1, 1).directionAngle, 0)
        XCTAssertEqual(Vec2.direction(0.3).directionAngle, 0.3, accuracy: 1e-12)
    }

    func testHomographyRecoversACameraFromNoisyPoints() {
        let camera = SyntheticCamera()
        let world = CalibrationTemplate.a3.references.map(\.position)
        var seed: UInt64 = 7
        let image = world.map { w -> Vec2 in
            seed = seed &* 6364136223846793005 &+ 1
            let jitter = Vec2(Double(seed % 100) / 100 - 0.5, Double((seed >> 20) % 100) / 100 - 0.5) * 0.2
            return camera.worldToImage.apply(w)! + jitter
        }
        let h = Homography.solve(from: image, to: world)!
        // A point well away from the references still lands within a fraction of a millimetre.
        let probe = Vec2(60, 250)
        let back = h.apply(camera.worldToImage.apply(probe)!)!
        XCTAssertLessThan(back.distance(to: probe), 0.5)
        XCTAssertLessThan(Homography.rmsError(h, from: image, to: world), 0.3)
    }

    func testRigidFitRecoversRotationAndTranslation() {
        let truth = RigidTransform2D(rotation: Angle.radians(1.7), translation: Vec2(12, -40))
        let local = [Vec2(-40, -12), Vec2(40, -12), Vec2(14, -22), Vec2(0, 0)]
        let fit = RigidTransform2D.fit(from: local, to: local.map(truth.apply))!
        XCTAssertEqual(fit.transform.rotation, truth.rotation, accuracy: 1e-9)
        XCTAssertEqual(fit.transform.translation.distance(to: truth.translation), 0, accuracy: 1e-9)
        XCTAssertEqual(fit.rms, 0, accuracy: 1e-9)
    }

    func testPracticeTargetRotatesAboutTheBall() {
        let surface = SurfaceCalibration(imageToWorld: .identity, worldToImage: .identity, imageWidth: 1, imageHeight: 1,
                                         mmPerPixelAtBall: 1, reprojectionErrorMM: 0, referenceCount: 8, confidence: 1,
                                         attitude: nil, timestamp: 0)
        var c = PuttingCoordinateSystem(surface: surface, target: PracticeTarget(aimOffset: Angle.radians(2.5)))
        // A point straight down the aim line sits on the target frame's +y axis.
        let onAim = c.aimDirection * 1000
        XCTAssertEqual(c.target(fromWorld: onAim).x, 0, accuracy: 1e-9)
        XCTAssertEqual(c.target(fromWorld: onAim).y, 1000, accuracy: 1e-9)
        XCTAssertEqual(c.targetAngle(fromWorldAngle: Angle.radians(2.5)), 0, accuracy: 1e-12)
        c.target.aimOffset = 0
        XCTAssertEqual(c.world(fromTarget: Vec2(3, 4)).distance(to: Vec2(3, 4)), 0, accuracy: 1e-12)
    }

    func testCameraGuardFlagsMovement() {
        let guardian = CameraMotionGuard()
        let flat = DeviceAttitude(w: 1, x: 0, y: 0, z: 0, gravity: Vec3(0, 0, -1))
        XCTAssertEqual(guardian.level(flat), .good)
        let half = Angle.radians(0.4) / 2
        let nudged = DeviceAttitude(w: cos(half), x: sin(half), y: 0, z: 0, gravity: Vec3(0, 0, -1))
        XCTAssertEqual(guardian.movement(from: flat, to: nudged), .nudged)
        let big = Angle.radians(2) / 2
        let moved = DeviceAttitude(w: cos(big), x: 0, y: sin(big), z: 0, gravity: Vec3(0, 0, -1))
        XCTAssertEqual(guardian.movement(from: flat, to: moved), .moved)
        let steep = DeviceAttitude(w: 1, x: 0, y: 0, z: 0, gravity: Vec3(0, -0.6, -0.8))
        XCTAssertEqual(guardian.level(steep), .tooSteep)
    }

    func testSlowHeadingDriftIsNotMovement() {
        let flat = DeviceAttitude(w: 1, x: 0, y: 0, z: 0, gravity: Vec3(0, 0, -1))
        var tracker = CameraMovementTracker(reference: flat, at: 0)
        // Heading creeping 3 degrees over ten minutes, gravity unchanged.
        var t = 0.0, result = CameraMotionGuard.Movement.still
        while t < 600 {
            let half = Angle.radians(3 * t / 600) / 2
            result = tracker.update(DeviceAttitude(w: cos(half), x: 0, y: 0, z: sin(half), gravity: Vec3(0, 0, -1)), at: t)
            t += 1.0 / 30
        }
        XCTAssertEqual(result, .still)
        // A knock: one degree in a tenth of a second.
        for i in 1...3 {
            let half = Angle.radians(3 + Double(i) / 3) / 2
            result = tracker.update(DeviceAttitude(w: cos(half), x: 0, y: 0, z: sin(half), gravity: Vec3(0, 0, -1)), at: t)
            t += 1.0 / 30
        }
        XCTAssertEqual(result, .moved)
    }

    /// The sheet coaches print is served from the booking site. It must be the
    /// layout the detector looks for. Regenerate with
    /// PUTTING_LAB_WRITE_TEMPLATE=1 swift test --filter testCommittedTemplate
    func testCommittedTemplateMatchesTheLayout() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("public/putting-lab/calibration-template-a3.svg")
        let svg = CalibrationTemplate.a3.svg()
        if ProcessInfo.processInfo.environment["PUTTING_LAB_WRITE_TEMPLATE"] == "1" {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try svg.write(to: url, atomically: true, encoding: .utf8)
        }
        let committed = try String(contentsOf: url, encoding: .utf8)
        XCTAssertEqual(committed, svg, "public/putting-lab/calibration-template-a3.svg is stale; regenerate it")
    }

    func testTemplateSVGIsPrintScale() {
        let svg = CalibrationTemplate.a3.svg()
        XCTAssertTrue(svg.contains("width=\"297.00mm\""))
        XCTAssertTrue(svg.contains("height=\"420.00mm\""))
        // Eight black references.
        XCTAssertEqual(svg.components(separatedBy: "fill=\"#000000\"").count - 1, 8)
    }
}
