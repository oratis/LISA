import XCTest
import SwiftUI
@testable import LisaPocket

final class AppearanceTests: XCTestCase {
    @MainActor
    func testTextAndStatusContrastInBothAppearances() {
        let foregrounds = [Theme.text, Theme.secondary, Theme.tertiary, Theme.accent,
                           Theme.gold, Theme.green, Theme.working, Theme.waiting,
                           Theme.danger, Theme.done, Theme.idle]
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            func luminance(_ color: Color) -> Double {
                var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                XCTAssertTrue(UIColor(color).resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a))
                func linear(_ v: CGFloat) -> Double {
                    let c = Double(v)
                    return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
                }
                return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
            }
            for background in [Theme.bgDeep, Theme.panel, Theme.card, Theme.userBubble] {
                for foreground in foregrounds {
                    let a = luminance(foreground), b = luminance(background)
                    XCTAssertGreaterThanOrEqual((max(a, b) + 0.05) / (min(a, b) + 0.05), 4.5,
                                                "Text/status contrast in \(style)")
                }
            }
        }
    }

    @MainActor
    func testChatAppearanceReviewArtifacts() throws {
        for scheme in [ColorScheme.light, .dark] {
            for size in [DynamicTypeSize.large, .accessibility1] {
                let preview = VStack(alignment: .leading, spacing: 20) {
                    Text("Lisa").font(.largeTitle.bold()).foregroundStyle(Theme.text)
                    Text("A little clarity, wherever you are.").foregroundStyle(Theme.secondary)
                    MessageBubble(message: ChatMessage(role: .user, text: "帮我整理今天的计划，让重点更清晰。"))
                    MessageBubble(message: ChatMessage(role: .lisa, text: "先完成最重要的一件事。\n\n**Today's focus**\nReview the draft, then leave time for a short break."))
                    HStack {
                        ThemePill(text: "Working", color: Theme.working)
                        ThemePill(text: "Done", color: Theme.done)
                    }
                    Text("Messages stay readable in both appearances.").font(.caption).foregroundStyle(Theme.tertiary)
                }
                .padding(20).frame(width: 393).background(Theme.bgDeep)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
                let renderer = ImageRenderer(content: preview)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage)
                XCTAssertEqual(image.size.width, 393)
                let attachment = XCTAttachment(image: image)
                attachment.name = "chat-\(scheme)-\(size)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }
}
