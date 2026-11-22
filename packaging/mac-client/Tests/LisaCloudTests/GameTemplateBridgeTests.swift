import AppKit
import WebKit
import XCTest
@testable import Lisa

@MainActor
private final class TemplatePage: NSObject, WKNavigationDelegate {
    var ready = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true }
}

@MainActor
final class GameTemplateBridgeTests: XCTestCase {
    private func waitFor(_ predicate: () -> Bool) async throws {
        for _ in 0..<500 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(domain: "GameTemplateBridgeTests", code: 1)
    }

    // Exercise the actual import button and WebKit frame metadata without reading the user's Lisa
    // server, browser data, or downloads. The chooser selects only a unique test directory.
    func testOwnerPageCanSaveOrCancelOnlyTheBuiltInTemplate() async throws {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let dest = directory.appendingPathComponent(GameLibraryTemplate.filename)
        let owner = URL(string: "http://localhost:58419/")!
        var requests: [GameLibraryTemplate] = []
        var shouldSave = false
        let bridge = GameTemplateBridge(origin: owner) { _, template, completion in
            requests.append(template)
            completion(shouldSave ? dest : nil)
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(bridge, name: GameTemplateBridge.name)
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 580, height: 400), configuration: config)
        let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = web
        let page = TemplatePage()
        web.navigationDelegate = page
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let client = try String(contentsOf: root.appendingPathComponent("src/web/assets/client/game-import.js"), encoding: .utf8)
        func load(origin: URL, language: String) async throws {
            page.ready = false
            web.loadHTMLString("""
            <!doctype html><html><body><div id="mount"></div><script>
            const LISA_LOCALE = '\(language)';
            function githubNode(tag, text, cls) {
              const el=document.createElement(tag);el.textContent=text;el.className=cls;return el;
            }
            \(client)
            renderGameImport(document.querySelector('#mount'), () => {});
            </script></body></html>
            """, baseURL: origin)
            try await waitFor { page.ready }
        }
        func click() async throws {
            _ = try await web.evaluateJavaScript("document.querySelector('a[download]').click(); null")
        }
        try await load(origin: owner, language: "en")
        try await click()
        try await waitFor { requests == [.english] }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.path))
        for (i, language) in ["en", "zh-CN"].enumerated() {
            try await load(origin: owner, language: language)
            shouldSave = true
            try await click()
            try await waitFor { requests.count == i + 2 }
            let browser = try await web.evaluateJavaScript("decodeURIComponent(document.querySelector('a[download]').href.split(',')[1])")
            let expected = try XCTUnwrap(browser as? String)
            XCTAssertEqual(try Data(contentsOf: dest), Data(expected.utf8))
            try FileManager.default.removeItem(at: dest)
        }
        _ = try await web.evaluateJavaScript("""
        window.webkit.messageHandlers.lisaGameTemplate.postMessage({locale:'en', path:'/tmp/other'});
        window.webkit.messageHandlers.lisaGameTemplate.postMessage('unsupported');
        const iframe=document.createElement('iframe');
        iframe.srcdoc="<script>window.webkit.messageHandlers.lisaGameTemplate.postMessage('en')<\\/script>";
        document.body.appendChild(iframe); null
        """)
        try await Task.sleep(nanoseconds: 100_000_000)
        try await load(origin: URL(string: "http://localhost:58420/")!, language: "en")
        try await click()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(requests, [.english, .english, .chinese])
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.path))
    }
}
