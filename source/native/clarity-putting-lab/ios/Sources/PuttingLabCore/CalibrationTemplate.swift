import Foundation

/// The printed calibration template: an A3 sheet laid on the green around the
/// ball for the first minute of a session, then taken away.
///
/// Coordinates are millimetres with the ball centre at the origin, +y down the
/// target line and +x to its right, exactly the world frame the lab measures in.
///
/// What is on it, and why:
///   - Six small black dots and one larger "aim" dot on the target line. The
///     aim dot tells the detector which way the target is; the small dots give
///     the solve redundancy, so it can report its own error.
///   - A solid black disc where the ball goes. It is an eighth reference (its
///     centre IS the world origin) before the ball is placed, and afterwards a
///     dark background that makes a white ball trivial to find.
///   - A thin grey square line at the back of the ball for the putter face,
///     and fainter +/-1 and +/-2 degree lines through the same point for
///     validation.
///   - A thin grey target line and a 100 mm scale bar to check the print.
///
/// The template is left-right symmetric, so it cannot say whether an image is
/// mirrored. It does not need to: the back camera never mirrors. Angles do not
/// depend on print scale (a uniformly scaled print only changes distances and
/// speeds), and the ball's measured diameter catches a badly scaled print.
public struct CalibrationTemplate: Sendable {
    public struct Reference: Sendable {
        public enum Kind: String, Sendable { case dot, aimDot, ballDisc }
        public var kind: Kind
        public var position: Vec2
        public var radius: Double
    }

    public var references: [Reference]
    /// Where the putter face sits at calibration: this far behind the ball centre.
    public var faceLineY: Double
    public var faceLineHalfLength: Double
    public var ballDiameter: Double
    /// Sheet bounds in template mm (for drawing).
    public var sheetMin: Vec2
    public var sheetMax: Vec2

    /// Regulation ball diameter.
    public static let ballDiameterMM = 42.67

    public static let a3: CalibrationTemplate = {
        let dotR = 8.0
        var refs: [Reference] = [
            Reference(kind: .ballDisc, position: Vec2(0, 0), radius: 28),
            Reference(kind: .aimDot, position: Vec2(0, 195), radius: 12)
        ]
        for (x, y) in [(-110.0, -165.0), (110, -165), (-110, 60), (110, 60), (-110, 195), (110, 195)] {
            refs.append(Reference(kind: .dot, position: Vec2(x, y), radius: dotR))
        }
        return CalibrationTemplate(
            references: refs,
            faceLineY: -ballDiameterMM / 2,
            faceLineHalfLength: 80,
            ballDiameter: ballDiameterMM,
            sheetMin: Vec2(-148.5, -195),
            sheetMax: Vec2(148.5, 225))
    }()

    public var ballDisc: Reference { references.first { $0.kind == .ballDisc }! }
    public var aimDot: Reference { references.first { $0.kind == .aimDot }! }
    public var dots: [Reference] { references.filter { $0.kind == .dot } }

    /// Validation fan through the face centre, in degrees (positive = face open/right).
    public static let validationFaceAngles: [Double] = [-2, -1, 1, 2]

