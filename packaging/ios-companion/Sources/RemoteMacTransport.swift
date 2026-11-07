import Foundation
import CryptoKit
import UIKit

struct RemoteMacTarget: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let publicKey: String
    let cloudOrigin: String
    let accountUID: String
}

enum RemoteLinkError: LocalizedError {
    case signIn, notAllowed, invalidPeer, interrupted, pairingRestarted
    var errorDescription: String? {
        switch self {
        case .signIn: return "Sign in to the same LISA account again to connect your Mac."
        case .notAllowed: return "Your Mac no longer allows this iPhone. Pair it again from Settings → Connect your Mac."
        case .invalidPeer: return "This connection couldn't verify your Mac. Pair it again from Settings."
        case .interrupted: return "The Mac connection was interrupted. Check the task's status before sending it again."
        case .pairingRestarted: return "Your Mac started a new pairing request, so the code changed. Compare the new code."
        }
    }
}

/// One poll of the pairing screen. `secure` means pairing v2 (a committed code); false
/// means the Mac only speaks v1, whose code a key-substituting relay can forge.
struct RemotePairingStatus: Equatable {
    let authorized: Bool
    let code: String
    let secure: Bool
    /// False when a v2 Mac has no open request for this iPhone (dismissed, expired or full).
    let open: Bool
}

/// Byte-for-byte compatible with src/remote/protocol.ts; keys never leave Keychain.
final class RemoteLinkCipher {
    struct Envelope: Codable { let seq: Int; let box: String }
    private let sendKey: SymmetricKey
    private let receiveKey: SymmetricKey
    private var sendSequence = 0
    private var receiveSequence = 0
    static func keyID(_ data: Data) -> String {
        SHA256.hash(data: data).prefix(16).map { String(format: "%02x", $0) }.joined()
    }
    private static func grouped(_ digest: SHA256.Digest) -> String {
        let hex = digest.prefix(6).map { String(format: "%02X", $0) }.joined()
        return stride(from: 0, to: 12, by: 4).map { n in
            String(hex.dropFirst(n).prefix(4))
        }.joined(separator: " ")
    }
    /// Pairing v1 (Mac 0.30 and earlier): no commitment, so a relay that substitutes both
    /// keys can grind a matching pair. Kept for older Macs, and flagged as weaker.
    static func code(host: Data, client: Data) -> String {
        grouped(SHA256.hash(data: host + client))
    }
    /// Pairing v2 (`lisa-pair-v2`), identical to src/remote/protocol.ts: the phone commits
    /// to its nonce before the Mac picks one, and reveals it only afterwards.
    static let pairingVersion = 2
    static func pairingCommitment(host: Data, client: Data, nonce: Data) -> Data {
        Data(SHA256.hash(data: Data("lisa-pair-v2|commit|".utf8) + host + client + nonce))
    }
    static func pairingCode(host: Data, client: Data, clientNonce: Data, hostNonce: Data) -> String {
        grouped(SHA256.hash(data: Data("lisa-pair-v2|code|".utf8) + host + client + clientNonce + hostNonce))
    }
    init(privateKey: Curve25519.KeyAgreement.PrivateKey, host: Data, salt: Data) throws {
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: host)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        let info = "lisa-link-v1|\(Self.keyID(host))|\(Self.keyID(privateKey.publicKey.rawRepresentation))"
        sendKey = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
            sharedInfo: Data((info + "|c2h").utf8), outputByteCount: 32)
        receiveKey = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
            sharedInfo: Data((info + "|h2c").utf8), outputByteCount: 32)
    }
    func seal(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object)
        let box = try AES.GCM.seal(data, using: sendKey,
            authenticating: Data("lisa-link-v1|c2h|\(sendSequence)".utf8))
        guard let combined = box.combined else { throw RemoteLinkError.invalidPeer }
        let frame = Envelope(seq: sendSequence, box: combined.base64EncodedString())
        sendSequence += 1
        return String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
    }
    func open(_ data: Data) throws -> [String: Any] {
        guard data.count <= 1024 * 1024,
              let frame = try? JSONDecoder().decode(Envelope.self, from: data),
              frame.seq == receiveSequence, let combined = Data(base64Encoded: frame.box) else {
            throw RemoteLinkError.invalidPeer
        }
        let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: receiveKey,
            authenticating: Data("lisa-link-v1|h2c|\(receiveSequence)".utf8))
        guard let object = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else {
            throw RemoteLinkError.invalidPeer
        }
        receiveSequence += 1
        return object
    }
}

