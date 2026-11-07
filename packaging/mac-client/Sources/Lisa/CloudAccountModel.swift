import AppKit
import Foundation
import LisaSetup

private final class CloudRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum CloudHTTP {
    private static let session = URLSession(configuration: .ephemeral, delegate: CloudRedirectPolicy(), delegateQueue: nil)
    static func json(_ url: URL, token: String? = nil, body: [String: Any]? = nil) async throws -> (Int, [String: Any]) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return (status, result)
    }
    static func message(status: Int, error: String) -> String {
        switch error {
        case "otp_cooldown": return "A code was just sent. Check your inbox, including spam."
        case "otp_daily_cap": return "You've requested the daily limit of codes. Try again tomorrow or use your password."
        case "bad_code": return "That code doesn't match. Check the six digits and try again."
        case "expired": return "This code has expired. Request a new code below."
        case "no_pending": return "Request a new code, then enter it here."
        case "too_many_attempts": return "Too many attempts. Request a new code to continue."
        case "bad_credentials": return "The email or password doesn't match. Try again or use an email code."
        case "invalid_email": return "Enter a valid email address."
        case "email_typo": return "Check the spelling of your email address."
        case "undeliverable_email": return "This email domain can't receive mail. Check your address."
        case "rate_limited", "throttled": return "Please wait a moment before trying again."
        default:
            if status == 404 { return "This server doesn't support Lisa accounts. Check Advanced settings." }
            if status >= 500 { return "Lisa Cloud is temporarily unavailable. Please try again shortly." }
            return "Couldn't complete the request. Please try again."
        }
    }
}

@MainActor
struct CloudAccountServices {
    var read: (String) -> String?
    var save: ([String: String]) throws -> Void
    var request: (URL, String?, [String: Any]?) async throws -> (Int, [String: Any])
    var restart: (@escaping (Bool) -> Void) -> Void
    static var live: Self {
        Self(read: { BackendController.shared.configEnvValue($0) },
             save: { try BackendController.shared.updateConfigEnv($0) },
             request: { try await CloudHTTP.json($0, token: $1, body: $2) },
             restart: { BackendController.shared.restart($0) })
    }
}

@MainActor
final class CloudAccountModel: ObservableObject {
    enum Step: Equatable { case email, code, password }
    @Published var step: Step = .email
    @Published var email = ""
    @Published var code = ""
    @Published var password = ""
    @Published var server = "https://cloud.meetlisa.ai"
    @Published var busy = false
    @Published var signedIn = false
    @Published var checkingAccount = false
    @Published var accountVerified = false
    @Published var needsSignIn = false
    @Published var accountEmail = ""
    @Published var notice: CloudNotice?
    @Published var resendAfter = Date.distantPast
    @Published var needsApply = false
    @Published var applying = false
    @Published var applyFailed = false
    @Published var applicationMessage = ""
    let connection: CloudConnectionModel
    private let connectionOwner = UUID()
    private let services: CloudAccountServices
    init(connection: CloudConnectionModel? = nil, services: CloudAccountServices? = nil) {
        self.connection = connection ?? .shared
        self.services = services ?? .live
    }
    var preview = false
    private var accountTask: Task<Void, Never>?
    private var loadedConfiguration = false
    private var sentEmail = ""
    private var sentServer: URL?

    var showsAccount: Bool { signedIn && !needsSignIn }
    var canContinue: Bool {
        !busy && !applying && !connection.busy && CloudAccountRules.validEmail(email)
            && CloudAccountRules.serverURL(server) != nil
            && (step != .code || code.count == 6)
            && (step != .password || !password.isEmpty)
    }
    var destinationEmail: String { sentEmail.isEmpty ? email : sentEmail }

