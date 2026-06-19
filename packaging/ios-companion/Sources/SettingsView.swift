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

                Section("Remote-control policy (set on the Mac)") {
                    if let p = policy {
                        LabeledContent("Control own agents", value: p.remoteControl ? "allowed" : "blocked")
                        LabeledContent("Adopt external sessions", value: p.remoteAdoptExternal ? "allowed" : "blocked")
                    } else {
                        Text("—").foregroundStyle(.secondary)
                    }
                    Text("Change these on the Mac (localhost only).").font(.caption).foregroundStyle(.secondary)
                }

                if !status.isEmpty {
                    Section { Text(status).font(.caption).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Settings")
            .onAppear(perform: syncFromConfig)
            .task { policy = try? await app.client.controlPolicy() }
        }
    }

    func syncFromConfig() {
        host = app.config.host
        portText = String(app.config.port)
        token = app.config.token ?? ""
    }
}
