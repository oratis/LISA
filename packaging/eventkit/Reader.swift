import CryptoKit
import Darwin
import EventKit
import Foundation

@available(macOS 14.0, *)
@main struct EventKitReader {
    static func main() async {
        do {
            let result = try await run()
            let data = try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
            FileHandle.standardOutput.write(data)
        } catch {
            // Never print contents, account information, or native errors.
            FileHandle.standardError.write(Data("eventkit_unavailable".utf8))
            exit(1)
        }
    }

    enum Failure: Error { case unavailable }

    static func run() async throws -> Any {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 5, ["events", "reminders"].contains(args[0]) else { throw Failure.unavailable }
        let events = args[0] == "events"
        let type: EKEntityType = events ? .event : .reminder
        let store = EKEventStore()
        if args[1] == "authorize" && EKEventStore.authorizationStatus(for: type) == .notDetermined {
            let allowed: Bool
            if events { allowed = try await store.requestFullAccessToEvents() }
            else { allowed = try await store.requestFullAccessToReminders() }
            guard allowed else { throw Failure.unavailable }
        }
        guard EKEventStore.authorizationStatus(for: type) == .fullAccess else { throw Failure.unavailable }
        if ["authorize", "status"].contains(args[1]) {
            // Bind synced calendar identifiers to this Mac and OS user without exposing its hardware UUID.
            var bytes = [UInt8](repeating: 0, count: 16)
            var wait = timespec(tv_sec: 2, tv_nsec: 0)
            guard gethostuuid(&bytes, &wait) == 0 else { throw Failure.unavailable }
            let digest = SHA256.hash(data: Data(bytes) + Data("lisa-eventkit-\(getuid())".utf8))
            return ["granted": true, "accountId": digest.map { String(format: "%02x", $0) }.joined()]
        }
        let calendars = store.calendars(for: type)
        func resource(_ c: EKCalendar) -> [String:String] {
            ["id": c.calendarIdentifier, "name": String(c.title.prefix(400))]
        }
        if args[1] == "resources" { return calendars.map(resource) }
        guard let calendar = calendars.first(where: { $0.calendarIdentifier == args[2] }) else { throw Failure.unavailable }
        if args[1] == "resource" { return resource(calendar) }
        guard args[1] == "read" else { throw Failure.unavailable }
        var items: [[String:Any]] = []
        let total: Int
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if events {
            guard let start = iso.date(from: args[3]), let end = iso.date(from: args[4]), end > start,
                  end.timeIntervalSince(start) <= 31 * 86400 else { throw Failure.unavailable }
            let list = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: [calendar]))
            total = list.count
            for event in list.prefix(50) {
                guard event.calendar.calendarIdentifier == calendar.calendarIdentifier else { throw Failure.unavailable }
                items.append(["title": String((event.title ?? "").prefix(500)), "start": iso.string(from: event.startDate),
                              "end": iso.string(from: event.endDate), "allDay": event.isAllDay])
            }
        } else {
            let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: [calendar])
            let list: [EKReminder]? = await withCheckedContinuation { continuation in
                store.fetchReminders(matching: predicate) { reminders in continuation.resume(returning: reminders) }
            }
            guard let list else { throw Failure.unavailable }
            total = list.count
            for reminder in list.prefix(50) {
                guard reminder.calendar.calendarIdentifier == calendar.calendarIdentifier else { throw Failure.unavailable }
                var item: [String:Any] = ["title": String((reminder.title ?? "").prefix(500)), "priority": reminder.priority]
                if let due = reminder.dueDateComponents?.date { item["due"] = iso.string(from: due) }
                items.append(item)
            }
        }
        guard EKEventStore.authorizationStatus(for: type) == .fullAccess,
              store.calendar(withIdentifier: args[2]) != nil else { throw Failure.unavailable }
        return ["items": items, "truncated": total > items.count]
    }
}
