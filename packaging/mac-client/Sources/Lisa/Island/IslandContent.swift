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
        // baseURL is nil here, so no relative image loads — we draw a tidy
        // "sleeping" pill (moon glyph) instead of a broken avatar. The whole
        // pill is clickable: tap → ask Swift to start the backend.
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
          html, body { margin: 0; padding: 0; background: transparent;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
            color: #e6e8ee; -webkit-font-smoothing: antialiased; user-select: none; cursor: default; }
          body { display: flex; flex-direction: column; align-items: center; padding: 4px 8px; }
          .pill { display: inline-flex; align-items: center; gap: 9px;
            background: linear-gradient(180deg, rgba(28,35,56,0.94) 0%, rgba(10,14,28,0.94) 100%);
            border: 1px solid rgba(255,255,255,0.08); border-radius: 22px;
            padding: 5px 14px 5px 5px;
            backdrop-filter: blur(20px) saturate(1.4);
            box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.12) inset;
            cursor: pointer;
            transition: transform 250ms cubic-bezier(.22,1,.36,1), box-shadow 250ms ease; }
          .pill:hover { transform: translateY(-1px) scale(1.015);
            box-shadow: 0 14px 32px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.16) inset; }
          .pill:active { transform: scale(0.99); }
          .av { width: 36px; height: 36px; border-radius: 50%;
            background: radial-gradient(circle at 50% 38%, #22304a 0%, #141a2c 100%);
            border: 1px solid rgba(255,255,255,0.10);
            display: grid; place-items: center; color: #7f8bb0; font-size: 18px; }
          .txt { display: flex; flex-direction: column; line-height: 1.15; }
          .label { font-size: 13px; font-weight: 600; color: #c3c9e0; letter-spacing: 0.02em; }
          .hint { font-size: 10px; color: #7f8bb0; }
          .dot { width: 7px; height: 7px; border-radius: 50%; background: #6b7280; flex-shrink: 0; margin-left: 2px; }
          body.starting .dot { background: #6ad4ff; animation: pulse 1.2s ease-in-out infinite; }
          body.starting .av  { color: #6ad4ff; }
          @keyframes pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
        </style></head><body>
          <div class="pill" onclick="wake()" title="Lisa backend offline — click to start">
            <div class="av">☾</div>
            <div class="txt"><div class="label" id="lbl">offline</div><div class="hint" id="hint">click to start</div></div>
            <div class="dot"></div>
          </div>
          <script>
            function wake() {
              document.body.classList.add('starting');
              document.getElementById('lbl').textContent = 'starting…';
              document.getElementById('hint').textContent = 'waking Lisa up';
              try { window.webkit.messageHandlers.island.postMessage({ type: 'start_backend' }); } catch (e) {}
            }
          </script>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - Open the full chat

    /// In-app island: the chat window lives in THIS process, so just ask the
    /// AppDelegate to bring it forward (rather than launching a separate app).
    static let showMainWindowNotification = Notification.Name("ai.meetlisa.showMainWindow")

    private func openLisaAppOrBrowser(prefill: String = "") {
        let info: [AnyHashable: Any] = prefill.isEmpty ? [:] : ["prefill": prefill]
        NotificationCenter.default.post(
            name: Self.showMainWindowNotification, object: nil, userInfo: info)
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        guard let type = body["type"] as? String else { return }
        switch type {
        case "start_backend":
            // Offline pill tapped — start the local backend. The island's own
            // 4s retry loop reloads /island once it's up.
            Task { @MainActor in BackendController.shared.start() }
        case "open_full_gui":
            // Bring the in-process chat window forward. An optional `prefill`
            // (from the screen-advisor "Optimize ▸" card) is carried along so
            // the chat composer can be pre-filled — never auto-sent.
            let prefill = (body["prefill"] as? String) ?? ""
            openLisaAppOrBrowser(prefill: prefill)
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
