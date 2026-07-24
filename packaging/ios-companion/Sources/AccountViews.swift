import SwiftUI
import AuthenticationServices
#if LISA_ENABLE_SIWA
import CryptoKit
#endif

/// Shared cloud sign-in form (PLAN_ACCOUNTS_BILLING B1; PLAN_AUTH_OTP_GOOGLE A2)
/// — the PRIMARY flow: Sign in with Apple first, then a **mailed one-time code**
/// (which registers the account if the address is new, so there's no separate
/// sign-up), with passwords behind a disclosure and the legacy paste-a-token
/// link behind another. Used from both Settings and the first-run onboarding
/// sheet so the two entry points can't drift apart.
///
/// Emits `onResult` after the connection is saved AND live-verified — the
/// parse-only fake success is what got build 1782924012 rejected (2.1).
struct CloudSignInForm: View {
    @EnvironmentObject var app: AppState
    /// Called with the verify outcome after a credential/URL was applied.
    let onResult: (VerifyOutcome) -> Void

    @State private var cloudURL = AppState.defaultCloudBase
    @State private var email = ""
    @State private var code = ""
    @State private var codeSent = false
    @State private var password = ""
    @State private var pasteText = ""
    @State private var busy = false
    @State private var error: String?
    @State private var note: String?
    /// This instance's Google iOS client id, or nil when it doesn't run Google.
    @State private var googleClientId: String?
    #if LISA_ENABLE_SIWA
    /// Raw (un-hashed) nonce for the in-flight Apple request (#261). We send
    /// sha256(raw) to Apple and the raw value to our server, which re-hashes it
    /// and matches it against the token's `nonce` claim — so a token minted for
    /// some other request can't be replayed at our sign-in endpoint.
    @State private var appleRawNonce: String?
    #endif

