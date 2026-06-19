import SwiftUI
import UserNotifications

/// APNs plumbing. SwiftUI has no didRegisterForRemoteNotifications hook, so a tiny
/// UIApplicationDelegate captures the device token (→ /api/push/register) and routes
/// a notification tap's `link` deep-link. Delivery itself needs the Mac's APNs key
/// (see src/web/push.ts) — this is the client half, ready in advance.
extension Notification.Name {
    static let apnsToken = Notification.Name("lisa.apnsToken")
    static let apnsTapLink = Notification.Name("lisa.apnsTapLink")
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

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

    // Show banners for pushes that arrive while the app is foregrounded.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    // Tapping a notification routes its `link` (the lisapocket:// deep-link the
    // server set, mirroring ntfy's Click) to the app.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        if let link = response.notification.request.content.userInfo["link"] as? String {
            NotificationCenter.default.post(name: .apnsTapLink, object: link)
        }
    }
}
