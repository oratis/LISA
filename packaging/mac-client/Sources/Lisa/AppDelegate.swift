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

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindow: MainWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Auto-start the local backend if it isn't already up, so opening the
        // app "just works" without a separate `lisa serve --web` in a terminal.
        BackendController.shared.ensureRunning()

        installMenu()
        showMainWindow()

        // Quiet update discovery — throttled to once/day and surfaced at most
        // once per version, so it never nags. Only fires when a newer GitHub
        // release exists than this bundle's version.
        Updater.shared.discoverInBackground { [weak self] info in
            self?.presentUpdatePrompt(info)
        }

        // Phase 3.5 — menu bar mirror of Claude Code activity.
        // Click the status item to bring the main window to front.
        MenuBarController.shared.install { [weak self] in
            self?.showMainWindow()
        }

        // Vision — global ⌃⌥S: screenshot straight into Lisa's composer,
        // from anywhere. Brings the window forward, then runs the page's
        // capture bridge (server-side screencapture → attachment).
        HotkeyManager.shared.register { [weak self] in
            self?.captureForLisa(nil)
        }

        // Lisa Island — the notch pill, now a feature of this app rather than
        // a separate LisaIsland.app. Toggle it from View ▸ Show Lisa Island;
        // the on/off choice is remembered across launches.
        IslandController.shared.applyInitialState()
        // The island's "open full chat" bridge posts this so we can bring the
        // chat window forward in-process.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleShowMainWindow(_:)),
            name: IslandContent.showMainWindowNotification,
            object: nil
        )
    }

    @objc private func handleShowMainWindow(_ note: Notification) {
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

    @objc func captureForLisa(_ sender: Any?) {
        // Do NOT raise the Lisa window first — that would cover whatever the
        // user is trying to screenshot. screencapture's crosshair is a
        // system-level overlay that works regardless of which app is frontmost,
        // and the WKWebView keeps running while backgrounded, so the JS bridge
        // fires fine. We bring the window forward only AFTER a shot is actually
        // attached (so the user sees it land), and leave everything untouched
        // if they cancelled with Escape.
        let fireCapture: () -> Void = { [weak self] in
            self?.mainWindow?.triggerCapture { attached in
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
            mainWindow = MainWindow()
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
        if !flag {
            showMainWindow()
        }
        return true
    }

    // MARK: - Window

    private func showMainWindow() {
        if let win = mainWindow {
            win.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let win = MainWindow()
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        mainWindow = win
    }

    @objc func reloadChat(_ sender: Any?) {
        mainWindow?.reload()
    }

    // MARK: - About / Updates

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

    @objc func newWindowAction(_ sender: Any?) {
        // Single-window for now; reuse existing.
        showMainWindow()
    }

    // MARK: - Menu

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
