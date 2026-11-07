#if DEBUG
import AppKit

/// Visual QA uses the real views with inert fixtures, never the owner's session.
@MainActor
enum CloudPreview {
    static var controller: NSWindowController?
    static func launchIfRequested() -> Bool {
        guard let argument = CommandLine.arguments.first(where: { $0.hasPrefix("--preview-cloud=") }) else { return false }
        let scene = String(argument.dropFirst("--preview-cloud=".count))
        if CommandLine.arguments.contains("--light") { NSApp.appearance = NSAppearance(named: .aqua) }
        if CommandLine.arguments.contains("--dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
        let account = CloudAccountModel(connection: CloudConnectionModel())
        account.preview = true; account.connection.preview = true
        account.email = "alex@example.com"; account.accountEmail = "alex@example.com"
        account.connection.loaded = true
        account.connection.state = CloudConnectionState(["enabled": true, "online": true, "name": "Alex's MacBook Pro", "requireSecurePairing": true])
        switch scene {
        case "code": account.step = .code; account.resendAfter = Date().addingTimeInterval(30)
        case "password": account.step = .password
        case "error":
            account.step = .code
            account.notice = CloudNotice(text: "This code has expired. Request a new code below.", kind: .error)
        case "expired": account.notice = CloudNotice(text: "Your session has expired. Sign in again to reconnect your devices.", kind: .warning)
        case "connected", "offline", "busy":
            account.signedIn = true; account.accountVerified = true
            if scene == "offline" { account.connection.state.online = false }
            if scene == "busy" {
                account.needsApply = true
                account.applying = true
                account.applicationMessage = "Applying your account. Lisa will be ready in a moment…"
            }
        default: break
        }
        if ["devices", "pairing", "legacy", "waiting", "long-name"].contains(scene) {
            let connection = account.connection
            if scene != "devices" {
                connection.state.pending = [CloudDevice([
                    "id": "preview-only", "name": scene == "long-name" ? "Alex's iPhone with a deliberately long device name" : "Alex's iPhone",
                    "code": scene == "waiting" ? "" : "A1B2 C3D4 E5F6", "secure": scene != "legacy", "known": false,
                ])]
            }
            let window = RemoteDevicesWindow(model: connection)
            controller = window; window.show()
        } else {
            let window = AccountWindowController(model: account)
            controller = window; window.show()
        }
        if CommandLine.arguments.contains("--compact") {
            controller?.window?.setContentSize(NSSize(width: 460, height: 540))
        }
        return true
    }
}
#endif
