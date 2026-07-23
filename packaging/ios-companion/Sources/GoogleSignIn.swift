import AuthenticationServices
import CryptoKit
import Foundation

/// Sign in with Google, without Google's SDK (PLAN_AUTH_OTP_GOOGLE A4).
///
/// The whole flow is ~100 lines of OAuth, so we run it ourselves rather than
/// take a dependency — the same call the server side makes in `googleAuth.ts`
/// (verify Apple/Google JWTs with `node:crypto` instead of a library).
///
/// It's the standard **authorization code + PKCE** flow for a native app:
///
///  1. mint a `code_verifier`, send only its SHA-256 (`code_challenge`) to the
///     authorize endpoint — so intercepting the redirect gains nothing without
///     the verifier, which never leaves the device;
///  2. `ASWebAuthenticationSession` shows Google's page in a sandboxed browser
///     the app cannot read, and intercepts the redirect itself (which is why no
///     URL scheme has to be registered in `project.yml`);
///  3. exchange the code for an `id_token` directly with Google over TLS. iOS
///     OAuth clients are public clients — there is no client secret to leak.
///
/// The `nonce` travels with the request and comes back inside the token, so the
/// server can tell a token minted for THIS sign-in from a replayed one.
enum GoogleSignInError: Error {
    case notConfigured
    case cancelled
    case failed(String)
}

@MainActor
final class GoogleSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = GoogleSignIn()

    struct Outcome {
        let idToken: String
        /// The raw nonce, echoed verbatim by Google inside the token.
        let nonce: String
    }

    private var live: ASWebAuthenticationSession?

    /// The redirect scheme Google assigns an iOS OAuth client: its id, reversed.
    /// `123-abc.apps.googleusercontent.com` ⇒ `com.googleusercontent.apps.123-abc`.
    static func redirectScheme(clientId: String) -> String? {
        let suffix = ".apps.googleusercontent.com"
        guard clientId.hasSuffix(suffix) else { return nil }
        return "com.googleusercontent.apps." + String(clientId.dropLast(suffix.count))
    }

    func signIn(iosClientId: String) async throws -> Outcome {
        guard let scheme = Self.redirectScheme(clientId: iosClientId) else {
            throw GoogleSignInError.notConfigured
        }
        let verifier = Self.randomURLSafe(64)
        let challenge = Self.sha256Base64URL(verifier)
        let state = Self.randomURLSafe(16)
        let nonce = Self.randomURLSafe(16)
        let redirectURI = scheme + ":/oauth2redirect"

        var comps = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        comps.queryItems = [
            URLQueryItem(name: "client_id", value: iosClientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
        ]
        guard let authURL = comps.url else { throw GoogleSignInError.notConfigured }

        let callback = try await present(authURL: authURL, scheme: scheme)
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }

        if let denied = value("error") {
            throw denied == "access_denied" ? GoogleSignInError.cancelled : GoogleSignInError.failed(denied)
        }
        // Guards against a redirect we didn't start (CSRF).
        guard value("state") == state else { throw GoogleSignInError.failed("state mismatch") }
        guard let code = value("code") else { throw GoogleSignInError.failed("no authorization code") }

        let idToken = try await exchange(code: code, verifier: verifier,
                                        clientId: iosClientId, redirectURI: redirectURI)
        return Outcome(idToken: idToken, nonce: nonce)
    }

    private func present(authURL: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: scheme) { url, error in
                if let url {
                    continuation.resume(returning: url)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: GoogleSignInError.cancelled)
                } else {
                    continuation.resume(throwing: GoogleSignInError.failed(
                        error?.localizedDescription ?? "the sign-in window closed unexpectedly"))
                }
            }
            session.presentationContextProvider = self
            // A fresh session every time: signing out of LISA shouldn't leave the
            // next person silently signed in as the last one.
            session.prefersEphemeralWebBrowserSession = true
            live = session
            if !session.start() {
                continuation.resume(throwing: GoogleSignInError.failed("couldn't open the sign-in window"))
            }
        }
    }

    /// Swap the one-time code for an id_token. Public client: no secret.
    private func exchange(code: String, verifier: String, clientId: String, redirectURI: String) async throws -> String {
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "code_verifier", value: verifier),
            URLQueryItem(name: "grant_type", value: "authorization_code"),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
        ]
        req.httpBody = form.percentEncodedQuery.map { Data($0.utf8) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        struct TokenResponse: Decodable {
            let id_token: String?
            let error_description: String?
        }
        let parsed = try? JSONDecoder().decode(TokenResponse.self, from: data)
        guard status == 200, let idToken = parsed?.id_token, !idToken.isEmpty else {
            throw GoogleSignInError.failed(parsed?.error_description ?? "Google refused the code exchange (\(status)).")
        }
        return idToken
    }

    // ── PKCE primitives ─────────────────────────────────────────────────────
    /// `bytes` of randomness as unreserved characters (RFC 7636 §4.1).
    private static func randomURLSafe(_ bytes: Int) -> String {
        var rng = SystemRandomNumberGenerator()
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return String((0..<bytes).map { _ in alphabet[Int.random(in: 0..<alphabet.count, using: &rng)] })
    }

    private static func sha256Base64URL(_ s: String) -> String {
        Data(SHA256.hash(data: Data(s.utf8)))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.first { $0.activationState == .foregroundActive }?.keyWindow
            ?? scenes.first?.keyWindow
        return window ?? ASPresentationAnchor()
    }
}
