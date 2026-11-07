import SwiftUI

struct MacConnectionsView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var hosts: [LisaClient.RelayHost] = []
    @State private var accountUID = ""
    @State private var status = ""
    @State private var code = ""
    @State private var selected: RemoteMacTarget?
    @State private var transport: RemoteMacTransport?
    @State private var loading = false

    var body: some View {
        List {
            Section {
                Text("Sign in to the same LISA account on your Mac, then open Connect iPhone from its menu.")
                    .foregroundStyle(.secondary)
            }
            if app.savedCloudConfig.token == nil {
                Section {
                    Button("Sign in to LISA") { app.setConnectionMode(.cloud); dismiss() }
                }
            } else {
                Section("Your Macs") {
                    if hosts.isEmpty && !loading {
                        Text("No Mac is online. Keep LISA running and enable phone connections on your Mac.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(hosts) { host in
                        Button {
                            select(host)
                        } label: {
                            Label(host.name, systemImage: "desktopcomputer")
                        }
                        .disabled(selected != nil)
                    }
                    Button("Refresh", action: { Task { await refresh() } }).disabled(loading)
                }
            }
            if let selected {
                Section("Authorize on \(selected.name)") {
                    if !code.isEmpty {
                        Text(code).font(.title2.monospaced()).textSelection(.enabled)
                        Text("Compare this code with the request on your Mac, then choose Allow. Keep this screen open until connected.")
                    } else { ProgressView("Connecting…") }
                    Button("Cancel", role: .cancel) {
                        if let transport { Task { await transport.invalidate() } }
                        self.selected = nil; transport = nil; code = ""
                    }
                }
            }
            if let target = app.config.remoteMac {
                Section("Current connection") {
                    LabeledContent(target.name, value: app.remoteRoute)
                    Text("Local network is preferred. Cloud relay takes over when you're away. Your Mac must remain awake and online.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !status.isEmpty { Section { Text(status).font(.footnote).foregroundStyle(.secondary) } }
        }
        .navigationTitle("Connect your Mac")
        .task { await refresh() }
        .task(id: selected?.id) {
            guard let target = selected, let transport else { return }
            while !Task.isCancelled {
                do {
                    let authorization = try await transport.authorization()
                    guard selected == target else { return }
                    code = authorization.code
                    if authorization.authorized {
                        app.connectRemoteMac(target)
                        self.selected = nil; self.transport = nil
                        await transport.invalidate()
                        return
                    }
                    status = "Waiting for approval on your Mac."
                } catch {
                    if Task.isCancelled { return }
                    status = error.localizedDescription
                }
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
    }
    private func select(_ host: LisaClient.RelayHost) {
        guard let origin = app.savedCloudConfig.baseURL?.absoluteString, !accountUID.isEmpty else { return }
        if let transport { Task { await transport.invalidate() } }
        let target = RemoteMacTarget(id: host.id, name: host.name, publicKey: host.publicKey,
                                     cloudOrigin: origin, accountUID: accountUID)
        transport = RemoteMacTransport(target: target, pairing: true)
        selected = target; code = ""; status = ""
    }
    private func refresh() async {
        guard app.savedCloudConfig.token != nil else { return }
        loading = true; defer { loading = false }
        let client = LisaClient(config: app.savedCloudConfig)
        do {
            let me = try await client.authMe()
            guard me.signedIn, let uid = me.uid else { throw RemoteLinkError.signIn }
            accountUID = uid
            hosts = try await client.remoteMacs()
            status = ""
        } catch LisaError.http(403), LisaError.http(404) {
            hosts = []; status = "This cloud service hasn't enabled Mac connections yet."
        } catch {
            hosts = []; status = error.localizedDescription
        }
    }
}
