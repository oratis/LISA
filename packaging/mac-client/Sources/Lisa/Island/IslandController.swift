//
//  IslandController.swift
//  Lisa
//
//  Owns the in-app Lisa Island — the notch pill that used to be a separate
//  LisaIsland.app. It's now a feature of Lisa.app, toggled from the menu
//  ("View ▸ Show Lisa Island") and remembered across launches in UserDefaults.
//
//  The window itself (IslandWindow) is identical to the standalone app's; this
//  controller just gates its lifecycle on the `enabled` preference.
//

import AppKit

// Not @MainActor: every caller is already a main-thread AppKit context
// (app launch + menu actions), and that keeps it callable from the
// nonisolated @objc menu selectors without hops.
final class IslandController {
    static let shared = IslandController()
    private init() {}

    private static let enabledKey = "ai.meetlisa.island.enabled"
    private var window: IslandWindow?

    /// Whether the island is switched on. Persisted; default off.
    var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    /// Show the island at launch if the user left it enabled.
    func applyInitialState() {
        if isEnabled { show() }
    }

    func setEnabled(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: Self.enabledKey)
        if on { show() } else { hide() }
    }

    func toggle() {
        setEnabled(!isEnabled)
    }

    func resetPosition() {
        window?.resetSavedOrigin()
    }

    // MARK: - Window lifecycle

    private func show() {
        if window == nil {
            window = IslandWindow()
        }
        // orderFrontRegardless: surface the pill without stealing focus from
        // whatever the user is doing (the island is a passive observer).
        window?.orderFrontRegardless()
    }

    private func hide() {
        // Fully tear down so the window's hover-polling timer stops (deinit
        // invalidates it). The saved origin lives in UserDefaults, so the pill
        // returns to the same spot when re-enabled.
        window?.orderOut(nil)
        window = nil
    }
}
