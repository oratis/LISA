//
//  WebContent.swift
//  Lisa
//
//  Hosts a WKWebView loading http://localhost:5757/ — the canonical LISA
//  chat GUI. Auto-retries on failed load (e.g. if the user opens this app
//  before starting `lisa serve --web`).
//

import AppKit
import WebKit

final class WebContent: NSViewController, WKNavigationDelegate, WKUIDelegate {
    static let lisaURL = URL(string: "http://localhost:5757/")!

    private var webView: WKWebView!
    private var reloadTimer: Timer?

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.processPool = WKProcessPool()

        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        config.defaultWebpagePreferences = preferences

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.autoresizingMask = [.width, .height]
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false
        // Custom user agent so the LISA server can recognize the client.
        // Cosmetic — useful in server logs and (eventually) for serving a
        // slightly different layout to native containers.
        wv.customUserAgent = "Mozilla/5.0 (Macintosh) Lisa-MacClient/0.1"

        webView = wv
        view = wv

        load()
    }

    // MARK: - Load / retry

    func load() {
        let request = URLRequest(
            url: Self.lisaURL,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 5
        )
        webView.load(request)
    }

    func reload() {
        webView.reloadFromOrigin()
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

    // MARK: - WKUIDelegate

    // Open target=_blank links in the user's default browser, not in a new
    // WebView (we don't have new-window infrastructure).
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}
