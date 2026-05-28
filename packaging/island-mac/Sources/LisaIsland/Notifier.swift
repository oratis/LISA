//
//  Notifier.swift
//  LisaIsland — Phase 3.5 of issue #29
//
//  Thin wrapper around UNUserNotificationCenter for surfacing
//  "Claude is waiting" alerts as macOS-native notifications. Called
//  from IslandContent in response to a `notify` postMessage from the
//  page — the page is the source of truth for *when* to notify (it
//  knows about state transitions), this module just owns the *how*.
//
//  The browser fallback (Notification API in island.ts) still works
//  when the page is loaded in a plain browser tab. When running
//  inside LisaIsland.app, the page detects the native bridge and
//  defers to us instead.
//

import AppKit
import UserNotifications

@MainActor
final class Notifier: NSObject, @preconcurrency UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    /// Track per-session throttle independently of the page so even if
    /// the page reloads we still rate-limit cleanly. Same 60s window
    /// as the JS-side throttle.
    private var lastFireAt: [String: Date] = [:]
    private static let throttleSeconds: TimeInterval = 60
    private var permissionRequested = false

    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// Ask the user for notification permission. Idempotent — calling
    /// repeatedly after the first decision is a no-op.
    func ensurePermission() {
        guard !permissionRequested else { return }
        permissionRequested = true
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound]
        ) { _, _ in
            // Result is best-effort; system handles denial silently.
        }
    }

    /// Post a notification. Title + body come from the page; we add
    /// throttling, identifier-based replace-not-stack behavior, and a
    /// click action that asks the host app to open the full chat GUI.
    ///
    /// Privacy: title/body strings are constructed by the page from
    /// `projectLabel` and `sessionId` only — never message content.
    /// This module never reads jsonl.
    func notify(title: String, body: String, sessionId: String) {
        let key = sessionId.isEmpty ? "_default" : sessionId
        let now = Date()
        if let prev = lastFireAt[key], now.timeIntervalSince(prev) < Self.throttleSeconds {
            return
        }
        lastFireAt[key] = now

        let content = UNMutableNotificationContent()
        content.title = title
        content.body  = body
        content.sound = .default
        // `threadIdentifier` makes macOS visually group same-session
        // notifications. `identifier` (on the request) makes a new
        // alert REPLACE a previous one for the same session rather
        // than stack.
        content.threadIdentifier = "lisa.claude.\(key)"
        content.userInfo = ["sessionId": sessionId]

        let request = UNNotificationRequest(
            identifier: "lisa.claude.\(key)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { _ in
            // Best-effort. macOS may quietly drop if Focus is on.
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Show banners even when the app is "foreground" (it's an
    /// .accessory app so there's no real foreground; this keeps
    /// banners visible regardless).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// Click on a notification → open the full LISA chat GUI.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        if let url = URL(string: "http://localhost:5757/") {
            NSWorkspace.shared.open(url)
        }
    }
}
