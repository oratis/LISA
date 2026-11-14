import SwiftUI

struct MacConnectionsView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    /// Refuse Macs that only speak pairing v1 (LISA 0.30 and earlier).
    @AppStorage("lisa.link.requireSecurePairing") private var requireSecurePairing = false
    @State private var hosts: [LisaClient.RelayHost] = []
    @State private var accountUID = ""
    /// The account this phone is signed in to, so a Mac on another account
    /// isn't a silent "No Mac is online" (#494).
    @State private var accountEmail = ""
    /// The saved LISA session was rejected: offer sign-in instead of "HTTP 401".
    @State private var needsSignIn = false
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
            } else if needsSignIn {
                Section {
                    Text("Your LISA session expired. Sign in again, then come back here.")
                        .foregroundStyle(.secondary)
                    Button("Sign in again") { app.noteSessionExpired(); app.beginSignInAgain(); dismiss() }
                }
            } else {
                Section {
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
                } header: {
                    Text("Your Macs")
                } footer: {
                    if !accountEmail.isEmpty {
                        Text("Signed in as \(accountEmail). Your Mac must be signed in to this same account to appear here.")
                    }
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
                    if let problem = app.remoteRouteProblem, let shown = problem.display {
                        Label(shown.message, systemImage: problem.icon)
                            .font(.footnote).foregroundStyle(Theme.waiting)
                    }
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
        .consoleBackground()
        .navigationTitle("Connect your Mac")
        // Keep the list current while it's on screen: a Mac waking up appears
        // without a manual Refresh (#494). Pauses while pairing.
        .task(id: selected == nil) {
            while selected == nil && !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(nanoseconds: 8_000_000_000) } catch { return }
            }
        }
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
        // Tell the Mac first, so the code can't be approved after the phone left.
        if let transport { Task { await transport.cancelPairing(); await transport.invalidate() } }
        selected = nil; transport = nil; code = ""; confirmed = false; authorized = false; secure = true
        comparable = true
    }
    private func select(_ host: LisaClient.RelayHost) {
        guard let origin = app.savedCloudConfig.baseURL?.absoluteString, !accountUID.isEmpty else { return }
        if let transport { Task { await transport.cancelPairing(); await transport.invalidate() } }
        let target = RemoteMacTarget(id: host.id, name: host.name, publicKey: host.publicKey,
                                     cloudOrigin: origin, accountUID: accountUID)
        transport = RemoteMacTransport(target: target, pairing: true)
        selected = target; code = ""; status = ""; confirmed = false; authorized = false; secure = true
        comparable = true
    }
    /// `/api/relay/macs` refused although `/api/auth/me` just confirmed the
    /// account: the cloud has no Mac relay. Its 403 says
    /// `account_session_required` (older servers: no code at all), which here
    /// can't mean "sign in", so it must not read as a sign-in problem.
    nonisolated static func macConnectionsUnavailable(_ error: Error) -> Bool {
        if error.httpStatus == 404 { return true }
        guard error.httpStatus == 403 else { return false }
        let code = error.serverFailure?.code ?? ""
        return code.isEmpty || code == "account_session_required"
    }

    private func refresh() async {
        guard app.savedCloudConfig.token != nil else { return }
        loading = true; defer { loading = false }
        let config = app.savedCloudConfig
        let client = LisaClient(config: config)
        do {
            let me = try await client.authMe()
            guard me.signedIn, let uid = me.uid else { throw RemoteLinkError.signIn }
            accountUID = uid
            accountEmail = me.email ?? ""
            needsSignIn = false
            hosts = try await client.remoteMacs()
            status = ""
        } catch let error where Self.macConnectionsUnavailable(error) {
            hosts = []; status = "This cloud service hasn't enabled Mac connections yet."
        } catch {
            let problem = ConnectionProblem.classify(error, config: config)
            if problem == .signInRequired {
                needsSignIn = true
                hosts = []; status = ""
                return
            }
            if problem == .cancelled { return }
            // Keep the last list on a brief network blip; say why it may be stale.
            status = problem.sentence ?? error.localizedDescription
        }
    }
}
