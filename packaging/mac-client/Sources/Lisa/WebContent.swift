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

/// Transparent overlay placed on top of the WKWebView for the top
/// `titlebarHeight` pixels. Dragging behavior is two-pronged because
/// `mouseDownCanMoveWindow = true` alone is unreliable when the view
/// sits in front of a WKWebView — WebKit's internal NSView graph can
/// intercept or reorder events, so we ALSO explicitly forward the
/// mouseDown to `NSWindow.performDrag(with:)`. Either path will move
/// the window; double-click still triggers the standard macOS zoom.
///
/// `wantsLayer = true` with a clear backing layer guarantees the view
/// participates in hit-testing as a normal opaque rect (without it
/// AppKit can skip the view on some macOS versions when it has no
/// drawing).
final class DragHandleView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }
    required init?(coder: NSCoder) { fatalError("not implemented") }

    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        // Double-click → zoom. Single-click → drag.
        if event.clickCount == 2 {
            window?.performZoom(nil)
            return
        }
        window?.performDrag(with: event)
    }
}

final class WebContent: NSViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let lisaURL = URL(string: "http://localhost:5757/")!
    static let titlebarHeight: CGFloat = 36

    private var webView: WKWebView!
    private var reloadTimer: Timer?

    override func loadView() {
        let config = WKWebViewConfiguration()
        // Share one persistent website data store with the island pill's web
        // view, so cookies / localStorage (the web session, theme choice) are the
        // same in both. This is the real seam for that sharing — the former
        // `config.processPool = WKProcessPool()` never was: since macOS 12 extra
        // process pools have no effect, and the API is deprecated.
        config.websiteDataStore = .default()

        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        config.defaultWebpagePreferences = preferences

        // Bridge so the offline splash's "Start backend" button can reach Swift.
        config.userContentController.add(self, name: "lisa")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false
        // Custom user agent so the LISA server can recognize the client.
        // Cosmetic — useful in server logs and (eventually) for serving a
        // slightly different layout to native containers.
        wv.customUserAgent = "Mozilla/5.0 (Macintosh) Lisa-MacClient/0.1"
        // Enable right-click → Inspect Element on macOS 13.3+ so we can
        // debug runtime issues (JS errors, click handlers, etc.) without
        // a separate browser session.
        if #available(macOS 13.3, *) {
            wv.isInspectable = true
        }

        // Container: WKWebView fills it (Auto Layout, all four edges).
        // DragHandleView floats on top for the title-bar strip — added
        // last so it sits in front in z-order. Auto Layout for both so
        // they coexist cleanly (mixing autoresizing-mask + Auto Layout
        // siblings can leave the mask sibling stuck at zero size).
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800))

        wv.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: container.topAnchor),
            wv.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        let drag = DragHandleView()
        drag.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(drag)
        NSLayoutConstraint.activate([
            drag.topAnchor.constraint(equalTo: container.topAnchor),
            drag.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            drag.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            drag.heightAnchor.constraint(equalToConstant: Self.titlebarHeight),
        ])

        webView = wv
        view = container
        applyAppearance(UserDefaults.standard.string(forKey: "lisaAppearancePreference") ?? "system")
        NotificationCenter.default.addObserver(self, selector: #selector(syncMotionVisibility), name: NSWindow.didChangeOcclusionStateNotification, object: nil)

        observeBackend()
        load()
    }

    // MARK: - Load / retry

    @objc private func syncMotionVisibility() {
        let visible = webView?.window?.occlusionState.contains(.visible) == true
        webView?.evaluateJavaScript("window.LisaMotion?.setHostVisible(\(visible ? "true" : "false"));", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        syncMotionVisibility()
    }

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

    /// Invoke the page's screenshot→composer bridge (defined in lisa-html.ts)
    /// and call `onAttached(true)` once a screenshot was actually captured +
    /// attached (false if the user pressed Escape / it failed).
    ///
    /// We AWAIT the page's Promise via callAsyncJavaScript so the window is
    /// raised only AFTER the shot is taken — raising it earlier would cover
    /// whatever the user is trying to screenshot. callAsyncJavaScript (macOS
    /// 11+) resolves with the JS return value; older macOS falls back to the
    /// fire-and-forget path (window already handled by the caller).
    func triggerCapture(onAttached: @escaping (Bool) -> Void) {
        let js = "return await (window.lisaCaptureAndAttach ? window.lisaCaptureAndAttach('interactive') : false);"
        if #available(macOS 11.0, *) {
            webView.callAsyncJavaScript(
                js, arguments: [:], in: nil, in: .page
            ) { result in
                switch result {
                case .success(let value):
                    onAttached((value as? Bool) ?? false)
                case .failure(let err):
                    FileHandle.standardError.write(
                        Data("[lisa] capture bridge error: \(err)\n".utf8))
                    onAttached(false)
                }
            }
        } else {
            webView.evaluateJavaScript(
                "window.lisaCaptureAndAttach && window.lisaCaptureAndAttach('interactive');"
            ) { _, _ in onAttached(true) }
        }
    }

    /// Drop text into the page's chat composer via window.lisaPrefillComposer
    /// (defined in lisa-html.ts). Never sends. The text is JSON-encoded (as a
    /// 1-element array, taking [0] in JS) so quotes/newlines can't break out.
    func prefillComposer(_ text: String) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: [text]),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript(
            "window.lisaPrefillComposer && window.lisaPrefillComposer(\(json)[0]);",
            completionHandler: nil
        )
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

    // MARK: - WKScriptMessageHandler (offline splash → Swift)

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        if type == "appearance" {
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == "localhost",
                  message.frameInfo.securityOrigin.port == 5757,
                  let preference = body["preference"] as? String,
                  ["system", "calm", "nebula"].contains(preference) else { return }
            UserDefaults.standard.set(preference, forKey: "lisaAppearancePreference")
            applyAppearance(preference)
        } else if type == "start_backend" {
            BackendController.shared.start()
        } else if type == "setup_backend" {
            // UX-7: the splash's second door — the guided install wizard, for
            // when the backend isn't just stopped but was never installed.
            BackendSetupController.shared.presentFromMenu()
        }
    }

    private func applyAppearance(_ preference: String) {
        let appearance: NSAppearance? = preference == "calm" ? NSAppearance(named: .aqua)
            : preference == "nebula" ? NSAppearance(named: .darkAqua) : nil
        view.appearance = appearance
        view.window?.appearance = appearance
        webView.underPageBackgroundColor = .windowBackgroundColor
    }

    /// Reload the chat as soon as the backend reports up (snappier than waiting
    /// for the 4s retry). Call once from loadView.
    private func observeBackend() {
        NotificationCenter.default.addObserver(
            forName: BackendController.statusChanged, object: nil, queue: .main
        ) { [weak self] note in
            if (note.userInfo?["up"] as? Bool) == true { self?.load() }
        }
    }

    /// Show a styled "backend not running" placeholder inside the WebView
    /// when localhost:5757 isn't reachable. Visually consistent with the
    /// real chat UI's chosen appearance; replaced atomically when the next
    /// retry succeeds (the actual page load replaces the entire document).
    private func loadOfflineSplash(error: Error) {
        // Prefer the backend's OWN reason for not being there — BackendController
        // reads it out of ~/.lisa/backend.log after a start attempt dies. WebKit's
        // error only ever says "could not connect", never why.
        let detail = BackendController.shared.lastFailure
            ?? "Last error: " + error.localizedDescription
        let html = Self.offlineHTML(errorMessage: detail)
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// `errorMessage` is already a full sentence (see loadOfflineSplash) — the
    /// backend's own exit line when we have it, WebKit's connection error if not.
    static func offlineHTML(errorMessage: String) -> String {
        // Bridge from JS → Swift via window.webkit.messageHandlers.island
        // isn't wired here, so the retry button just reloads the WebView's
        // current URL — which, since baseURL is nil and the document is
        // synthetic, falls through to a no-op. We instead navigate back
        // to localhost:5757 directly with location.assign — that triggers
        // a fresh load attempt.
        let escaped = errorMessage
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        let preference = UserDefaults.standard.string(forKey: "lisaAppearancePreference") ?? "system"
        let theme = preference == "calm" ? "light" : preference == "nebula" ? "dark" : "system"
        return """
        <!doctype html><html lang=\"en\" data-theme=\"\(theme)\"><head><meta charset=\"utf-8\">
        <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
        <title>LISA — backend offline</title>
        <style>
          :root { color-scheme: dark; --bg:#0b1024; --card:#161c3c; --fg:#e8eaff;
            --secondary:#aeb5d3; --muted:#969fbe; --accent:#6ad4ff; --on-accent:#0a1024;
            --border:#303858; --well:#0c1126; --error:#ff95a8; }
          :root[data-theme="light"] { color-scheme:light; --bg:#f5f6fa; --card:#fff; --fg:#1b2430;
            --secondary:#4d5666; --muted:#5f6878; --accent:#4f5bd5; --on-accent:#fff;
            --border:#dde2ec; --well:#f0f3f8; --error:#be2945; }
          @media (prefers-color-scheme: light) {
            :root:not([data-theme="dark"]) { color-scheme:light; --bg:#f5f6fa; --card:#fff; --fg:#1b2430;
              --secondary:#4d5666; --muted:#5f6878; --accent:#4f5bd5; --on-accent:#fff;
              --border:#dde2ec; --well:#f0f3f8; --error:#be2945; }
          }
          * { box-sizing:border-box; }
          html, body { margin:0; min-height:100%; background:var(--bg); color:var(--fg);
            font-family:-apple-system, BlinkMacSystemFont, system-ui, sans-serif;
            -webkit-font-smoothing:antialiased; }
          body { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:56px 24px 24px; }
          .card { width:min(560px, 100%); padding:32px; background:var(--card);
            border:1px solid var(--border); border-radius:20px; box-shadow:0 16px 48px rgba(32,45,70,.08); }
          h1 { font-size:26px; margin:0 0 10px; letter-spacing:-.025em; }
          p.sub { margin:0 0 24px; color:var(--secondary); font-size:15px; line-height:1.65; }
          h2 { font-size:13px; font-weight:600; color:var(--secondary); margin:24px 0 10px; }
          pre { margin:0; padding:12px 14px; background:var(--well); color:var(--fg);
            border:1px solid var(--border); border-radius:10px; font:12.5px/1.6 ui-monospace, Menlo, monospace;
            white-space:pre-wrap; overflow-wrap:anywhere; user-select:all; }
          .row { display:flex; flex-wrap:wrap; gap:10px; margin-top:12px; }
          button { flex:1; min-height:44px; padding:12px 16px; font:600 14px system-ui;
            border-radius:12px; cursor:pointer; background:var(--accent); color:var(--on-accent); border:0; }
          button:hover { filter:brightness(.95); }
          button.ghost { background:var(--card); color:var(--fg); border:1px solid var(--border); }
          button:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
          button:disabled { opacity:.6; cursor:default; }
          .err { margin-top:18px; padding:12px; border-radius:10px; background:var(--well);
            color:var(--error); border:1px solid var(--border); font:12px/1.6 ui-monospace, Menlo, monospace;
            overflow-wrap:anywhere; user-select:text; }
          .hint { color:var(--muted); font-size:13px; margin-top:20px; line-height:1.6; }
        </style></head><body>
        <div class=\"card\">
          <h1>Let’s reconnect Lisa</h1>
          <p class=\"sub\">
            Lisa’s local service isn’t responding yet. Start it below to get back
            to your conversations.
          </p>

          <div class=\"row\">
            <button id=\"startBtn\" onclick=\"startBackend()\">Start Lisa</button>
            <button class=\"ghost\" onclick=\"location.assign('http://localhost:5757/')\">Retry</button>
          </div>
          <div class=\"row\">
            <button class=\"ghost\" onclick=\"setupBackend()\">Set&nbsp;up&nbsp;backend…</button>
          </div>
          <script>
            function startBackend() {
              var b = document.getElementById('startBtn');
              if (b) { b.textContent = 'Starting…'; b.disabled = true; }
              try { window.webkit.messageHandlers.lisa.postMessage({ type: 'start_backend' }); } catch (e) {}
            }
            function setupBackend() {
              try { window.webkit.messageHandlers.lisa.postMessage({ type: 'setup_backend' }); } catch (e) {}
            }
          </script>

          <h2>If it keeps failing</h2>
          <pre>tail -n 40 ~/.lisa/backend.log</pre>

          <div class=\"err\">\(escaped)</div>
          <p class=\"hint\">
            Lisa.app will also retry automatically every 4 seconds.
            Once the backend is up, this page disappears on its own.
          </p>
        </div>
        </body></html>
        """
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Only swap to the offline splash if the URL we were trying was
        // our real backend — synthetic loads (loadHTMLString) shouldn't
        // recurse into "show offline" themselves.
        let nsErr = error as NSError
        let isOurUrl = (nsErr.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.host == "localhost"
        if isOurUrl {
            loadOfflineSplash(error: error)
        }
        scheduleReload()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let nsErr = error as NSError
        let isOurUrl = (nsErr.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.host == "localhost"
        if isOurUrl {
            loadOfflineSplash(error: error)
        }
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

    // Grant the web UI's getUserMedia request (🎙 voice dictation). Without this
    // delegate, WKWebView denies capture by default and the page sees no
    // mediaDevices ("recording not supported"). We only ever load our own
    // localhost UI; the OS TCC prompt (NSMicrophoneUsageDescription) still gates
    // actual access, and the audio-input entitlement is declared for the
    // hardened runtime.
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }

    /// WKWebView on macOS does NOT provide a default file picker for
    /// `<input type="file">` clicks — without this delegate method,
    /// clicking the paperclip in the chat composer is a silent no-op.
    /// We bridge it to a standard NSOpenPanel.
    ///
    /// `parameters.allowsMultipleSelection` honors the HTML `multiple`
    /// attribute. We don't filter by MIME type from `accept=` (Apple
    /// doesn't expose that on `WKOpenPanelParameters`), so the picker
    /// shows everything — the chat backend already handles whatever
    /// the user picks.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        // stderr log so we can tell at a glance whether WKWebView is
        // forwarding the picker request to us. Visible via
        // `log stream --process Lisa` or by launching from Terminal.
        FileHandle.standardError.write(
            Data("[lisa] runOpenPanel (multiple=\(parameters.allowsMultipleSelection))\n".utf8)
        )
        // Must dispatch to main — WKWebView delegate callbacks already
        // run on main, but the NSOpenPanel sheet machinery is touchy
        // about being on the main runloop, so be explicit.
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.resolvesAliases = true
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.message = "Select files to attach to your message"
            panel.prompt = "Attach"
            if let host = webView.window {
                panel.beginSheetModal(for: host) { response in
                    completionHandler(response == .OK ? panel.urls : nil)
                }
            } else {
                let response = panel.runModal()
                completionHandler(response == .OK ? panel.urls : nil)
            }
        }
    }
}
