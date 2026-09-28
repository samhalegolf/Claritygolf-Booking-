import Capacitor
import CoreLocation
import Foundation
import ProximityReader
import StripeTerminal

/// Tap to Pay on iPhone for Clarity Booking.
///
/// Deliberately thin. This plugin never decides an amount, never talks to
/// Clarity's API and never holds a Stripe key. The web page (the live Booking
/// site, loaded in this app's WebView with the coach's normal session) asks the
/// server for everything and hands the plugin only what the Terminal SDK needs:
///
///   - a connection token, whenever the SDK asks for one. The plugin raises a
///     `connectionTokenRequest` event; the page fetches
///     /api/billing/terminal/connection-token and answers with
///     `provideConnectionToken`. Tokens are never cached here.
///   - the Stripe Terminal location to connect at.
///   - the client secret of a PaymentIntent the server created and priced.
///
/// After a tap the plugin reports what the SDK said, and the page asks the
/// server what actually happened. The server's answer is the one that counts.
@objc(ClarityTerminalPlugin)
public class ClarityTerminalPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ClarityTerminalPlugin"
    public let jsName = "ClarityTerminal"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "collectPayment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "provideConnectionToken", returnType: CAPPluginReturnPromise)
    ]

    private let tokenBridge = TokenBridge()
    private let locationManager = CLLocationManager()
    private var discoverCancelable: Cancelable?
    private var collectCancelable: Cancelable?
    private var discoveryDelegate: DiscoveryRelay?
    private var connectedLocationId = ""

    /// The SDK can only be initialised once per process.
    private static var terminalInitialized = false

    override public func load() {
        tokenBridge.plugin = self
        if !Self.terminalInitialized {
            Terminal.initWithTokenProvider(tokenBridge)
            Self.terminalInitialized = true
        }
    }

    // MARK: - Support

    /// Can this iPhone take Tap to Pay at all? Says nothing about the business;
    /// the server answers that half (GET /api/billing/terminal/status).
    /// Apple's own answer is used rather than the SDK's, so this works before
    /// the SDK has connected to anything. Discovery still has the last word:
    /// `prepare` fails on a device Stripe will not accept.
    @objc func isSupported(_ call: CAPPluginCall) {
        if call.getBool("simulated") == true {
            call.resolve(["supported": true, "reason": ""])
            return
        }
        guard #available(iOS 16.0, *), PaymentCardReader.isSupported else {
            call.resolve(["supported": false, "reason": "This iPhone cannot take Tap to Pay."])
            return
        }
        call.resolve(["supported": true, "reason": ""])
    }

    // MARK: - Connecting

    /// Location permission, then discover and connect this iPhone's Tap to Pay
    /// reader at the given Stripe Terminal location. Safe to call again: an
    /// existing connection at the same location is kept.
    @objc func prepare(_ call: CAPPluginCall) {
        guard let locationId = call.getString("stripeLocationId"), !locationId.isEmpty else {
            call.reject("A Stripe Terminal location is required.", "LOCATION_REQUIRED")
            return
        }
        let simulated = call.getBool("simulated") ?? false

        if Terminal.shared.connectionStatus == .connected && connectedLocationId == locationId {
            call.resolve(["connected": true])
            return
        }

        DispatchQueue.main.async {
            switch self.locationManager.authorizationStatus {
            case .denied, .restricted:
                call.reject(
                    "Location access is off. Turn it on for Clarity Booking in Settings to take card payments.",
                    "LOCATION_DENIED"
                )
                return
            case .notDetermined:
                self.locationManager.requestWhenInUseAuthorization()
            default:
                break
            }
            self.connect(call, locationId: locationId, simulated: simulated)
        }
    }

    private func connect(_ call: CAPPluginCall, locationId: String, simulated: Bool) {
        let finish: () -> Void = {
            do {
                let config = try TapToPayDiscoveryConfigurationBuilder().setSimulated(simulated).build()
                let relay = DiscoveryRelay { [weak self] readers in
                    guard let self = self, let reader = readers.first else { return }
                    self.connectReader(reader, locationId: locationId, call: call)
                }
                self.discoveryDelegate = relay
                self.discoverCancelable = Terminal.shared.discoverReaders(config, delegate: relay) { error in
                    if let error = error, (error as NSError).code != ErrorCode.canceled.rawValue {
                        self.reject(call, error, fallbackCode: "DISCOVERY_FAILED")
                    }
                }
            } catch {
                self.reject(call, error, fallbackCode: "DISCOVERY_FAILED")
            }
        }
        if Terminal.shared.connectionStatus == .connected {
            // Connected somewhere else: move to this location.
            Terminal.shared.disconnectReader { _ in finish() }
        } else {
            finish()
        }
    }

    private func connectReader(_ reader: Reader, locationId: String, call: CAPPluginCall) {
        do {
            let config = try TapToPayConnectionConfigurationBuilder(delegate: self, locationId: locationId).build()
            Terminal.shared.connectReader(reader, connectionConfig: config) { [weak self] connected, error in
                guard let self = self else { return }
                if let error = error {
                    self.reject(call, error, fallbackCode: "CONNECT_FAILED")
                    return
                }
                self.connectedLocationId = locationId
                call.resolve(["connected": connected != nil])
            }
        } catch {
            reject(call, error, fallbackCode: "CONNECT_FAILED")
        }
    }

    // MARK: - Paying

    /// Collect a card for a PaymentIntent the server created, then confirm it.
    ///
    /// `stage` in the result tells the page how much it can trust a failure:
    /// a failure at "collect" means no card was charged and the tap can be
    /// offered again; anything at "confirm" may or may not have charged, and
    /// the page must ask the server before doing anything else.
    @objc func collectPayment(_ call: CAPPluginCall) {
        guard let clientSecret = call.getString("clientSecret"), !clientSecret.isEmpty else {
            call.reject("A payment to collect is required.", "PAYMENT_REQUIRED")
            return
        }
        Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret) { [weak self] intent, error in
            guard let self = self else { return }
            guard let intent = intent else {
                call.resolve(self.outcome("failed", stage: "retrieve", error: error))
                return
            }
            self.collectCancelable = Terminal.shared.collectPaymentMethod(intent) { collected, error in
                self.collectCancelable = nil
                guard let collected = collected else {
                    let cancelled = (error as NSError?)?.code == ErrorCode.canceled.rawValue
                    call.resolve(self.outcome(cancelled ? "cancelled" : "failed", stage: "collect", error: error))
                    return
                }
                Terminal.shared.confirmPaymentIntent(collected) { confirmed, confirmError in
                    if let confirmed = confirmed {
                        call.resolve([
                            "outcome": "confirmed",
                            "stage": "confirm",
                            "paymentIntentId": confirmed.stripeId ?? "",
                            "status": confirmed.status == .succeeded ? "succeeded" : "processing"
                        ])
                    } else {
                        call.resolve(self.outcome("failed", stage: "confirm", error: confirmError))
                    }
                }
            }
        }
    }

    /// Stop waiting for a card. Only works before a card is read; after that
    /// the payment runs to its end and the page reconciles.
    @objc func cancel(_ call: CAPPluginCall) {
        guard let cancelable = collectCancelable else {
            call.resolve(["cancelled": false])
            return
        }
        cancelable.cancel { error in
            call.resolve(["cancelled": error == nil])
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        discoverCancelable?.cancel { _ in }
        guard Terminal.shared.connectionStatus == .connected else {
            call.resolve()
            return
        }
        Terminal.shared.disconnectReader { _ in
            self.connectedLocationId = ""
            call.resolve()
        }
    }

    // MARK: - Connection tokens

    /// The page's answer to a `connectionTokenRequest` event.
    @objc func provideConnectionToken(_ call: CAPPluginCall) {
        tokenBridge.answer(
            requestId: call.getString("requestId") ?? "",
            secret: call.getString("secret"),
            message: call.getString("error")
        )
        call.resolve()
    }

    func requestConnectionToken(requestId: String) {
        notifyListeners("connectionTokenRequest", data: ["requestId": requestId])
    }

    // MARK: - Helpers

    private func outcome(_ outcome: String, stage: String, error: Error?) -> [String: Any] {
        let nsError = error as NSError?
        var result: [String: Any] = [
            "outcome": outcome,
            "stage": stage,
            "message": error?.localizedDescription ?? "",
            "code": nsError.map { String($0.code) } ?? ""
        ]
        if let confirmError = error as? ConfirmPaymentIntentError {
            result["declineCode"] = confirmError.declineCode ?? ""
            result["paymentIntentId"] = confirmError.paymentIntent?.stripeId ?? ""
        }
        return result
    }

    /// The SDK's own message is already written for a person (missing
    /// entitlement, unsupported device, Apple terms not accepted, location
    /// off), so it is passed through as is, with Stripe's numeric code for logs.
    private func reject(_ call: CAPPluginCall, _ error: Error, fallbackCode: String) {
        call.reject(error.localizedDescription, fallbackCode, error, ["sdkCode": (error as NSError).code])
    }
}

