import SwiftUI
import AuthenticationServices

struct SettingsView: View {
    @EnvironmentObject var app: AppState
    @State private var host = ""
    @State private var portText = "5757"
    @State private var token = ""
    @State private var pairText = ""
    @State private var policy: ControlPolicy?
    @State private var ntfyTopic = ""
    @State private var ntfyServer = ""
    @State private var transport: PushTransport = .ntfy
    @State private var prefs = PushPrefs()
    /// What the Mac says it will actually publish to (GET /api/push/list).
    @State private var pushSubs: [PushSubscriptionDTO] = []
    @State private var pushLoaded = false
    @State private var testBusy = false
    @State private var testStatus = ""
    @State private var status = ""
    @State private var showScanner = false
    @State private var showUnpairConfirm = false
    @State private var connectBusy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Connect to", selection: Binding(
                        get: { app.connectionMode },
                        set: { app.setConnectionMode($0) })) {
                        ForEach(ConnectionMode.allCases) { m in Text(m.label).tag(m) }
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text(app.connectionMode == .mac
                         ? "Talk to your own Mac running Lisa — your data stays on your Mac."
                         : "Use hosted LISA Cloud — no Mac needed.")
                }

                Section {
                    Button { app.presentOnboarding() } label: {
                        Label("Set up / re-pair…", systemImage: "wand.and.stars")
                    }
                } footer: {
                    Text("Walk through installing LISA on your Mac and pairing this iPhone.")
                }

                if app.connectionMode == .mac {
                    Section("Connection") {
                        TextField("Host (IP or tailnet name)", text: $host)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        TextField("Port", text: $portText)
                            .keyboardType(.numberPad)
                        SecureField("Device token", text: $token)
                        Button("Save") {
                            app.update(host: host, port: Int(portText) ?? 5757, token: token.isEmpty ? nil : token)
                            status = "Saved."
                        }
                    }

                    Section("Pair from QR / URL") {
                        Button {
                            showScanner = true
                        } label: {
                            Label("Scan QR code", systemImage: "qrcode.viewfinder")
                        }
                        TextField("lisa-pair://… or http://host:port/?token=", text: $pairText)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                        Button("Apply pairing") {
                            if app.applyPairing(pairText) {
                                syncFromConfig()
                                verifyAndReport(prefix: "Paired")
                            } else {
                                status = "Couldn't parse that pairing string."
                            }
                        }
                        .disabled(pairText.isEmpty || connectBusy)
                        Text("Run `lisa pair` on your Mac and scan the QR — over the same Wi-Fi (LAN) or a Tailscale tailnet name.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    // Cloud data plane: LISA accounts are the primary flow (B1) —
                    // signed-in card when we have an account session, the shared
                    // sign-in form (SIWA / email / advanced token link) otherwise.
                    if app.account?.signedIn == true {
                        AccountCard()
                    } else {
                        CloudSignInForm { outcome in
                            switch outcome {
                            case .ok:
                                app.notify("Connected to LISA Cloud.")
                            case .unauthorized:
                                app.notify("Signed in, but the connection was rejected (401) — try again.", ok: false)
                            case .serverError(let code):
                                app.notify("LISA Cloud responded with an error (\(code)).", ok: false)
                            case .unreachable:
                                app.notify("Couldn't reach LISA Cloud — check the URL and your connection.", ok: false)
                            }
                        }
                    }
                }

                Section("Notifications") {
                    Picker("Deliver via", selection: $transport) {
                        ForEach(PushTransport.allCases) { t in Text(t.label).tag(t) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("Notification transport")

                    if transport == .ntfy {
                        TextField("ntfy topic", text: $ntfyTopic)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .accessibilityHint("Anyone who knows this topic can read your alerts — make it hard to guess")
                        TextField("ntfy server (optional)", text: $ntfyServer)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                    }

                    // The honest line: built from GET /api/push/list, never from
                    // "we sent a register request" (the UX-12 dead end).
                    Text(PushSettings.stateLine(transport: transport, subs: pushSubs, loaded: pushLoaded,
                                                apnsToken: app.apnsToken, ntfyTopic: ntfyTopic))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if transport == .apns {
                        Button("Enable push notifications") {
                            Task { await app.enablePush(prefs: prefs); await loadPush() }
                        }
                        if !app.pushStatus.isEmpty {
                            Text(app.pushStatus).font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else {
                        Button("Register") {
                            Task { @MainActor in
                                do {
                                    _ = try await app.client.pushRegister(
                                        kind: "ntfy", target: ntfyTopic.trimmed,
                                        server: ntfyServer.trimmed.isEmpty ? nil : ntfyServer.trimmed,
                                        prefs: prefs)
                                    saveNtfyDefaults()
                                    app.notify("Your Mac will publish to “\(ntfyTopic.trimmed)”.")
                                    await loadPush()
                                } catch {
                                    app.notify((error as? LocalizedError)?.errorDescription ?? "Couldn't register push.", ok: false)
                                }
                            }
                        }
                        .disabled(ntfyTopic.trimmed.isEmpty)

                        // A real end-to-end check: publishing to an ntfy topic is
                        // an unauthenticated POST, so the phone can prove the topic
                        // + the ntfy app work without involving the Mac at all.
                        // There is no equivalent for APNs — the server exposes no
                        // test endpoint and Apple delivery can't be triggered from
                        // the device — so the button is honestly ntfy-only.
                        Button("Send a test notification") { Task { await sendTestNotification() } }
                            .disabled(ntfyTopic.trimmed.isEmpty || testBusy)
                        if !testStatus.isEmpty {
                            Text(testStatus).font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                Section("Notify me about") {
                    Toggle("Agent done", isOn: $prefs.done)
                    Toggle("Agent error", isOn: $prefs.error)
                    Toggle("Needs permission", isOn: $prefs.permission)
                    Toggle("While-away notes", isOn: $prefs.idle)   // was mislabeled "Reve notes" (B11)
                    Toggle("Advisor tips", isOn: $prefs.advisor)    // was hardcoded, never exposed (B11)
                    Toggle("Mail digest + alerts", isOn: $prefs.mail)
                    Toggle("Daily feeds brief", isOn: $prefs.brief)  // server had it; the app never showed it
                    if let sub = registeredSub {
                        // Flipping a switch used to do nothing until you happened
                        // to re-register. Say so, and give it a button.
                        if PushSettings.hasUnsavedPrefs(local: prefs, registered: sub.prefs) {
                            Button("Save preferences") {
                                Task { @MainActor in
                                    do {
                                        try await app.client.pushSetPrefs(id: sub.id, prefs: prefs)
                                        app.notify("Preferences saved.")
                                        await loadPush()
                                    } catch {
                                        app.notify((error as? LocalizedError)?.errorDescription ?? "Couldn't save preferences.", ok: false)
                                    }
                                }
                            }
                            Text("Unsaved — these apply once you tap Save preferences.")
                                .font(.caption).foregroundStyle(Theme.waiting)
                        } else {
                            Text("In sync with your Mac.").font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        Text("These apply when you register a destination above.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section("Remote-control policy (set on the Mac)") {
                    if let p = policy {
                        LabeledContent("Control own agents", value: p.remoteControl ? "allowed" : "blocked")
                        LabeledContent("Adopt external sessions", value: p.remoteAdoptExternal ? "allowed" : "blocked")
                    } else {
                        Text("—").foregroundStyle(.secondary)
                    }
                    Text("Change these on the Mac (localhost only).").font(.caption).foregroundStyle(.secondary)
                }

                Section("Appearance") {
                    Picker("Theme", selection: Binding(
                        get: { app.appearance },
                        set: { app.setAppearance($0) })) {
                        Text("Nebula (dark)").tag("nebula")
                        Text("Calm (light)").tag("calm")
                        Text("Auto (system)").tag("auto")
                    }
                    Text("Mirrors the Mac shell's Nebula / Calm theme pair.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Autonomy") {
                    Toggle("Proactive mode", isOn: Binding(
                        get: { app.proactiveEnabled },
                        set: { app.setProactive($0) }))
                        .tint(Theme.green)
                        .disabled(app.proactiveBusy || !app.proactiveAvailable)
                    Text(app.proactiveAvailable
                         ? "When on, Lisa reflects and pursues her desires while you're away (idle + heartbeat). Off means she only acts when you talk to her."
                         : "This Mac doesn't expose autonomy control yet — update Lisa to toggle it from here.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Privacy") {
                    NavigationLink { DevicesView() } label: { Label("Paired devices", systemImage: "iphone.gen3") }
                    // Sense (ambient-signal consent) — a privacy control, so it
                    // lives in Settings now rather than its own tab (review P4/H1).
                    NavigationLink { SenseView() } label: { Label("Sense (consent)", systemImage: "sensor.tag.radiowaves.forward") }
                }

                Section("Security") {
                    Toggle("Require Face ID / passcode", isOn: Binding(
                        get: { app.biometricLockEnabled },
                        set: { app.setBiometricLock($0) }))
                    Text("Locks the app behind biometrics — the device token grants full control of your Mac's agents.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Disconnect") {
                    Button("Unpair this Mac", role: .destructive) { showUnpairConfirm = true }
                        .disabled(!app.config.isConfigured)
                    Text("Removes the saved connection + device token from this iPhone. Your Mac and its data are untouched — pair again any time.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                // "Inspect Lisa" (Soul/Memory/Skills/Tools) moved to the Lisa home
                // tab — it's content about who Lisa is, not a setting (review H3).

                if !status.isEmpty {
                    Section { Text(status).font(.caption).foregroundStyle(.secondary) }
                }
            }
            .consoleBackground()
            .navigationTitle("Settings")
            .onAppear(perform: syncFromConfig)
            .task { policy = try? await app.client.controlPolicy(); await app.loadProactive(); await app.refreshAccount() }
            .task(id: app.config) { await loadPush() }
            .onChange(of: transport) { _, _ in adoptRegisteredPrefs() }
            .sheet(isPresented: $showScanner) {
                QRScanSheet(onScanned: handleScan, onError: { status = $0 })
            }
            .confirmationDialog("Unpair this Mac?", isPresented: $showUnpairConfirm, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    app.update(host: "", port: 5757, token: nil)
                    syncFromConfig()
                    status = "Unpaired — the device token was removed from this iPhone."
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Removes the connection + device token from this iPhone. Your Mac is untouched.")
            }
        }
    }

    func syncFromConfig() {
        host = app.config.host
        portText = String(app.config.port)
        token = app.config.token ?? ""
        let d = UserDefaults.standard
        // The topic used to live only in @State — leave Settings and it was gone,
        // so the section couldn't tell you what your Mac was publishing to.
        if ntfyTopic.isEmpty { ntfyTopic = d.string(forKey: "lisa.ntfy.topic") ?? "" }
        if ntfyServer.isEmpty { ntfyServer = d.string(forKey: "lisa.ntfy.server") ?? "" }
        if let saved = d.string(forKey: "lisa.push.transport"), let t = PushTransport(rawValue: saved) {
            transport = t
        }
    }

    private func saveNtfyDefaults() {
        let d = UserDefaults.standard
        d.set(ntfyTopic.trimmed, forKey: "lisa.ntfy.topic")
        d.set(ntfyServer.trimmed, forKey: "lisa.ntfy.server")
        d.set(transport.rawValue, forKey: "lisa.push.transport")
    }

    /// The destination this screen is currently talking about, as the Mac has it.
    private var registeredSub: PushSubscriptionDTO? {
        PushSettings.current(pushSubs, transport: transport,
                             target: transport == .apns ? (app.apnsToken ?? "") : ntfyTopic.trimmed)
    }

    private func loadPush() async {
        guard app.config.isConfigured else { pushLoaded = true; return }
        pushSubs = (try? await app.client.pushList()) ?? []
        pushLoaded = true
        // Adopt a topic we've never seen locally, so a phone that was set up on
        // another device (or reinstalled) shows the truth instead of a blank field.
        if ntfyTopic.trimmed.isEmpty, let n = pushSubs.first(where: { $0.transport == .ntfy }) {
            ntfyTopic = n.target
            ntfyServer = n.server ?? ""
        }
        adoptRegisteredPrefs()
    }

    /// Start the toggles from what the Mac stored, so "unsaved" means a real edit.
    private func adoptRegisteredPrefs() {
        if let p = registeredSub?.prefs { prefs = p }
        app.pushPrefs = prefs
        saveNtfyDefaults()
    }

    private func sendTestNotification() async {
        testBusy = true
        defer { testBusy = false }
        testStatus = "Sending…"
        saveNtfyDefaults()
        switch await NtfyTester.send(server: ntfyServer.trimmed.isEmpty ? nil : ntfyServer.trimmed,
                                     topic: ntfyTopic.trimmed) {
        case .sent:
            testStatus = "Sent. It should appear in the ntfy app within a few seconds — if it doesn't, you're not subscribed to that topic there."
        case .badTopic:
            testStatus = "That topic isn't usable as a URL — try letters, digits, - and _."
        case .rejected(let code):
            testStatus = "The ntfy server refused it (HTTP \(code)). A self-hosted server may need auth, which Lisa Pocket doesn't send."
        case .unreachable(let why):
            testStatus = "Couldn't reach the ntfy server: \(why)"
        }
    }

    /// Probe the just-applied Mac pairing and report the real outcome into the
    /// status line (same fake-success fix as connectCloud, for the LAN path).
    private func verifyAndReport(prefix: String) {
        status = "\(prefix) — checking the connection…"
        connectBusy = true
        Task {
            defer { connectBusy = false }
            switch await app.verifyConnection() {
            case .ok:
                status = "\(prefix) and connected."
            case .unauthorized:
                status = "\(prefix), but the token was rejected — run `lisa pair` on the Mac and re-scan."
            case .serverError(let code):
                status = "\(prefix), but the Mac returned an error (\(code))."
            case .unreachable:
                status = "\(prefix), but your Mac is unreachable — same Wi-Fi / Tailscale? Did you serve with --host 0.0.0.0?"
            }
        }
    }

    /// Apply a scanned code the same way pasted text is applied; on a parse failure,
    /// drop it into the text field so the user can see/fix what was scanned.
    func handleScan(_ value: String) {
        if app.applyPairing(value) {
            syncFromConfig()
            verifyAndReport(prefix: "Paired")
        } else {
            pairText = value
            status = "Scanned a code, but couldn't parse it as a pairing string."
        }
    }
}

/// The scanner presented as a sheet: a viewfinder plus a Cancel button. Fires at
/// most one outcome, then dismisses itself (which flips the parent's binding back).
private struct QRScanSheet: View {
    let onScanned: (String) -> Void
    let onError: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var finished = false

    var body: some View {
        NavigationStack {
            QRScannerView(
                onScan: { value in finish { onScanned(value) } },
                onError: { reason in finish { onError(reason) } }
            )
            .ignoresSafeArea()
            .overlay(alignment: .bottom) {
                Text("Point at the QR code Lisa shows on your Mac.")
                    .font(.caption)
                    .padding(8)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
            }
            .navigationTitle("Scan to pair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    /// Run the outcome once (the camera can fire repeatedly), then dismiss.
    private func finish(_ action: () -> Void) {
        guard !finished else { return }
        finished = true
        action()
        dismiss()
    }
}
