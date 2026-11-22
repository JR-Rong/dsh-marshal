package com.rongjunrui.marshal.mobile;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.rongjunrui.marshalstream.PushTokens;

/** 令牌变化时写回，JS 再向 Hub 登记。审批和运行中的任务用常驻通知。 */
public class MarshalFirebaseService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        PushTokens.update("fcm", token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String kind = message.getData().get("kind");
        if ("approval".equals(kind) || "run-start".equals(kind) || "question".equals(kind)) {
            String title = message.getNotification() == null ? "调度官" : message.getNotification().getTitle();
            String body = message.getNotification() == null ? "" : message.getNotification().getBody();
            MainActivity.showOngoing(this, title == null ? "调度官" : title, body == null ? "" : body);
        }
    }
}
