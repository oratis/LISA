import AppKit
import SwiftUI
import LisaSetup

@MainActor
final class AccountWindowController: NSWindowController, NSWindowDelegate {
    static let shared = AccountWindowController()
    let model: CloudAccountModel

    init(model: CloudAccountModel? = nil) {
        let model = model ?? CloudAccountModel()
        self.model = model
        let window = cloudWindow(title: "Lisa Account")
        super.init(window: window)
        window.delegate = self
        window.contentView = NSHostingView(rootView: CloudAccountView(model: model, connection: model.connection) { [weak self] in
            guard !model.preview else { return }
            RemoteDevicesWindow.shared.show()
            self?.close()
        })
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func show() {
        model.start()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func windowWillClose(_ notification: Notification) { model.stop() }
}

struct CloudAccountView: View {
    @ObservedObject var model: CloudAccountModel
    @ObservedObject var connection: CloudConnectionModel
    var openDevices: () -> Void
    @State private var advanced = false
    @State private var confirmSignOut = false
    @State private var confirmApply = false
    @FocusState private var focus: Field?
    private enum Field { case email, code, password }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    CloudHeader(symbol: model.showsAccount ? "person.crop.circle.badge.checkmark" : "person.crop.circle",
                                eyebrow: "LISA ACCOUNT",
                                title: model.showsAccount ? "Your Lisa, connected." : model.step == .code ? "Check your inbox." : "At home. On the go.",
                                subtitle: model.showsAccount ? "One account for this Mac and Lisa Pocket."
                                    : model.step == .code ? "Use the code from your latest email to sign in."
                                    : "Sign in to bring your Mac and Lisa Pocket together.")
                    if model.showsAccount { accountContent } else { signInContent }
                    if model.needsApply {
                        CloudNoticeView(notice: CloudNotice(text: model.applicationMessage,
                                                           kind: model.applyFailed ? .warning : .information))
                        Button(model.applying ? "Applying…" : "Apply cloud model settings…") { confirmApply = true }
                            .disabled(model.applying || model.busy || connection.busy)
                    }
                    Label("Your conversations stay on this Mac.", systemImage: "lock.shield")
                        .font(.system(size: 11)).foregroundColor(.secondary)
                        .frame(maxWidth: .infinity)
                }
                .frame(maxWidth: 500).padding(.horizontal, 28).padding(.top, 48).padding(.bottom, 28)
                .frame(maxWidth: .infinity).id("cloud-top")
            }
            .onAppear { DispatchQueue.main.async { proxy.scrollTo("cloud-top", anchor: .top) } }
        }
        .background(CloudStyle.background).tint(CloudStyle.accent)
        .onAppear { updateFocus() }
        .onChange(of: model.step) { _ in updateFocus() }
        .onChange(of: model.showsAccount) { _ in updateFocus() }
        .confirmationDialog("Apply account settings?", isPresented: $confirmApply, titleVisibility: .visible) {
            Button("Apply and reconnect") { model.applyAccount() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Lisa will briefly reconnect. Any current response or running task will stop. Your saved conversations will stay here.")
        }
        .confirmationDialog("Sign out of Lisa?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { model.signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Phone connections will close and Lisa will briefly reconnect. Current responses and tasks will stop. Your saved conversations and files will stay here.")
        }
    }

    private var accountContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            CloudCard {
                HStack(spacing: 12) {
                    Image(systemName: "person.crop.circle.fill").font(.system(size: 36))
                        .foregroundColor(CloudStyle.accent).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.accountEmail.isEmpty ? "Your Lisa account" : model.accountEmail)
                            .font(.system(size: 15, weight: .semibold)).textSelection(.enabled)
                        Text(model.checkingAccount ? "Checking account…" : model.accountVerified ? "Signed in" : "Account saved")
                            .font(.system(size: 12)).foregroundColor(.secondary)
                    }
                    Spacer(minLength: 0)
                    if model.accountVerified {
                        Image(systemName: "checkmark.seal.fill").foregroundColor(.green).accessibilityLabel("Account verified")
                    }
                }
                Divider()
                CloudStatusRow(symbol: connection.state.online && connection.available ? "checkmark.circle.fill" : "desktopcomputer",
                               title: connection.title, detail: connection.detail,
                               color: connection.state.online && connection.available ? .green : CloudStyle.accent)
                if let notice = connection.notice { CloudNoticeView(notice: notice) }
            }
            if let notice = model.notice { CloudNoticeView(notice: notice) }
            CloudCard {
                CloudStatusRow(symbol: "iphone.and.arrow.forward", title: "Take Lisa with you",
                               detail: "Connect Pocket once, then switch between Wi-Fi and cloud automatically.")
                Button(action: openDevices) {
                    HStack { Text(connection.state.devices.isEmpty ? "Connect Lisa Pocket" : "Manage connected devices"); Spacer(); Image(systemName: "arrow.right") }
                }.buttonStyle(CloudPrimaryButton()).accessibilityIdentifier("account.connect-pocket")
                Text("Use this same account in Pocket. You'll approve your iPhone on this Mac.")
                    .font(.system(size: 12)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Label(CloudAccountRules.serverURL(model.server)?.host ?? "Lisa Cloud", systemImage: "cloud")
                    .font(.system(size: 11)).foregroundColor(.secondary)
                Spacer()
                Button("Sign out…") { confirmSignOut = true }.buttonStyle(.borderless)
                    .font(.system(size: 12)).foregroundColor(.secondary)
                    .disabled(model.busy || model.applying || connection.busy)
            }
        }
    }

    private var signInContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            CloudCard {
                if model.step == .code {
                    HStack {
                        Label("Sent to \(model.destinationEmail)", systemImage: "envelope")
                            .font(.system(size: 12)).foregroundColor(.secondary)
                        Spacer(minLength: 4)
                        Button("Change") { model.changeMethod(.email) }.buttonStyle(.borderless)
                    }
                    CloudField(label: "Verification code") {
                        TextField("000000", text: $model.code)
                            .font(.system(size: 24, weight: .medium, design: .monospaced)).tracking(6)
                            .focused($focus, equals: .code).accessibilityLabel("Six-digit verification code")
                            .onChange(of: model.code) { value in model.code = CloudAccountRules.codeDigits(value) }
                            .onSubmit { model.continueSignIn() }
                    }
                    Text("The code expires in 10 minutes. You can paste all six digits at once.")
                        .font(.system(size: 12)).foregroundColor(.secondary)
                } else {
                    CloudField(label: "Email address") {
                        TextField("you@example.com", text: $model.email)
                            .focused($focus, equals: .email).accessibilityLabel("Email address")
                            .onSubmit { model.continueSignIn() }
                    }
                    if model.step == .password {
                        CloudField(label: "Password") {
                            SecureField("Your password", text: $model.password)
                                .focused($focus, equals: .password).accessibilityLabel("Password")
                                .onSubmit { model.continueSignIn() }
                        }
                    } else {
                        Text("We'll email you a sign-in code. No password to remember.")
                            .font(.system(size: 12)).foregroundColor(.secondary)
                    }
                }
                if let notice = model.notice { CloudNoticeView(notice: notice) }
                Button { model.continueSignIn() } label: {
                    HStack(spacing: 8) {
                        if model.busy { ProgressView().controlSize(.small).tint(.white) }
                        Text(model.busy ? (model.step == .email ? "Sending code…" : "Signing in…")
                             : model.step == .email ? "Continue with email" : "Sign in")
                        if !model.busy { Image(systemName: "arrow.right") }
                    }
                }
                .buttonStyle(CloudPrimaryButton()).disabled(!model.canContinue)
                .opacity(model.canContinue || model.busy ? 1 : 0.45)
                .keyboardShortcut(.defaultAction).accessibilityIdentifier("account.continue")
                if model.step == .code {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let seconds = max(0, Int(ceil(model.resendAfter.timeIntervalSince(context.date))))
                        HStack {
                            Text("Didn't get it?").foregroundColor(.secondary)
                            Button(seconds > 0 ? "Resend in \(seconds)s" : "Send a new code") { model.sendCode() }
                                .disabled(seconds > 0 || model.busy)
                        }.font(.system(size: 12)).frame(maxWidth: .infinity)
                    }
                } else {
                    Button(model.step == .password ? "Use an email code instead" : "Use a password instead") {
                        model.changeMethod(model.step == .password ? .email : .password)
                    }.buttonStyle(.borderless).font(.system(size: 12)).frame(maxWidth: .infinity)
                }
            }.disabled(model.busy || model.applying || connection.busy)
            if model.step != .code {
                DisclosureGroup("Advanced", isExpanded: $advanced) {
                    VStack(alignment: .leading, spacing: 10) {
                        CloudField(label: "Lisa server") {
                            TextField("https://cloud.meetlisa.ai", text: $model.server).accessibilityLabel("Lisa server address")
                        }
                        Text("Use the default unless you host your own Lisa server.")
                            .font(.system(size: 11)).foregroundColor(.secondary)
                        if CloudAccountRules.serverURL(model.server) == nil {
                            Text("Enter an HTTPS server address without a path.")
                                .font(.system(size: 11)).foregroundColor(.red)
                        }
                    }.padding(.top, 10)
                }.font(.system(size: 12)).foregroundColor(.secondary).disabled(model.busy)
            }
            if model.step == .email {
                HStack(alignment: .top, spacing: 18) {
                    benefit("iphone.and.arrow.forward", "Pocket, connected", "Your Mac within reach.")
                    benefit("arrow.triangle.swap", "Local or cloud", "Local when you're nearby.")
                }
            }
        }
    }
    private func benefit(_ icon: String, _ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: icon).foregroundColor(CloudStyle.accent).font(.system(size: 16)).accessibilityHidden(true)
            Text(title).font(.system(size: 12, weight: .semibold))
            Text(detail).font(.system(size: 11)).foregroundColor(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func updateFocus() {
        DispatchQueue.main.async {
            focus = model.showsAccount ? nil : model.step == .code ? .code : model.step == .password ? .password : .email
        }
    }
}
