import SwiftUI
import AuthenticationServices

/// First-run guided flow: carries a brand-new user from "app installed, nothing
/// configured" → "paired and in the app" (docs/PLAN_IOS_ONBOARDING_v1.0.md, M1).
/// Presented as a `.fullScreenCover` over RootView when `app.showOnboarding`.
///
/// Pure UX over existing primitives — `applyPairing` / `parsePairing` / `update`
/// / `QRScannerView` / `verifyConnection`. No new backend protocol.
struct OnboardingFlow: View {
    @EnvironmentObject var app: AppState

    @State private var step: OnboardingStep = .welcome
    @State private var method: InstallMethod = .homebrew
    @State private var showManual = false
    @State private var manualMode: ConnectionMode = .mac
    @State private var scanNote: String?
    @State private var rescanToken = 0
    @State private var verifying = false
    @State private var outcome: VerifyOutcome?

    var body: some View {
        ZStack {
            Theme.bgDeep.ignoresSafeArea()
            content
        }
        .preferredColorScheme(.dark)
        .tint(Theme.accent)
        .sheet(isPresented: $showManual) {
            OnboardingManualEntry(mode: manualMode) {
                showManual = false
                go(.connect)
            }
            .environmentObject(app)
        }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .welcome: welcomeScreen
        case .mode:    modeScreen
        case .install: installScreen
        case .start:   startScreen
        case .pair:    pairScreen
        case .scan:    scanScreen
        case .connect: connectScreen
        }
    }

    // ── navigation ──────────────────────────────────────────────
    private func go(_ s: OnboardingStep) { withAnimation(.easeInOut(duration: 0.2)) { step = s } }
    private func skip() { app.finishOnboarding(paired: false) }
    private func openManual(_ m: ConnectionMode) { manualMode = m; showManual = true }

    // ── 0 · Welcome ─────────────────────────────────────────────
    private var welcomeScreen: some View {
        VStack(spacing: 0) {
            OnboardingTopBar(step: nil, onSkip: skip)
            ScrollableCenter {
                VStack(spacing: 22) {
                    Image(systemName: "macbook.and.iphone")
                        .font(.system(size: 72, weight: .light))
                        .foregroundStyle(Theme.accent)
                    VStack(spacing: 10) {
                        Text("Meet Lisa")
                            .font(.largeTitle.weight(.bold)).foregroundStyle(Theme.text)
                        Text("She lives on your Mac. This is your window to her — chat, check on her agents, and stay in the loop from anywhere.")
                            .font(.body).foregroundStyle(Theme.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                }
                .padding(.vertical, 24)
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                OnboardingPrimaryButton(title: "Get started") { go(.mode) }
                OnboardingSecondaryButton(title: "I already have LISA running") { go(.pair) }
            }
            .padding(.bottom, 24)
        }
    }

    // ── 1 · Where Lisa lives (mode fork) ────────────────────────
    private var modeScreen: some View {
        VStack(spacing: 0) {
            OnboardingTopBar(step: nil, onSkip: skip)
            ScrollView {
                VStack(spacing: 18) {
                    OnboardingTitle(title: "Where does Lisa live?",
                                    subtitle: "Lisa runs on a Mac. Connect to your own, or use hosted LISA Cloud.")
                    OnboardingChoiceCard(systemImage: "desktopcomputer",
                                         title: "My Mac", subtitle: "Private and local — your data never leaves your Mac.",
                                         badge: "Recommended", selected: app.connectionMode == .mac) {
                        app.setConnectionMode(.mac); go(.install)
                    }
                    OnboardingChoiceCard(systemImage: "cloud",
                                         title: "LISA Cloud", subtitle: "No Mac needed. Paste a cloud URL + token for now.",
                                         selected: app.connectionMode == .cloud) {
                        app.setConnectionMode(.cloud); openManual(.cloud)
                    }
                }
                .padding(.vertical, 24)
            }
        }
    }

    // ── 2 · Install on your Mac ─────────────────────────────────
    private var installScreen: some View {
        VStack(spacing: 0) {
            OnboardingTopBar(step: .install, onSkip: skip)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    OnboardingTitle(title: "Install LISA on your Mac",
                                    subtitle: "Pick whichever you prefer — you only do this once.")
                    Picker("Install method", selection: $method) {
                        ForEach(InstallMethod.allCases) { m in Text(m.label).tag(m) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 24)

                    if let cmd = method.installCommand {
                        CopyCommandRow(command: cmd)
                        Text("Paste it into Terminal on your Mac and press return.")
                            .font(.caption).foregroundStyle(Theme.tertiary).padding(.horizontal, 24)
                    } else if let url = method.downloadURL {
                        Link(destination: url) {
                            HStack(spacing: 8) {
                                Image(systemName: "arrow.down.circle.fill")
                                Text("Download Lisa-Suite.dmg")
                            }
                            .font(.headline).foregroundStyle(Theme.accent)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
                            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius).strokeBorder(Theme.border, lineWidth: Theme.hairline))
                        }
                        .padding(.horizontal, 24)
                        Text("Open the .dmg and drag Lisa to Applications.")
                            .font(.caption).foregroundStyle(Theme.tertiary).padding(.horizontal, 24)
                    }
                }
                .padding(.vertical, 24)
            }
            VStack { OnboardingPrimaryButton(title: "It's installed →") { go(.start) } }
                .padding(.bottom, 24)
        }
    }

    // ── 3 · Start LISA (reachably) ──────────────────────────────
    private var startScreen: some View {
        VStack(spacing: 0) {
            OnboardingTopBar(step: .start, onSkip: skip)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    OnboardingTitle(title: "Start Lisa", subtitle: method.startHint)
                    if let serve = method.serveCommand {
                        CopyCommandRow(command: serve)
                        Label("Keep this iPhone on the same Wi-Fi as your Mac.",
                              systemImage: "wifi")
                            .font(.caption).foregroundStyle(Theme.tertiary).padding(.horizontal, 24)
                    } else {
                        Label("Keep this iPhone on the same Wi-Fi as your Mac.",
                              systemImage: "wifi")
                            .font(.subheadline).foregroundStyle(Theme.secondary).padding(.horizontal, 24)
                    }
                }
                .padding(.vertical, 24)
            }
            VStack { OnboardingPrimaryButton(title: "It's running →") { go(.pair) } }
                .padding(.bottom, 24)
        }
    }

    // ── 4 · Show the pairing QR ─────────────────────────────────
    private var pairScreen: some View {
        VStack(spacing: 0) {
            OnboardingTopBar(step: .pair, onSkip: skip)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if method == .app {
                        // Mac-app users have no terminal — lead with the menu-bar
                        // pairing window (review B4), CLI shown only as a fallback.
                        OnboardingTitle(title: "Pair this iPhone",
                                        subtitle: "LISA is in your Mac's menu bar. Click the Lisa icon → “Pair iPhone…” — it shows a QR code to scan.")
                        Label("No terminal needed.", systemImage: "menubar.rectangle")
                            .font(.subheadline).foregroundStyle(Theme.accent).padding(.horizontal, 24)
                        DisclosureGroup {
                            CopyCommandRow(command: pairCommand)
                        } label: {
                            Text("Prefer the terminal?").font(.caption).foregroundStyle(Theme.secondary)
                        }
                        .padding(.horizontal, 24)
                    } else {
                        OnboardingTitle(title: "Pair this iPhone",
                                        subtitle: "Keep LISA running on your Mac. Then, in a new terminal window, run this — it prints a QR code there.")
                        CopyCommandRow(command: pairCommand)
                        Text("Only someone with this code can connect — and only over your Wi-Fi or tailnet.")
                            .font(.caption).foregroundStyle(Theme.tertiary).padding(.horizontal, 24)
                    }
                }
                .padding(.vertical, 24)
            }
            VStack(spacing: 8) {
                OnboardingPrimaryButton(title: "Scan the QR") { go(.scan) }
                OnboardingSecondaryButton(title: "Paste link / enter manually") { openManual(.mac) }
            }
            .padding(.bottom, 24)
        }
    }

    // ── 5 · Scan ────────────────────────────────────────────────
    private var scanScreen: some View {
        ZStack {
            QRScannerView(
                onScan: { value in
                    guard !showManual else { return }   // ignore decodes while the manual sheet is up (A11)
                    if app.applyPairing(value) { go(.connect) }
                    // Stay on the scanner and let them re-aim instead of yanking
                    // them into a form for a momentary mis-scan (A10/A11).
                    else { scanNote = "That isn't a LISA pairing code — line it up and try again."; rescanToken += 1 }
                },
                onError: { reason in scanNote = reason; openManual(.mac) },
                rescanToken: rescanToken
            )
            .ignoresSafeArea()
            VStack {
                OnboardingTopBar(step: .scan, onSkip: skip)
                    .background(
                        LinearGradient(colors: [.black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom)
                            .ignoresSafeArea(edges: .top)
                    )   // scrim so "Not now" reads over a bright camera scene (C5)
                Spacer()
                VStack(spacing: 12) {
                    if let scanNote {
                        Text(scanNote).font(.caption).foregroundStyle(.white)
                            .padding(8).background(.ultraThinMaterial, in: Capsule())
                    } else {
                        Text("Point at the QR code Lisa shows on your Mac.")
                            .font(.subheadline).foregroundStyle(.white)
                            .padding(10).background(.ultraThinMaterial, in: Capsule())
                    }
                    Button("Paste link / enter manually") { openManual(.mac) }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .padding(.bottom, 32)
            }
        }
    }

    // ── 6 · Connecting → Connected ──────────────────────────────
    private var connectScreen: some View {
        VStack(spacing: 0) {
            OnboardingTopBar(step: .connect, onSkip: skip)
            ScrollableCenter {
              Group {
                if verifying {
                    VStack(spacing: 16) {
                        ProgressView().tint(Theme.accent).scaleEffect(1.4)
                        Text("Connecting to Lisa…").font(.headline).foregroundStyle(Theme.text)
                    }
                } else if outcome == .ok {
                    VStack(spacing: 16) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 64)).foregroundStyle(Theme.green)
                        Text("Connected to Lisa").font(.title2.weight(.bold)).foregroundStyle(Theme.text)
                        Text("You're all set.").font(.body).foregroundStyle(Theme.secondary)
                    }
                } else if let outcome {
                    failureView(outcome)
                }
              }
            }
            footer
                .padding(.bottom, 24)
        }
        .task { await verify() }
    }

    @ViewBuilder private var footer: some View {
        if outcome == .ok {
            OnboardingPrimaryButton(title: "Enter") { app.finishOnboarding(paired: true) }
        } else if !verifying, let outcome {
            // Outcome-specific recovery: a rejected token re-scans, an unreachable
            // Mac retries (see VerifyOutcome.recovery).
            let actions = outcome.recovery
            VStack(spacing: 8) {
                if let primary = actions.first {
                    OnboardingPrimaryButton(title: primary.label) { perform(primary) }
                }
                ForEach(Array(actions.dropFirst()), id: \.self) { action in
                    OnboardingSecondaryButton(title: action.label) { perform(action) }
                }
                OnboardingSecondaryButton(title: "Back") { go(.pair) }
            }
        }
    }

    private func perform(_ action: RecoveryAction) {
        switch action {
        case .retry:  Task { await verify() }
        case .rescan: scanNote = nil; go(.scan)
        case .manual: openManual(.mac)
        }
    }

    @ViewBuilder private func failureView(_ o: VerifyOutcome) -> some View {
        let (icon, title, desc): (String, String, String) = {
            switch o {
            case .unauthorized:
                return ("lock.trianglebadge.exclamationmark",
                        "Pairing was rejected",
                        "That code may have expired or been revoked. Run `lisa pair` on your Mac again for a fresh QR, then re-scan.")
            case .serverError(let code):
                return ("exclamationmark.triangle",
                        "Your Mac returned an error",
                        "LISA answered with HTTP \(code). Make sure it's up to date, then try again.")
            case .unreachable, .ok:
                return ("wifi.exclamationmark",
                        "Can't reach your Mac",
                        "• Is this iPhone on the same Wi-Fi as your Mac?\n• For a terminal install, did you start it with `--host 0.0.0.0`?\n• If macOS asked to allow incoming connections, choose Allow.\n• A Tailscale tailnet name works too.")
            }
        }()
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 52)).foregroundStyle(Theme.waiting)
            Text(title).font(.title3.weight(.bold)).foregroundStyle(Theme.text)
            Text(desc).font(.subheadline).foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center).padding(.horizontal, 28)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @MainActor private func verify() async {
        verifying = true
        outcome = nil
        let result = await app.verifyConnection()
        outcome = result
        verifying = false
        if result == .ok { Haptics.success() } else { Haptics.warning() }
    }
}

