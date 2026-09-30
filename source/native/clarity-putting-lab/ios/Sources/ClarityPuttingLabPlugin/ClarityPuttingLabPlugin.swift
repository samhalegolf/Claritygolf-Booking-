import AVFoundation
import Capacitor
import Foundation
import PuttingLabCore

/// Clarity Putting Lab for the Clarity Booking staff app.
///
/// The page opens the lab; everything live (camera, tracking, the gate
/// screen) is native, because it has to keep up with 120-240 frames a second.
/// The page hears back only what it may want to keep: each measured putt, and
/// the session when it closes. Nothing here talks to Clarity's server or
/// stores anything; saving putts to a player is the page's job, later.
@objc(ClarityPuttingLabPlugin)
public class ClarityPuttingLabPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ClarityPuttingLabPlugin"
    public let jsName = "ClarityPuttingLab"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private weak var controller: PuttingLabViewController?

    /// Does this device have a back camera, and how fast can it go?
    @objc func isSupported(_ call: CAPPluginCall) {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let best = PuttingCameraSession.bestFormat(for: device) else {
            call.resolve(["supported": false, "maxFrameRate": 0, "reason": "This device has no usable back camera."])
            return
        }
        call.resolve(["supported": true, "maxFrameRate": best.fps, "reason": ""])
    }

    /// Open the lab full screen.
    ///
    /// Options: `aimDegrees` (virtual aim, positive = right), `handedness`
    /// ("right" | "left"), `gates` ([{ distance, width }] in mm), `debug` (bool).
    @objc func open(_ call: CAPPluginCall) {
        var configuration = PuttingLabConfiguration()
        configuration.handedness = call.getString("handedness") == "left" ? .left : .right
        configuration.target.aimOffsetDegrees = call.getDouble("aimDegrees") ?? 0
        configuration.target.gates = (call.getArray("gates") ?? []).compactMap { value -> PracticeGate? in
            guard let gate = value as? JSObject,
                  let distance = (gate["distance"] as? NSNumber)?.doubleValue,
                  let width = (gate["width"] as? NSNumber)?.doubleValue, distance > 0, width > 0 else { return nil }
            return PracticeGate(distance: distance, width: width)
        }
        var options = PuttingLabViewController.Options(configuration: configuration)
        if call.getBool("debug") == true {
            options.debugLayers = [.calibrationPoints, .ballCentre, .putterCentre, .putterMarkers, .featurePoints,
                                   .edgePoints, .confidence, .timing, .impactTime]
        }

        DispatchQueue.main.async {
            guard self.controller == nil else {
                call.reject("The Putting Lab is already open.", "ALREADY_OPEN")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("Nothing to present the Putting Lab from.", "NO_VIEW")
                return
            }
            let lab = PuttingLabViewController(options: options)
            lab.onStroke = { [weak self] stroke in
                self?.notifyListeners("strokeMeasured", data: ["stroke": Self.json(stroke)])
            }
            lab.onPhase = { [weak self] phase in
                self?.notifyListeners("phaseChanged", data: ["phase": phase.rawValue])
            }
            lab.onValidation = { [weak self] run in
                self?.notifyListeners("validationFinished", data: ["run": Self.json(run), "summary": Self.json(run.summary)])
            }
            lab.onClose = { [weak self] strokes in
                self?.notifyListeners("closed", data: [
                    "strokes": strokes.map { Self.json($0) },
                    "consistency": Self.json(PuttingConsistency(strokes: strokes))
                ])
            }
            self.controller = lab
            presenter.present(lab, animated: true) {
                call.resolve(["opened": true])
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let lab = self.controller else {
                call.resolve(["closed": false])
                return
            }
            // From the presenter, so a sheet or alert open over the lab closes with it.
            let presenter = lab.presentingViewController ?? lab
            presenter.dismiss(animated: true) {
                call.resolve(["closed": true])
            }
        }
    }

    /// Codable -> bridge-safe dictionary.
    static func json<T: Encodable>(_ value: T) -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.nonConformingFloatEncodingStrategy = .convertToString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
        guard let data = try? encoder.encode(value),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }
}
