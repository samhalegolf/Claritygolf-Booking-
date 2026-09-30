import XCTest
@testable import PuttingLabCore

/// End to end on synthetic frames: calibrate from the template, lift it, hit a
/// putt with known face, path and start, and compare. These are the software
/// half of validation: they prove the maths and the pipeline, not the camera,
/// the light or the green (the lab's Validation mode does that on a real one).
final class PipelineTests: XCTestCase {
    let camera = SyntheticCamera()
    lazy var renderer = SyntheticRenderer(camera: camera)

    /// Feed a static scene for `seconds` at `fps`, fresh noise each frame.
    @discardableResult
    func feed(_ engine: PuttingLabEngine, _ scene: SyntheticScene, from t0: Double, seconds: Double, fps: Double = 30,
              until: ((PuttingLabEngine) -> Bool)? = nil) -> Double {
        let clean = renderer.render(scene)
        var t = t0
        while t < t0 + seconds {
            renderer.frame(clean).withPlane { _ = engine.process($0, timestamp: t) }
            t += 1 / fps
            if let until, until(engine) { break }
        }
        return t
    }

    /// Calibrate, lift the template, set a ball and the putter at address.
    func calibratedEngine(markers: Bool, plain: Bool = false, putt: SyntheticPutt, file: StaticString = #filePath, line: UInt = #line) -> (PuttingLabEngine, Double) {
        let engine = PuttingLabEngine()
        var scene = SyntheticScene(templateDown: true)
        var t = feed(engine, scene, from: 0, seconds: 2) { $0.phase != .findingTemplate }
        XCTAssertEqual(engine.phase, .placingBall, "template not found", file: file, line: line)

        scene.ball = .zero
        t = feed(engine, scene, from: t, seconds: 2) { $0.phase != .placingBall }
        XCTAssertEqual(engine.phase, .placingPutter, "ball not confirmed", file: file, line: line)

        scene.putterPose = RigidTransform2D(rotation: 0, translation: Vec2(0, -CalibrationTemplate.ballDiameterMM / 2))
        scene.putterMarkers = markers
        scene.plainHead = plain
        t = feed(engine, scene, from: t, seconds: 2) { $0.phase != .placingPutter }
        XCTAssertEqual(engine.phase, .removeTemplate, "putter not calibrated: \(engine.snapshot.prompt)", file: file, line: line)

        // Template, ball and putter lifted away.
        t = feed(engine, SyntheticScene(), from: t, seconds: 2) { $0.phase != .removeTemplate }
        XCTAssertEqual(engine.phase, .live, file: file, line: line)

        // A fresh ball near the spot, the putter set behind it.
        var address = SyntheticScene(ball: putt.ballRest, putterPose: putt.putterPose(0))
        address.putterMarkers = markers
        address.plainHead = plain
        t = feed(engine, address, from: t, seconds: 1.0, fps: 240)
        XCTAssertEqual(engine.snapshot.gate, .ready, file: file, line: line)
        XCTAssertEqual(engine.snapshot.putterStatus, .tracking, "putter not reacquired", file: file, line: line)
        return (engine, t)
    }

    /// Play the putt at `fps`, rendering every frame.
    func play(_ engine: PuttingLabEngine, _ putt: SyntheticPutt, markers: Bool, plain: Bool = false, from t0: Double,
              fps: Double = 240) -> PuttingStroke? {
        var stroke: PuttingStroke?
        var worst = 0.0, total = 0.0, frames = 0.0
        engine.onStroke = { stroke = $0 }
        defer { print(String(format: "[core timing] mean %.2f ms, worst %.2f ms per frame", total / max(1, frames), worst)) }
        let duration = putt.impactTime + 0.7
        var k = 0.0
        while k / fps < duration, stroke == nil {
            let tp = k / fps
            var scene = SyntheticScene(ball: putt.ballPosition(tp), putterPose: putt.putterPose(tp))
            scene.putterMarkers = markers
            scene.plainHead = plain
            renderer.frame(renderer.render(scene)).withPlane {
                let ms = engine.process($0, timestamp: t0 + tp).processingMilliseconds
                worst = max(worst, ms)
                total += ms
                frames += 1
            }
            k += 1
        }
        return stroke
    }

