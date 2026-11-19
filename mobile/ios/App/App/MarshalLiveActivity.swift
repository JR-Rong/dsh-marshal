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

/// 每个会话只保留一个 Live Activity。更新令牌按会话存放，一签发就通知应用发给 Hub。
@available(iOS 16.2, *)
enum MarshalLiveActivity {
    private static let tokensKey = "marshal.push.live.sessions"
    private static var activities: [String: Activity<MarshalAttributes>] = [:]

    static func remember(token: String, session: String) {
        guard !session.isEmpty, !token.isEmpty else { return }
        var map = UserDefaults.standard.dictionary(forKey: tokensKey) as? [String: String] ?? [:]
        map[session] = token
        UserDefaults.standard.set(map, forKey: tokensKey)
        NotificationCenter.default.post(
            name: Notification.Name("marshal.liveToken"),
            object: nil,
            userInfo: ["session": session, "token": token]
        )
    }

    static func forget(session: String) {
        var map = UserDefaults.standard.dictionary(forKey: tokensKey) as? [String: String] ?? [:]
        map.removeValue(forKey: session)
        UserDefaults.standard.set(map, forKey: tokensKey)
        NotificationCenter.default.post(
            name: Notification.Name("marshal.liveToken"),
            object: nil,
            userInfo: ["session": session, "token": ""]
        )
    }

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
                    remember(token: token, session: session)
                }
            }
        } catch {
            UserDefaults.standard.set(error.localizedDescription, forKey: "marshal.push.live.error")
        }
    }

    static func end(session: String) {
        forget(session: session)
        guard let activity = activities.removeValue(forKey: session) else { return }
        let state = MarshalAttributes.ContentState(title: "已结束", phase: "done")
        Task { await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .immediate) }
    }

    static func registerPushToken() {
        Task {
            for await activity in Activity<MarshalAttributes>.activityUpdates {
                let session = activity.attributes.session
                for await tokenData in activity.pushTokenUpdates {
                    let token = tokenData.map { String(format: "%02x", $0) }.joined()
                    remember(token: token, session: session)
                    UserDefaults.standard.removeObject(forKey: "marshal.push.live.error")
                }
            }
        }
    }
}
