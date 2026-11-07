import XCTest
@testable import LisaPocket

/// Opt-in release verification against a disposable Mac fixture and deployed relay.
/// Set TEST_RUNNER_LISA_LIVE_RELAY_FIXTURE to a protected JSON fixture file.
/// This exercises URLSession/ATS and route changes; it does not simulate cellular radio.
final class RemoteMacLiveTests: XCTestCase {
    private struct Fixture: Decodable {
        let target: RemoteMacTarget
        let token: String
        let control: String
        let controlURL: String
    }
    @MainActor
    func testProductionRelayAndRealLANFallbackAndRecovery() async throws {
        guard let path = ProcessInfo.processInfo.environment["LISA_LIVE_RELAY_FIXTURE"] else {
            throw XCTSkip("Requires the opt-in production relay fixture")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let cacheKey = "lisa.link.\(fixture.target.id).lanURLs"
        UserDefaults.standard.removeObject(forKey: cacheKey)
        let transport = RemoteMacTransport(target: fixture.target, pairing: true, credentialProvider: { fixture.token })
        func control(_ path: String, code: String = "") async throws {
            var request = URLRequest(url: URL(string: fixture.controlURL + path)!)
            request.httpMethod = "POST"
            request.setValue(fixture.control, forHTTPHeaderField: "X-Fixture-Control")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
            let (_, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
        let authorization = try await transport.authorization()
        if !authorization.authorized { try await control("/approve", code: authorization.code) }
        func read(_ route: String) async throws {
            let expectation = expectation(forNotification: .lisaRemoteRoute, object: fixture.target.id) { notification in
                notification.userInfo?["route"] as? String == route
            }
            let (data, response) = try await transport.data(path: "/api/edition", method: "GET", body: nil)
            XCTAssertEqual(response.statusCode, 200)
            let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            XCTAssertEqual(result?["ok"] as? Bool, true)
            XCTAssertEqual(result?["remote"] as? String, "remote-link")
            await fulfillment(of: [expectation], timeout: 3)
        }
        do {
            try await read("Cloud relay")
            try await read("Local network")
            try await control("/lan/off")
            await transport.networkChanged()
            try await read("Cloud relay")
            try await control("/lan/on")
            await transport.networkChanged()
            try await read("Local network")
            await transport.invalidate()
        } catch {
            try? await control("/lan/on")
            await transport.invalidate()
            throw error
        }
        UserDefaults.standard.removeObject(forKey: cacheKey)
    }
}