private enum RemoteDeviceKey {
    private static let lock = NSLock()
    static func load() throws -> Curve25519.KeyAgreement.PrivateKey {
        lock.lock(); defer { lock.unlock() }
        let account = "remote-device-x25519-v1"
        if let saved = TokenStore.load(account: account) {
            guard let data = Data(base64Encoded: saved) else { throw LisaError.secureStorage }
            return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        let value = key.rawRepresentation.base64EncodedString()
        TokenStore.save(value, account: account)
        guard TokenStore.load(account: account) == value else { throw LisaError.secureStorage }
        return key
    }
}

private final class RemoteSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Never redirect an account Bearer token to another host.
    }
}

protocol RemoteConnection: AnyObject {
    var welcome: [String: Any] { get }
    func send(_ object: [String: Any]) async throws
    func receive() async throws -> [String: Any]
    func ping() async throws
    func close()
}

private final class RemoteSocket: RemoteConnection {
    let task: URLSessionWebSocketTask
    let cipher: RemoteLinkCipher
    var welcome: [String: Any] = [:]
    init(task: URLSessionWebSocketTask, cipher: RemoteLinkCipher) { self.task = task; self.cipher = cipher }
    func send(_ object: [String: Any]) async throws {
        try await task.send(.string(cipher.seal(object)))
    }
    func ping() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task.sendPing { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }
    func receive() async throws -> [String: Any] {
        let message = try await task.receive()
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let bytes): data = bytes
        @unknown default: throw RemoteLinkError.invalidPeer
        }
        return try cipher.open(data)
    }
    func close() { task.cancel(with: .goingAway, reason: nil) }
}

extension Notification.Name { static let lisaRemoteRoute = Notification.Name("lisaRemoteRoute") }

