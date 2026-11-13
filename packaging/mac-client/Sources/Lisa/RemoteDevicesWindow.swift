import AppKit
import SwiftUI

@MainActor
final class RemoteDevicesWindow: NSWindowController, NSWindowDelegate {
    static let shared = RemoteDevicesWindow()
    let model: CloudConnectionModel
    private let connectionOwner = UUID()
    init(model: CloudConnectionModel? = nil) {
        let model = model ?? .shared
        self.model = model
        let window = cloudWindow(title: "Connect Lisa Pocket", height: 720)
        super.init(window: window)
        window.delegate = self
        window.contentView = NSHostingView(rootView: CloudDevicesView(model: model) { [weak self] in
            guard !model.preview else { return }
            AccountWindowController.shared.show()
            self?.close()
        })
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func show() {
        model.start(owner: connectionOwner)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func windowWillClose(_ notification: Notification) { model.stop(owner: connectionOwner) }
    static func request(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        do {
            let (status, result) = try await CloudHTTP.json(URL(string: "http://127.0.0.1:5757/api/remote/\(path)")!, body: body)
            guard status == 200 else {
                let text = path == "approve" ? "This request has expired or changed. Start pairing again in Pocket."
                    : path == "connect" ? "Couldn't connect. Check your internet connection and sign in to Lisa again if needed."
                    : "Couldn't update the connection. Check that Lisa is running and try again."
                throw NSError(domain: "LISARemote", code: status, userInfo: [NSLocalizedDescriptionKey: text])
            }
            return result
        } catch let error as NSError where error.domain == "LISARemote" { throw error }
        catch {
            throw NSError(domain: "LISARemote", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't reach Lisa on this Mac. Open Lisa and try again."])
        }
    }
}

struct CloudDevicesView: View {
    @ObservedObject var model: CloudConnectionModel
    var openAccount: () -> Void
    @State private var advanced = false
    @State private var approval: CloudDevice?
    @State private var removing: CloudDevice?
    @State private var confirmDisable = false
    private var signedIn: Bool {
        model.preview || !(BackendController.shared.configEnvValue("LISA_MANAGED_SESSION") ?? "").isEmpty
    }
    private var online: Bool { model.available && model.state.online }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Button(action: openAccount) { Label("Lisa account", systemImage: "chevron.left") }
                        .buttonStyle(.borderless).font(.system(size: 12)).foregroundColor(.secondary)
                    CloudHeader(symbol: "laptopcomputer.and.iphone", eyebrow: "LISA POCKET",
                                title: "Your Mac. Within reach.",
                                subtitle: "Start here. Pick up on your iPhone.")
                    CloudCard {
                        HStack(alignment: .top, spacing: 14) {
                            CloudStatusRow(symbol: online ? "checkmark.circle.fill" : "desktopcomputer",
                                           title: model.title, detail: model.detail,
                                           color: online ? .green : CloudStyle.accent)
                            if model.busy || !model.loaded { ProgressView().controlSize(.small) }
                        }
                        if !signedIn {
                            Button("Sign in to connect") { openAccount() }.buttonStyle(CloudPrimaryButton())
                        } else if model.loaded && !online {
                            Button(model.state.enabled ? "Reconnect" : "Enable phone connections") {
                                Task { await model.connect() }
                            }.buttonStyle(CloudPrimaryButton()).disabled(model.busy)
                        }
                        if let notice = model.notice { CloudNoticeView(notice: notice) }
                        if online {
                            Divider()
                            HStack(spacing: 16) {
                                Label("Local when nearby", systemImage: "wifi")
                                Label("Cloud when away", systemImage: "cloud")
                            }.font(.system(size: 11)).foregroundColor(.secondary)
                        }
                    }
                    if let refused = model.state.legacyRefusedName {
                        CloudNoticeView(notice: CloudNotice(text: "A request from \(refused) used an older pairing method. Update Lisa Pocket and try again.", kind: .warning))
                    }
                    ForEach(model.state.pending) { pending in pairingCard(pending) }
                    if model.state.devices.isEmpty && model.state.pending.isEmpty {
                        CloudCard {
                            Text("Connect your iPhone").font(.system(size: 16, weight: .semibold))
                            CloudStep(number: 1, title: "Open Lisa Pocket", detail: "Sign in with the same Lisa account as this Mac.")
                            CloudStep(number: 2, title: "Choose this Mac", detail: "In Pocket, open Settings → Connect your Mac.")
                            CloudStep(number: 3, title: "Compare and approve", detail: "Match the code on both screens, then approve here.")
                            if online {
                                HStack(spacing: 8) {
                                    Circle().fill(Color.green).frame(width: 6, height: 6)
                                    Text("Ready — your iPhone's request will appear here.")
                                }.font(.system(size: 12)).foregroundColor(.secondary).padding(.top, 2)
                            }
                        }
                    }
                    if !model.state.devices.isEmpty {
                        CloudCard {
                            HStack {
                                Text("Authorized devices").font(.system(size: 16, weight: .semibold))
                                Spacer()
                                Text(String(model.state.devices.count)).font(.system(size: 12)).foregroundColor(.secondary)
                            }
                            ForEach(model.state.devices) { device in
                                HStack(spacing: 12) {
                                    CloudStatusRow(symbol: "iphone", title: device.name,
                                                   detail: device.secure ? "Approved on this Mac" : "Older pairing · update Pocket to pair securely")
                                    Button("Remove…") { removing = device }.buttonStyle(.borderless).font(.system(size: 12))
                                }.disabled(model.busy)
                            }
                        }
                    }
                    Label("Keep this Mac awake and Lisa running to connect from Pocket.", systemImage: "moon.zzz")
                        .font(.system(size: 12)).foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    DisclosureGroup("Connection settings", isExpanded: $advanced) {
                        VStack(alignment: .leading, spacing: 14) {
                            if model.state.supportsSecurePairing && model.state.enabled {
                                Toggle("Require secure pairing", isOn: Binding(get: { model.state.requireSecurePairing }, set: { value in
                                    Task { await model.perform("policy", body: ["requireSecurePairing": value]) }
                                }))
                                Text("Only updated versions of Pocket can make new pairing requests. Existing device approvals are kept.")
                                    .font(.system(size: 11)).foregroundColor(.secondary)
                            }
                            if model.state.enabled {
                                Button("Turn off phone connections…") { confirmDisable = true }
                            }
                            Button("Pair with a local QR code…") {
                                if !model.preview { PairController.shared.showPairing() }
                            }.buttonStyle(.borderless)
                            Text("Local QR pairing is available for older Pocket versions on the same Wi-Fi.")
                                .font(.system(size: 11)).foregroundColor(.secondary)
                        }.padding(.top, 12).disabled(model.busy)
                    }.font(.system(size: 12)).foregroundColor(.secondary)
                }.frame(maxWidth: 500).padding(.horizontal, 28).padding(.top, 44).padding(.bottom, 28)
                    .frame(maxWidth: .infinity).id("cloud-top")
            }.onAppear { DispatchQueue.main.async { proxy.scrollTo("cloud-top", anchor: .top) } }
        }.background(CloudStyle.background).tint(CloudStyle.accent)
        .alert("Compare the code on your iPhone", isPresented: Binding(get: { approval != nil }, set: { if !$0 { approval = nil } })) {
            if let device = approval {
                Button("Codes match — allow") { Task { await model.perform("approve", body: ["id": device.id, "code": device.code]) } }
                Button("Cancel", role: .cancel) {}
            }
        } message: {
            if let device = approval {
                Text("Only approve if your phone shows \(device.code). This allows \(device.name) to use this Mac's Lisa and permitted remote controls."
                     + (device.secure ? " If Pocket warns about an older pairing method, cancel."
                        : " This request uses an older pairing method: a compromised relay could fake its code. Update Pocket first."))
            }
        }
        .confirmationDialog("Remove this device?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            if let device = removing {
                Button("Remove \(device.name)", role: .destructive) { Task { await model.perform("revoke", body: ["id": device.id]) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("It will need your approval again to connect to this Mac.") }
        .confirmationDialog("Turn off phone connections?", isPresented: $confirmDisable, titleVisibility: .visible) {
            Button("Turn off", role: .destructive) { Task { await model.perform("disconnect", body: [:]) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Pocket will disconnect. You can turn connections back on here at any time.") }
    }

    private func pairingCard(_ device: CloudDevice) -> some View {
        CloudCard {
            Label(device.known ? "\(device.name) is reconnecting" : "\(device.name) wants to connect", systemImage: "iphone.radiowaves.left.and.right")
                .font(.system(size: 15, weight: .semibold))
            if device.code.isEmpty {
                CloudNoticeView(notice: CloudNotice(text: "Waiting for the verification code. If you aren't pairing Pocket, dismiss this request."))
            } else {
                Text("Check that your iPhone shows this same code.").font(.system(size: 12)).foregroundColor(.secondary)
                Text(device.code).font(.system(size: 27, weight: .semibold, design: .monospaced)).tracking(3)
                    .frame(maxWidth: .infinity).padding(.vertical, 17)
                    .background(CloudStyle.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Verification code: \(device.code)").textSelection(.enabled)
                CloudNoticeView(notice: CloudNotice(text: device.secure
                    ? "This Mac uses secure pairing. If Pocket warns about an older pairing method, dismiss this request."
                    : "Older pairing method. A compromised relay could fake this code. Update Lisa Pocket before pairing.",
                    kind: device.secure ? .information : .warning))
                Button("Compare codes & approve…") { approval = device }.buttonStyle(CloudPrimaryButton())
            }
            Button(device.code.isEmpty ? "Clear request" : "Dismiss request") {
                Task { await model.perform("dismiss", body: ["id": device.id]) }
            }.buttonStyle(.borderless).font(.system(size: 12)).frame(maxWidth: .infinity)
        }.disabled(model.busy)
    }
}