/// Paste / manual-entry fallback for both data planes. Mac: a `lisa-pair://` or
/// `http://host:port/?token=` link, or host/port/token fields. Cloud:
/// **Sign in with Apple** against a LISA Cloud instance (M4 — the server verifies
/// the Apple identity token and hands back the session token; see
/// src/web/cloudAuth.ts), or paste an `https://…/?token=` URL directly.
struct OnboardingManualEntry: View {
    @EnvironmentObject var app: AppState
    let mode: ConnectionMode
    let onPaired: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var pasteText = ""
    @State private var host = ""
    @State private var portText = "5757"
    @State private var token = ""
    @State private var cloudURL = ""
    @State private var appleBusy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if mode == .cloud { cloudSections } else { macSections }

                if let error {
                    Section { Text(error).font(.caption).foregroundStyle(Theme.danger) }
                }
            }
            .consoleBackground()
            .navigationTitle(mode == .cloud ? "Connect to LISA Cloud" : "Enter pairing details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .preferredColorScheme(.dark)
    }

    // ── Cloud: paste a token link. Sign in with Apple is gated OFF for v1 (single-
    // tenant M0 + App Store 5.1.1(v) account-deletion); re-enable via LISA_ENABLE_SIWA.
    @ViewBuilder private var cloudSections: some View {
        #if LISA_ENABLE_SIWA
        Section {
            TextField("https://your-instance.run.app", text: $cloudURL)
                .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
            SignInWithAppleButton(.continue,
                onRequest: { req in req.requestedScopes = [.fullName, .email] },
                onCompletion: handleApple)
                .signInWithAppleButtonStyle(.white)
                .frame(height: 46)
                .cornerRadius(Theme.cardRadius)
                .disabled(appleBusy || AppState.parseCloudBase(cloudURL) == nil)
                .opacity(appleBusy ? 0.5 : 1)
            if appleBusy { ProgressView().tint(Theme.accent) }
        } header: {
            Text("Sign in")
        } footer: {
            Text("Enter your LISA Cloud URL, then sign in. Your Mac isn't needed.")
        }
        #endif

        Section {
            TextField("https://…/?token=", text: $pasteText)
                .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
            Button("Connect") { apply(pasteText) }
                .disabled(pasteText.isEmpty)
        } header: {
            Text("LISA Cloud")
        } footer: {
            Text("Paste your LISA Cloud URL (including its ?token=…) — your Mac isn't needed.")
        }
    }

    // ── Mac: paste a pairing link, or enter host/port/token ──
    @ViewBuilder private var macSections: some View {
        Section {
            TextField("lisa-pair://… or http://host:port/?token=", text: $pasteText)
                .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
            Button("Apply") { apply(pasteText) }
                .disabled(pasteText.isEmpty)
        } header: {
            Text("Paste pairing link")
        } footer: {
            Text("Run `lisa pair` on your Mac and copy the link it prints.")
        }

        Section("Or enter manually") {
            TextField("Host (IP or tailnet name)", text: $host)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
            TextField("Port", text: $portText).keyboardType(.numberPad)
            SecureField("Device token", text: $token)
            Button("Connect") {
                app.update(host: host.trimmingCharacters(in: .whitespaces),
                           port: Int(portText) ?? 5757,
                           token: token.isEmpty ? nil : token, scheme: "http")
                if app.config.isConfigured { finish() } else { error = "Enter a host and token." }
            }
            .disabled(host.isEmpty || token.isEmpty)
        }
    }

    #if LISA_ENABLE_SIWA
    /// Handle the Sign in with Apple result: pull the identity token, exchange it
    /// at the entered cloud URL for a session token, and save the connection.
    /// Gated OFF for v1 — see cloudSections.
    private func handleApple(_ result: Result<ASAuthorization, Error>) {
        error = nil
        switch result {
        case .failure(let err):
            // A user-cancelled prompt isn't an error worth shouting about.
            if (err as? ASAuthorizationError)?.code == .canceled { return }
            error = err.localizedDescription
        case .success(let auth):
            guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
                  let data = cred.identityToken, let idToken = String(data: data, encoding: .utf8) else {
                error = "Apple didn't return an identity token."
                return
            }
            appleBusy = true
            Task {
                defer { appleBusy = false }
                do {
                    try await app.connectCloudWithApple(baseURL: cloudURL, identityToken: idToken)
                    finish()
                } catch LisaError.http(404) {
                    error = "This LISA Cloud instance hasn't enabled Sign in with Apple. Paste a token link instead."
                } catch LisaError.http(401), LisaError.http(403) {
                    error = "Apple sign-in was rejected by this instance."
                } catch {
                    self.error = "Couldn't reach that LISA Cloud URL."
                }
            }
        }
    }
    #endif

    private func apply(_ raw: String) {
        if app.applyPairing(raw) { finish() }
        else { error = mode == .cloud ? "Couldn't read that cloud URL." : "Couldn't read that pairing link." }
    }
    private func finish() { dismiss(); onPaired() }
}