    func start() {
        guard !preview else { return }
        // Going to the inbox and reopening the window must preserve the current
        // login attempt, including its destination and the code/password step.
        let editingSignIn = busy || applying || step != .email || (loadedConfiguration && !showsAccount)
        if !loadedConfiguration || !editingSignIn {
            if let base = services.read("LISA_MANAGED_BASE"), !base.isEmpty { server = base }
            let token = services.read("LISA_MANAGED_SESSION") ?? ""
            signedIn = !token.isEmpty
            accountEmail = services.read("LISA_MANAGED_EMAIL") ?? ""
            if email.isEmpty { email = accountEmail }
            if signedIn && !editingSignIn { verifyAccount(token: token) }
        }
        loadedConfiguration = true
        connection.start(owner: connectionOwner)
        if !applying {
            needsApply = services.read("LISA_ACCOUNT_PENDING_APPLY") == "1"
            if needsApply { applicationMessage = signedIn ? "Apply your account to cloud models when you’re ready." : "Apply this change to stop using your account for cloud models." }
        }
    }
    func stop() {
        connection.stop(owner: connectionOwner)
        accountTask?.cancel()

    }
    func changeMethod(_ next: Step) {
        guard !busy else { return }
        accountTask?.cancel(); checkingAccount = false
        code = ""; password = ""; notice = nil; step = next
    }
    func continueSignIn() {
        guard canContinue, !preview else { return }
        if step == .email { sendCode() } else { authenticate() }
    }
    func sendCode() {
        guard !busy, !applying, !connection.busy, !preview, CloudAccountRules.validEmail(email),
              let base = CloudAccountRules.serverURL(server) else { return }
        accountTask?.cancel(); checkingAccount = false
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true; notice = nil
        Task {
            defer { busy = false }
            do {
                let (status, result) = try await services.request(base.appendingPathComponent("api/auth/otp/request"), nil, ["email": address])
                let cooldown = result["error"] as? String == "otp_cooldown"
                guard status == 200 || cooldown else { showFailure(status, result); return }
                guard cooldown || result["sent"] as? Bool == true else {
                    notice = CloudNotice(text: "This server couldn't send an email. Try signing in with your password.", kind: .error)
                    return
                }
                sentEmail = address; sentServer = base; code = ""; step = .code
                resendAfter = Date().addingTimeInterval(TimeInterval(max(1, result["retryAfterSec"] as? Int ?? 60)))
                if cooldown { notice = CloudNotice(text: "A code is already on its way. Check your inbox and spam folder.") }
            } catch { notice = networkNotice }
        }
    }
    private func authenticate() {
        guard let base = step == .code ? sentServer : CloudAccountRules.serverURL(server) else { return }
        accountTask?.cancel(); checkingAccount = false
        let address = step == .code ? sentEmail : email.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = step == .code ? ["email": address, "code": code] : ["email": address, "password": password]
        let route = step == .code ? "api/auth/otp/verify" : "api/auth/login"
        busy = true; notice = nil
        Task {
            defer { busy = false }
            do {
                let (status, result) = try await services.request(base.appendingPathComponent(route), nil, body)
                guard status == 200, let token = result["token"] as? String, !token.isEmpty else {
                    showFailure(status, result); return
                }
                do {
                    try services.save([
                        "LISA_MANAGED_SESSION": token, "LISA_MANAGED_BASE": base.absoluteString,
                        "LISA_MANAGED_EMAIL": address, "LISA_ACCOUNT_PENDING_APPLY": "1",
                    ])
                } catch {
                    notice = CloudNotice(text: "Couldn’t save your sign-in on this Mac. Please try again.", kind: .error)
                    return
                }
                accountTask?.cancel()
                code = ""; password = ""; signedIn = true; needsSignIn = false; accountEmail = address
                step = .email
                accountVerified = true; checkingAccount = false; server = base.absoluteString; email = address
                needsApply = true; notice = nil
                await connection.connect(base: base.absoluteString, token: token)
                applicationMessage = "Apply your account to cloud models when you’re ready."
            } catch {
                notice = CloudNotice(text: "Couldn't finish signing in. Check your connection and try again.", kind: .error)
            }
        }
    }
    func signOut() {
        guard !busy, !applying, !preview else { return }
        busy = true; notice = nil
        Task {
            defer { busy = false }
            do {
                // Close remote access before changing the visible or saved account.
                try await connection.disconnectAccount {
                    try services.save([
                        "LISA_MANAGED_SESSION": "", "LISA_ACCOUNT_PENDING_APPLY": "1",
                    ])
                }
                accountTask?.cancel()
                signedIn = false; accountVerified = false; needsSignIn = false; step = .email; code = ""; password = ""
                notice = CloudNotice(text: "Signed out. Phone connections are closed; your conversations stay on this Mac.", kind: .success)
                needsApply = true
                applicationMessage = "Apply this change to stop using your account for cloud models."
                busy = false
                applyAccount()
            } catch {
                notice = CloudNotice(text: "Couldn't close phone connections. You're still signed in. Try again when Lisa is available.", kind: .error)
            }
        }
    }
    private func verifyAccount(token: String) {
        accountTask?.cancel()
        guard let base = CloudAccountRules.serverURL(server) else { return }
        checkingAccount = true
        accountTask = Task {
            do {
                let (status, account) = try await services.request(base.appendingPathComponent("api/auth/me"), token, nil)
                guard !Task.isCancelled else { return }
                checkingAccount = false
                if status == 200, account["signedIn"] as? Bool == true {
                    needsSignIn = false; accountVerified = true; notice = nil
                    if let address = account["email"] as? String {
                        accountEmail = address; email = address
                        try? services.save(["LISA_MANAGED_EMAIL": address])
                    }
                } else if status == 401 || status == 403 {
                    needsSignIn = true; accountVerified = false; step = .email
                    notice = CloudNotice(text: "Your session has expired. Sign in again to reconnect your devices.", kind: .warning)
                } else {
                    notice = CloudNotice(text: "Your account is saved. We couldn't verify it just now; check your connection and try again.", kind: .warning)
                }
            } catch {
                guard !Task.isCancelled else { return }
                checkingAccount = false; notice = networkNotice
            }
        }
    }
    func applyAccount() {
        guard !preview, needsApply, !applying, !busy, !connection.busy else { return }
        applying = true; applyFailed = false
        applicationMessage = "Applying your account. Lisa will be ready in a moment…"
        Task {
            defer { applying = false }
            do {
                let up = await withCheckedContinuation { continuation in
                    services.restart { continuation.resume(returning: $0) }
                }
                guard up else { throw NSError(domain: "LISAAccount", code: 2) }
                try services.save(["LISA_ACCOUNT_PENDING_APPLY": "0"])
                needsApply = false; applicationMessage = ""
                await connection.refresh()
            } catch {
                applyFailed = true; needsApply = true
                try? services.save(["LISA_ACCOUNT_PENDING_APPLY": "1"])
                applicationMessage = "Your account is saved, but setup couldn't finish. Try again when Lisa is available."
            }
        }
    }
    private var networkNotice: CloudNotice {
        CloudNotice(text: "Couldn't reach Lisa Cloud. Check your internet connection and try again.", kind: .error)
    }
    private func showFailure(_ status: Int, _ result: [String: Any]) {
        var text = CloudHTTP.message(status: status, error: result["error"] as? String ?? "")
        if let suggestion = result["suggestion"] as? String { text += " Did you mean @\(suggestion)?" }
        notice = CloudNotice(text: text, kind: .error)
    }
}
