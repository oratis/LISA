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

final class WebContent: NSViewController, WKNavigationDelegate, WKUIDelegate {
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
