import SwiftUI
import UserNotifications

/// APNs plumbing. SwiftUI has no didRegisterForRemoteNotifications hook, so a tiny
/// UIApplicationDelegate captures the device token and hands it to AppState (via a
/// notification) to POST to /api/push/register. Delivery itself needs the Mac's
/// APNs key (see src/web/push.ts) — this is the client half, ready in advance.
extension Notification.Name {
    static let apnsToken = Notification.Name("lisa.apnsToken")
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: .apnsToken, object: hex)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // e.g. the Simulator has no APNs — surface as a nil token (AppState reports it).
        NotificationCenter.default.post(name: .apnsToken, object: nil)
    }
}
