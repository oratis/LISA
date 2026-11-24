//
//  RoomWindow.swift
//  Lisa — Room Phase 3 (docs/PLAN_ROOM_v1.0.md §5)
//
//  Dedicated macOS ambient companion window hosting Lisa's `/room` view inside
//  a loopback-locked WKWebView. Reports window visibility back to `/room` via
//  the existing `lisa-room-visibility` message channel so particle loops pause
//  when minimized or closed.
//

import AppKit
import WebKit

/// Pure, testable configuration and navigation guard for the Room window.
enum RoomWindowConfig {
    static let defaultSize = CGSize(width: 560, height: 560)
    static let minSize = CGSize(width: 360, height: 360)
    static let frameAutosaveName = "ai.meetlisa.room.windowFrame.v1"
    static let roomURL = URL(string: "http://localhost:5757/room")!

    /// Allow only the local Lisa backend's `/room` page (and `about:blank`).
    static func isAllowedNavigation(_ url: URL?) -> Bool {
        guard let url else { return false }
        if url.absoluteString == "about:blank" { return true }
        guard url.scheme == "http",
              let host = url.host?.lowercased(),
              host == "localhost" || host == "127.0.0.1",
              url.port == 5757 else {
            return false
        }
        return url.path == "/room" || url.path.hasPrefix("/room/")
    }

    /// JavaScript snippet notifying `/room` when the native window hides or shows.
    static func visibilityMessageJS(visible: Bool) -> String {
        let flag = visible ? "true" : "false"
        return "window.postMessage({ type: 'lisa-room-visibility', visible: \(flag) }, window.location.origin);"
    }
}

@MainActor
final class RoomWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate {
    static let shared = RoomWindowController()

    private var panel: NSPanel?
    private var webView: WKWebView?
    private var workspaceActive = false

    func setWorkspaceActive(_ active: Bool) {
        workspaceActive = active
        if !active {
            closeIfOpen()
        }
    }

    func show() {
        guard workspaceActive else { return }
        if let existing = panel {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            notifyVisibility(true)
            return
        }

        let rect = NSRect(origin: .zero, size: RoomWindowConfig.defaultSize)
        let win = NSPanel(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        win.title = "Lisa · Room"
        win.minSize = RoomWindowConfig.minSize
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.isMovableByWindowBackground = true
        win.isReleasedWhenClosed = false
        win.hidesOnDeactivate = false
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        win.delegate = self

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let wv = WKWebView(frame: win.contentView?.bounds ?? rect, configuration: config)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        wv.setValue(false, forKey: "drawsBackground")
        win.contentView = wv

        win.setFrameAutosaveName(RoomWindowConfig.frameAutosaveName)
        if !win.setFrameUsingName(RoomWindowConfig.frameAutosaveName) {
            win.setContentSize(RoomWindowConfig.defaultSize)
            win.center()
        }

        self.panel = win
        self.webView = wv

        wv.load(URLRequest(url: RoomWindowConfig.roomURL))
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func closeIfOpen() {
        notifyVisibility(false)
        panel?.close()
    }

    private func notifyVisibility(_ visible: Bool) {
        webView?.evaluateJavaScript(RoomWindowConfig.visibilityMessageJS(visible: visible), completionHandler: nil)
    }

    // MARK: - NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        notifyVisibility(false)
    }

    func windowDidMiniaturize(_ notification: Notification) {
        notifyVisibility(false)
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        notifyVisibility(true)
    }

    // MARK: - WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if RoomWindowConfig.isAllowedNavigation(navigationAction.request.url) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let visible = panel?.isVisible == true && panel?.isMiniaturized == false
        notifyVisibility(visible)
    }
}
