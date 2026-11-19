import ActivityKit
import Capacitor
import Foundation
import UIKit
import UserNotifications

@objc(MarshalPushPlugin)
public class MarshalPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MarshalPushPlugin"
    public let jsName = "MarshalPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "token", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateLive", returnType: CAPPluginReturnPromise)
    ]

    @objc func token(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
                call.resolve(["provider": "apns", "token": ""])
            }
        }
    }

    @objc func updateLive(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "调度官"
        let body = call.getString("body") ?? ""
        if #available(iOS 16.1, *) {
            MarshalLiveActivity.update(title: title, body: body, running: call.getBool("running") ?? false)
        }
        call.resolve()
    }
}

@available(iOS 16.1, *)
public struct MarshalActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var title: String
        public var body: String
        public var running: Bool
    }
    public var name: String
}

@available(iOS 16.1, *)
enum MarshalLiveActivity {
    static func update(title: String, body: String, running: Bool) {
        let state = MarshalActivityAttributes.ContentState(title: title, body: body, running: running)
        if let current = Activity<MarshalActivityAttributes>.activities.first {
            Task { await current.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        guard running else { return }
        _ = try? Activity.request(
            attributes: MarshalActivityAttributes(name: "marshal"),
            content: ActivityContent(state: state, staleDate: nil),
            pushType: nil
        )
    }
}
