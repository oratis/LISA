import SwiftUI

/// Keep the phone launcher in exactly the same reading order as the Mac grid.
enum RoomDestination: String, CaseIterable, Hashable {
    case chat, dashboard, control, reve, room, sense, memory, knowledge, settings

    var title: LocalizedStringKey {
        switch self {
        case .chat: return "Chat"
        case .dashboard: return "Dashboard"
        case .control: return "Control"
        case .reve: return "Rêve"
        case .room: return "Room"
        case .sense: return "Sense"
        case .memory: return "Memory"
        case .knowledge: return "Knowledge"
        case .settings: return "Settings"
        }
    }
    var symbol: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .dashboard: return "chart.bar.xaxis"
        case .control: return "slider.horizontal.3"
        case .reve: return "moon.stars"
        case .room: return "chair.lounge"
        case .sense: return "waveform"
        case .memory: return "brain.head.profile"
        case .knowledge: return "books.vertical"
        case .settings: return "gearshape"
        }
    }
}

struct RoomView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.scenePhase) private var phase
    @Environment(\.dynamicTypeSize) private var typeSize
    @AppStorage("lisa.room.interior") private var interior = RoomInterior.sunroom
    @State private var ping: IslandPing?
    @State private var failed = false
    @State private var refreshVersion = 0
    @State private var briefing: RoomBriefing?
    @State private var selectedRequest: RoomRequest?
    private var needsYou: [AgentSession] { (briefing?.sessions ?? []).filter { $0.activity?.pendingPermission != nil } }

    private var online: Bool { ping?.online == true && !failed }
    private var status: String {
        if !app.config.isConfigured { return String(localized: "Welcome to Lisa’s room") }
        if failed { return String(localized: "Connection unavailable") }
        guard let ping, ping.online else { return String(localized: "Connecting…") }
        return RoomPose(mood: ping.mood).activity
    }

    var body: some View {
        NavigationStack(path: $app.roomPath) {
            GeometryReader { geo in
                let wide = geo.size.width >= 740 && !typeSize.isAccessibilitySize
                let portraitSpread = wide && geo.size.height > geo.size.width
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Space.l) {
                        roomHeader
                        if portraitSpread {
                            sceneColumn
                            HStack(alignment: .top, spacing: 24) {
                                launcher.frame(maxWidth: .infinity)
                                briefingSection.frame(maxWidth: .infinity)
                            }
                        } else if wide {
                            HStack(alignment: .top, spacing: 24) {
                                sceneColumn.frame(maxWidth: .infinity)
                                launcher.frame(maxWidth: .infinity)
                            }
                        } else {
                            sceneColumn
                            launcher
                        }
                        if !portraitSpread { briefingSection }
                    }
                    .frame(maxWidth: wide ? 1000 : Theme.readingWidth)
                    .padding(.horizontal, wide ? 32 : 18).padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await refresh() }
            }
            .background(Theme.bgDeep.ignoresSafeArea()).foregroundStyle(Theme.text)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: RoomDestination.self) { destination in
                detail(destination)
                    .navigationBarTitleDisplayMode(destination == .knowledge ? .inline : .large)
                    .toolbar(.visible, for: .navigationBar)
            }
        }
        .sheet(item: $selectedRequest, onDismiss: {
            if isRoomVisible { Task { await refresh() } }
        }) { item in
            RoomRequestView(item: item, canAnswer: briefing?.inbox?.canApprove == true && app.config.remoteMac == nil)
        }
        .task(id: isRoomVisible) {
            guard isRoomVisible, app.config.isConfigured else { return }
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(20)) } catch { break }
            }
        }
    }

    private var briefingSection: some View {
        RoomBriefingView(briefing: briefing, configured: app.config.isConfigured,
                         showMemory: { open(.memory) }, showRequest: { selectedRequest = $0 },
                         showSession: { session in
                             app.pendingSession = PendingNav(agent: session.agent, id: session.sessionId)
                             app.selectedTab = 2
                         })
    }

    private var isRoomVisible: Bool {
        app.selectedTab == 0 && (app.roomPath.isEmpty || app.roomPath == [.room] || app.roomPath == [.reve]) && phase == .active && !app.locked
    }
    private var roomHeader: some View {
        HStack(spacing: 12) {
            Text("Room").font(Theme.title(.largeTitle)).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 4)
            Button { app.openRoomSettings() } label: {
                HStack(spacing: 7) {
                    Image(systemName: app.connectionMode == .cloud ? "icloud" : "desktopcomputer")
                    if let name = app.config.remoteMac?.name { Text(verbatim: name) }
                    else { Text(LocalizedStringKey(app.connectionMode.label)) }
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                }
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Theme.sage, in: Capsule()).frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Theme.accent)
        }
    }

    private var sceneColumn: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(spacing: 0) {
                interactiveScene.aspectRatio(1.60, contentMode: .fit)
                ViewThatFits(in: .horizontal) {
                    HStack { sceneCaption.fixedSize(horizontal: true, vertical: false); Spacer(minLength: 12); sceneAction.fixedSize() }
                    VStack(alignment: .leading, spacing: 8) { sceneCaption; sceneAction }
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .foregroundStyle(Color.white)
                .background(Color(hex: 0x224437))
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius))
            if let first = needsYou.first, online {
                Button {
                    if needsYou.count == 1 { app.pendingSession = PendingNav(agent: first.agent, id: first.sessionId) }
                    app.selectedTab = 2
                } label: {
                    Label("Needs you · \(needsYou.count)", systemImage: "hand.raised")
                }.frame(minHeight: 44)
            } else if ping?.has_unread_idle_message == true, online {
                Button { app.roomPath.append(.reve) } label: {
                    Label("A note from Lisa", systemImage: "envelope")
                }.frame(minHeight: 44)
            }
        }
    }

    private var sceneCaption: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(interior.title).font(.caption.weight(.semibold)).foregroundStyle(Color(hex: 0xC6D9BB))
            Text(status).font(Theme.title(.title2))
        }
    }

    private var sceneAction: some View {
        Button { app.config.isConfigured ? open(.chat) : app.presentOnboarding() } label: {
            Label(app.config.isConfigured ? LocalizedStringKey("Chat") : LocalizedStringKey("Get started"),
                  systemImage: app.config.isConfigured ? "bubble.left" : "arrow.right")
                .font(.subheadline.weight(.semibold)).padding(.horizontal, 14)
                .frame(minHeight: 44).background(.white.opacity(0.15), in: Capsule())
        }.buttonStyle(.plain)
        .accessibilityLabel(app.config.isConfigured ? Text("Talk to Lisa") : Text("Get started"))
    }

    private var launcher: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                Text("Explore").font(Theme.title(.title2)).accessibilityAddTraits(.isHeader)
                Rectangle().fill(Theme.border).frame(height: Theme.hairline)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: typeSize.isAccessibilitySize ? 2 : 3), spacing: 8) {
                ForEach(RoomDestination.allCases, id: \.self) { destination in
                    Button { open(destination) } label: {
                        VStack(spacing: 7) {
                            Image(systemName: destination.symbol).font(.title3.weight(.medium))
                                .foregroundStyle(Theme.accent)
                            Text(destination.title).font(.subheadline.weight(.medium))
                                .multilineTextAlignment(.center).foregroundStyle(Theme.text)
                        }
                        .frame(maxWidth: .infinity, minHeight: 58).padding(.vertical, 5)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border, lineWidth: Theme.hairline) }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("room.tile."+destination.rawValue)
                }
            }
        }
    }

    private var interactiveScene: some View {
        RoomScene(interior: interior, mood: online ? ping?.mood : nil)
            .overlay {
                GeometryReader { geo in
                    let side = max(geo.size.width, geo.size.height)
                    let top = RoomScene.imageTop(for: geo.size)
                    let sunny = interior == .sunroom
                    hotspot(.memory).position(x: side * (sunny ? 0.22 : 0.26), y: top + side * (sunny ? 0.48 : 0.36))
                    hotspot(.control).position(x: side * 0.16, y: top + side * (sunny ? 0.69 : 0.60))
                    if online {
                        let standing = RoomPose(mood: ping?.mood ?? "") == .idle
                        hotspot(.chat).position(x: side * (standing ? 0.50 : interior.seat.x),
                                                y: top + side * (standing ? 0.71 : interior.seat.y - 0.09))
                    }
                }
            }
    }

    private func hotspot(_ destination: RoomDestination) -> some View {
        Button { open(destination) } label: {
            Color.clear.frame(width: 46, height: 46).contentShape(Rectangle())
        }
        .accessibilityLabel(Text(destination.title))
        .accessibilityIdentifier("room.object." + destination.rawValue)
    }

    private func open(_ destination: RoomDestination) {
        switch destination {
        case .chat: app.selectedTab = 1
        case .control: app.selectedTab = 2
        default: app.roomPath.append(destination)
        }
    }

    @ViewBuilder private func detail(_ destination: RoomDestination) -> some View {
        switch destination {
        case .room:
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    interactiveScene
                        .aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 20))
                    Picker("Interior", selection: $interior) {
                        ForEach(RoomInterior.allCases, id: \.self) { Text($0.title).tag($0) }
                    }.pickerStyle(.segmented)
                    Text(status).font(.title3)
                    Button("Talk to Lisa") { app.config.isConfigured ? open(.chat) : app.presentOnboarding() }
                        .buttonStyle(.borderedProminent)
                }.frame(maxWidth: 650).padding().frame(maxWidth: .infinity)
            }.background(Theme.bgDeep).navigationTitle("Inside the room")
        case .dashboard: HomeView()
        case .settings: SettingsView()
        case .sense:
            if app.connectionMode == .mac, app.config.isConfigured { SenseView() }
            else {
                ContentUnavailableView {
                    Label("Sense", systemImage: "waveform")
                } description: { Text("Connect your Mac to review ambient signals and their permissions.") }
                actions: { Button("Connection settings") { app.openRoomSettings() } }
                .navigationTitle("Sense")
            }
        case .memory:
            if app.config.isConfigured { MemoryView() }
            else { RoomConnectionPrompt().navigationTitle("Memory") }
        case .knowledge: RoomKnowledgeView()
        case .reve: RoomReveView(note: online ? ping?.last_idle_message_text : nil)
        case .chat, .control: EmptyView() // Routed to the persistent tabs by open(_:).
        }
    }

    @MainActor private func refresh() async {
        refreshVersion += 1
        let generation = refreshVersion
        let client = app.client
        async let snapshot = client.islandPing()
        async let context = app.roomPath.isEmpty ? RoomBriefing.load(client, mac: app.connectionMode == .mac) : nil
        let result = try? await snapshot
        guard !Task.isCancelled, app.client === client, generation == refreshVersion else { return }
        ping = result
        failed = result?.online != true
        let updated = await context
        guard !Task.isCancelled, app.client === client, generation == refreshVersion else { return }
        if let updated { briefing = updated }
    }
}
