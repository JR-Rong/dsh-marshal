package com.rongjunrui.marshal.mobile;

import com.huawei.hms.push.HmsMessageService;
import com.huawei.hms.push.RemoteMessage;
import com.rongjunrui.marshalstream.PushTokens;

public class MarshalHmsService extends HmsMessageService {
    @Override
    public void onNewToken(String token) {
        PushTokens.update("huawei", token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String kind = message.getData() == null ? "" : message.getData();
        if (kind.contains("approval") || kind.contains("run-start") || kind.contains("question")) {
            MainActivity.showOngoing(this, "调度官", kind);
        }
    }
}