    func testCalibrationSolvesThePlane() {
        let engine = PuttingLabEngine()
        feed(engine, SyntheticScene(templateDown: true), from: 0, seconds: 2) { $0.phase != .findingTemplate }
        let surface = try! XCTUnwrap(engine.snapshot.surface)
        XCTAssertLessThan(surface.reprojectionErrorMM, 0.4)
        // Compare against the true camera at points the template never marked.
        for p in [Vec2(0, 0), Vec2(80, -40), Vec2(-60, 150), Vec2(0, 260)] {
            let pixel = camera.worldToImage.apply(p)!
            XCTAssertLessThan(surface.imageToWorld.apply(pixel)!.distance(to: p), 0.35, "at \(p)")
        }
        XCTAssertEqual(surface.mmPerPixelAtBall, 0.9, accuracy: 0.06)
    }

    func testMarkerlessPutt() throws {
        let putt = SyntheticPutt()
        let (engine, t) = calibratedEngine(markers: false, putt: putt)
        XCTAssertEqual(engine.snapshot.trackingMode, .markerless)
        let stroke = try XCTUnwrap(play(engine, putt, markers: false, from: t), "no stroke detected")
        report(stroke, putt, from: t)
        assertMeasures(stroke, putt, from: t, faceTolerance: 0.1, pathTolerance: 0.2)
    }

    func testEnhancedPutt() throws {
        let putt = SyntheticPutt(face: -0.8, path: 1.2, start: -0.5)
        let (engine, t) = calibratedEngine(markers: true, putt: putt)
        XCTAssertEqual(engine.snapshot.trackingMode, .enhanced)
        let stroke = try XCTUnwrap(play(engine, putt, markers: true, from: t), "no stroke detected")
        report(stroke, putt, from: t)
        assertMeasures(stroke, putt, from: t, faceTolerance: 0.1, pathTolerance: 0.2)
    }

    func testFirmPuttAt120FPS() throws {
        let putt = SyntheticPutt(face: 0.4, path: -1.5, start: 0.1, backswing: 170, downswingSeconds: 0.2)
        let (engine, t) = calibratedEngine(markers: false, putt: putt)
        let stroke = try XCTUnwrap(play(engine, putt, markers: false, from: t, fps: 120), "no stroke detected")
        report(stroke, putt, from: t)
        assertMeasures(stroke, putt, from: t, faceTolerance: 0.15, pathTolerance: 0.25, impactTolerance: 0.005)
    }

    func testPlainPutterTracksOnItsEdge() throws {
        let putt = SyntheticPutt(face: -1.2, path: 0.3, start: -0.9)
        let (engine, t) = calibratedEngine(markers: false, plain: true, putt: putt)
        XCTAssertTrue(try XCTUnwrap(engine.snapshot.putterCalibration).features.count < 3)
        let stroke = try XCTUnwrap(play(engine, putt, markers: false, plain: true, from: t), "no stroke detected")
        report(stroke, putt, from: t)
        assertMeasures(stroke, putt, from: t, faceTolerance: 0.15, pathTolerance: 0.25)
    }

    func testAimRotationReReadsTheSamePutt() throws {
        let putt = SyntheticPutt()
        let (engine, t) = calibratedEngine(markers: true, putt: putt)
        let stroke = try XCTUnwrap(play(engine, putt, markers: true, from: t))
        let before = stroke.metrics
        engine.setTarget(PracticeTarget(aimOffset: Angle.radians(2.5)))
        let after = try XCTUnwrap(engine.strokes.last).metrics
        XCTAssertEqual(after.face!.value, before.face!.value - 2.5, accuracy: 1e-6)
        XCTAssertEqual(after.path!.value, before.path!.value - 2.5, accuracy: 1e-6)
        XCTAssertEqual(after.start!.value, before.start!.value - 2.5, accuracy: 1e-6)
        XCTAssertEqual(after.faceToPath!.value, before.faceToPath!.value, accuracy: 1e-6)
    }

