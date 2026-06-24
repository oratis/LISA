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

    var body: some View {
        NavigationStack {
            Form {
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
                    Button("Apply pairing") {
                        if app.applyPairing(pairText) {
                            syncFromConfig()
                            status = "Paired."
                        } else {
                            status = "Couldn't parse that pairing string."
                        }
                    }
                    .disabled(pairText.isEmpty)
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
            .navigationTitle("Settings")
            .onAppear(perform: syncFromConfig)
            .task { policy = try? await app.client.controlPolicy() }
            .sheet(isPresented: $showScanner) {
                QRScanSheet(onScanned: handleScan, onError: { status = $0 })
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
