import SwiftUI

struct AssistantStarter: Identifiable {
    let id: String
    let title: String
    let icon: String
    let prompt: String

    static let all: [AssistantStarter] = [
        .init(id: "day", title: "Plan my day", icon: "sun.max",
              prompt: "Help me plan my day. Ask about my priorities and available time, then suggest a realistic plan."),
        .init(id: "draft", title: "Write a first draft", icon: "square.and.pencil",
              prompt: "Help me draft a message. Ask who it is for, what I want to say, and the tone. Prepare a draft for me to review."),
        .init(id: "ideas", title: "Turn an idea into a plan", icon: "lightbulb",
              prompt: "Help me turn an idea into a practical plan. Ask about my goal and constraints, then break it into manageable next steps.")
    ]
}

struct MacFeaturesView: View {
    @EnvironmentObject var app: AppState
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Connect your Mac", systemImage: "desktopcomputer")
            } description: {
                Text("Your cloud assistant is ready in Chat. Connect a Mac running LISA to manage its coding agents, local integrations, and activity notifications. Cloud and Mac conversations are stored separately.")
            } actions: {
                Button("Set up my Mac") {
                    app.setConnectionMode(.mac)
                    app.selectedTab = 3
                }.buttonStyle(.borderedProminent)
            }
            .navigationTitle("My Mac")
            .background(Theme.bgDeep.ignoresSafeArea())
        }
    }
}

struct AssistantPrivacyView: View {
    var body: some View {
        List {
            Section("LISA Cloud") {
                Text("Your account, conversations, and assistant memory are stored by LISA Cloud. Messages and relevant context are sent to the AI provider configured by the service to generate responses. Do not include information you do not want processed by that provider.")
            }
            Section("Your Mac") {
                Text("The app connects to the Mac you pair. Your configured model provider may receive messages and relevant context; choosing a local model can keep inference on your Mac. Switching modes does not copy your conversations between instances.")
            }
            Section("You stay in control") {
                Text("AI can make mistakes. Review important results. Local integrations require setup and consent on your Mac. You can sign out or delete your cloud account from Settings → LISA account, and unpair your Mac separately.")
                Link("Privacy policy", destination: URL(string: "https://meetlisa.ai/privacy")!)
                Link("Support", destination: URL(string: "https://meetlisa.ai/support")!)
            }
        }.navigationTitle("AI and your data")
    }
}
