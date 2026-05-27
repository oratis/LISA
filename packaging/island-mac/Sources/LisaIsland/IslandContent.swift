//
//  IslandContent.swift
//  LisaIsland — Phase 2.1
//
//  Wraps the WKWebView. Loads http://localhost:5757/island (the Phase 1
//  widget) and exposes the `island` message handler the page already
//  checks for (see src/web/island.ts — when present, btnOpen routes
//  `open_full_gui` here instead of `window.open('/')`).
//
//  Auto-reload on failure: if the LISA server is down at launch time, the
//  webview shows a blank page. Phase 2.3 (LisaProbe) will add a proper
//  offline overlay; for now we just retry the load every 4 seconds when
//  the page reports a failure.
//

import AppKit
import WebKit

final class IslandContent: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    static let lisaURL = URL(string: "http://localhost:5757/island")!

    private var webView: WKWebView!
    private var reloadTimer: Timer?

    override func loadView() {
        let config = WKWebViewConfiguration()
        // Receive `open_full_gui` from window.webkit.messageHandlers.island
        config.userContentController.add(self, name: "island")
        // Prefer a fast, JIT-enabled WebKit process pool; share with other
        // webviews this app might create later.
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

        // Cosmetics: kill the bounce + selection rings, we're not a webpage.
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
        // Most common: LISA isn't running yet — keep retrying quietly.
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
        default:
            // Unknown message — ignore, don't crash. Future phases add more.
            break
        }
    }
}
