import AVFoundation
import PuttingLabCore
import UIKit

/// The camera fills the screen; the preview layer is the view's own layer.
private final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

/// The Putting Lab screen: a live digital gate.
///
/// Ready -> putt -> Face / Path / Start and the trace -> Ready again, with no
/// taps between putts. Everything else (aim, validation, the debug overlay)
/// sits in small controls around the edge.
final class PuttingLabViewController: UIViewController {
    struct Options {
        var configuration = PuttingLabConfiguration()
        var debugLayers: Set<PuttingDebugLayer> = []
    }

    var onStroke: ((PuttingStroke) -> Void)?
    var onPhase: ((PuttingLabPhase) -> Void)?
    var onValidation: ((ValidationRun) -> Void)?
    /// Called once, after the screen has gone, with every putt it measured.
    var onClose: (([PuttingStroke]) -> Void)?

    private let session: PuttingLabSession
    private let preview = PreviewView()
    private let overlay = PuttingOverlayView()
    private var displayLink: CADisplayLink?
    private var strokes: [PuttingStroke] = []
    private var target: PracticeTarget
    private var debugLayers: Set<PuttingDebugLayer>
    private var captureSize = CGSize(width: 1920, height: 1080)

    private let closeButton = UIButton(type: .system)
    private let modeLabel = UILabel()
    private let aimLabel = UILabel()
    private let aimMinus = UIButton(type: .system)
    private let aimPlus = UIButton(type: .system)
    private let promptLabel = UILabel()
    private let warningLabel = UILabel()
    private let faceValue = UILabel()
    private let pathValue = UILabel()
    private let startValue = UILabel()
    private let detailLabel = UILabel()
    private let resultStack = UIStackView()
    private let recalibrateButton = UIButton(type: .system)
    private let validateButton = UIButton(type: .system)
    private let debugButton = UIButton(type: .system)
    private let practiseButton = UIButton(type: .system)

    init(options: Options) {
        target = options.configuration.target
        debugLayers = options.debugLayers
        session = PuttingLabSession(configuration: options.configuration)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview.previewLayer.session = (session.camera as? PuttingCameraSession)?.session
        preview.previewLayer.videoGravity = .resizeAspect
        overlay.debugLayers = debugLayers
        overlay.toView = { [weak self] p in self?.viewPoint(forImagePixel: p) }
        buildInterface()

        session.onStroke = { [weak self] stroke in self?.strokeArrived(stroke) }
        session.onPhase = { [weak self] phase in self?.onPhase?(phase) }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else {
                    self.promptLabel.text = "Camera access is off. Turn it on in Settings > Clarity Booking."
                    return
                }
                self.session.start { result in
                    switch result {
                    case .success(let format):
                        self.captureSize = CGSize(width: format.width, height: format.height)
                        self.setPreviewPortrait()
                    case .failure(let error):
                        self.promptLabel.text = error.localizedDescription
                    }
                }
            }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFramesPerSecond = 60
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        displayLink?.invalidate()
        displayLink = nil
        session.stop()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // However it was closed (its own button, or the page), report the session once.
        if isBeingDismissed {
            onClose?(strokes)
            onClose = nil
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
        overlay.frame = view.bounds
    }

