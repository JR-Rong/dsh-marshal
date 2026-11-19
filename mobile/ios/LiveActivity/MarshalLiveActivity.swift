import ActivityKit
import WidgetKit
import SwiftUI

struct MarshalActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var title: String
        var body: String
        var running: Bool
    }
    var name: String
}

struct MarshalLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MarshalActivityAttributes.self) { context in
            Text(context.state.title).font(.headline)
            Text(context.state.body).font(.caption)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title)
                    Text(context.state.body).font(.caption)
                }
            } compactLeading: {
                Image("NotifyIcon").resizable().scaledToFit().frame(width: 18, height: 18)
            } compactTrailing: {
                Text(context.state.title).lineLimit(1)
            } minimal: {
                Image("NotifyIcon").resizable().scaledToFit()
            }
        }
    }
}
