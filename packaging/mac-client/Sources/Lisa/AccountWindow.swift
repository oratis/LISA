//
//  AccountWindow.swift
//  Lisa
//
//  "Sign in to LISA Cloud" (PLAN_ACCOUNTS_BILLING B8d): email+password against
//  the hosted cloud; on success the account session is written to
//  ~/.lisa/config.env (LISA_MANAGED_SESSION/_BASE) and the local backend runs
//  KEY-FREE — its LLM calls route through the LISA inference gateway, metered
//  against the account's allowance. BYO keys in config.env always win; signing
//  out simply clears the session. The backend reads config.env at start, so
//  apply = restart (offered in-window).
//

import AppKit

final class AccountWindowController: NSWindowController {
    static let shared = AccountWindowController()

    private let baseField = NSTextField(string: "")
    private let emailField = NSTextField(string: "")
    private let passwordField = NSSecureTextField(string: "")
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private lazy var signInButton = NSButton(title: "Sign in", target: self, action: #selector(signIn))
    private lazy var signOutButton = NSButton(title: "Sign out", target: self, action: #selector(signOut))
    private lazy var restartButton = NSButton(title: "Restart backend to apply", target: self, action: #selector(restartBackend))

    private convenience init() {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 320),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        win.titleVisibility = .hidden
        win.titlebarAppearsTransparent = true
        win.isMovableByWindowBackground = true
        win.isReleasedWhenClosed = false
        self.init(window: win)
        win.contentView = buildContent()
        win.center()
    }

    func show() {
        refreshState()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildContent() -> NSView {
        let title = NSTextField(labelWithString: "LISA Cloud account")
        title.font = .boldSystemFont(ofSize: 16)
        let blurb = NSTextField(wrappingLabelWithString:
            "Sign in and this Mac runs key-free: models without your own API key route " +
            "through LISA Cloud, using your account's daily allowance and credits. " +
            "Your soul and data stay on this Mac.")
        blurb.font = .systemFont(ofSize: 12)
        blurb.textColor = .secondaryLabelColor

        baseField.placeholderString = "https://cloud.meetlisa.ai"
        emailField.placeholderString = "Email"
        passwordField.placeholderString = "Password"
        statusLabel.font = .systemFont(ofSize: 12)

        signInButton.bezelStyle = .rounded
        signInButton.keyEquivalent = "\r"
        signOutButton.bezelStyle = .rounded
        restartButton.bezelStyle = .rounded
        restartButton.isHidden = true

        let buttonRow = NSStackView(views: [signInButton, signOutButton, restartButton])
        buttonRow.spacing = 8

        let stack = NSStackView(views: [title, blurb, baseField, emailField, passwordField, buttonRow, statusLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 36, left: 24, bottom: 24, right: 24)
        for f in [baseField, emailField, passwordField] {
            f.translatesAutoresizingMaskIntoConstraints = false
            f.widthAnchor.constraint(equalToConstant: 352).isActive = true
        }
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.widthAnchor.constraint(equalToConstant: 352).isActive = true
        return stack
    }

    private func refreshState() {
        let base = BackendController.shared.configEnvValue("LISA_MANAGED_BASE") ?? ""
        baseField.stringValue = base.isEmpty ? "https://cloud.meetlisa.ai" : base
        let signedIn = !(BackendController.shared.configEnvValue("LISA_MANAGED_SESSION") ?? "").isEmpty
        signOutButton.isHidden = !signedIn
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = signedIn
            ? "Signed in — managed inference is on. BYO API keys in config.env still take priority."
            : ""
    }

    @objc private func signIn() {
        let base = baseField.stringValue.trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let email = emailField.stringValue.trimmingCharacters(in: .whitespaces)
        let password = passwordField.stringValue
        guard let url = URL(string: "\(base)/api/auth/login"), !email.isEmpty, !password.isEmpty else {
            setStatus("Enter the cloud URL, email, and password.", error: true)
            return
        }
        signInButton.isEnabled = false
        setStatus("Signing in…", error: false)
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.signInButton.isEnabled = true
                let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                guard code == 200, let data,
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let token = obj["token"] as? String, !token.isEmpty else {
                    let hint = code == 401 ? "wrong email or password"
                        : code == 429 ? "too many attempts — wait 15 minutes"
                        : code == 404 ? "this instance doesn't offer accounts"
                        : code == -1 ? "couldn't reach the server" : "HTTP \(code)"
                    self.setStatus("Sign-in failed (\(hint)).", error: true)
                    return
                }
                BackendController.shared.upsertConfigEnv("LISA_MANAGED_SESSION", value: token)
                BackendController.shared.upsertConfigEnv("LISA_MANAGED_BASE", value: base)
                self.passwordField.stringValue = ""
                self.refreshState()
                self.setStatus("Signed in. Restart the backend so it picks up the session.", error: false)
                self.restartButton.isHidden = false
            }
        }.resume()
    }

    @objc private func signOut() {
        BackendController.shared.upsertConfigEnv("LISA_MANAGED_SESSION", value: "")
        refreshState()
        setStatus("Signed out. Restart the backend to apply.", error: false)
        restartButton.isHidden = false
    }

    @objc private func restartBackend() {
        restartButton.isEnabled = false
        setStatus("Restarting the backend…", error: false)
        BackendController.shared.restart { [weak self] up in
            guard let self else { return }
            self.restartButton.isEnabled = true
            self.restartButton.isHidden = up
            self.setStatus(up ? "Backend restarted — you're all set." : "Backend didn't come back — check ~/.lisa/backend.log.",
                           error: !up)
        }
    }

    private func setStatus(_ text: String, error: Bool) {
        statusLabel.stringValue = text
        statusLabel.textColor = error ? .systemRed : .secondaryLabelColor
    }
}
