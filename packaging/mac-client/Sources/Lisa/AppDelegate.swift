//
//  AppDelegate.swift
//  Lisa
//
//  Owns the MainWindow lifecycle and installs the standard Mac menu bar
//  (App / File / Edit / View / Window / Help).
//
//  Behavior:
//    - Closing the only window keeps the app alive in the Dock (standard
//      Mac model). Click the Dock icon to bring the window back.
//    - ⌘Q quits.
//    - ⌘W closes the front window.
//    - ⌘R reloads the chat (useful after server restart).
//

import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var mainWindow: MainWindow?
    private var workspace = Workspace.restore(in: .standard)

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()
        showMainWindow()

        // Quiet update discovery — throttled to once/day and surfaced at most
        // once per version, so it never nags. Only fires when a newer GitHub
        // release exists than this bundle's version.
        if workspace != .welcome {
            Updater.shared.discoverInBackground { [weak self] info in
                self?.presentUpdatePrompt(info)
            }
        }

        updateLocalServices()
        // The island's "open full chat" bridge posts this so we can bring the
        // chat window forward in-process.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleShowMainWindow(_:)),
            name: IslandContent.showMainWindowNotification,
            object: nil
        )
    }

    private func selectWorkspace(_ next: Workspace) {
        guard next != workspace else { return }
        let wasWelcome = workspace == .welcome
        workspace = next
        UserDefaults.standard.set(next.rawValue, forKey: Workspace.preference)
        mainWindow?.display(next)
        updateLocalServices()
        if wasWelcome {
            Updater.shared.discoverInBackground { [weak self] info in
                self?.presentUpdatePrompt(info)
            }
        }
    }

    private func updateLocalServices() {
        IslandController.shared.setWorkspaceActive(workspace == .mac)
        guard workspace == .mac else {
            HotkeyManager.shared.unregister()
            MenuBarController.shared.uninstall()
            return
        }
        // Auto-start the local backend if it isn't already up, so opening the
        // app "just works" without a separate `lisa serve --web` in a terminal.
        BackendController.shared.ensureRunning()
        // Phase 3.5 — menu bar mirror of Claude Code activity.
        // Click the status item to bring the main window to front.
        MenuBarController.shared.install { [weak self] in
            self?.showMainWindow()
        }
        // Vision — global ⌃⌥S (and ⌃⌥⇧S with context): screenshot straight into
        // Lisa's composer, from anywhere.
        HotkeyManager.shared.register { [weak self] includeContext in
            self?.captureForLisa(includeContext: includeContext)
        }
    }

    @objc private func handleShowMainWindow(_ note: Notification) {
        guard workspace == .mac else { return }
        let hadWindow = mainWindow != nil
        showMainWindow()
        // Screen-advisor "Optimize ▸" carries a prefill — drop it into the
        // chat composer (never auto-send). A freshly-created window needs a
        // beat for its WebView to finish loading before the JS bridge is live.
        if let prefill = note.userInfo?["prefill"] as? String, !prefill.isEmpty {
            let delay: TimeInterval = hadWindow ? 0.15 : 0.6
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.mainWindow?.prefillComposer(prefill)
            }
        }
    }

    @objc func captureForLisa(_ sender: Any?) { captureForLisa(includeContext: false) }
    @objc func captureContextForLisa(_ sender: Any?) { captureForLisa(includeContext: true) }
    private func captureForLisa(includeContext: Bool) {
        guard workspace == .mac else { return }
        // Do NOT raise the Lisa window first — that would cover whatever the
        // user is trying to screenshot. screencapture's crosshair is a
        // system-level overlay that works regardless of which app is frontmost,
        // and the WKWebView keeps running while backgrounded, so the JS bridge
        // fires fine. We bring the window forward only AFTER a shot is actually
        // attached (so the user sees it land), and leave everything untouched
        // if they cancelled with Escape.
        let fireCapture: @MainActor @Sendable () -> Void = { [weak self] in
            self?.mainWindow?.triggerCapture(includeContext: includeContext) { attached in
                if attached { self?.bringWindowToFront() }
            }
        }
        if mainWindow != nil {
            fireCapture()
        } else {
            // First run: create the window to host the WebView/bridge but
            // order it BEHIND the frontmost app so it doesn't obscure the
            // capture target; give it a beat to load before firing.
            showMainWindowInBackground()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: fireCapture)
        }
    }

    /// Bring the chat window forward — called after a screenshot is attached,
    /// so the user sees the shot land in the composer.
    func bringWindowToFront() {
        showMainWindow()
    }

    private func showMainWindowInBackground() {
        if mainWindow == nil {
            mainWindow = makeMainWindow()
        }
        // orderFront (not makeKeyAndOrderFront) + no app activation: the
        // window exists to host the bridge but stays behind the capture target.
        mainWindow?.orderFront(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Standard Mac app behavior — keep running so Dock icon click can
        // reopen. Quit only on explicit ⌘Q.
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Coming back to the app is the other moment "the client started" means
        // to a user — and the backend may have died since launch. ensureRunning
        // probes first and no-ops while a start is already in flight, so this is
        // free when everything is healthy.
        if workspace == .mac { BackendController.shared.ensureRunning() }
        if !flag {
            showMainWindow()
        }
        return true
    }

    // MARK: - Window

    private func makeMainWindow() -> MainWindow {
        MainWindow(workspace: workspace) { [weak self] in self?.selectWorkspace($0) }
    }

    private func showMainWindow() {
        if let win = mainWindow {
            win.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let win = makeMainWindow()
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        mainWindow = win
    }

    @objc func reloadChat(_ sender: Any?) {
        mainWindow?.reload()
    }

    // MARK: - About / Updates

    @MainActor @objc func showPocket(_ sender: Any?) {
        RemoteDevicesWindow.shared.show()
    }

    @MainActor @objc func showAccount(_ sender: Any?) {
        if workspace == .cloud {
            showMainWindow()
            mainWindow?.openCloudAccount()
        } else {
            AccountWindowController.shared.show()
        }
    }

    @objc func showAbout(_ sender: Any?) {
        AboutWindowController.shared.show()
    }

    @objc func checkForUpdatesMenu(_ sender: Any?) {
        AboutWindowController.shared.show()
        AboutWindowController.shared.checkForUpdates()
    }

    /// A gentle, once-per-version prompt when launch discovery finds a newer
    /// release. Download installs the notarized DMG (Gatekeeper verifies it).
    private func presentUpdatePrompt(_ info: UpdateInfo) {
        let alert = NSAlert()
        alert.messageText = "Lisa \(info.tag) is available"
        alert.informativeText = "You have \(Updater.shared.currentVersion). Download the new version, or see what changed."
        alert.addButton(withTitle: "Download")
        alert.addButton(withTitle: "Changelog")
        alert.addButton(withTitle: "Later")
        switch alert.runModal() {
        case .alertFirstButtonReturn: NSWorkspace.shared.open(info.downloadURL)
        case .alertSecondButtonReturn: NSWorkspace.shared.open(Updater.changelogURL)
        default: break
        }
    }

    // MARK: - Settings

    @objc func openPreferences(_ sender: Any?) {
        PreferencesController.shared.show()
    }

    /// Main-actor isolated because the wizard is (it drives AppKit and spawns
    /// processes); menu actions always arrive on the main thread anyway.
    @MainActor
    @objc func openBackendSetup(_ sender: Any?) {
        BackendSetupController.shared.presentFromMenu()
    }

    @objc func newWindowAction(_ sender: Any?) {
        // Single-window for now; reuse existing.
        showMainWindow()
    }

    // MARK: - Menu

    @objc private func chooseCloud(_ sender: Any?) { selectWorkspace(.cloud); showMainWindow() }
    @objc private func chooseMac(_ sender: Any?) { selectWorkspace(.mac); showMainWindow() }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(chooseCloud(_:)), #selector(chooseMac(_:)):
            let choice: Workspace = menuItem.action == #selector(chooseCloud(_:)) ? .cloud : .mac
            menuItem.state = choice == workspace ? .on : .off
        case #selector(showAccount(_:)):
            menuItem.title = workspace == .cloud ? workspaceText("Cloud Account…") : "Account & Devices…"
            return workspace != .welcome
        case #selector(reloadChat(_:)):
            return workspace != .welcome
        case #selector(openBackendSetup(_:)), #selector(openPreferences(_:)), #selector(showPocket(_:)),
             #selector(captureForLisa(_:)), #selector(captureContextForLisa(_:)):
            return workspace == .mac
        default: break
        }
        return true
    }

    private func installMenu() {
        let mainMenu = NSMenu()

        // ── App menu ────────────────────────────────────────────────
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        let aboutItem = NSMenuItem(
            title: "About Lisa",
            action: #selector(showAbout(_:)),
            keyEquivalent: ""
        )
        aboutItem.target = self
        appMenu.addItem(aboutItem)
        let updatesItem = NSMenuItem(
            title: "Check for Updates…",
            action: #selector(checkForUpdatesMenu(_:)),
            keyEquivalent: ""
        )
        updatesItem.target = self
        appMenu.addItem(updatesItem)
        appMenu.addItem(.separator())
        let settingsItem = NSMenuItem(
            title: "Settings…",
            action: #selector(openPreferences(_:)),
            keyEquivalent: ","
        )
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        // Backend install / update wizard (UX-7) — also opens on its own when the
        // app can't find the `lisa` CLI at start.
        let setupItem = NSMenuItem(
            title: "Set Up Backend…",
            action: #selector(openBackendSetup(_:)),
            keyEquivalent: ""
        )
        setupItem.target = self
        appMenu.addItem(setupItem)
        // Managed inference (B8d): sign in once, run key-free via LISA Cloud.
        let accountItem = NSMenuItem(
            title: "Account & Devices…",
            action: #selector(showAccount(_:)),
            keyEquivalent: ""
        )
        accountItem.target = self
        appMenu.addItem(accountItem)
        let pocketItem = NSMenuItem(title: "Connect Lisa Pocket…", action: #selector(showPocket(_:)), keyEquivalent: "")
        pocketItem.target = self
        appMenu.addItem(pocketItem)
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(
            title: "Hide Lisa",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        ))
        let hideOthers = NSMenuItem(
            title: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(NSMenuItem(
            title: "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        ))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(
            title: "Quit Lisa",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        ))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // ── File menu ───────────────────────────────────────────────
        let fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(NSMenuItem(
            title: "New Window",
            action: #selector(newWindowAction(_:)),
            keyEquivalent: "n"
        ))
        fileMenu.addItem(NSMenuItem(
            title: "Close Window",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        ))
        fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)

        // ── Edit menu (standard responder chain — copy/paste etc.) ──
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let workspaceItem = NSMenuItem()
        let workspaceMenu = NSMenu(title: workspaceText("Workspace"))
        workspaceMenu.addItem(withTitle: Workspace.cloud.title, action: #selector(chooseCloud(_:)), keyEquivalent: "").target = self
        workspaceMenu.addItem(withTitle: Workspace.mac.title, action: #selector(chooseMac(_:)), keyEquivalent: "").target = self
        workspaceItem.submenu = workspaceMenu
        mainMenu.addItem(workspaceItem)

        // ── View menu ───────────────────────────────────────────────
        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(NSMenuItem(
            title: "Reload Chat",
            action: #selector(reloadChat(_:)),
            keyEquivalent: "r"
        ))
        // Vision — also reachable from the menu (global ⌃⌥S works anywhere).
        let captureItem = NSMenuItem(
            title: "Screenshot for Lisa",
            action: #selector(captureForLisa(_:)),
            keyEquivalent: "s"
        )
        captureItem.keyEquivalentModifierMask = [.control, .option]
        viewMenu.addItem(captureItem)
        let contextItem = NSMenuItem(title: "Screenshot + Front-window Text…",
            action: #selector(captureContextForLisa(_:)), keyEquivalent: "s")
        contextItem.keyEquivalentModifierMask = [.control, .option, .shift]
        viewMenu.addItem(contextItem)
        viewMenu.addItem(.separator())
        viewMenu.addItem(NSMenuItem(
            title: "Enter Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        ))
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        // ── Window menu (standard) ──────────────────────────────────
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(NSMenuItem(
            title: "Minimize",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        ))
        windowMenu.addItem(NSMenuItem(
            title: "Zoom",
            action: #selector(NSWindow.performZoom(_:)),
            keyEquivalent: ""
        ))
        windowMenu.addItem(.separator())
        windowMenu.addItem(NSMenuItem(
            title: "Bring All to Front",
            action: #selector(NSApplication.arrangeInFront(_:)),
            keyEquivalent: ""
        ))
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApplication.shared.mainMenu = mainMenu
    }
}
