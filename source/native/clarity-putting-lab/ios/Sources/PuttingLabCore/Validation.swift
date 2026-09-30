import Foundation

/// Measures the lab against known physical geometry, so accuracy is a number
/// someone measured rather than a claim.
///
///   face  - set the putter on the square line or a printed +/-1, +/-2 degree
///           line and hold it still; each still hold is one reading.
///   start - roll or putt the ball along a known line; each putt is one reading.
///
/// Both are against the PHYSICAL calibration line (aim offset ignored): the
/// printed lines do not move when the virtual aim does.
public struct ValidationRun: Codable, Sendable {
    public enum Kind: String, Codable, Sendable { case faceAngle, startDirection }

    public var kind: Kind
    /// Degrees, positive = right.
    public var known: Double
    /// Degrees, measured.
    public var readings: [Double] = []

    public init(kind: Kind, known: Double) {
        self.kind = kind
        self.known = known
    }

    public var summary: ValidationSummary { ValidationSummary(run: self) }
}

public struct ValidationSummary: Codable, Sendable {
    public var kind: ValidationRun.Kind
    public var known: Double
    public var count: Int
    /// Mean of (measured - known), degrees: the bias.
    public var meanError: Double
    /// Spread of the readings, degrees: the repeatability.
    public var standardDeviation: Double
    public var maxAbsError: Double

    init(run: ValidationRun) {
        kind = run.kind
        known = run.known
        count = run.readings.count
        let errors = run.readings.map { $0 - run.known }
        meanError = errors.isEmpty ? 0 : errors.reduce(0, +) / Double(errors.count)
        let m = run.readings.isEmpty ? 0 : run.readings.reduce(0, +) / Double(run.readings.count)
        standardDeviation = run.readings.count < 2 ? 0 :
            (run.readings.map { ($0 - m) * ($0 - m) }.reduce(0, +) / Double(run.readings.count - 1)).squareRoot()
        maxAbsError = errors.map(abs).max() ?? 0
    }
}

/// Turns a stream of putter samples into one reading per still hold.
struct StillHoldDetector {
    var holdSeconds = 0.6
    private var window: [PutterSample] = []
    /// After a reading, the putter must move before the next one counts.
    private var waitingForMove = false

    mutating func add(_ s: PutterSample) -> Double? {
        let still = s.velocity.length < 4 && abs(s.angularVelocity) < Angle.radians(0.5) && s.confidence > 0.6
        if !still {
            if s.velocity.length > 30 { waitingForMove = false }
            window.removeAll()
            return nil
        }
        guard !waitingForMove else { return nil }
        window.append(s)
        guard let first = window.first, s.timestamp - first.timestamp >= holdSeconds else { return nil }
        let reading = window.map(\.faceAngleWorld).reduce(0, +) / Double(window.count)
        window.removeAll()
        waitingForMove = true
        return Angle.degrees(reading)
    }
}