    var body: some View {
        Section {
            TextField("LISA Cloud URL", text: $cloudURL)
                .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
            #if LISA_ENABLE_SIWA
            SignInWithAppleButton(.continue,
                onRequest: { req in
                    req.requestedScopes = [.fullName, .email]
                    let raw = Self.randomNonce()
                    appleRawNonce = raw
                    req.nonce = Self.sha256Hex(raw)
                },
                onCompletion: handleApple)
                .signInWithAppleButtonStyle(.white)
                .frame(height: 46)
                .cornerRadius(Theme.cardRadius)
                .disabled(busy || AppState.parseCloudBase(cloudURL) == nil)
                .opacity(busy ? 0.5 : 1)
            #endif
            // Google sits BELOW Apple: Guideline 4.8 wants Sign in with Apple
            // offered with equal prominence wherever a third-party login is.
            // Drawn only when this instance runs an iOS Google client.
            if let googleClientId {
                Button { signInWithGoogle(clientId: googleClientId) } label: {
                    Text("Sign in with Google")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(Color.white)
                        .foregroundStyle(.black)
                        .cornerRadius(Theme.cardRadius)
                }
                .buttonStyle(.plain)
                .disabled(busy || AppState.parseCloudBase(cloudURL) == nil)
                .opacity(busy ? 0.5 : 1)
            }
            TextField("Email", text: $email)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .keyboardType(.emailAddress).textContentType(.username)
                // Editing the address invalidates whatever code is outstanding.
                .onChange(of: email) { if codeSent { codeSent = false; note = nil } }
            if codeSent {
                TextField("6-digit code", text: $code)
                    .keyboardType(.numberPad).textContentType(.oneTimeCode)
                Button("Sign in") { submitCode() }
                    .disabled(busy || code.isEmpty)
                Button("Send another code") { sendCode() }
                    .disabled(busy || !addressReady)
            } else {
                Button("Email me a code") { sendCode() }
                    .disabled(busy || !addressReady)
            }
            if busy { ProgressView().tint(Theme.accent) }
        } header: {
            Text("LISA account")
        } footer: {
            Text("Sign in and go — no Mac, no API key, no password to remember. New here? The code creates your account. A free usage allowance refreshes every 12 hours.")
        }

        Section {
            DisclosureGroup("Use a password instead") {
                SecureField("Password (8+ characters)", text: $password)
                    .textContentType(.password)
                HStack {
                    Button("Sign in") { emailAuth(register: false) }
                        .disabled(!passwordFormReady)
                    Spacer()
                    Button("Create account") { emailAuth(register: true) }
                        .disabled(!passwordFormReady)
                }
            }
        } footer: {
            Text("For accounts that already have a password.")
        }

        Section {
            DisclosureGroup("Advanced: connect with a token link") {
                TextField("https://…/?token=", text: $pasteText)
                    .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
                Button("Connect") { applyPaste() }
                    .disabled(pasteText.isEmpty || busy)
            }
        } footer: {
            Text("For self-hosted instances using a shared LISA_WEB_TOKEN.")
        }

        if let note {
            Section { Text(note).font(.caption).foregroundStyle(Theme.accent) }
        }
        if let error {
            Section { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
        // Re-asked whenever the URL changes: two instances can offer different
        // sign-in surfaces.
        Section {} .task(id: cloudURL) {
            googleClientId = await app.authConfig(baseURL: cloudURL)?.google?.iosClientId
        }
    }

    private var addressReady: Bool {
        !email.isEmpty && AppState.parseCloudBase(cloudURL) != nil
    }

    /// The domain half of the typed address, for rewriting it to a suggestion.
    private var emailDomain: String {
        guard let at = email.lastIndex(of: "@") else { return "" }
        return String(email[email.index(after: at)...])
    }

    private var passwordFormReady: Bool {
        !busy && addressReady && password.count >= 8
    }

    /// Verify after saving so success is REAL success (2.1 fix), then report.
    private func verifyThenReport() async {
        let outcome = await app.verifyConnection()
        busy = false
        onResult(outcome)
    }

    private func signInWithGoogle(clientId: String) {
        error = nil
        note = nil
        busy = true
        Task {
            do {
                let outcome = try await GoogleSignIn.shared.signIn(iosClientId: clientId)
                try await app.connectCloudWithGoogle(baseURL: cloudURL, idToken: outcome.idToken,
                                                     nonce: outcome.nonce)
                await verifyThenReport()
            } catch GoogleSignInError.cancelled {
                busy = false // the person backed out — not an error worth shouting about
            } catch GoogleSignInError.failed(let why) {
                busy = false
                error = "Google sign-in failed: \(why)"
            } catch GoogleSignInError.notConfigured {
                busy = false
                error = "This instance's Google client id looks wrong."
            } catch let err as LisaClient.SignInCodeError {
                busy = false
                error = err.status == 404
                    ? "This instance hasn't enabled Google sign-in."
                    : "Google sign-in was rejected by this instance (\(err.status))."
            } catch {
                busy = false
                self.error = "Couldn't reach that LISA Cloud URL."
            }
        }
    }

    /// Human-readable reason for a refused code request/redemption.
    private func describe(_ err: LisaClient.SignInCodeError) -> String {
        switch err.reason {
        case "otp_cooldown": return "A code just went out — check your inbox."
        case "otp_daily_cap": return "Too many codes for this address today. Try a password, or again tomorrow."
        case "bad_code": return "That code isn't right."
        case "expired": return "That code expired — send another."
        case "no_pending": return "No code outstanding — send one first."
        case "too_many_attempts": return "Too many wrong codes. Send a fresh one."
        case "invalid_email": return "That doesn't look like an email address."
        case "email_typo":
            // A named typo is one tap from fixed — offer the fix, don't scold.
            return err.suggestion.map { "Did you mean \(email.replacingOccurrences(of: emailDomain, with: $0))?" }
                ?? "That address looks misspelled."
        case "undeliverable_email": return "That domain doesn't seem to accept mail — check the spelling."
        case "rate_limited": return "Too many attempts from this network — try again later."
        default:
            return err.status == 404
                ? "This instance doesn't offer accounts — use the token link below."
                : "The server answered with an error (\(err.status))."
        }
    }

    private func sendCode() {
        error = nil
        note = nil
        busy = true
        Task {
            do {
                let sent = try await app.requestSignInCode(baseURL: cloudURL, email: email)
                busy = false
                codeSent = true
                code = ""
                if sent {
                    note = "We sent a 6-digit code to \(email). It expires in 10 minutes."
                } else {
                    error = "This instance couldn't send the mail. Try a password instead."
                }
            } catch let err as LisaClient.SignInCodeError {
                busy = false
                error = describe(err)
            } catch {
                busy = false
                self.error = "Couldn't reach that LISA Cloud URL."
            }
        }
    }

    private func submitCode() {
        error = nil
        note = nil
        busy = true
        Task {
            do {
                try await app.connectCloudWithCode(baseURL: cloudURL, email: email, code: code)
                await verifyThenReport()
            } catch let err as LisaClient.SignInCodeError {
                busy = false
                error = describe(err)
                // A burned or expired code can't be retried — back to sending one.
                if ["expired", "no_pending", "too_many_attempts"].contains(err.reason) {
                    codeSent = false
                }
            } catch {
                busy = false
                self.error = "Couldn't reach that LISA Cloud URL."
            }
        }
    }

    private func emailAuth(register: Bool) {
        error = nil
        busy = true
        Task {
            do {
                try await app.connectCloudWithEmail(baseURL: cloudURL, email: email,
                                                    password: password, register: register)
                await verifyThenReport()
            } catch LisaError.http(let code) {
                busy = false
                switch code {
                case 401: error = "Wrong email or password."
                case 409: error = "That email already has an account — use Sign in."
                case 429: error = "Too many attempts — wait 15 minutes and try again."
                case 404: error = "This instance doesn't offer accounts — use the token link below."
                case 400: error = "Check the email address and use 8+ characters for the password."
                default:  error = "The server answered with an error (\(code))."
                }
            } catch {
                busy = false
                self.error = "Couldn't reach that LISA Cloud URL."
            }
        }
    }

    private func applyPaste() {
        error = nil
        guard app.applyPairing(pasteText) else {
            error = "Couldn't read that cloud URL — paste the full https://…/?token=… link."
            return
        }
        busy = true
        Task { await verifyThenReport() }
    }

    #if LISA_ENABLE_SIWA
    /// 32 hex chars of randomness — the raw nonce (#261). `SystemRandomNumber-
    /// Generator` is arc4random_buf on Apple platforms, so no Security import.
    private static func randomNonce() -> String {
        var rng = SystemRandomNumberGenerator()
        return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &rng)) }.joined()
    }

    /// SHA-256 as lowercase hex — the form Apple echoes into the `nonce` claim.
    private static func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>) {
        error = nil
        switch result {
        case .failure(let err):
            if (err as? ASAuthorizationError)?.code == .canceled { return }
            error = err.localizedDescription
        case .success(let auth):
            guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
                  let data = cred.identityToken, let idToken = String(data: data, encoding: .utf8) else {
                error = "Apple didn't return an identity token."
                return
            }
            busy = true
            // One nonce per request: consume it so a second sign-in can't reuse it.
            let raw = appleRawNonce
            appleRawNonce = nil
            Task {
                do {
                    try await app.connectCloudWithApple(baseURL: cloudURL, identityToken: idToken,
                                                        rawNonce: raw)
                    await verifyThenReport()
                } catch LisaError.http(404) {
                    busy = false
                    error = "This instance hasn't enabled Sign in with Apple — use email or a token link."
                } catch LisaError.http(401), LisaError.http(403) {
                    busy = false
                    error = "Apple sign-in was rejected by this instance."
                } catch {
                    busy = false
                    self.error = "Couldn't reach that LISA Cloud URL."
                }
            }
        }
    }
    #endif
}

