import PuttingLabCore
import UIKit

/// Layers of the developer overlay. Each can be switched on its own while tuning.
enum PuttingDebugLayer: String, CaseIterable {
    case calibrationPoints = "Calibration points"
    case physicalAxis = "Calibrated target axis"
    case worldAxes = "World axes"
    case ballSearch = "Ball search area"
    case ballCentre = "Ball centre"
    case putterMarkers = "Putter markers"
    case featurePoints = "Tracked feature points"
    case edgePoints = "Face edge points"
    case putterCentre = "Putter centre"
    case confidence = "Confidence values"
    case timing = "Frame rate and latency"
    case impactTime = "Impact timestamp"
    case keepTraces = "Keep traces on screen"
}

/// Draws the lab's view of the green over the camera picture. Everything is
/// held in world millimetres or buffer pixels; `toView` turns buffer pixels
/// into this view's points (it goes through the preview layer, which knows
/// the rotation and letterboxing).
final class PuttingOverlayView: UIView {
    var snapshot = PuttingLabSnapshot()
    var debugLayers: Set<PuttingDebugLayer> = []
    var toView: ((Vec2) -> CGPoint?)?
    /// Traces kept across putts when the debug layer asks for it.
    private var keptTraces: [[PutterSample]] = []
    private var lastStrokeId: String?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: - Mapping

    private func view(image p: Vec2) -> CGPoint? { toView?(p) }

    private func view(world p: Vec2) -> CGPoint? {
        guard let s = snapshot.surface, let pixel = s.worldToImage.apply(p) else { return nil }
        return view(image: pixel)
    }

    private func path(world points: [Vec2]) -> UIBezierPath {
        let path = UIBezierPath()
        var started = false
        for p in points {
            guard let v = view(world: p) else { continue }
            if started { path.addLine(to: v) } else { path.move(to: v) }
            started = true
        }
        return path
    }

    // MARK: - Drawing

    override func draw(_ rect: CGRect) {
        let s = snapshot
        if let stroke = s.lastStroke, stroke.id != lastStrokeId {
            lastStrokeId = stroke.id
            if debugLayers.contains(.keepTraces) {
                keptTraces.append(stroke.putterSamples)
                if keptTraces.count > 12 { keptTraces.removeFirst() }
            }
        }
        if !debugLayers.contains(.keepTraces) { keptTraces.removeAll() }

        if debugLayers.contains(.calibrationPoints) {
            UIColor.systemYellow.setStroke()
            for p in s.templatePoints {
                guard let v = view(image: p) else { continue }
                let ring = UIBezierPath(ovalIn: CGRect(x: v.x - 6, y: v.y - 6, width: 12, height: 12))
                ring.lineWidth = 1.5
                ring.stroke()
            }
        }
        guard let surface = s.surface else { return }

        let aim = Vec2.direction(s.target.aimOffset)
        if debugLayers.contains(.worldAxes) {
            UIColor.systemRed.setStroke()
            stroke(path(world: [.zero, Vec2(100, 0)]), width: 1.5)
            UIColor.systemGreen.setStroke()
            stroke(path(world: [.zero, Vec2(0, 100)]), width: 1.5)
        }
        if debugLayers.contains(.physicalAxis) {
            UIColor.systemGray.setStroke()
            stroke(path(world: [Vec2(0, -150), Vec2(0, 900)]), width: 1, dash: [4, 4])
        }

        // The virtual aim line and the ball spot: always shown once calibrated.
        UIColor.white.withAlphaComponent(0.55).setStroke()
        stroke(path(world: [surface.ballOrigin - aim * 150, surface.ballOrigin + aim * 1500]), width: 1.5)
        let ballRadius = CalibrationTemplate.ballDiameterMM / 2
        let circle = (0...36).map { surface.ballOrigin + Vec2.direction(Double($0) / 36 * 2 * .pi) * ballRadius }
        UIColor.white.withAlphaComponent(s.gate == .waitingForBall ? 0.9 : 0.35).setStroke()
        stroke(path(world: circle), width: 1.5, dash: [3, 3])

        // Gates: two pegs either side of the aim line.
        for g in s.target.gates {
            let across = Vec2(aim.y, -aim.x)
            for side in [-1.0, 1.0] {
                let peg = surface.ballOrigin + aim * g.distance + across * side * (g.width / 2 + 4)
                if let v = view(world: peg) {
                    UIColor.systemOrange.setFill()
                    UIBezierPath(ovalIn: CGRect(x: v.x - 4, y: v.y - 4, width: 8, height: 8)).fill()
                }
            }
        }

        if debugLayers.contains(.ballSearch), let search = s.ballSearch, let c = view(image: search.center),
           let edge = view(image: search.center + Vec2(search.radius, 0)) {
            let r = hypot(edge.x - c.x, edge.y - c.y)
            UIColor.systemTeal.setStroke()
            stroke(UIBezierPath(ovalIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)), width: 1)
        }
        if debugLayers.contains(.ballCentre), let b = s.ball, let v = view(world: b.position) {
            UIColor.systemTeal.setStroke()
            let cross = UIBezierPath()
            cross.move(to: CGPoint(x: v.x - 6, y: v.y))
            cross.addLine(to: CGPoint(x: v.x + 6, y: v.y))
            cross.move(to: CGPoint(x: v.x, y: v.y - 6))
            cross.addLine(to: CGPoint(x: v.x, y: v.y + 6))
            stroke(cross, width: 1.5)
        }

