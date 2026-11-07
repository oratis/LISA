import SwiftUI

struct MacConnectionsView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    /// Refuse Macs that only speak pairing v1 (LISA 0.30 and earlier).
    @AppStorage("lisa.link.requireSecurePairing") private var requireSecurePairing = false
    @State private var hosts: [LisaClient.RelayHost] = []
    @State private var accountUID = ""
    @State private var status = ""
    @State private var code = ""
    @State private var secure = true
    @State private var comparable = true
    @State private var authorized = false
    /// The user compared the codes on this phone. Pocket pins a Mac's key only after this:
    /// otherwise a relay could pose as the Mac and simply claim the phone was approved.
    @State private var confirmed = false
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
                        // Each device describes only its own side of the pairing.
                        if secure {
                            Text("This iPhone is using secure pairing. If your Mac warns about an older pairing method, tap Cancel.")
                                .font(.footnote).foregroundStyle(.secondary)
                        } else {
                            Label("Older pairing method: the Mac answered as LISA 0.30 or earlier, so a compromised relay could fake this code. Update LISA on your Mac to pair securely.",
                                  systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                        }
                        if !secure && requireSecurePairing {
                            Text("Require Secure Pairing is on, so Pocket won't add this Mac. Update LISA on your Mac, then select it again.")
                        } else if !comparable {
                            // No button: without a code on the Mac there is nothing to verify.
                            Text("Your Mac already allows this iPhone, but its older LISA shows no code to compare, so Pocket can't verify it. On your Mac, open Connect iPhone and disconnect this iPhone, then select your Mac here again.")
                        } else if confirmed {
                            Text(authorized ? "Connecting…" : "Now choose Allow on your Mac. Keep this screen open until connected.")
                        } else {
                            Text("Check that your Mac shows exactly this code. If it does, tap Codes Match and choose Allow on your Mac. If it doesn't, tap Cancel.")
                            Button("Codes Match") { confirmed = true }
                        }
                    } else { ProgressView("Connecting…") }
                    Button("Cancel", role: .cancel) { cancelPairing() }
                }
            }
            if let target = app.config.remoteMac {
                Section("Current connection") {
                    LabeledContent(target.name, value: app.remoteRoute)
                    Text("Local network is preferred. Cloud relay takes over when you're away. Your Mac must remain awake and online.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                Toggle("Require Secure Pairing", isOn: $requireSecurePairing)
            } footer: {
                Text("Refuse the older pairing method (LISA 0.30 and earlier on the Mac), whose code a compromised relay could fake. Full protection also needs Require secure pairing on the Mac.")
            }
            if !status.isEmpty { Section { Text(status).font(.footnote).foregroundStyle(.secondary) } }
        }
        .navigationTitle("Connect your Mac")
        .task { await refresh() }
        .task(id: "\(selected?.id ?? "")|\(confirmed)|\(requireSecurePairing)") { await poll() }
    }
    private func poll() async {
        guard let target = selected, let transport else { return }
        while !Task.isCancelled {
            do {
                let pairing = try await transport.pairingStatus()
                guard selected == target else { return }
                // A confirmation only ever covers the code the user actually saw.
                if pairing.code != code { confirmed = false }
                code = pairing.code; secure = pairing.secure; authorized = pairing.authorized
                comparable = pairing.comparable
                if !pairing.open {
                    status = "Your Mac has no open request from this iPhone (it was dismissed or expired). Select your Mac to try again."
                    cancelPairing()
                    return
                }
                if (!pairing.secure && requireSecurePairing) || !pairing.comparable { status = ""; return }
                if pairing.mayConnect(confirmed: confirmed, requireSecure: requireSecurePairing) {
                    app.connectRemoteMac(target)
                    self.selected = nil; self.transport = nil
                    await transport.invalidate()
                    return
                }
                status = pairing.authorized ? "" : "Waiting for approval on your Mac."
            } catch RemoteLinkError.pairingRestarted {
                code = ""; confirmed = false
                status = RemoteLinkError.pairingRestarted.localizedDescription
            } catch RemoteLinkError.pairingAborted {
                status = RemoteLinkError.pairingAborted.localizedDescription
                cancelPairing()
                return
            } catch {
                if Task.isCancelled { return }
                status = error.localizedDescription
            }
            do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
        }
    }
    private func cancelPairing() {
        if let transport { Task { await transport.invalidate() } }
        selected = nil; transport = nil; code = ""; confirmed = false; authorized = false; secure = true
        comparable = true
    }
    private func select(_ host: LisaClient.RelayHost) {
        guard let origin = app.savedCloudConfig.baseURL?.absoluteString, !accountUID.isEmpty else { return }
        if let transport { Task { await transport.invalidate() } }
        let target = RemoteMacTarget(id: host.id, name: host.name, publicKey: host.publicKey,
                                     cloudOrigin: origin, accountUID: accountUID)
        transport = RemoteMacTransport(target: target, pairing: true)
        selected = target; code = ""; status = ""; confirmed = false; authorized = false; secure = true
        comparable = true
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