/// The signed-in account card for Settings: who you are, sign out, and the
/// App Store 5.1.1(v) in-app deletion (confirm dialog; destructive).
struct AccountCard: View {
    @EnvironmentObject var app: AppState
    @State private var showDeleteConfirm = false
    @State private var deleting = false
    @State private var quota: LisaClient.QuotaStatus?
    @State private var showPaywall = false
    @State private var resendMessage: String?

    private static let tierLabels: [String: String] = [
        "free": "Free", "free-unverified": "Free (verify email for more)",
        "tier1": "Tier 1", "tier2": "Tier 2",
    ]

    var body: some View {
        Section("LISA account") {
            if let acct = app.account, acct.signedIn {
                LabeledContent("Signed in as", value: acct.email ?? acct.uid ?? "—")
                // Unverified email = reduced ($1) session window (B8a).
                if acct.kind == "email" && acct.verified == false {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Email not verified — your free allowance is limited to $1 per session.",
                              systemImage: "envelope.badge")
                            .font(.caption).foregroundStyle(Theme.waiting)
                        Button(resendMessage ?? "Resend verification email") {
                            Task {
                                let sent = (try? await app.client.resendVerification()) ?? false
                                resendMessage = sent ? "Sent — check your inbox." : "Couldn't send — try again later."
                            }
                        }
                        .font(.caption)
                        .disabled(resendMessage == "Sent — check your inbox.")
                    }
                }
                if let q = quota, q.available, let window = q.windowMicroUSD, window > 0 {
                    let spent = q.spentMicroUSD ?? 0
                    let remaining = q.remainingMicroUSD ?? 0
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Session allowance")
                            Spacer()
                            Text("\(Self.dollars(remaining)) of \(Self.dollars(window)) left")
                                .foregroundStyle(.secondary)
                        }
                        .font(.subheadline)
                        ProgressView(value: Double(min(spent, window)), total: Double(window))
                            .tint(remaining > 0 ? Theme.green : Theme.danger)
                        if let reset = q.resetAt, remaining <= 0 {
                            Text("Refreshes \(Date(timeIntervalSince1970: reset / 1000), style: .relative)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Tier", value: Self.tierLabels[q.tier ?? "free"] ?? (q.tier ?? "Free"))
                    LabeledContent("Credits", value: Self.dollars(max(0, q.paidMicroUSD ?? 0)))
                    Button {
                        showPaywall = true
                    } label: {
                        Label("Add credits…", systemImage: "plus.circle")
                    }
                } else {
                    LabeledContent("Plan", value: (acct.plan ?? "free").capitalized)
                }
                Button("Sign out") {
                    app.signOutCloud()
                    app.notify("Signed out.")
                }
                Button("Delete account…", role: .destructive) { showDeleteConfirm = true }
                    .disabled(deleting)
            } else {
                // Connected with a legacy shared/device token — not an account.
                LabeledContent("Signed in", value: "No (token connection)")
            }
        }
        .task { quota = try? await app.client.billingQuota() }
        .sheet(isPresented: $showPaywall, onDismiss: {
            Task { quota = try? await app.client.billingQuota() }
        }) {
            PaywallSheet().environmentObject(app)
        }
        .confirmationDialog("Delete your LISA account?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete account and data", role: .destructive) {
                deleting = true
                Task {
                    defer { deleting = false }
                    do {
                        try await app.deleteCloudAccount()
                        app.notify("Account deleted.")
                    } catch {
                        app.notify("Couldn't delete the account — try again.", ok: false)
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Deletes your account and its cloud data permanently. Purchased credits are handled by Apple's refund process and are not restored by re-registering.")
        }
    }

    private static func dollars(_ micro: Int) -> String {
        String(format: "$%.2f", Double(micro) / 1_000_000)
    }
}