        for trace in keptTraces { drawTrace(trace, impact: nil, faded: true) }
        drawTrace(s.trace, impact: s.gate == .showingResult ? s.lastStroke?.impactTime : nil, faded: false)
        drawBall(s)

        // The putter face as tracked right now.
        if let putter = s.putter, let cal = s.putterCalibration {
            let line = cal.faceLine(for: putter.pose)
            let colour: UIColor = putter.confidence > 0.7 ? .systemGreen : .systemYellow
            colour.setStroke()
            stroke(path(world: [line.heel, line.toe]), width: 3)
            if debugLayers.contains(.putterCentre), let v = view(world: line.center) {
                colour.setFill()
                UIBezierPath(ovalIn: CGRect(x: v.x - 3, y: v.y - 3, width: 6, height: 6)).fill()
            }
        }
        drawSourcePoints(s)
        drawDebugText(s)
    }

    /// The face's journey: the centre's path, then short face lines through the impact zone.
    private func drawTrace(_ samples: [PutterSample], impact: Double?, faded: Bool) {
        guard samples.count >= 2, let cal = snapshot.putterCalibration else { return }
        let alpha: CGFloat = faded ? 0.3 : 1
        // Split at the top of the backswing: the furthest point back along the aim.
        let aim = Vec2.direction(snapshot.target.aimOffset)
        let top = samples.indices.min { samples[$0].position.dot(aim) < samples[$1].position.dot(aim) } ?? 0
        UIColor.systemBlue.withAlphaComponent(0.8 * alpha).setStroke()
        stroke(path(world: samples[...top].map(\.position)), width: 2)
        UIColor.white.withAlphaComponent(0.95 * alpha).setStroke()
        stroke(path(world: samples[top...].map(\.position)), width: 2.5)

        guard let impact else { return }
        // Face lines every few milliseconds through the impact zone.
        let zone = samples.filter { abs($0.timestamp - impact) <= 0.05 }
        let step = max(1, zone.count / 12)
        for (i, s) in zone.enumerated() where i % step == 0 {
            let line = cal.faceLine(for: s.pose)
            UIColor.systemPink.withAlphaComponent(0.8 * alpha).setStroke()
            stroke(path(world: [line.heel, line.toe]), width: 1)
        }
        if let nearest = samples.min(by: { abs($0.timestamp - impact) < abs($1.timestamp - impact) }),
           let v = view(world: nearest.position) {
            UIColor.systemPink.setFill()
            UIBezierPath(ovalIn: CGRect(x: v.x - 5, y: v.y - 5, width: 10, height: 10)).fill()
        }
    }

    private func drawBall(_ s: PuttingLabSnapshot) {
        guard s.ballTrace.count >= 2 else { return }
        UIColor.systemYellow.setStroke()
        stroke(path(world: s.ballTrace.map(\.position)), width: 2)
        // The start line, carried on past the camera's view.
        if s.gate == .showingResult, let start = s.lastStroke?.metrics.start, let rest = s.lastStroke?.ballRest {
            let direction = Vec2.direction(Angle.radians(start.value) + s.target.aimOffset)
            UIColor.systemYellow.withAlphaComponent(0.6).setStroke()
            stroke(path(world: [rest, rest + direction * 1500]), width: 1, dash: [6, 4])
        }
    }

    private func drawSourcePoints(_ s: PuttingLabSnapshot) {
        let wanted: [(PuttingDebugLayer, PutterSource, UIColor)] = [
            (.putterMarkers, .markers, .systemOrange),
            (.featurePoints, .features, .systemPurple),
            (.edgePoints, .edge, .systemGreen)
        ]
        for (layer, source, colour) in wanted where debugLayers.contains(layer) {
            colour.setFill()
            for p in s.sourcePoints[source] ?? [] {
                guard let v = view(image: p) else { continue }
                UIBezierPath(ovalIn: CGRect(x: v.x - 2, y: v.y - 2, width: 4, height: 4)).fill()
            }
        }
    }

    private func drawDebugText(_ s: PuttingLabSnapshot) {
        var lines: [String] = []
        if debugLayers.contains(.timing) {
            lines.append(String(format: "%.0f fps in · %.2f ms/frame", s.inputFPS, s.processingMilliseconds))
            if let tilt = s.cameraTiltDegrees { lines.append(String(format: "tilt %.1f° · %@", tilt, s.movement?.rawValue ?? "-")) }
            if let surface = s.surface {
                lines.append(String(format: "%.2f mm/px · solve %.2f mm", surface.mmPerPixelAtBall, surface.reprojectionErrorMM))
            }
        }
        if debugLayers.contains(.confidence) {
            let sources = PutterSource.allCases.compactMap { src in s.sourceConfidence[src].map { String(format: "%@ %.2f", src.rawValue, $0) } }
            lines.append("putter \(s.putterStatus.rawValue) " + String(format: "%.2f", s.putter?.confidence ?? 0))
            if !sources.isEmpty { lines.append(sources.joined(separator: " · ")) }
            lines.append("ball \(s.ballStatus.rawValue) " + String(format: "%.2f", s.ball?.confidence ?? 0))
        }
        if debugLayers.contains(.impactTime), let stroke = s.lastStroke {
            let i = stroke.impact
            lines.append(String(format: "impact %.4f s (ball %@, putter %@)", i.time,
                                i.fromBall.map { String(format: "%.4f", $0) } ?? "-",
                                i.fromPutter.map { String(format: "%.4f", $0) } ?? "-"))
        }
        guard !lines.isEmpty else { return }
        let text = lines.joined(separator: "\n") as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: UIColor.white
        ]
        let origin = CGPoint(x: 12, y: safeAreaInsets.top + 56)
        let size = text.boundingRect(with: CGSize(width: bounds.width - 24, height: .greatestFiniteMagnitude),
                                     options: .usesLineFragmentOrigin, attributes: attributes, context: nil).size
        UIColor.black.withAlphaComponent(0.5).setFill()
        UIBezierPath(roundedRect: CGRect(origin: origin, size: size).insetBy(dx: -6, dy: -4), cornerRadius: 6).fill()
        text.draw(at: origin, withAttributes: attributes)
    }

    private func stroke(_ path: UIBezierPath, width: CGFloat, dash: [CGFloat]? = nil) {
        path.lineWidth = width
        path.lineCapStyle = .round
        if let dash { path.setLineDash(dash, count: dash.count, phase: 0) }
        path.stroke()
    }
}
