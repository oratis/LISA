//
//  AppDelegate.swift
//  LisaIsland
//
//  Owns the IslandWindow lifecycle. The window itself doesn't have a close
//  button — the only way to exit is ⌘Q (or `killall LisaIsland`).
//
//  Keyboard shortcuts:
//    ⌘Q     — quit
//    ⌃⌘0    — reset pill position to default (just below notch/menu bar)
//
//  Mouse:
//    ⌥+drag — reposition the pill (saved to UserDefaults)
//

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: IslandWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Minimal menu — needed for ⌘Q and the reset-position shortcut.
        installMenu()

        // Create + show the island. Bringing it to front without activating
        // the app keeps focus on whatever the user was doing.
        let win = IslandWindow()
        win.orderFrontRegardless()
        window = win
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // The island window can't actually be closed by the user (no close
        // button, no Window menu Close item). But just in case some system
        // event closes it, keep the process alive — Phase 2.3's LisaProbe
        // will need it running to detect LISA coming back online.
        return false
    }

    // MARK: - Menu

    private func installMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)

        let appMenu = NSMenu()

        let resetItem = NSMenuItem(
            title: "Reset Position",
            action: #selector(resetPosition(_:)),
            keyEquivalent: "0"
        )
        resetItem.keyEquivalentModifierMask = [.control, .command]
        resetItem.target = self
        appMenu.addItem(resetItem)

        appMenu.addItem(.separator())

        let quitItem = NSMenuItem(
            title: "Quit Lisa Island",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        quitItem.keyEquivalentModifierMask = [.command]
        appMenu.addItem(quitItem)

        appMenuItem.submenu = appMenu
        NSApplication.shared.mainMenu = mainMenu
    }

    @objc private func resetPosition(_ sender: Any?) {
        window?.resetSavedOrigin()
    }
}
