import SwiftUI
import AuthenticationServices

/// Shared cloud sign-in form (PLAN_ACCOUNTS_BILLING B1) — the PRIMARY flow:
/// Sign in with Apple first, email+password second, and the legacy paste-a-token
/// link tucked behind an "Advanced" disclosure. Used from both Settings and the
/// first-run onboarding sheet so the two entry points can't drift apart.
///
/// Emits `onSignedIn` after the connection is saved AND live-verified — the
/// parse-only fake success is what got build 1782924012 rejected (2.1).
struct CloudSignInForm: View {
    @EnvironmentObject var app: AppState
    /// Called with the verify outcome after a credential/URL was applied.
    let onResult: (VerifyOutcome) -> Void

    @State private var cloudURL = AppState.defaultCloudBase
    @State private var email = ""
    @State private var password = ""
    @State private var pasteText = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Section {
            TextField("LISA Cloud URL", text: $cloudURL)
                .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
            #if LISA_ENABLE_SIWA
            SignInWithAppleButton(.continue,
                onRequest: { req in req.requestedScopes = [.fullName, .email] },
                onCompletion: handleApple)
                .signInWithAppleButtonStyle(.white)
                .frame(height: 46)
                .cornerRadius(Theme.cardRadius)
                .disabled(busy || AppState.parseCloudBase(cloudURL) == nil)
                .opacity(busy ? 0.5 : 1)
            #endif
            TextField("Email", text: $email)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .keyboardType(.emailAddress).textContentType(.username)
            SecureField("Password (8+ characters)", text: $password)
                .textContentType(.password)
            HStack {
                Button("Sign in") { emailAuth(register: false) }
                    .disabled(!emailFormReady)
                Spacer()
                Button("Create account") { emailAuth(register: true) }
                    .disabled(!emailFormReady)
            }
            if busy { ProgressView().tint(Theme.accent) }
        } header: {
            Text("LISA account")
        } footer: {
            Text("Sign in and go — no Mac, no API key. A free usage allowance refreshes every 12 hours.")
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

        if let error {
            Section { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
    }

    private var emailFormReady: Bool {
        !busy && !email.isEmpty && password.count >= 8 && AppState.parseCloudBase(cloudURL) != nil
    }

    /// Verify after saving so success is REAL success (2.1 fix), then report.
    private func verifyThenReport() async {
        let outcome = await app.verifyConnection()
        busy = false
        onResult(outcome)
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
            Task {
                do {
                    try await app.connectCloudWithApple(baseURL: cloudURL, identityToken: idToken)
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

    var body: some View {
        Section("LISA account") {
            if let acct = app.account, acct.signedIn {
                LabeledContent("Signed in as", value: acct.email ?? acct.uid ?? "—")
                LabeledContent("Plan", value: (acct.plan ?? "free").capitalized)
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
}