actor RemoteMacTransport {
    let target: RemoteMacTarget
    private let session: URLSession
    private var lanURLs: [URL] = []
    private var nextLANProbe = Date.distantPast
    private var active: [UUID: any RemoteConnection] = [:]
    private var invalidated = false
    private let credentialProvider: (() throws -> String)?
    /// Test hook: (url, Bearer token, timeout, hello fields) → an opened connection.
    private let connector: ((URL, String?, UInt64, [String: Any]) async throws -> any RemoteConnection)?
    private let pairing: Bool
    private let deviceKey: Curve25519.KeyAgreement.PrivateKey?
    /// One v2 pairing attempt: the phone nonce it committed to, and the only Mac nonce
    /// that nonce may ever be revealed against.
    private struct PairingAttempt {
        let nonce = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        var macNonce: Data?
        var code: String?
        var secure = false
    }
    private var attempt = PairingAttempt()

    init(target: RemoteMacTarget, pairing: Bool = false, credentialProvider: (() throws -> String)? = nil,
         sessionConfiguration: URLSessionConfiguration = .ephemeral,
         deviceKey: Curve25519.KeyAgreement.PrivateKey? = nil,
         connector: ((URL, String?, UInt64, [String: Any]) async throws -> any RemoteConnection)? = nil) {
        self.target = target
        self.session = URLSession(configuration: sessionConfiguration, delegate: RemoteSessionDelegate(), delegateQueue: nil)
        self.pairing = pairing
        self.credentialProvider = credentialProvider
        self.deviceKey = deviceKey
        self.connector = connector
        self.lanURLs = (UserDefaults.standard.stringArray(forKey: "lisa.link.\(target.id).lanURLs") ?? []).compactMap(Self.validLANURL)
    }

    /// Cloud credentials are checked even for LAN: signing out stops the saved connection.
    private func credentials() throws -> String {
        if let credentialProvider { return try credentialProvider() }
        let config = ConnectionProfiles().load(.cloud)
        guard config.baseURL?.absoluteString == target.cloudOrigin,
              let token = config.token, !token.isEmpty else { throw RemoteLinkError.signIn }
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { throw RemoteLinkError.signIn }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let bytes = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              claims["uid"] as? String == target.accountUID,
              let expires = claims["exp"] as? Double, expires > Date().timeIntervalSince1970 * 1000 else {
            throw RemoteLinkError.signIn
        }
        return token // The cloud verifies the signature; the local check prevents accidental account mixing.
    }
    static func validLANURL(_ raw: String) -> URL? {
        guard let parts = URLComponents(string: raw), parts.scheme == "ws", parts.path == "/link",
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              let host = parts.host, let port = parts.port, (1...65535).contains(port) else { return nil }
        let ip = host.split(separator: ".").compactMap { Int($0) }
        guard ip.count == 4, ip.allSatisfy({ (0...255).contains($0) }),
              ip[0] == 10 || (ip[0] == 192 && ip[1] == 168) || (ip[0] == 172 && (16...31).contains(ip[1])) else { return nil }
        return parts.url
    }
    private func deviceKeyPair() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let deviceKey { return deviceKey }
        return try RemoteDeviceKey.load()
    }
    private func open(url: URL, token: String?, timeout: UInt64, fields: [String: Any]) async throws -> any RemoteConnection {
        if let connector { return try await connector(url, token, timeout, fields) }
        guard !invalidated, let hostKey = Data(base64Encoded: target.publicKey),
              RemoteLinkCipher.keyID(hostKey) == target.id else { throw RemoteLinkError.invalidPeer }
        let key = try deviceKeyPair()
        let salt = Curve25519.KeyAgreement.PrivateKey().rawRepresentation
        let cipher = try RemoteLinkCipher(privateKey: key, host: hostKey, salt: salt)
        var request = URLRequest(url: url)
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let task = session.webSocketTask(with: request)
        let socket = RemoteSocket(task: task, cipher: cipher)
        let deadline = Task {
            do { try await Task.sleep(nanoseconds: timeout); socket.close() } catch { }
        }
        defer { deadline.cancel() }
        task.resume()
        do {
            return try await withTaskCancellationHandler(operation: {
                var hello: [String: Any] = ["type": "hello", "publicKey": key.publicKey.rawRepresentation.base64EncodedString(),
                    "salt": salt.base64EncodedString(), "name": await UIDevice.current.name]
                hello.merge(fields) { _, field in field }
                try await task.send(.data(JSONSerialization.data(withJSONObject: hello)))
                socket.welcome = try await socket.receive()
                guard socket.welcome["type"] as? String == "welcome" else { throw RemoteLinkError.invalidPeer }
                // A v2 Mac never sends the uncommitted v1 code; a v1 Mac's must match ours.
                if socket.welcome["v"] as? Int != RemoteLinkCipher.pairingVersion {
                    guard socket.welcome["code"] as? String == RemoteLinkCipher.code(host: hostKey, client: key.publicKey.rawRepresentation) else {
                        throw RemoteLinkError.invalidPeer
                    }
                }
                return socket
            }, onCancel: { socket.close() })
        } catch { socket.close(); throw error }
    }
    private func connection(hello: [String: Any] = [:]) async throws -> any RemoteConnection {
        guard !invalidated else { throw RemoteLinkError.signIn }
        let token = try credentials()
        // Every hello announces pairing v2; a v1 Mac ignores the extra fields.
        var fields: [String: Any] = ["v": RemoteLinkCipher.pairingVersion, "pair": false]
        fields.merge(hello) { _, field in field }
        // Pairing verifies a Mac picked from the cloud list, so it only uses the cloud route.
        if !pairing && Date() >= nextLANProbe {
            nextLANProbe = Date().addingTimeInterval(20)
            for url in lanURLs.prefix(2) {
                do {
                    let socket = try await open(url: url, token: nil, timeout: 900_000_000, fields: fields)
                    guard socket.welcome["authorized"] as? Bool == true else { socket.close(); continue }
                    nextLANProbe = .distantPast
                    report("Local network")
                    return socket
                } catch { try Task.checkCancellation() }
            }
        }
        guard var parts = URLComponents(string: target.cloudOrigin), parts.scheme == "https" else {
            throw RemoteLinkError.invalidPeer
        }
        parts.scheme = "wss"; parts.path = "/api/relay/client"
        parts.queryItems = [URLQueryItem(name: "host", value: target.id)]
        guard let url = parts.url else { throw RemoteLinkError.invalidPeer }
        let socket = try await open(url: url, token: token, timeout: 10_000_000_000, fields: fields)
        let wasEmpty = lanURLs.isEmpty
        lanURLs = (socket.welcome["lanURLs"] as? [String] ?? []).compactMap(Self.validLANURL)
        if wasEmpty && !lanURLs.isEmpty { nextLANProbe = .distantPast }
        UserDefaults.standard.set(lanURLs.map(\.absoluteString), forKey: "lisa.link.\(target.id).lanURLs")
        report("Cloud relay")
        return socket
    }
    private func report(_ route: String) {
        NotificationCenter.default.post(name: .lisaRemoteRoute, object: target.id, userInfo: ["route": route])
    }
    /// One poll of the pairing screen. Until a code exists this runs the v2 commitment
    /// round (or reads an older Mac's v1 code); afterwards it only asks for approval.
    func pairingStatus() async throws -> RemotePairingStatus {
        guard pairing, let hostKey = Data(base64Encoded: target.publicKey) else { throw RemoteLinkError.invalidPeer }
        let client = try deviceKeyPair().publicKey.rawRepresentation
        let current = attempt
        var hello: [String: Any] = ["pair": current.code == nil]
        if current.code == nil {
            hello["commit"] = RemoteLinkCipher.pairingCommitment(host: hostKey, client: client,
                                                                 nonce: current.nonce).base64EncodedString()
        }
        let socket = try await connection(hello: hello)
        defer { socket.close() }
        // Another poll restarted the attempt while this one was connecting.
        guard attempt.nonce == current.nonce else { throw RemoteLinkError.pairingRestarted }
        let welcome = socket.welcome
        let authorized = welcome["authorized"] as? Bool == true
        let v2 = welcome["v"] as? Int == RemoteLinkCipher.pairingVersion
        if let code = current.code {
            // A Mac that paired with v2 cannot fall back to v1 halfway through.
            if current.secure && !v2 { throw RemoteLinkError.invalidPeer }
            return RemotePairingStatus(authorized: authorized, code: code, secure: current.secure,
                                       open: authorized || !v2 || welcome["pending"] as? Bool == true)
        }
        guard v2 else {
            // Mac 0.30 and earlier: open() already checked this v1 code against both keys.
            let code = welcome["code"] as? String ?? ""
            attempt.code = code
            attempt.secure = false
            return RemotePairingStatus(authorized: authorized, code: code, secure: false, open: true)
        }
        guard let raw = welcome["nonce"] as? String, let macNonce = Data(base64Encoded: raw), macNonce.count == 32 else {
            return RemotePairingStatus(authorized: authorized, code: "", secure: true, open: false)
        }
        if let pinned = attempt.macNonce, pinned != macNonce {
            // This phone nonce may already be revealed. Pairing it with a second Mac nonce
            // would let a relay pick that nonce knowing ours, so start a fresh attempt.
            attempt = PairingAttempt()
            throw RemoteLinkError.pairingRestarted
        }
        attempt.macNonce = macNonce
        try await socket.send(["type": "pair", "nonce": current.nonce.base64EncodedString()])
        let reply = try await socket.receive()
        let code = RemoteLinkCipher.pairingCode(host: hostKey, client: client, clientNonce: current.nonce, hostNonce: macNonce)
        guard reply["type"] as? String == "paired", reply["code"] as? String == code else {
            throw RemoteLinkError.invalidPeer
        }
        guard attempt.nonce == current.nonce else { throw RemoteLinkError.pairingRestarted }
        attempt.code = code
        attempt.secure = true
        return RemotePairingStatus(authorized: authorized, code: code, secure: true, open: true)
    }
    func data(path: String, method: String, body: Data?) async throws -> (Data, HTTPURLResponse) {
        var data = Data()
        let response = try await perform(path: path, method: method, body: body) { chunk in
            guard data.count + chunk.count <= 16 * 1024 * 1024 else { throw RemoteLinkError.interrupted }
            data.append(chunk)
        }
        return (data, response)
    }
    func stream(path: String, method: String, body: Data?,
                yield: @escaping (SSEMessage) -> Void) async throws {
        var decoder = SSEDecoder()
        _ = try await perform(path: path, method: method, body: body, requireSuccess: true) { chunk in
            for byte in chunk { if let message = decoder.append(byte) { yield(message) } }
        }
    }
    private func perform(path: String, method: String, body: Data?, requireSuccess: Bool = false,
                         consume: (Data) throws -> Void) async throws -> HTTPURLResponse {
        let socket = try await connection()
        guard !invalidated else { socket.close(); throw RemoteLinkError.signIn }
        guard socket.welcome["authorized"] as? Bool == true else {
            socket.close(); throw RemoteLinkError.notAllowed
        }
        let id = UUID(); active[id] = socket
        defer { active.removeValue(forKey: id); socket.close() }
        let timeout = Task {
            do { try await Task.sleep(nanoseconds: requireSuccess ? 3_300_000_000_000 : 30_000_000_000); socket.close() } catch { }
        }
        let heartbeat = Task {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 15_000_000_000)
                    let deadline = Task {
                        do { try await Task.sleep(nanoseconds: 5_000_000_000); socket.close() } catch { }
                    }
                    defer { deadline.cancel() }
                    try await socket.ping()
                } catch { socket.close(); return }
            }
        }
        defer { timeout.cancel(); heartbeat.cancel() }
        do {
            return try await withTaskCancellationHandler(operation: {
                let request: [String: Any] = ["type": "request", "id": id.uuidString.lowercased(),
                    "challenge": socket.welcome["challenge"] as? String ?? "",
                    "expiresAt": Date().timeIntervalSince1970 * 1000 + 60_000,
                    "path": path, "method": method, "body": body?.base64EncodedString() ?? ""]
                // Once sent, never retry on another path: a mutation may already have executed.
                try await socket.send(request)
                var response: HTTPURLResponse?
                while true {
                    let frame = try await socket.receive()
                    switch frame["type"] as? String {
                    case "headers":
                        guard response == nil, let status = frame["status"] as? Int,
                              let url = URL(string: target.cloudOrigin) else { throw RemoteLinkError.invalidPeer }
                        response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                            headerFields: frame["headers"] as? [String: String])
                        if requireSuccess && !(200..<300).contains(status) { throw LisaError.http(status) }
                        if let response { try LisaAPICompatibility.validate(response) }
                    case "chunk":
                        guard response != nil, let raw = frame["body"] as? String,
                              let data = Data(base64Encoded: raw) else { throw RemoteLinkError.invalidPeer }
                        try consume(data)
                    case "end":
                        guard let response else { throw RemoteLinkError.interrupted }
                        return response
                    default: throw RemoteLinkError.invalidPeer
                    }
                }
            }, onCancel: { socket.close() })
        } catch is URLError {
            if Task.isCancelled { throw CancellationError() }
            throw RemoteLinkError.interrupted
        }
    }
    func networkChanged() {
        nextLANProbe = .distantPast
        for socket in active.values { socket.close() }
    }
    func invalidate() {
        invalidated = true
        for socket in active.values { socket.close() }
        session.invalidateAndCancel()
    }
}