    private func setPreviewPortrait() {
        guard let connection = preview.previewLayer.connection else { return }
        if #available(iOS 17.0, *) {
            if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
        } else if connection.isVideoOrientationSupported {
            connection.videoOrientation = .portrait
        }
    }

    /// Buffer pixel -> this view's point, via the preview layer (rotation and letterboxing included).
    private func viewPoint(forImagePixel p: Vec2) -> CGPoint? {
        guard captureSize.width > 0, captureSize.height > 0 else { return nil }
        let devicePoint = CGPoint(x: p.x / captureSize.width, y: p.y / captureSize.height)
        return preview.previewLayer.layerPointConverted(fromCaptureDevicePoint: devicePoint)
    }

    // MARK: - Per display frame

    @objc private func tick() {
        let s = session.snapshot
        overlay.snapshot = s
        overlay.setNeedsDisplay()

        modeLabel.text = s.trackingMode.map { $0 == .enhanced ? "Enhanced tracking" : "Markerless tracking" } ?? "Calibrating"
        practiseButton.isHidden = s.phase != .removeTemplate
        warningLabel.text = s.warning
        warningLabel.isHidden = s.warning == nil

        switch s.phase {
        case .live where s.gate == .showingResult:
            promptLabel.text = nil
            showResult(s.lastStroke, consistency: s.consistency)
        case .live:
            promptLabel.text = s.prompt
            if s.gate == .ready || s.gate == .waitingForBall { showResult(nil, consistency: s.consistency) }
        case .cameraMoved:
            promptLabel.text = s.prompt
            resultStack.isHidden = true
        default:
            promptLabel.text = s.prompt
            resultStack.isHidden = true
        }
        if let v = s.validation {
            detailLabel.isHidden = false
            detailLabel.text = Self.describe(v)
        }
    }

    private func showResult(_ stroke: PuttingStroke?, consistency: PuttingConsistency?) {
        guard let stroke else {
            resultStack.isHidden = true
            return
        }
        resultStack.isHidden = false
        let m = stroke.metrics
        faceValue.attributedText = Self.row("Face", m.face)
        pathValue.attributedText = Self.row("Path", m.path)
        startValue.attributedText = Self.row("Start", m.start)
        var detail: [String] = []
        if let f2p = m.faceToPath { detail.append("Face to path \(Self.angle(f2p.value))") }
        if let speed = m.ballSpeed, speed.confidence > 0.4 { detail.append(String(format: "%.2f m/s", speed.value)) }
        if let strike = m.strikePoint, strike.confidence > 0.5 {
            let mm = Int(strike.value.rounded())
            detail.append(mm == 0 ? "Centre strike" : "\(abs(mm)) mm \(mm > 0 ? "toe" : "heel")")
        }
        if let c = consistency, let face = c.face, let start = c.start {
            detail.append(String(format: "%d putts · SD face %.1f° start %.1f°", face.count, face.standardDeviation, start.standardDeviation))
        }
        if m.confidence < 0.5 { detail.append("Low confidence") }
        detailLabel.text = detail.joined(separator: "  ·  ")
        detailLabel.isHidden = detail.isEmpty
    }

    /// "0.4° R", "0.1° L", "0.0°"
    static func angle(_ degrees: Double) -> String {
        if abs(degrees) < 0.05 { return "0.0°" }
        return String(format: "%.1f° %@", abs(degrees), degrees > 0 ? "R" : "L")
    }

    private static func row(_ name: String, _ value: Measured?) -> NSAttributedString {
        let text = NSMutableAttributedString(string: name + "  ", attributes: [
            .font: UIFont.systemFont(ofSize: 20, weight: .medium),
            .foregroundColor: UIColor.white.withAlphaComponent(0.7)
        ])
        let shown = value.map { angle($0.value) } ?? "–"
        let faint = (value?.confidence ?? 0) < 0.5
        text.append(NSAttributedString(string: shown, attributes: [
            .font: UIFont.monospacedDigitSystemFont(ofSize: 40, weight: .semibold),
            .foregroundColor: faint ? UIColor.white.withAlphaComponent(0.5) : UIColor.white
        ]))
        return text
    }

    private static func describe(_ v: ValidationSummary) -> String {
        let what = v.kind == .faceAngle ? "Face" : "Start"
        return String(format: "Validating %@ %+.1f°: %d readings · bias %+.2f° · spread %.2f° · max %.2f°",
                      what, v.known, v.count, v.meanError, v.standardDeviation, v.maxAbsError)
    }

    private func strokeArrived(_ stroke: PuttingStroke) {
        strokes.append(stroke)
        onStroke?(stroke)
    }

    // MARK: - Controls

    @objc private func close() {
        dismiss(animated: true)
    }

    @objc private func aimDown() { changeAim(by: -0.5) }
    @objc private func aimUp() { changeAim(by: 0.5) }

    private func changeAim(by degrees: Double) {
        target.aimOffsetDegrees = (target.aimOffsetDegrees + degrees).clamped(to: -10...10)
        aimLabel.text = "Aim " + Self.angle(target.aimOffsetDegrees)
        let t = target
        session.perform { $0.setTarget(t) }
    }

    @objc private func recalibrate() {
        session.recalibrate()
    }

    @objc private func practiseWithTemplate() {
        session.perform { $0.startLive() }
    }

    @objc private func validate() {
        let sheet = UIAlertController(title: "Validation",
                                      message: "Measure against printed geometry. Face: set the putter on a line and hold it still; each hold is one reading. Start: roll balls along the calibration line.",
                                      preferredStyle: .actionSheet)
        for known in [0.0] + CalibrationTemplate.validationFaceAngles {
            let title = known == 0 ? "Face on the square line" : String(format: "Face on the %+.0f° line", known)
            sheet.addAction(UIAlertAction(title: title, style: .default) { [weak self] _ in
                self?.session.perform { $0.beginValidation(.faceAngle, known: known) }
            })
        }
        sheet.addAction(UIAlertAction(title: "Ball along the calibration line", style: .default) { [weak self] _ in
            self?.session.perform { $0.beginValidation(.startDirection, known: 0) }
        })
        sheet.addAction(UIAlertAction(title: "Finish validation", style: .destructive) { [weak self] _ in
            self?.session.perform { engine in
                guard let run = engine.endValidation() else { return }
                DispatchQueue.main.async { self?.validationFinished(run) }
            }
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = validateButton
        sheet.popoverPresentationController?.sourceRect = validateButton.bounds
        present(sheet, animated: true)
    }

    private func validationFinished(_ run: ValidationRun) {
        onValidation?(run)
        detailLabel.text = nil
        let alert = UIAlertController(title: "Validation result", message: Self.describe(run.summary), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    @objc private func showDebugLayers() {
        let picker = PuttingDebugLayersViewController(selected: debugLayers) { [weak self] layers in
            self?.debugLayers = layers
            self?.overlay.debugLayers = layers
        }
        let nav = UINavigationController(rootViewController: picker)
        if #available(iOS 15.0, *), let sheet = nav.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
        }
        present(nav, animated: true)
    }

    // MARK: - Layout

    private func buildInterface() {
        view.addSubview(preview)
        view.addSubview(overlay)

        func style(_ b: UIButton, _ title: String, _ action: Selector) {
            b.setTitle(title, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
            b.tintColor = .white
            b.backgroundColor = UIColor.black.withAlphaComponent(0.45)
            b.layer.cornerRadius = 10
            b.contentEdgeInsets = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
            b.addTarget(self, action: action, for: .touchUpInside)
        }
        style(closeButton, "Close", #selector(close))
        style(aimMinus, "−", #selector(aimDown))
        style(aimPlus, "+", #selector(aimUp))
        style(recalibrateButton, "Recalibrate", #selector(recalibrate))
        style(validateButton, "Validate", #selector(validate))
        style(debugButton, "Debug", #selector(showDebugLayers))
        style(practiseButton, "Practise with template down", #selector(practiseWithTemplate))
        practiseButton.isHidden = true

        for label in [modeLabel, aimLabel] {
            label.font = .systemFont(ofSize: 13, weight: .medium)
            label.textColor = .white
        }
        aimLabel.text = "Aim " + Self.angle(target.aimOffsetDegrees)

        promptLabel.font = .systemFont(ofSize: 22, weight: .semibold)
        promptLabel.textColor = .white
        promptLabel.numberOfLines = 0
        promptLabel.textAlignment = .center
        promptLabel.shadowColor = .black
        promptLabel.shadowOffset = CGSize(width: 0, height: 1)

        warningLabel.font = .systemFont(ofSize: 14, weight: .medium)
        warningLabel.textColor = .systemYellow
        warningLabel.numberOfLines = 0
        warningLabel.textAlignment = .center
        warningLabel.isHidden = true

        detailLabel.font = .systemFont(ofSize: 14, weight: .regular)
        detailLabel.textColor = UIColor.white.withAlphaComponent(0.85)
        detailLabel.numberOfLines = 0
        detailLabel.textAlignment = .center

        resultStack.axis = .vertical
        resultStack.alignment = .center
        resultStack.spacing = 2
        for row in [faceValue, pathValue, startValue] { resultStack.addArrangedSubview(row) }
        resultStack.isHidden = true

        let aimStack = UIStackView(arrangedSubviews: [aimMinus, aimLabel, aimPlus])
        aimStack.spacing = 6
        aimStack.alignment = .center
        let topBar = UIStackView(arrangedSubviews: [closeButton, modeLabel, UIView(), aimStack])
        topBar.spacing = 10
        topBar.alignment = .center

        let bottomBar = UIStackView(arrangedSubviews: [recalibrateButton, validateButton, debugButton])
        bottomBar.spacing = 10
        bottomBar.distribution = .fillEqually

        let centre = UIStackView(arrangedSubviews: [promptLabel, warningLabel, resultStack, detailLabel, practiseButton])
        centre.axis = .vertical
        centre.alignment = .center
        centre.spacing = 10

        let panel = UIView()
        panel.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        panel.layer.cornerRadius = 16

        for v in [topBar, panel, centre, bottomBar] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: guide.topAnchor, constant: 8),
            topBar.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 12),
            topBar.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -12),

            bottomBar.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -10),
            bottomBar.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 12),
            bottomBar.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -12),

            centre.bottomAnchor.constraint(equalTo: bottomBar.topAnchor, constant: -20),
            centre.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            centre.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),

            panel.topAnchor.constraint(equalTo: centre.topAnchor, constant: -12),
            panel.bottomAnchor.constraint(equalTo: centre.bottomAnchor, constant: 12),
            panel.leadingAnchor.constraint(equalTo: centre.leadingAnchor, constant: -12),
            panel.trailingAnchor.constraint(equalTo: centre.trailingAnchor, constant: 12)
        ])
    }
}

/// Switches for each debug overlay layer.
private final class PuttingDebugLayersViewController: UITableViewController {
    private var selected: Set<PuttingDebugLayer>
    private let onChange: (Set<PuttingDebugLayer>) -> Void

    init(selected: Set<PuttingDebugLayer>, onChange: @escaping (Set<PuttingDebugLayer>) -> Void) {
        self.selected = selected
        self.onChange = onChange
        super.init(style: .insetGrouped)
        title = "Debug overlay"
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(done))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func done() { dismiss(animated: true) }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        PuttingDebugLayer.allCases.count
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let layer = PuttingDebugLayer.allCases[indexPath.row]
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        cell.textLabel?.text = layer.rawValue
        let toggle = UISwitch()
        toggle.isOn = selected.contains(layer)
        toggle.tag = indexPath.row
        toggle.addTarget(self, action: #selector(toggled(_:)), for: .valueChanged)
        cell.accessoryView = toggle
        cell.selectionStyle = .none
        return cell
    }

    @objc private func toggled(_ sender: UISwitch) {
        let layer = PuttingDebugLayer.allCases[sender.tag]
        if sender.isOn { selected.insert(layer) } else { selected.remove(layer) }
        onChange(selected)
    }
}

private extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double { Swift.min(range.upperBound, Swift.max(range.lowerBound, self)) }
}
