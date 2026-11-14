import SwiftUI
import UIKit

/// Settings → Connection diagnostics: everything needed to tell why Pocket can't
/// reach Lisa, on one screen a user can screenshot or copy for support (#496).
/// Shows no credentials: only when the session expires, never the token.
struct ConnectionDiagnosticsView: View {
    @EnvironmentObject private var app: AppState
    @ObservedObject private var log = ConnectionLog.shared
    @State private var checking = false
    @State private var checkResult: String?

    var body: some View {
        List {
            Section("Connection") {
                LabeledContent("Mode", value: app.connectionMode.label)
                LabeledContent("Server", value: serverLabel)
                if app.config.remoteMac != nil {
                    LabeledContent("Route", value: app.remoteRoute)
                    if let problem = app.remoteRouteProblem?.display {
                        Text(problem.message).font(.footnote).foregroundStyle(Theme.waiting)
                    }
                }
                LabeledContent("Network", value: app.onCellular ? "Cellular" : "Wi-Fi or wired")
                Button(checking ? "Checking…" : "Check connection") { check() }
                    .disabled(checking || !app.config.isConfigured)
                if let checkResult { Text(checkResult).font(.footnote) }
            }

            Section("LISA account") {
                LabeledContent("Account", value: accountLabel)
                LabeledContent("Session", value: sessionLabel)
                if app.sessionExpired {
                    Button("Sign in again") { app.beginSignInAgain() }
                }
            }

            Section {
                if log.entries.isEmpty {
                    Text("No errors since Lisa Pocket opened.").foregroundStyle(.secondary)
                }
                ForEach(log.entries) { entry in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(entry.what).font(.caption.monospaced())
                            Spacer()
                            Text(entry.date, style: .time).font(.caption2).foregroundStyle(.secondary)
                        }
                        Text(entry.detail).font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Recent errors")
            } footer: {
                Text("The last 20 failed requests, newest first. They stay on this iPhone.")
            }

            Section {
                Button("Copy diagnostics") {
                    UIPasteboard.general.string = report
                    app.notify("Diagnostics copied.")
                }
                Button("Clear errors", role: .destructive) { log.clear() }
                    .disabled(log.entries.isEmpty)
            } footer: {
                Text("The copy has no passwords or tokens. Paste it into a support request.")
            }
        }
        .navigationTitle("Connection diagnostics")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var serverLabel: String {
        if let mac = app.config.remoteMac { return "\(mac.name) via your LISA account" }
        guard app.config.isConfigured else { return "Not set up" }
        return app.config.baseURL?.host ?? app.config.host
    }

    private var accountLabel: String {
        if let account = app.account, account.signedIn { return account.email ?? "Signed in" }
        if app.accountUnavailable { return "Unknown (LISA Cloud unreachable)" }
        return app.savedCloudConfig.token == nil ? "Not signed in" : "Not signed in on this connection"
    }

    private var sessionLabel: String {
        guard let claims = SessionToken.claims(app.savedCloudConfig.token) else { return "None" }
        if app.sessionExpired || claims.expiresAt <= Date() { return "Expired — sign in again" }
        let style = Date.RelativeFormatStyle(presentation: .named)
        return "Renews automatically · expires \(claims.expiresAt.formatted(style))"
    }

    private func check() {
        checking = true
        checkResult = nil
        Task {
            defer { checking = false }
            switch await app.verifyConnection() {
            case .ok: checkResult = "Lisa answered. The connection works."
            case .unauthorized: checkResult = "Lisa answered, but rejected this device's credential."
            case .serverError(let code): checkResult = "Lisa answered with an error (HTTP \(code))."
            case .unreachable: checkResult = "Lisa didn't answer."
            }
        }
    }

    /// Plain text for support: settings and error summaries, no credentials.
    private var report: String {
        let info = Bundle.main.infoDictionary
        var lines = [
            "Lisa Pocket \(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))",
            "iOS \(UIDevice.current.systemVersion)",
            "Mode: \(app.connectionMode.label)",
            "Server: \(serverLabel)",
            "Network: \(app.onCellular ? "cellular" : "wifi/wired")",
            "Account: \(accountLabel)",
            "Session: \(sessionLabel)",
        ]
        if app.config.remoteMac != nil { lines.append("Route: \(app.remoteRoute)") }
        let stamp = ISO8601DateFormatter()
        for entry in log.entries {
            lines.append("\(stamp.string(from: entry.date)) \(entry.what) — \(entry.detail)")
        }
        return lines.joined(separator: "\n")
    }
}
