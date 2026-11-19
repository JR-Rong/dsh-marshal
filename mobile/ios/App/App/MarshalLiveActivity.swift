import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct MarshalAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var title: String
        var phase: String
    }
    var session: String
}

/// 已有 Live Activity 时，把系统发来的更新令牌记下来。没有活动就不编造令牌。
@available(iOS 16.1, *)
enum MarshalLiveActivity {
    static func start(title: String, phase: String) {
        let state = MarshalAttributes.ContentState(title: title, phase: phase)
        do {
            let activity = try Activity.request(
                attributes: MarshalAttributes(session: phase),
                content: ActivityContent(state: state, staleDate: nil),
                pushType: .token
            )
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
