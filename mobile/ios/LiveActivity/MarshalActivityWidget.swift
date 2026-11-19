import ActivityKit
import WidgetKit
import SwiftUI

@available(iOS 16.2, *)
struct MarshalAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var title: String
        var phase: String
    }
    var session: String
}

@available(iOS 16.2, *)
struct MarshalActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MarshalAttributes.self) { context in
            Text(context.state.title)
                .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title)
                }
            } compactLeading: {
                Text("调")
            } compactTrailing: {
                Text(context.state.phase)
            } minimal: {
                Text("调")
            }
        }
    }
}

@available(iOS 16.2, *)
@main
struct MarshalActivityBundle: WidgetBundle {
    var body: some Widget {
        MarshalActivityWidget()
    }
}