    func testNudgeAtAddressIsNotAPutt() {
        let putt = SyntheticPutt()
        let (engine, t0) = calibratedEngine(markers: false, putt: putt)
        var strokes = 0
        engine.onStroke = { _ in strokes += 1 }
        // The ball rolls 15 mm and stops.
        var t = t0
        for i in 0..<120 {
            let d = min(15, Double(i) * 0.5)
            let scene = SyntheticScene(ball: putt.ballRest + Vec2(0, d), putterPose: putt.putterPose(0))
            renderer.frame(renderer.render(scene)).withPlane { _ = engine.process($0, timestamp: t) }
            t += 1.0 / 240
        }
        XCTAssertEqual(strokes, 0)
    }

    func testCameraMovementStopsMeasuring() {
        let engine = PuttingLabEngine()
        let flat = DeviceAttitude(w: 1, x: 0, y: 0, z: 0, gravity: Vec3(0, 0, -1))
        let clean = renderer.render(SyntheticScene(templateDown: true))
        var t = 0.0
        while engine.phase == .findingTemplate, t < 2 {
            renderer.frame(clean).withPlane { _ = engine.process($0, timestamp: t, attitude: flat) }
            t += 1.0 / 30
        }
        XCTAssertEqual(engine.phase, .placingBall)
        let half = Angle.radians(1.5) / 2
        let moved = DeviceAttitude(w: cos(half), x: sin(half), y: 0, z: 0, gravity: Vec3(0, 0, -1))
        renderer.frame(clean).withPlane { _ = engine.process($0, timestamp: t, attitude: moved) }
        XCTAssertEqual(engine.phase, .cameraMoved)
        engine.recalibrate()
        XCTAssertEqual(engine.phase, .findingTemplate)
    }

    // MARK: -

    func report(_ s: PuttingStroke, _ p: SyntheticPutt, from t0: Double) {
        let m = s.metrics
        func f(_ v: Measured?) -> String { v.map { String(format: "%+.3f (c %.2f)", $0.value, $0.confidence) } ?? "-" }
        print("""
        [synthetic putt] face \(f(m.face)) truth \(p.face) | path \(f(m.path)) truth \(p.path) | \
        start \(f(m.start)) truth \(p.start) | speed \(f(m.ballSpeed)) truth \(String(format: "%.3f", p.ballSpeed / 1000)) | \
        impact \(String(format: "%.4f", s.impact.time - t0)) truth \(String(format: "%.4f", p.impactTime)) | \
        strike \(f(m.strikePoint)) | rate \(f(m.faceRotationRate)) | samples \(s.putterSamples.count)/\(s.ballSamples.count)
        """)
    }

    func assertMeasures(_ s: PuttingStroke, _ p: SyntheticPutt, from t0: Double, faceTolerance: Double, pathTolerance: Double,
                        impactTolerance: Double = 0.003,
                        file: StaticString = #filePath, line: UInt = #line) {
        let m = s.metrics
        XCTAssertEqual(m.face?.value ?? .nan, p.face, accuracy: faceTolerance, "face", file: file, line: line)
        XCTAssertEqual(m.path?.value ?? .nan, p.path, accuracy: pathTolerance, "path", file: file, line: line)
        XCTAssertEqual(m.start?.value ?? .nan, p.start, accuracy: 0.15, "start", file: file, line: line)
        XCTAssertEqual(m.faceToPath?.value ?? .nan, p.face - p.path, accuracy: faceTolerance + pathTolerance, file: file, line: line)
        XCTAssertEqual(m.ballSpeed?.value ?? .nan, p.ballSpeed / 1000, accuracy: p.ballSpeed / 1000 * 0.05, "speed", file: file, line: line)
        XCTAssertEqual(s.impact.time - t0, p.impactTime, accuracy: impactTolerance, "impact", file: file, line: line)
        // The putter was set with its face centre square behind the ball: a centred strike.
        XCTAssertEqual(m.strikePoint?.value ?? .nan, 0, accuracy: 1.5, "strike", file: file, line: line)
        XCTAssertGreaterThan(m.confidence, 0.4, file: file, line: line)
    }
}