    /// The printable sheet as SVG at 1:1 millimetres. Print at 100% ("actual
    /// size"), never "fit to page", and check the scale bar.
    public func svg() -> String {
        let w = sheetMax.x - sheetMin.x, h = sheetMax.y - sheetMin.y
        // SVG y runs down the page; template +y (target) runs up it.
        func px(_ p: Vec2) -> (Double, Double) { (p.x - sheetMin.x, sheetMax.y - p.y) }
        func f(_ v: Double) -> String { String(format: "%.2f", v) }
        var s = """
        <svg xmlns="http://www.w3.org/2000/svg" width="\(f(w))mm" height="\(f(h))mm" viewBox="0 0 \(f(w)) \(f(h))">
        <rect x="0" y="0" width="\(f(w))" height="\(f(h))" fill="#ffffff"/>

        """
        // Keep every printed line well clear of the dots: a line touching a dot
        // would merge with it and spoil its shape.
        let gap = 8.0
        func line(_ a: Vec2, _ b: Vec2, _ colour: String, _ width: Double, dash: String? = nil) {
            let (x1, y1) = px(a), (x2, y2) = px(b)
            let d = dash.map { " stroke-dasharray=\"\($0)\"" } ?? ""
            s += "<line x1=\"\(f(x1))\" y1=\"\(f(y1))\" x2=\"\(f(x2))\" y2=\"\(f(y2))\" stroke=\"\(colour)\" stroke-width=\"\(f(width))\"\(d)/>\n"
        }
        // Target line: from the ball disc to short of the aim dot.
        line(Vec2(0, ballDisc.radius + gap), Vec2(0, aimDot.position.y - aimDot.radius - gap), "#9a9a9a", 0.6)
        // Square line for the putter face.
        line(Vec2(-faceLineHalfLength, faceLineY), Vec2(-ballDisc.radius - 2, faceLineY), "#8a8a8a", 0.5)
        line(Vec2(ballDisc.radius + 2, faceLineY), Vec2(faceLineHalfLength, faceLineY), "#8a8a8a", 0.5)
        // Validation fan (face at +/-1, +/-2 degrees about the face centre).
        for deg in Self.validationFaceAngles {
            let a = Angle.radians(deg)
            // A face turned right (open) by a has its line rotated clockwise by a.
            let dir = Vec2(1, 0).rotated(by: -a)
            let c = Vec2(0, faceLineY)
            line(c + dir * (ballDisc.radius + 6), c + dir * faceLineHalfLength, "#c4c4c4", 0.35, dash: "2 1.5")
            line(c - dir * (ballDisc.radius + 6), c - dir * faceLineHalfLength, "#c4c4c4", 0.35, dash: "2 1.5")
            let label = c + dir * (faceLineHalfLength + 6)
            let (lx, ly) = px(label)
            s += "<text x=\"\(f(lx))\" y=\"\(f(ly))\" font-family=\"Helvetica\" font-size=\"3\" fill=\"#9a9a9a\" text-anchor=\"middle\">\(deg > 0 ? "+" : "")\(Int(deg))°</text>\n"
        }
        for r in references {
            let (cx, cy) = px(r.position)
            s += "<circle cx=\"\(f(cx))\" cy=\"\(f(cy))\" r=\"\(f(r.radius))\" fill=\"#000000\"/>\n"
        }
        // Ball outline guide inside the disc (white, so it never joins the disc's blob outline).
        let (bx, by) = px(.zero)
        s += "<circle cx=\"\(f(bx))\" cy=\"\(f(by))\" r=\"\(f(ballDiameter / 2))\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"0.3\" stroke-dasharray=\"1.5 1.5\"/>\n"
        // Scale bar: 100 mm, bottom left.
        let sb0 = Vec2(sheetMin.x + 15, sheetMin.y + 12)
        line(sb0, sb0 + Vec2(100, 0), "#6a6a6a", 0.5)
        line(sb0 + Vec2(0, -2), sb0 + Vec2(0, 2), "#6a6a6a", 0.5)
        line(sb0 + Vec2(100, -2), sb0 + Vec2(100, 2), "#6a6a6a", 0.5)
        let (tx, ty) = px(sb0 + Vec2(50, 4))
        s += "<text x=\"\(f(tx))\" y=\"\(f(ty))\" font-family=\"Helvetica\" font-size=\"3.5\" fill=\"#6a6a6a\" text-anchor=\"middle\">100 mm: print at actual size and check this bar</text>\n"
        let (hx, hy) = px(Vec2(0, sheetMax.y - 10))
        s += "<text x=\"\(f(hx))\" y=\"\(f(hy))\" font-family=\"Helvetica\" font-size=\"4\" fill=\"#6a6a6a\" text-anchor=\"middle\">Clarity Putting Lab calibration: target this way</text>\n"
        s += "</svg>\n"
        return s
    }
}
