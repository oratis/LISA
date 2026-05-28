//
//  IslandContent.swift
//  LisaIsland — Phase 2.1 + 2.2
//
//  Wraps the WKWebView. Loads http://localhost:5757/island (the Phase 1
//  widget) and bridges three messages from the page:
//
//    - open_full_gui  → open default browser to /
//    - expand         → grow window so the expand panel isn't clipped
//    - collapse       → shrink window back to pill size
//
//  Auto-reload on failure: if the LISA server is down at launch time, the
//  webview retries the load every 4 seconds.
//

import AppKit
import WebKit

final class IslandContent: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    static let lisaURL = URL(string: "http://localhost:5757/island")!

    private weak var hostWindow: IslandWindow?
    private var webView: WKWebView!
    private var reloadTimer: Timer?

    init(window: IslandWindow) {
        self.hostWindow = window
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("not implemented")
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        // Receive postMessage from window.webkit.messageHandlers.island.
        config.userContentController.add(self, name: "island")
        config.processPool = WKProcessPool()

        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        config.defaultWebpagePreferences = preferences

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.autoresizingMask = [.width, .height]
        // Transparent: the page's CSS draws the rounded pill, the rest of
        // the rectangle should show what's underneath.
        wv.setValue(false, forKey: "drawsBackground")
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false

        webView = wv
        view = wv

        load()
    }

    // MARK: - Load / retry

    private func load() {
        let request = URLRequest(
            url: Self.lisaURL,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 5
        )
        webView.load(request)
    }

    private func scheduleReload() {
        reloadTimer?.invalidate()
        reloadTimer = Timer.scheduledTimer(
            withTimeInterval: 4.0,
            repeats: false
        ) { [weak self] _ in
            self?.load()
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleReload()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleReload()
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        guard let type = body["type"] as? String else { return }
        switch type {
        case "open_full_gui":
            if let fullURL = URL(string: "http://localhost:5757/") {
                NSWorkspace.shared.open(fullURL)
            }
        case "expand":
            hostWindow?.setExpanded(true)
        case "collapse":
            hostWindow?.setExpanded(false)
        case "drag_delta":
            // JS sends per-frame deltas in browser screen coords during a
            // pointermove drag. Swift moves the window directly — no
            // performDrag, no AppKit drag tracking loop, smooth as the
            // mouse hardware allows.
            guard let dx = body["dx"] as? Double,
                  let dy = body["dy"] as? Double else { return }
            hostWindow?.translateOriginByScreenDelta(dx: CGFloat(dx), dy: CGFloat(dy))
        case "drag_end":
            // Save the new anchor so it survives restart + state changes.
            hostWindow?.saveCurrentPositionAsAnchor()
        default:
            // Unknown message — ignore, don't crash.
            break
        }
    }
}
