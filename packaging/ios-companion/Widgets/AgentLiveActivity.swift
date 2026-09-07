import ActivityKit
import WidgetKit
import SwiftUI

/// The pinned agent's status on the Lock Screen + Dynamic Island — the iOS twin
/// of the Mac "island" (docs/IOS_COMPANION_PLAN.md §3.4).
struct AgentLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            // Lock Screen / banner
            HStack(spacing: 10) {
                Circle().fill(activityColor(context.state.state)).frame(width: 10, height: 10)
                    .accessibilityHidden(true)   // the combined label below says the state
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(context.attributes.agent) · \(context.attributes.project)")
                        .font(.headline).lineLimit(1)
                    Text(context.state.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text("\(context.state.turns)t").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            .padding()
            // One spoken sentence, with the state as a word — the dot's colour was
            // the only thing carrying it on the Lock Screen (D1).
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(context.attributes.agent), \(context.attributes.project), \(GlanceColors.phrase(context.state.state))")
            .accessibilityValue("\(context.state.detail), \(context.state.turns) turns")
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.attributes.agent, systemImage: "cpu").font(.caption)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(context.state.state)
                            .font(.caption.bold())
                            .foregroundStyle(activityColor(context.state.state))
                        Text("\(context.state.turns) turns")     // B22 — was dropped in expanded
                            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(GlanceColors.phrase(context.state.state)), \(context.state.turns) turns")
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("\(context.attributes.project) — \(context.state.detail)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            } compactLeading: {
                Circle().fill(activityColor(context.state.state)).frame(width: 8, height: 8)
                    .accessibilityLabel("Agent \(GlanceColors.phrase(context.state.state))")
            } compactTrailing: {
                Text("\(context.state.turns)").font(.caption2.monospacedDigit())
                    .accessibilityLabel("\(context.state.turns) turns")
            } minimal: {
                Circle().fill(activityColor(context.state.state)).frame(width: 8, height: 8)
                    .accessibilityLabel("Agent \(GlanceColors.phrase(context.state.state))")
            }
        }
    }
}

// Shared palette so the activity dot matches the roster + widget (I1/B23).
func activityColor(_ state: String) -> Color { GlanceColors.forState(state) }
