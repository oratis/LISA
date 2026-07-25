//
//  AccountWindow.swift
//  Lisa
//
//  "Sign in to LISA Cloud" (PLAN_ACCOUNTS_BILLING B8d; PLAN_AUTH_OTP_GOOGLE A2):
//  by default a one-time code is mailed to the address — which also creates the
//  account if it's new — with the password field kept for accounts that have one.
//  On success the account session is written to ~/.lisa/config.env
//  (LISA_MANAGED_SESSION/_BASE) and the local backend runs KEY-FREE — its LLM
//  calls route through the LISA inference gateway, metered against the account's
//  allowance. BYO keys in config.env always win; signing out simply clears the
//  session. The backend reads config.env at start, so apply = restart (offered
//  in-window).
//

import AppKit

final class AccountWindowController: NSWindowController {
    static let shared = AccountWindowController()

    private let baseField = NSTextField(string: "")
    private let emailField = NSTextField(string: "")
    private let codeField = NSTextField(string: "")
    private let passwordField = NSSecureTextField(string: "")
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private lazy var sendCodeButton = NSButton(title: "Email me a code", target: self, action: #selector(sendCode))
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
        codeField.placeholderString = "6-digit code from your inbox"
        passwordField.placeholderString = "Password (only if your account has one)"
        statusLabel.font = .systemFont(ofSize: 12)

        sendCodeButton.bezelStyle = .rounded
        signInButton.bezelStyle = .rounded
        signInButton.keyEquivalent = "\r"
        signOutButton.bezelStyle = .rounded
        restartButton.bezelStyle = .rounded
        restartButton.isHidden = true

        let buttonRow = NSStackView(views: [sendCodeButton, signInButton, signOutButton, restartButton])
        buttonRow.spacing = 8

        let stack = NSStackView(views: [title, blurb, baseField, emailField, codeField, passwordField, buttonRow, statusLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 36, left: 24, bottom: 24, right: 24)
        for f in [baseField, emailField, codeField, passwordField] {
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

    private var trimmedBase: String {
        baseField.stringValue.trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    /// POST JSON to an auth endpoint and hand the parsed body (or a reason) back
    /// on the main queue.
    private func postAuth(
        path: String,
        payload: [String: String],
        completion: @escaping (_ body: [String: Any]?, _ reason: String) -> Void,
    ) {
        guard let url = URL(string: "\(trimmedBase)\(path)") else {
            completion(nil, "that cloud URL doesn't look right")
            return
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? nil
            DispatchQueue.main.async {
                if status == 200 {
                    completion(obj, "")
                } else {
                    var reason = Self.hint(status: status, error: obj?["error"] as? String ?? "")
                    // A named typo is one edit from fixed — say what to fix.
                    if let fix = obj?["suggestion"] as? String { reason += " — did you mean @\(fix)?" }
                    completion(nil, reason)
                }
            }
        }.resume()
    }

    private static func hint(status: Int, error: String) -> String {
        switch error {
        case "otp_cooldown": return "a code just went out — check your inbox"
        case "otp_daily_cap": return "too many codes for this address today"
        case "bad_code": return "that code isn't right"
        case "expired": return "that code expired — send another"
        case "no_pending": return "no code outstanding — send one first"
        case "too_many_attempts": return "too many wrong codes — send a fresh one"
        case "bad_credentials": return "wrong email or password"
        case "invalid_email": return "that doesn't look like an email address"
        case "email_typo": return "that address looks misspelled"
        case "undeliverable_email": return "that domain doesn't seem to accept mail"
        case "rate_limited", "throttled": return "too many attempts — wait a while"
        default:
            return status == 404 ? "this instance doesn't offer accounts"
                : status == -1 ? "couldn't reach the server" : "HTTP \(status)"
        }
    }

    @objc private func sendCode() {
        let email = emailField.stringValue.trimmingCharacters(in: .whitespaces)
        guard !email.isEmpty else {
            setStatus("Enter your email address first.", error: true)
            return
        }
        sendCodeButton.isEnabled = false
        setStatus("Sending a code…", error: false)
        postAuth(path: "/api/auth/otp/request", payload: ["email": email]) { [weak self] body, reason in
            guard let self else { return }
            self.sendCodeButton.isEnabled = true
            guard let body else {
                self.setStatus("Couldn't send a code (\(reason)).", error: true)
                return
            }
            if body["sent"] as? Bool == false {
                self.setStatus("This instance couldn't send the mail — use a password instead.", error: true)
                return
            }
            self.codeField.stringValue = ""
            self.window?.makeFirstResponder(self.codeField)
            self.setStatus("A 6-digit code is on its way to \(email). It expires in 10 minutes.", error: false)
        }
    }

    /// Signs in with whichever credential is filled: the mailed code first (it
    /// also registers a new address), else the password.
    @objc private func signIn() {
        let email = emailField.stringValue.trimmingCharacters(in: .whitespaces)
        let code = codeField.stringValue.trimmingCharacters(in: .whitespaces)
        let password = passwordField.stringValue
        guard !email.isEmpty, !code.isEmpty || !password.isEmpty else {
            setStatus("Enter your email, then the code we mail you (or your password).", error: true)
            return
        }
        let usingCode = !code.isEmpty
        let path = usingCode ? "/api/auth/otp/verify" : "/api/auth/login"
        let payload = usingCode
            ? ["email": email, "code": code]
            : ["email": email, "password": password]
        signInButton.isEnabled = false
        setStatus("Signing in…", error: false)
        let base = trimmedBase
        postAuth(path: path, payload: payload) { [weak self] body, reason in
            guard let self else { return }
            self.signInButton.isEnabled = true
            guard let token = body?["token"] as? String, !token.isEmpty else {
                self.setStatus("Sign-in failed (\(reason.isEmpty ? "unexpected server response" : reason)).", error: true)
                return
            }
            BackendController.shared.upsertConfigEnv("LISA_MANAGED_SESSION", value: token)
            BackendController.shared.upsertConfigEnv("LISA_MANAGED_BASE", value: base)
            self.passwordField.stringValue = ""
            self.codeField.stringValue = ""
            self.refreshState()
            self.setStatus("Signed in. Restart the backend so it picks up the session.", error: false)
            self.restartButton.isHidden = false
        }
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