// MARK: - Reader events

extension ClarityTerminalPlugin: TapToPayReaderDelegate {
    public func tapToPayReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
        notifyListeners("readerUpdate", data: ["state": "started", "progress": 0])
    }

    public func tapToPayReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
        notifyListeners("readerUpdate", data: ["state": "progress", "progress": progress])
    }

    public func tapToPayReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
        notifyListeners("readerUpdate", data: ["state": "finished", "progress": 1])
    }

    public func tapToPayReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions = []) {
        notifyListeners("readerMessage", data: ["message": Terminal.stringFromReaderInputOptions(inputOptions)])
    }

    public func tapToPayReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
        notifyListeners("readerMessage", data: ["message": Terminal.stringFromReaderDisplayMessage(displayMessage)])
    }

    public func reader(_ reader: Reader, didDisconnect reason: DisconnectReason) {
        connectedLocationId = ""
        notifyListeners("disconnected", data: [:])
    }
}

/// Holds the discovery delegate strongly, as the SDK requires.
private final class DiscoveryRelay: NSObject, DiscoveryDelegate {
    private let onReaders: ([Reader]) -> Void
    private var handled = false

    init(onReaders: @escaping ([Reader]) -> Void) {
        self.onReaders = onReaders
    }

    func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
        guard !handled, !readers.isEmpty else { return }
        handled = true
        onReaders(readers)
    }
}

