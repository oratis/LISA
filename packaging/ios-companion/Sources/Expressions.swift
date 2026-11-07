import SwiftUI

struct ExpressionPreferences: Codable, Equatable {
    enum Display: String, Codable, CaseIterable { case auto, `static`, emoji, off
        var label: String { switch self { case .auto: "Automatic"; case .static: "Still stickers"; case .emoji: "Emoji only"; case .off: "Off" } }
    }
    enum Frequency: String, Codable, CaseIterable { case restrained, lively
        var label: String { self == .restrained ? "Occasionally" : "More often" }
    }
    var display: Display = .static
    var frequency: Frequency = .restrained
    var json: [String: Any] { ["display": display.rawValue, "frequency": frequency.rawValue] }
}

struct ConversationExpression: Codable, Equatable, Identifiable {
    let version: Int
    let id: String
    let assetId: String
    let format: String
    let alt: String
    let emoji: String
    let animation: String
    let poster: String
    let native: String
    let durationMs: Int
    var valid: Bool {
        let prefix = "/assets/visuals/soft-ink-motion-v1/"
        return version == 1 && ["animated", "static", "emoji"].contains(format)
            && assetId.range(of: "^[a-z0-9-]{1,40}$", options: .regularExpression) != nil
            && animation == prefix + assetId + ".webp" && poster == prefix + assetId + "-static.webp"
            && native == prefix + assetId + ".gif" && (1...20000).contains(durationMs)
    }
    var playbackSeconds: Double { min(5, Double(durationMs) * 2 / 1000) }
    static func decode(_ object: Any?) -> ConversationExpression? {
        guard let object, JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let value = try? JSONDecoder().decode(Self.self, from: data), value.valid else { return nil }
        return value
    }
}

private struct ExpressionFrameKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

struct ConversationExpressionView: View {
    let expression: ConversationExpression
    let client: LisaClient
    let preferences: ExpressionPreferences
    let live: Bool
    var onPlaybackStarted: (() -> Void)? = nil
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var inViewport = false
    @State private var poster: UIImage?
    @State private var animation: UIImage?
    @State private var playing = false
    @State private var failed = false
    @State private var remaining: Double?
    @State private var replay = 0
    @State private var playbackRun = UUID()
    @State private var started: TimeInterval?
    private var sticker: Bool { preferences.display != .emoji && expression.format != "emoji" && expression.valid }
    private var canPlay: Bool { sticker && preferences.display == .auto && expression.format == "animated" && visible && inViewport && scenePhase == .active && !reduceMotion && !failed }
    private func pausePlayback() {
        if let started, let remaining { self.remaining = max(0, remaining - (ProcessInfo.processInfo.systemUptime - started)) }
        started = nil; playing = false; animation = nil
    }
    var body: some View {
        if preferences.display != .off {
            VStack(alignment: .leading, spacing: 4) {
                Group {
                    if sticker, let poster { PortraitImage(image: poster, animation: animation, playing: playing && canPlay) }
                    else { Text(expression.emoji).font(.system(size: 64)) }
                }
                .frame(width: 128, height: 128)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(expression.alt)
                .accessibilityAddTraits(.isImage)
                // The image above already announces the label once.
                Text(expression.alt).font(.caption2).foregroundStyle(.secondary).accessibilityHidden(true)
                if sticker && preferences.display == .auto && expression.format == "animated" && !reduceMotion && !failed {
                    Button("Replay") { remaining = expression.playbackSeconds; replay += 1 }
                        .disabled(playing).frame(minHeight: 44)
                        .accessibilityLabel("Replay \(expression.alt)")
                }
            }
            .background(GeometryReader { geometry in Color.clear.preference(key: ExpressionFrameKey.self, value: geometry.frame(in: .global)) })
            .onPreferenceChange(ExpressionFrameKey.self) { frame in
                inViewport = !frame.isEmpty && frame.intersects(UIScreen.main.bounds)
            }
            .onAppear { visible = true }
            .onDisappear { visible = false; playbackRun = UUID(); pausePlayback() }
            .task(id: "\(expression.id)|\(sticker)") {
                guard sticker else { poster = nil; return }
                poster = try? await LisaArtwork.expressionPoster(client: client, path: expression.poster)
            }
            .task(id: "\(canPlay)|\(replay)|\(expression.id)") {
                let run = UUID()
                playbackRun = run
                pausePlayback()
                guard canPlay else { return }
                if remaining == nil {
                    remaining = live ? expression.playbackSeconds : 0
                    // A LazyVStack may recreate an offscreen cell. Consume live
                    // autoplay in the transcript, so recreated cells stay still.
                    if live { onPlaybackStarted?() }
                }
                guard let budget = remaining, budget > 0 else { return }
                do {
                    guard let image = try await LisaArtwork.animation(client: client, path: expression.native) else { failed = true; return }
                    try Task.checkCancellation()
                    guard playbackRun == run else { return }
                    animation = image
                    // The first frame also works when a still request failed.
                    if poster == nil { poster = image.images?.first }
                    playing = true
                    started = ProcessInfo.processInfo.systemUptime
                    defer { if playbackRun == run { pausePlayback() } }
                    try await Task.sleep(nanoseconds: UInt64(budget * 1_000_000_000))
                } catch is CancellationError { }
                catch { if !Task.isCancelled { failed = true } }
            }
        }
    }
}

struct ExpressionSettingsSection: View {
    @EnvironmentObject var app: AppState
    @State private var busy = false
    @State private var status = ""
    var body: some View {
        Section("Conversation expressions") {
            Picker("Display", selection: Binding(get: { app.expressionPreferences.display }, set: { value in var next = app.expressionPreferences; next.display = value; save(next) })) {
                ForEach(ExpressionPreferences.Display.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            Picker("Frequency", selection: Binding(get: { app.expressionPreferences.frequency }, set: { value in var next = app.expressionPreferences; next.frequency = value; save(next) })) {
                ForEach(ExpressionPreferences.Frequency.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            Text("History stays still. Animations pause offscreen and follow Reduce Motion.").font(.caption).foregroundStyle(.secondary)
            if !status.isEmpty { Text(status).font(.caption).accessibilityAddTraits(.updatesFrequently) }
        }
        .disabled(busy)
        .task(id: app.config) { let expected = app.config; if let prefs = try? await app.client.expressionPreferences(), app.config == expected { app.expressionPreferences = prefs } }
    }
    private func save(_ prefs: ExpressionPreferences) {
        busy = true
        let expected = app.config
        Task { @MainActor in
            defer { busy = false }
            do {
                let saved = try await app.client.setExpressionPreferences(prefs)
                guard app.config == expected else { return }
                app.expressionPreferences = saved; status = "Saved."
            } catch { status = "Could not save. Try again." }
        }
    }
}
