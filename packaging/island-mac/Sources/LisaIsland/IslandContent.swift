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
        // Enable right-click → Inspect Element on macOS 13.3+ so we can
        // debug runtime issues without a separate browser session.
        if #available(macOS 13.3, *) {
            wv.isInspectable = true
        }

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
        loadOfflineSplash()
        scheduleReload()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadOfflineSplash()
        scheduleReload()
    }

    /// Pill-sized "offline" placeholder shown when localhost:5757 is
    /// unreachable. Visually consistent with the real pill so users
    /// understand at a glance that the app's alive but the backend isn't.
    /// Replaced atomically the next time the real page loads.
    private func loadOfflineSplash() {
        let html = """
        <!doctype html><html><head><meta charset=\"utf-8\"><style>
          html, body { margin: 0; padding: 0; background: transparent;
            font-family: -apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif;
            color: #e4e4e6; -webkit-font-smoothing: antialiased; user-select: none; }
          body { display: flex; flex-direction: column; align-items: center;
                 padding: 4px 8px; }
          .pill { display: inline-flex; align-items: center; gap: 8px;
            background: rgba(8, 12, 24, 0.92);
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 22px; padding: 5px 14px 5px 5px;
            backdrop-filter: blur(20px);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); }
          /* No avatar image — baseURL is nil on the offline splash, so
             relative URLs don't resolve. A muted circle with a "Z" mark
             ("she's sleeping") communicates offline without a broken icon. */
          .av { width: 36px; height: 36px; border-radius: 50%;
                background: #15192a; opacity: 0.55;
                border: 1px solid rgba(255, 255, 255, 0.10);
                display: grid; place-items: center;
                color: #6b7280; font-size: 16px; font-weight: 700; }
          .label { font-size: 13px; font-weight: 600; color: #9ba3b8;
                   letter-spacing: 0.02em; }
          .dot { width: 7px; height: 7px; border-radius: 50%;
                 background: #6b7280; flex-shrink: 0; }
        </style></head><body>
          <div class=\"pill\" title=\"LISA backend offline — start: lisa serve --web\">
            <div class=\"av\">z</div>
            <div class=\"label\">offline</div>
            <div class=\"dot\"></div>
          </div>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - Launch Lisa.app

    private func openLisaAppOrBrowser() {
        let ws = NSWorkspace.shared
        // Look up the installed Lisa.app by bundle id.
        if let appURL = ws.urlForApplication(withBundleIdentifier: "ai.meetlisa.app") {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = true
            ws.openApplication(at: appURL, configuration: cfg, completionHandler: nil)
            return
        }
        // Fall back to the browser.
        if let fullURL = URL(string: "http://localhost:5757/") {
            ws.open(fullURL)
        }
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        guard let type = body["type"] as? String else { return }
        switch type {
        case "open_full_gui":
            // Prefer launching the native Lisa.app (bundle id
            // ai.meetlisa.app) if it's installed. Falls back to the
            // browser at http://localhost:5757/ when the app isn't
            // present — keeps the island useful for users who only
            // run the web widget.
            openLisaAppOrBrowser()
        case "expand":
            // Page-side expand state — Swift uses this to size the
            // click-through "hot rect" (whole window when expanded,
            // just the pill when collapsed). No window resize happens.
            hostWindow?.setExpanded(true)
        case "collapse":
            hostWindow?.setExpanded(false)
        case "ensure_notify_permission":
            // Page is asking us to request macOS notification
            // permission (idempotent; system handles repeats).
            Task { @MainActor in
                Notifier.shared.ensurePermission()
            }
        case "notify":
            // Page detected a Claude session transitioning to
            // waiting/error/etc. and wants to surface it as a native
            // notification. Title + body are constructed page-side
            // from projectLabel + sessionId — never message content.
            guard let title = body["title"] as? String,
                  let bodyText = body["body"] as? String else { return }
            let sessionId = (body["sessionId"] as? String) ?? ""
            Task { @MainActor in
                Notifier.shared.notify(title: title, body: bodyText, sessionId: sessionId)
            }
        case "open_path":
            // Open a Finder window at the cwd of a Claude session
            // (Phase 3.5 B). Path is page-supplied; we restrict to
            // absolute paths under the user's home for safety.
            guard let raw = body["path"] as? String else { return }
            let path = (raw as NSString).expandingTildeInPath
            if path.hasPrefix("/") {
                let url = URL(fileURLWithPath: path, isDirectory: true)
                NSWorkspace.shared.open(url)
            }
        default:
            // Drag is handled entirely Swift-side now (sendEvent
            // intercept + nextEvent loop), so we no longer expect
            // drag_delta / drag_end from the page. Unknown messages
            // are tolerated for forward-compat with future phases.
            break
        }
    }
}
