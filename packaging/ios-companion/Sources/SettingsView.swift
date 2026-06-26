import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var app: AppState
    @State private var host = ""
    @State private var portText = "5757"
    @State private var token = ""
    @State private var pairText = ""
    @State private var policy: ControlPolicy?
    @State private var ntfyTopic = ""
    @State private var prefs = PushPrefs()
    @State private var status = ""
    @State private var showScanner = false
    @State private var showUnpairConfirm = false

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
                                status = "Paired."
                            } else {
                                status = "Couldn't parse that pairing string."
                            }
                        }
                        .disabled(pairText.isEmpty)
                        Text("Run `lisa pair` on your Mac and scan the QR — over the same Wi-Fi (LAN) or a Tailscale tailnet name.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Section("LISA Cloud") {
                        TextField("https://…run.app/?token=", text: $pairText)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                        Button("Connect") {
                            if app.applyPairing(pairText) {
                                syncFromConfig()
                                status = "Connected to LISA Cloud."
                            } else {
                                status = "Couldn't parse that cloud URL."
                            }
                        }
                        .disabled(pairText.isEmpty)
                        Button {} label: {
                            Label("Sign in with Apple (coming soon)", systemImage: "person.crop.circle")
                        }
                        .disabled(true)
                        Text("Paste your LISA Cloud URL + token. Sign in with Apple is coming.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section("Push (ntfy)") {
                    TextField("ntfy topic", text: $ntfyTopic)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Toggle("Agent done", isOn: $prefs.done)
                    Toggle("Agent error", isOn: $prefs.error)
                    Toggle("Needs permission", isOn: $prefs.permission)
                    Toggle("Reve notes", isOn: $prefs.idle)
                    Toggle("Mail digest + alerts", isOn: $prefs.mail)
                    Button("Register push") {
                        Task { @MainActor in
                            do {
                                try await app.client.pushRegister(kind: "ntfy", target: ntfyTopic, prefs: prefs)
                                status = "Push registered."
                            } catch {
                                status = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                            }
                        }
                    }
                    .disabled(ntfyTopic.isEmpty)
                }

                Section("Push (APNs)") {
                    Button("Enable push notifications") { Task { await app.enablePush() } }
                    if !app.pushStatus.isEmpty {
                        Text(app.pushStatus).font(.caption).foregroundStyle(.secondary)
                    }
                    Text("Native Apple Push. Delivery needs an APNs key set on the Mac; ntfy works without one.")
                        .font(.caption).foregroundStyle(.secondary)
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

                Section {
                    NavigationLink { DevicesView() } label: { Label("Paired devices", systemImage: "iphone.gen3") }
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

                Section("Inspect Lisa") {
                    NavigationLink { SoulView() } label: { Label("Soul", systemImage: "sparkles") }
                    NavigationLink { MemoryView() } label: { Label("Memory", systemImage: "brain") }
                    NavigationLink { NamedListView(title: "Skills", load: { try await app.client.skills() }) } label: {
                        Label("Skills", systemImage: "wand.and.stars")
                    }
                    NavigationLink { NamedListView(title: "Tools", load: { try await app.client.tools() }) } label: {
                        Label("Tools", systemImage: "hammer")
                    }
                }

                if !status.isEmpty {
                    Section { Text(status).font(.caption).foregroundStyle(.secondary) }
                }
            }
            .consoleBackground()
            .navigationTitle("Settings")
            .onAppear(perform: syncFromConfig)
            .task { policy = try? await app.client.controlPolicy(); await app.loadProactive() }
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
    }

    /// Apply a scanned code the same way pasted text is applied; on a parse failure,
    /// drop it into the text field so the user can see/fix what was scanned.
    func handleScan(_ value: String) {
        if app.applyPairing(value) {
            syncFromConfig()
            status = "Paired."
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
