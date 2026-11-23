import SwiftUI

func workspaceText(_ text: String) -> String {
    NSLocalizedString(text, tableName: "Workspace", value: text, comment: "")
}

enum Workspace: String {
    case welcome, cloud, mac

    static let preference = "ai.meetlisa.workspace"
    static let frameName = "ai.meetlisa.app.MainWindow.v2-redesign"

    static func restore(in defaults: UserDefaults) -> Self {
        if let saved = defaults.string(forKey: preference), let workspace = Self(rawValue: saved) {
            return workspace
        }
        // Older releases always opened My Mac. Read this before constructing
        // the window, which can write its own autosaved frame even on first run.
        let initial: Self = defaults.object(forKey: "NSWindow Frame " + frameName) == nil ? .welcome : .mac
        defaults.set(initial.rawValue, forKey: preference)
        return initial
    }

    var title: String {
        switch self {
        case .cloud: return "LISA Cloud"
        case .mac: return workspaceText("My Mac")
        case .welcome: return "Lisa"
        }
    }
}

struct WorkspaceWelcome: View {
    let select: (Workspace) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "cloud")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(CloudStyle.accent)
                .accessibilityHidden(true)
            Text(workspaceText("Welcome to Lisa"))
                .font(.system(size: 34, weight: .medium, design: .serif))
                .accessibilityAddTraits(.isHeader)
            Text(workspaceText("Sign in with the account you use in Lisa Pocket to open your cloud chats, memories and services on this Mac."))
                .font(.body).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(workspaceText("Continue with LISA Cloud")) { select(.cloud) }
                .buttonStyle(CloudPrimaryButton()).keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("workspace.continue-cloud")
            Divider().padding(.vertical, 3)
            Button(workspaceText("Use My Mac")) { select(.mac) }
                .accessibilityIdentifier("workspace.use-mac")
            Text(workspaceText("Open your local chats, files and tools. You can switch workspaces at any time."))
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(32).frame(maxWidth: 430, alignment: .leading)
        .background(CloudStyle.card, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(CloudStyle.border))
        .padding().frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CloudStyle.background)
    }
}
