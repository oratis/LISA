import AppKit
import Foundation

@MainActor
final class RemoteDevicesWindow: NSWindowController {
    static let shared = RemoteDevicesWindow()
    private let stack = NSStackView()
    private var refreshTask: Task<Void, Never>?
    private var message = ""

    private convenience init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 500),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Connect iPhone"
        window.isReleasedWhenClosed = false
        self.init(window: window)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = stack
        window.contentView = scroll
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.widthAnchor.constraint(equalTo: scroll.widthAnchor).isActive = true
        window.center()
    }
    func show() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.window?.isVisible == true else { return }
                await self.refresh()
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
    }
    static func request(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:5757/api/remote/\(path)")!, timeoutInterval: 15)
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "LISARemote", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "Couldn't update the connection. Check that the backend is up to date and you're signed in."])
        }
        return result
    }
    private func label(_ text: String, bold: Bool = false) {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = bold ? .boldSystemFont(ofSize: 15) : .systemFont(ofSize: 13)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
        stack.addArrangedSubview(field)
    }
    private func button(_ title: String, action: Selector, value: String? = nil) {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.identifier = value.map { NSUserInterfaceItemIdentifier(rawValue: $0) }
        stack.addArrangedSubview(button)
    }
    private func refresh() async {
        let status: [String: Any]
        do { status = try await Self.request("status") }
        catch { status = [:]; message = error.localizedDescription }
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        label("Your Mac, wherever you are", bold: true)
        label("Sign in to the same LISA account in Pocket. On your phone, open Settings → Connect your Mac. Connections are encrypted between your devices.")
        let enabled = status["enabled"] as? Bool == true
        let online = status["online"] as? Bool == true
        label(online ? "Online · ready for Lisa Pocket" : enabled ? "Reconnecting to LISA Cloud…" : "Phone connections are off.")
        if !message.isEmpty { label(message) }
        let signedIn = !(BackendController.shared.configEnvValue("LISA_MANAGED_SESSION") ?? "").isEmpty
        if signedIn {
            button(enabled ? "Reconnect" : "Enable phone connections", action: #selector(connect))
            if enabled { button("Turn off phone connections", action: #selector(disconnect)) }
        } else { button("Sign in to LISA", action: #selector(signIn)) }
        if enabled {
            let strict = NSButton(checkboxWithTitle: "Require secure pairing (refuse older Lisa Pocket versions)",
                                  target: self, action: #selector(toggleSecurePairing(_:)))
            strict.state = status["requireSecurePairing"] as? Bool == true ? .on : .off
            stack.addArrangedSubview(strict)
        }
        // Never suggest turning strict mode off here: the "older" phone may be a relay
        // that stripped the secure-pairing fields.
        if let refused = status["legacyRefused"] as? [String: Any] {
            label("A pairing request from \(refused["name"] as? String ?? "an iPhone") used the older pairing method, which this Mac refuses. If that iPhone runs Lisa Pocket 1.3 or earlier, update it and try again.")
        }
        for pending in status["pending"] as? [[String: Any]] ?? [] {
            guard let id = pending["id"] as? String, let code = pending["code"] as? String else { continue }
            let name = pending["name"] as? String ?? "iPhone"
            if code.isEmpty {
                // Holds one of ten request slots; anyone on the relay can open one.
                label("\(name): pairing request waiting for its code", bold: true)
                label("If you aren't pairing Lisa Pocket right now, clear it.")
                button("Clear request", action: #selector(dismiss(_:)), value: id)
                continue
            }
            // `secure` describes this Mac's side only: pairing v2 (a committed code).
            let secure = pending["secure"] as? Bool == true
            let known = pending["known"] as? Bool == true
            label(known ? "\(name) is pairing with this Mac again" : "\(name) wants to connect", bold: true)
            label("Compare with the code on your phone: \(code)")
            if secure {
                label("This Mac is using secure pairing. If your phone warns about an older pairing method, dismiss this request.")
            } else {
                label("⚠︎ Older pairing method: this request arrived as Lisa Pocket 1.3 or earlier, so a compromised relay could fake its code. Update Lisa Pocket, then pair again.")
            }
            button(known ? "Codes match" : "Allow this device", action: #selector(approve(_:)),
                   value: "\(secure ? "v2" : "v1")|\(id)|\(code)")
            if known { button("Disconnect \(name)", action: #selector(revoke(_:)), value: id) }
            else { button("Dismiss request", action: #selector(dismiss(_:)), value: id) }
        }
        let devices = status["devices"] as? [[String: Any]] ?? []
        if !devices.isEmpty { label("Authorized devices", bold: true) }
        for device in devices {
            guard let id = device["id"] as? String else { continue }
            let older = device["secure"] as? Bool != true
            button("Disconnect \(device["name"] as? String ?? "iPhone")\(older ? " (older pairing)" : "")",
                   action: #selector(revoke(_:)), value: id)
        }
        label("Keep this Mac awake and LISA running. Pocket uses your local network when available and cloud relay when you're away.")
        button("Legacy QR pairing…", action: #selector(legacy))
    }
    private func perform(_ path: String, body: [String: Any]) {
        Task {
            do { _ = try await Self.request(path, body: body); message = "" }
            catch { message = error.localizedDescription }
            await refresh()
        }
    }
    @objc private func connect() {
        perform("connect", body: [
            "base": BackendController.shared.configEnvValue("LISA_MANAGED_BASE") ?? "https://cloud.meetlisa.ai",
            "session": BackendController.shared.configEnvValue("LISA_MANAGED_SESSION") ?? "",
        ])
    }
    @objc private func disconnect() { perform("disconnect", body: [:]) }
    @objc private func approve(_ sender: NSButton) {
        let parts = (sender.identifier?.rawValue ?? "").split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count == 3 else { return }
        let alert = NSAlert()
        alert.messageText = "Does your phone show \(parts[2])?"
        alert.informativeText = "Only allow it if the codes match. This device can access this Mac's LISA and its permitted remote controls."
            + (parts[0] == "v2" ? "" : "\n\nThis request uses the older pairing method: a compromised relay could make the codes match. Prefer updating Lisa Pocket first.")
        if parts[0] != "v2" { alert.alertStyle = .warning }
        alert.addButton(withTitle: "Codes match — allow"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        perform("approve", body: ["id": parts[1], "code": parts[2]])
    }
    @objc private func toggleSecurePairing(_ sender: NSButton) {
        perform("policy", body: ["requireSecurePairing": sender.state == .on])
    }
    @objc private func dismiss(_ sender: NSButton) { perform("dismiss", body: ["id": sender.identifier?.rawValue ?? ""]) }
    @objc private func revoke(_ sender: NSButton) { perform("revoke", body: ["id": sender.identifier?.rawValue ?? ""]) }
    @objc private func signIn() { AccountWindowController.shared.show() }
    @objc private func legacy() { PairController.shared.showPairing() }
}
