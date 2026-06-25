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
        config.processPool = WKProcessPool()

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

        observeBackend()
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
        if type == "start_backend" {
            BackendController.shared.start()
        }
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
    /// real chat UI's dark theme; replaced atomically when the next
    /// retry succeeds (the actual page load replaces the entire document).
    private func loadOfflineSplash(error: Error) {
        let html = Self.offlineHTML(errorMessage: error.localizedDescription)
        webView.loadHTMLString(html, baseURL: nil)
    }

    static func offlineHTML(errorMessage: String) -> String {
        // Bridge from JS → Swift via window.webkit.messageHandlers.island
        // isn't wired here, so the retry button just reloads the WebView's
        // current URL — which, since baseURL is nil and the document is
        // synthetic, falls through to a no-op. We instead navigate back
        // to localhost:5757 directly with location.assign — that triggers
        // a fresh load attempt.
        let escaped = errorMessage
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return """
        <!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">
        <title>LISA — backend offline</title>
        <style>
          :root { color-scheme: dark; }
          html, body { margin:0; padding:0; height:100%; background: #07091a;
            font-family: -apple-system, BlinkMacSystemFont, \"SF Pro Text\",
                         \"Inter\", system-ui, sans-serif;
            color: #e8eaff; -webkit-font-smoothing: antialiased; user-select: none; }
          body { display: flex; align-items: center; justify-content: center;
            background:
              radial-gradient(ellipse at 30% 20%, #1a1238 0%, transparent 50%),
              radial-gradient(ellipse at 80% 70%, #0a1f3a 0%, transparent 60%),
              linear-gradient(180deg, #0b1024 0%, #07091a 100%); }
          .card { width: min(560px, 88vw); padding: 32px 36px;
            background: rgba(20, 26, 64, 0.65);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 18px; backdrop-filter: blur(30px); }
          h1 { font-size: 22px; margin: 0 0 6px;
               letter-spacing: 0.01em; color: #ffd066; }
          p.sub { margin: 0 0 22px; color: #aeb5d3; font-size: 14px; line-height: 1.5; }
          h2 { font-size: 11px; font-weight: 700; letter-spacing: 0.10em;
               text-transform: uppercase; color: #6ad4ff; margin: 18px 0 8px; }
          pre { margin: 0; padding: 12px 14px; background: rgba(0, 0, 0, 0.30);
               border-radius: 10px; font-family: ui-monospace, \"SF Mono\", Menlo, monospace;
               font-size: 12.5px; color: #e8eaff; line-height: 1.55;
               white-space: pre-wrap; word-break: break-all;
               cursor: copy; transition: background 120ms ease; user-select: all; }
          pre:hover { background: rgba(106, 212, 255, 0.10); }
          .row { display: flex; gap: 10px; margin-top: 24px; }
          button { flex: 1; padding: 11px 14px; font-family: inherit;
                   font-size: 12.5px; font-weight: 700; letter-spacing: 0.06em;
                   border-radius: 12px; cursor: pointer;
                   background: linear-gradient(180deg, #6ad4ff 0%, #4eb8e5 100%);
                   color: #0a1024; border: 0;
                   box-shadow: 0 4px 14px rgba(106, 212, 255, 0.25);
                   transition: transform 120ms ease, box-shadow 120ms ease; }
          button:hover { transform: translateY(-1px);
                         box-shadow: 0 6px 18px rgba(106, 212, 255, 0.35); }
          button.ghost { background: rgba(255,255,255,0.06); color: #cdd3f0;
                         box-shadow: none; border: 1px solid rgba(255,255,255,0.16); }
          button:disabled { opacity: 0.6; cursor: default; transform: none; }
          .err { margin-top: 18px; padding: 10px 12px; border-radius: 8px;
                 background: rgba(255, 85, 119, 0.08); color: #ff95a8;
                 border: 1px solid rgba(255, 85, 119, 0.30);
                 font-size: 11.5px; font-family: ui-monospace, Menlo, monospace; }
          .hint { color: #6c7398; font-size: 11.5px; margin-top: 18px; line-height: 1.5; }
        </style></head><body>
        <div class=\"card\">
          <h1>LISA backend offline</h1>
          <p class=\"sub\">
            Lisa.app loads its chat from <code>http://localhost:5757</code> — but
            that server isn't responding right now.
          </p>

          <div class=\"row\">
            <button id=\"startBtn\" onclick=\"startBackend()\">▶&nbsp;&nbsp;Start Lisa backend</button>
            <button class=\"ghost\" onclick=\"location.assign('http://localhost:5757/')\">Retry</button>
          </div>
          <script>
            function startBackend() {
              var b = document.getElementById('startBtn');
              if (b) { b.textContent = 'Starting…'; b.disabled = true; }
              try { window.webkit.messageHandlers.lisa.postMessage({ type: 'start_backend' }); } catch (e) {}
            }
          </script>

          <h2>Or start it manually</h2>
          <pre>npm install -g @oratis/lisa     # one-time
        lisa serve --web                # start the backend</pre>

          <div class=\"err\">Last error: \(escaped)</div>
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
