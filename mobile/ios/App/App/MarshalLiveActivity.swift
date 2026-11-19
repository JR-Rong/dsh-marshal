import ActivityKit
import Foundation

@available(iOS 16.2, *)
struct MarshalAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var title: String
        var phase: String
    }
    var session: String
}

/// 每个会话只保留一个 Live Activity。结束时关掉它，并记下更新令牌。
@available(iOS 16.2, *)
enum MarshalLiveActivity {
    private static var activities: [String: Activity<MarshalAttributes>] = [:]

    static func start(title: String, phase: String, session: String) {
        let state = MarshalAttributes.ContentState(title: title, phase: phase)
        if let existing = activities[session] {
            Task { await existing.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        do {
            let activity = try Activity.request(
                attributes: MarshalAttributes(session: session),
                content: ActivityContent(state: state, staleDate: nil),
                pushType: .token
            )
            activities[session] = activity
            Task {
                for await tokenData in activity.pushTokenUpdates {
                    let token = tokenData.map { String(format: "%02x", $0) }.joined()
                    UserDefaults.standard.set(token, forKey: "marshal.push.live")
                }
            }
        } catch {
            UserDefaults.standard.set(error.localizedDescription, forKey: "marshal.push.live.error")
        }
    }

    static func end(session: String) {
        guard let activity = activities.removeValue(forKey: session) else { return }
        let state = MarshalAttributes.ContentState(title: "已结束", phase: "done")
        Task { await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .immediate) }
    }

    static func registerPushToken() {
        Task {
            for await activity in Activity<MarshalAttributes>.activityUpdates {
                for await tokenData in activity.pushTokenUpdates {
                    let token = tokenData.map { String(format: "%02x", $0) }.joined()
                    UserDefaults.standard.set(token, forKey: "marshal.push.live")
                    UserDefaults.standard.removeObject(forKey: "marshal.push.live.error")
                }
            }
        }
    }
}
