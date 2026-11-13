import Foundation

struct CloudDevice: Identifiable {
    let id: String
    let name: String
    let code: String
    let secure: Bool
    let known: Bool
    init(_ value: [String: Any]) {
        id = value["id"] as? String ?? ""
        name = value["name"] as? String ?? "iPhone"
        code = value["code"] as? String ?? ""
        secure = value["secure"] as? Bool == true
        known = value["known"] as? Bool == true
    }
}

struct CloudConnectionState {
    var enabled = false
    var online = false
    var name = "This Mac"
    var error = ""
    var supportsSecurePairing = false
    var requireSecurePairing = false
    var legacyRefusedName: String?
    var devices: [CloudDevice] = []
    var pending: [CloudDevice] = []
    init(_ value: [String: Any] = [:]) {
        enabled = value["enabled"] as? Bool == true
        online = value["online"] as? Bool == true
        name = value["name"] as? String ?? "This Mac"
        error = value["error"] as? String ?? ""
        supportsSecurePairing = value["requireSecurePairing"] is Bool
        requireSecurePairing = value["requireSecurePairing"] as? Bool == true
        legacyRefusedName = (value["legacyRefused"] as? [String: Any])?["name"] as? String
        devices = (value["devices"] as? [[String: Any]] ?? []).map(CloudDevice.init).filter { !$0.id.isEmpty }
        pending = (value["pending"] as? [[String: Any]] ?? []).map(CloudDevice.init).filter { !$0.id.isEmpty }
    }
}

@MainActor
final class CloudConnectionModel: ObservableObject {
    static let shared = CloudConnectionModel()
    @Published var state = CloudConnectionState()
    @Published var loaded = false
    @Published var available = true
    @Published var busy = false
    @Published var notice: CloudNotice?
    var preview = false
    private var polling: Task<Void, Never>?
    private var revision = 0
    private var subscribers = Set<UUID>()
    typealias Request = (String, [String: Any]?) async throws -> [String: Any]
    private let request: Request
    init(request: Request? = nil) {
        self.request = request ?? { try await RemoteDevicesWindow.request($0, body: $1) }
    }

    var title: String {
        if !loaded { return "Checking this Mac…" }
        if !available { return "Lisa is unavailable" }
        if state.online { return "This Mac is online" }
        if !state.error.isEmpty { return "Connection needs attention" }
        return state.enabled ? "Reconnecting…" : "Phone connections are off"
    }
    var detail: String {
        if !loaded { return "Checking your connection to Lisa Cloud." }
        if !available { return "Open Lisa and try again. Your saved devices are kept." }
        if state.online { return "Ready to connect with Lisa Pocket." }
        if !state.error.isEmpty { return "Check your internet connection and account, then reconnect." }
        return state.enabled ? "Lisa will reconnect automatically when the network is available."
            : "Enable connections to use this Mac from your iPhone."
    }
    func start(owner: UUID) {
        guard !preview else { return }
        subscribers.insert(owner)
        guard polling == nil else { return }
        polling = Task {
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
    }
    func stop(owner: UUID) {
        subscribers.remove(owner)
        if subscribers.isEmpty { polling?.cancel(); polling = nil }
    }
    func disconnectAccount(save: () throws -> Void) async throws {
        guard !preview, !busy else { throw NSError(domain: "LISAAccount", code: 3) }
        revision += 1; busy = true
        defer { busy = false }
        let result = try await request("disconnect", [:])
        try save()
        state = CloudConnectionState(result); loaded = true; available = true
    }
    func refresh() async {
        guard !busy, !preview else { return }
        let current = revision
        do {
            let result = try await request("status", nil)
            guard !Task.isCancelled, current == revision else { return }
            state = CloudConnectionState(result); loaded = true; available = true
        } catch {
            guard !Task.isCancelled, current == revision else { return }
            loaded = true; available = false
        }
    }
    func connect(base: String? = nil, token: String? = nil) async {
        await perform("connect", body: [
            "base": base ?? BackendController.shared.configEnvValue("LISA_MANAGED_BASE") ?? "https://cloud.meetlisa.ai",
            "session": token ?? BackendController.shared.configEnvValue("LISA_MANAGED_SESSION") ?? "",
        ])
    }
    func perform(_ path: String, body: [String: Any]) async {
        guard !busy, !preview else { return }
        revision += 1; busy = true; notice = nil
        defer { busy = false }
        do {
            state = CloudConnectionState(try await request(path, body))
            loaded = true; available = true
        } catch { notice = CloudNotice(text: error.localizedDescription, kind: .error) }
    }
}
