import Foundation
import WebKit
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A main-frame-only bridge, with ordered chunk acknowledgements and no URL fetching.
public final class NativeVideoShareBridge: NSObject, WKScriptMessageHandlerWithReply {
    public static let handlerName = "clarityVideoShare"
    private weak var webView: WKWebView?
    private var session: Session?
    private let io = DispatchQueue(label: "app.claritygolf.video-share", qos: .userInitiated)
    #if !os(macOS)
    public weak var presentingViewController: UIViewController?
    #endif

    private final class Session {
        let id: String
        let file: ShareFile
        let type: UTType
        var requested = false
        var timeout: DispatchWorkItem?
        #if os(macOS)
        var picker: NSSharingServicePicker?
        var selectedService: NSSharingService?
        #else
        var controller: UIActivityViewController?
        #endif
        init(id: String, file: ShareFile, type: UTType) { self.id = id; self.file = file; self.type = type }
    }

    public func install(in webView: WKWebView) {
        self.webView = webView
        let controller = webView.configuration.userContentController
        controller.addScriptMessageHandler(self, contentWorld: .page, name: Self.handlerName)
        let script = """
        (() => {
          const allowed = (location.protocol === 'https:' && location.hostname === 'claritygolf.app') ||
            (location.protocol === 'capacitor:' && location.hostname === 'localhost');
          if (allowed && window === window.top && !window.__clarityVideoShare) {
            Object.defineProperty(window, '__clarityVideoShare', { value: {
              version: 1, post: message => window.webkit.messageHandlers.clarityVideoShare.postMessage(message)
            }});
          }
        })();
        """
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Capacitor may already have loaded its initial document.
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    public func cancelAll() {
        if let session { end(session, type: "cancelled") }
    }

    public func userContentController(_ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              (origin.protocol == "https" && origin.host == "claritygolf.app") ||
              (origin.protocol == "capacitor" && origin.host == "localhost"),
              let body = message.body as? [String: Any], let action = body["action"] as? String,
              let id = body["id"] as? String, UUID(uuidString: id) != nil else {
            replyHandler(nil, "Share bridge rejected this request."); return
        }
        if action == "present" {
            guard session == nil else { replyHandler(nil, "A share is already open."); return }
            do {
                guard let name = body["name"] as? String, name.count <= 200,
                      let ext = name.split(separator: ".").last?.lowercased(),
                      ["mp4", "mov", "m4v", "webm"].contains(ext),
                      let type = UTType(filenameExtension: ext), type.conforms(to: .movie) else {
                    throw ShareFile.error("A share is already open or the video type is unsupported.")
                }
                let current = Session(id: id, file: try ShareFile(name: name), type: type)
                session = current
                try present(current)
                let timeout = DispatchWorkItem { [weak self, weak current] in
                    guard let self, let current else { return }
                    self.end(current, type: "error", error: "Video sharing timed out.")
                }
                current.timeout = timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + 900, execute: timeout)
                replyHandler(true, nil)
            } catch {
                if let session { end(session, type: "error", error: error.localizedDescription) }
                replyHandler(nil, error.localizedDescription)
            }
            return
        }
        guard let current = session, current.id == id else { replyHandler(nil, "Share session is no longer active."); return }
        switch action {
        case "chunk":
            guard current.requested, let offset = body["offset"] as? Int,
                  let encoded = body["data"] as? String, encoded.count <= 700_000,
                  let data = Data(base64Encoded: encoded) else { replyHandler(nil, "Invalid video chunk."); return }
            io.async {
                do { try current.file.append(data, offset: offset); DispatchQueue.main.async { replyHandler(true, nil) } }
                catch { DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) } }
            }
        case "finish":
            guard current.requested, let size = body["size"] as? Int else { replyHandler(nil, "Missing video size."); return }
            io.async {
                do {
                    try current.file.finish(size: size)
                    DispatchQueue.main.async { replyHandler(true, nil) }
                } catch { DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) } }
            }
        case "cancel":
            end(current, type: "cancelled")
            replyHandler(true, nil)
        case "fail":
            end(current, type: "error", error: String((body["message"] as? String ?? "Could not prepare video.").prefix(500)))
            replyHandler(true, nil)
        default: replyHandler(nil, "Unknown share action.")
        }
    }

    private func emit(_ current: Session, type: String, error: String? = nil) {
        guard let webView else { return }
        var detail = ["id": current.id, "type": type]
        if let error { detail["message"] = error }
        webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('clarity-video-share', {detail}));",
            arguments: ["detail": detail], in: nil, contentWorld: .page, completionHandler: nil)
    }

    private func request(_ current: Session) {
        guard session === current, !current.requested else { return }
        current.requested = true
        emit(current, type: "prepare")
    }

    private func end(_ current: Session, type: String, error: String? = nil) {
        guard session === current else { return }
        current.timeout?.cancel()
        if type != "complete" { current.file.abort(ShareFile.error(error ?? "Sharing cancelled.")) }
        emit(current, type: type, error: error)
        #if !os(macOS)
        if type != "complete" { current.controller?.dismiss(animated: true) }
        #endif
        session = nil
        // A receiving extension may still be copying after the share callback.
        let file = current.file
        io.asyncAfter(deadline: .now() + (type == "complete" ? 300 : 0)) { file.remove() }
    }

    private func present(_ current: Session) throws {
        guard let webView, webView.window != nil else { throw ShareFile.error("The sharing window is unavailable.") }
        #if os(macOS)
        let provider = NSItemProvider()
        provider.suggestedName = current.file.url.lastPathComponent
        provider.registerFileRepresentation(forTypeIdentifier: current.type.identifier, fileOptions: [], visibility: .all) { completion in
            let progress = Progress(totalUnitCount: 1)
            DispatchQueue.global(qos: .userInitiated).async {
                do { let url = try current.file.wait(); progress.completedUnitCount = 1; completion(url, false, nil) }
                catch { completion(nil, false, error) }
            }
            return progress
        }
        let picker = NSSharingServicePicker(items: [provider])
        current.picker = picker
        picker.delegate = self
        picker.show(relativeTo: NSRect(x: webView.bounds.maxX - 60, y: webView.bounds.maxY - 60, width: 24, height: 24),
                    of: webView, preferredEdge: .minX)
        #else
        guard let presenter = presentingViewController, presenter.presentedViewController == nil else {
            throw ShareFile.error("Close the current panel before sharing.")
        }
        let provider = DeferredVideoItem(placeholderItem: current.file.url)
        provider.produce = { [weak self, weak current] in
            guard let current else { return NSNull() }
            DispatchQueue.main.async { self?.request(current) }
            do { return try current.file.wait() } catch { return NSNull() }
        }
        let controller = UIActivityViewController(activityItems: [provider], applicationActivities: nil)
        current.controller = controller
        controller.completionWithItemsHandler = { [weak self, weak current] _, completed, _, error in
            guard let self, let current else { return }
            self.end(current, type: error != nil ? "error" : completed ? "complete" : "cancelled", error: error?.localizedDescription)
        }
        if let popover = controller.popoverPresentationController {
            popover.sourceView = webView
            popover.sourceRect = CGRect(x: webView.bounds.maxX - 60, y: 50, width: 24, height: 24)
        }
        presenter.present(controller, animated: true)
        #endif
    }
}

#if os(macOS)
extension NativeVideoShareBridge: NSSharingServicePickerDelegate, NSSharingServiceDelegate {
    public func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker, didChoose service: NSSharingService?) {
        guard let current = session, current.picker === sharingServicePicker else { return }
        if let service { current.selectedService = service; request(current) } else { end(current, type: "cancelled") }
    }
    public func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker, delegateFor sharingService: NSSharingService) -> NSSharingServiceDelegate? { self }
    public func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
        if let session, session.selectedService === sharingService { end(session, type: "complete") }
    }
    public func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) {
        if let session, session.selectedService === sharingService { end(session, type: "error", error: error.localizedDescription) }
    }
}
#else
private final class DeferredVideoItem: UIActivityItemProvider, @unchecked Sendable {
    var produce: (() -> Any)?
    override var item: Any {
        // Preview/type inspection must never start encoding.
        guard activityType != nil else { return placeholderItem }
        return produce?() ?? NSNull()
    }
}
#endif
