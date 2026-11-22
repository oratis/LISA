// Save the fixed, localized game-library template from the owner page in Lisa.app.
import AppKit
import UniformTypeIdentifiers
import WebKit

enum GameLibraryTemplate: String {
    case english = "en"
    case chinese = "zh-CN"

    static let filename = "lisa-game-library-template.csv"

    var contents: Data {
        let header = self == .chinese
            ? "标题,来源,平台,版本,游玩秒数,游戏 ID,导出时间"
            : "Title,Source,Platform,Version,PlaytimeSeconds,Game Id,ExportedAt"
        return Data(("\u{FEFF}" + header + "\r\n").utf8)
    }
}

@MainActor
final class GameTemplateBridge: NSObject, WKScriptMessageHandler {
    static let name = "lisaGameTemplate"
    typealias Choose = (NSWindow, GameLibraryTemplate, @escaping (URL?) -> Void) -> Void

    private let origin: URL
    private let choose: Choose

    init(origin: URL, choose: Choose? = nil) {
        self.origin = origin
        self.choose = choose ?? Self.chooseDestination
    }

    // Share the owner-origin check with the native appearance bridge.
    static func isOwnerFrame(_ frame: WKFrameInfo, at origin: URL) -> Bool {
        let sender = frame.securityOrigin
        return frame.isMainFrame && sender.protocol == origin.scheme &&
            sender.host == origin.host && sender.port == origin.port
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.name, Self.isOwnerFrame(message.frameInfo, at: origin),
              let locale = message.body as? String, let template = GameLibraryTemplate(rawValue: locale),
              let window = message.webView?.window, window.attachedSheet == nil else { return }
        choose(window, template) { url in
            guard let url else { return }
            do {
                try template.contents.write(to: url, options: .atomic)
            } catch {
                NSAlert(error: error).beginSheetModal(for: window)
            }
        }
    }

    private static func chooseDestination(_ window: NSWindow, _ template: GameLibraryTemplate,
                                          _ completion: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = GameLibraryTemplate.filename
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.canCreateDirectories = true
        panel.title = template == .chinese ? "保存游戏库模板" : "Save game library template"
        panel.beginSheetModal(for: window) { response in
            completion(response == .OK ? panel.url : nil)
        }
    }
}
