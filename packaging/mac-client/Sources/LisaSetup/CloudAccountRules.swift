import Foundation

/// Validation shared by the account screens, before credentials leave the Mac.
public enum CloudAccountRules {
    public static func serverURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        let local = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host.lowercased())
        guard url.scheme == "https" || (local && url.scheme == "http") else { return nil }
        return URL(string: String(url.absoluteString.dropLast(url.absoluteString.hasSuffix("/") ? 1 : 0)))
    }

    public static func validEmail(_ raw: String) -> Bool {
        let email = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".")
            && !email.contains(where: { $0.isWhitespace })
    }

    public static func codeDigits(_ raw: String) -> String {
        String(raw.filter { $0 >= "0" && $0 <= "9" }.prefix(6))
    }

    public static func isLisaBackendCommand(_ command: String) -> Bool {
        let text = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.contains(" serve --web") else { return false }
        return text.hasPrefix("lisa serve --web") || text.contains("/lisa serve --web")
            || (text.contains("/Lisa.app/Contents/Resources/backend/dist/cli.js "))
            || ((text.contains("/LISA/") || text.contains("/lisa/"))
                && (text.contains("/cli.js serve --web") || text.contains("/cli.ts serve --web")))
    }
}