/// The SDK's ConnectionTokenProvider, answered by the page.
///
/// The SDK asks whenever it needs a token (connecting, reconnecting, after one
/// expires). Each ask becomes an event with its own id; the page fetches a
/// fresh token from Clarity's server and answers that id.
private final class TokenBridge: NSObject, ConnectionTokenProvider {
    weak var plugin: ClarityTerminalPlugin?
    private var pending: [String: ConnectionTokenCompletionBlock] = [:]
    private let lock = NSLock()

    func fetchConnectionToken(_ completion: @escaping ConnectionTokenCompletionBlock) {
        let requestId = UUID().uuidString
        lock.lock()
        pending[requestId] = completion
        lock.unlock()
        guard let plugin = plugin else {
            answer(requestId: requestId, secret: nil, message: "Tap to Pay is not ready.")
            return
        }
        plugin.requestConnectionToken(requestId: requestId)
        // Never leave the SDK waiting forever on a page that went away.
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.answer(requestId: requestId, secret: nil, message: "Timed out getting permission from Clarity.")
        }
    }

    func answer(requestId: String, secret: String?, message: String?) {
        lock.lock()
        let completion = pending.removeValue(forKey: requestId)
        lock.unlock()
        guard let completion = completion else { return }
        if let secret = secret, !secret.isEmpty {
            completion(secret, nil)
        } else {
            completion(nil, NSError(
                domain: "app.claritygolf.terminal",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: message ?? "Clarity did not provide a connection token."]
            ))
        }
    }
}
