//
//  MainWindow.swift
//  Lisa
//
//  Standard Mac window hosting the chat WKWebView. Remembers position +
//  size across launches via NSWindow's frameAutosaveName.
//

import AppKit
import SwiftUI

final class MainWindow: NSWindow {
    private static let defaultSize = CGSize(width: 1200, height: 800)
    // D-17: keep Mac ≥721px so the Web shell stays in desktop layout and never
    // collapses its mobile header under the traffic lights or DragHandleView.
    private static let minSize     = CGSize(width: 721, height: 500)

    private lazy var local = WebContent()
    private lazy var cloud = CloudWorkspace()
    private var workspace: Workspace = .welcome
    private var picker = NSPopUpButton()
    private var select: ((Workspace) -> Void)?

    convenience init(workspace: Workspace, onSelect: @escaping (Workspace) -> Void) {
        let frame = NSRect(origin: .zero, size: Self.defaultSize)
        self.init(
            contentRect: frame,
            styleMask: [
                .titled,
                .closable,
                .miniaturizable,
                .resizable,
                .fullSizeContentView,
            ],
            backing: .buffered,
            defer: false
        )

        title = "Lisa"
        minSize = Self.minSize
        // Title bar transparent so the chat's pixel-art background can extend
        // edge-to-edge underneath the traffic lights.
        titlebarAppearsTransparent = true
        // Hide the NATIVE title text: the hosted page draws its own branded
        // ".titlebar" ("Lisa") in that strip, so showing the native title too
        // rendered a duplicate "Lisa Lisa" in the title bar.
        titleVisibility = .hidden
        toolbarStyle = .unified
        isReleasedWhenClosed = false   // AppDelegate keeps a strong reference

        // Persist last frame across launches. The autosave key is
        // versioned — bumping it forces every user (including ones who
        // had a small window on the old pixel-art shell) to land back on
        // the 1200×800 default once when they pick up the redesign.
        // After this single reset, subsequent resizes are remembered.
        let autosaveKey = Workspace.frameName
        setFrameAutosaveName(autosaveKey)

        if !setFrameUsingName(autosaveKey) {
            // Fresh user / first run after the namespace bump: ensure
            // we're really at 1200×800 (init's contentRect can be
            // overridden by AppKit on some HiDPI setups), then center.
            setContentSize(Self.defaultSize)
            center()
        }

        select = onSelect
        picker.addItems(withTitles: [Workspace.cloud.title, Workspace.mac.title])
        picker.setAccessibilityLabel(workspaceText("Workspace"))
        picker.toolTip = workspaceText("Workspace")
        picker.target = self
        picker.action = #selector(workspacePicked)
        picker.sizeToFit()
        let accessory = NSTitlebarAccessoryViewController()
        accessory.layoutAttribute = .right
        accessory.view = picker
        addTitlebarAccessoryViewController(accessory)
        display(workspace)
    }

    @objc private func workspacePicked() {
        select?(picker.indexOfSelectedItem == 0 ? .cloud : .mac)
    }

    func display(_ next: Workspace) {
        workspace = next
        title = next.title
        picker.isHidden = next == .welcome
        appearance = nil
        // The local shell draws its own draggable title bar. Hosted pages,
        // including the login page, need the entire area below the native bar.
        if next == .mac { styleMask.insert(.fullSizeContentView) }
        else { styleMask.remove(.fullSizeContentView) }
        titlebarAppearsTransparent = next == .mac
        titleVisibility = next == .mac ? .hidden : .visible
        switch next {
        case .welcome:
            contentViewController = NSHostingController(rootView: WorkspaceWelcome { [weak self] in self?.select?($0) })
        case .cloud:
            picker.selectItem(at: 0)
            contentViewController = cloud
        case .mac:
            picker.selectItem(at: 1)
            contentViewController = local
        }
    }

    func openCloudAccount() {
        guard workspace == .cloud else { return }
        cloud.openAccount()
    }

    func reload() {
        switch workspace {
        case .mac: local.reload()
        case .cloud: cloud.reload()
        case .welcome: break
        }
    }

    /// Fire the screenshot→composer flow in the hosted page; `onAttached`
    /// reports whether a shot was actually captured (vs cancelled).
    func triggerCapture(includeContext: Bool = false, onAttached: @escaping (Bool) -> Void) {
        guard workspace == .mac else { onAttached(false); return }
        local.triggerCapture(includeContext: includeContext, onAttached: onAttached)
    }

    /// Pre-fill the chat composer (never auto-sends) — used by the
    /// screen-advisor suggestion card via the island bridge.
    func prefillComposer(_ text: String) {
        if workspace == .mac { local.prefillComposer(text) }
    }

    /// D-16: open in-conversation find (⌘F from Edit ▸ Find…).
    func triggerFind() {
        if workspace == .mac { local.triggerFind() }
    }
}
