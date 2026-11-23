import AppKit
import WebKit

/// The hosted web app owns authentication, session cookies and account data.
/// This view never installs the local workspace's script handlers or reads Mac credentials.
final class CloudWorkspace: NSViewController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    static let home = URL(string: "https://cloud.meetlisa.ai/")!
    private let web = WKWebView()
    private lazy var returnButton = NSButton(title: workspaceText("Return to chat"), target: self, action: #selector(openChat))
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let errorView = NSStackView()
    private var signInWindow: NSWindow?
    private var signInWeb: WKWebView?
    private var destination = home

    static func isCloud(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == home.host &&
            (url.port ?? 443) == 443 && url.user == nil && url.password == nil
    }

    static func isIdentityProvider(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && (url.port ?? 443) == 443 && url.user == nil && url.password == nil &&
            ["appleid.apple.com", "account.apple.com", "idmsa.apple.com", "accounts.google.com"].contains(url.host?.lowercased())
    }

    static func allowsMainFrameNavigation(_ url: URL, inSignInPopup: Bool) -> Bool {
        if isCloud(url) { return true }
        return inSignInPopup && (isIdentityProvider(url) || url.absoluteString == "about:blank")
    }

    static func allowsSubframeNavigation(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        if scheme == "https" {
            return url.user == nil && url.password == nil
        }
        return scheme == "about"
    }

    static func shouldOpenExternally(_ url: URL, navigationType: WKNavigationType) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else { return false }
        if navigationType == .linkActivated { return true }
        return url.host?.lowercased() == "checkout.stripe.com" && (url.port ?? 443) == 443
    }

    override func loadView() {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700))
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true

        returnButton.isHidden = true
        let column = NSStackView(views: [returnButton, web])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 0
        column.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(column)

        let title = NSTextField(labelWithString: workspaceText("Couldn’t open LISA Cloud"))
        title.font = .preferredFont(forTextStyle: .title2)
        errorView.orientation = .vertical
        errorView.spacing = 12
        errorView.addArrangedSubview(title)
        errorView.addArrangedSubview(errorLabel)
        let retry = NSButton(title: workspaceText("Try again"), target: self, action: #selector(reload))
        errorView.addArrangedSubview(retry)
        errorView.translatesAutoresizingMaskIntoConstraints = false
        errorView.isHidden = true
        container.addSubview(errorView)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: container.topAnchor), column.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            column.leadingAnchor.constraint(equalTo: container.leadingAnchor), column.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            web.widthAnchor.constraint(equalTo: column.widthAnchor),
            errorView.centerXAnchor.constraint(equalTo: container.centerXAnchor), errorView.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            errorView.widthAnchor.constraint(lessThanOrEqualToConstant: 400),
        ])
        view = container
        openChat()
    }

    @objc func openChat() { navigate(to: Self.home) }
    func openAccount() { navigate(to: Self.home.appendingPathComponent("account")) }

    private func navigate(to url: URL) {
        destination = url
        errorView.isHidden = true
        web.isHidden = false
        returnButton.isHidden = url.path.isEmpty || url.path == "/"
        web.load(URLRequest(url: url))
    }

    @objc func reload() { navigate(to: destination) }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        // WebKit asks for policy before delivering target=_blank to createWebViewWith.
        if action.targetFrame == nil {
            decisionHandler(.allow)
        } else if action.targetFrame?.isMainFrame == false {
            // Hosted sign-in embeds HTTPS identity and challenge frames.
            decisionHandler(Self.allowsSubframeNavigation(url) ? .allow : .cancel)
        } else if Self.allowsMainFrameNavigation(url, inSignInPopup: webView === signInWeb) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if Self.shouldOpenExternally(url, navigationType: action.navigationType) {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === web, let url = web.url, Self.isCloud(url) else { return }
        destination = url
        returnButton.isHidden = url.path.isEmpty || url.path == "/"
    }

    private func failed(_ webView: WKWebView, _ error: Error) {
        let failure = error as NSError
        guard webView === web, !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled),
              !(failure.domain == "WebKitErrorDomain" && failure.code == 102) else { return }
        if let url = failure.userInfo[NSURLErrorFailingURLErrorKey] as? URL, Self.isCloud(url) { destination = url }
        web.isHidden = true
        errorLabel.stringValue = error.localizedDescription
        errorView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if webView === signInWeb {
            if Self.shouldOpenExternally(url, navigationType: action.navigationType) {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
        guard webView === web else { return nil }
        if Self.isCloud(url) { navigate(to: url); return nil }
        if Self.isIdentityProvider(url) || url.absoluteString == "about:blank" {
            signInWindow?.close()
            let child = WKWebView(frame: .zero, configuration: configuration)
            child.navigationDelegate = self
            child.uiDelegate = self
            let popup = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 640),
                                 styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            popup.isReleasedWhenClosed = false
            popup.title = "LISA Cloud"
            popup.contentView = child
            popup.delegate = self
            signInWindow = popup
            signInWeb = child
            popup.center()
            popup.makeKeyAndOrderFront(nil)
            return child
        }
        if Self.shouldOpenExternally(url, navigationType: action.navigationType) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView === signInWeb { signInWindow?.close() }
    }

    func windowWillClose(_ notification: Notification) { signInWeb = nil; signInWindow = nil }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        signInWindow?.close()
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard webView === web, frame.isMainFrame, let url = frame.request.url, Self.isCloud(url) else {
            completionHandler(nil); return
        }
        webView.chooseAttachments(parameters, completionHandler: completionHandler)
    }
}
