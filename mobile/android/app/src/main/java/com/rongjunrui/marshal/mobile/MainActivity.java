package com.rongjunrui.marshal.mobile;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.rongjunrui.marshalstream.PushTokens;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

public class MainActivity extends BridgeActivity {
    private static final int POST_NOTIFICATIONS = 41;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, POST_NOTIFICATIONS);
        }
        readPushToken();
    }

    /** FCM 与华为推送都走官方类。类不在 classpath 上就记 unconfigured，不编造令牌。 */
    private void readPushToken() {
        String fcm = reflectToken("com.google.firebase.messaging.FirebaseMessaging", "getInstance", "getToken");
        if (fcm != null) {
            PushTokens.provider = "fcm";
            PushTokens.token = fcm;
            PushTokens.reason = null;
            return;
        }
        String hms = reflectToken("com.huawei.hms.aaid.HmsInstanceId", "getInstance", "getToken");
        if (hms != null) {
            PushTokens.provider = "huawei";
            PushTokens.token = hms;
            PushTokens.reason = null;
            return;
        }
        PushTokens.reason = "unconfigured";
    }

    private String reflectToken(String className, String instance, String method) {
        try {
            Class<?> type = Class.forName(className);
            Object receiver = type.getMethod(instance, android.content.Context.class).invoke(null, this);
            Object value = receiver.getClass().getMethod(method).invoke(receiver);
            if (value != null && value.getClass().getName().contains("Task")) {
                Class<?> listener = Class.forName("com.google.android.gms.tasks.OnSuccessListener");
                Object proxy = Proxy.newProxyInstance(listener.getClassLoader(), new Class<?>[]{listener}, (unused, called, args) -> {
                    if ("onSuccess".equals(called.getName()) && args != null && args.length > 0 && args[0] instanceof String && !((String) args[0]).isEmpty()) {
                        PushTokens.provider = "fcm";
                        PushTokens.token = (String) args[0];
                        PushTokens.reason = null;
                    }
                    return null;
                });
                value.getClass().getMethod("addOnSuccessListener", listener).invoke(value, proxy);
                return null;
            }
            return value instanceof String && !((String) value).isEmpty() ? (String) value : null;
        } catch (Throwable ignored) {
            try {
                Class<?> type = Class.forName(className);
                Method factory = type.getMethod(instance, android.content.Context.class);
                Object receiver = factory.invoke(null, this);
                Method get = receiver.getClass().getMethod(method, android.content.Context.class, String.class);
                Object value = get.invoke(receiver, this, "HCM");
                return value instanceof String && !((String) value).isEmpty() ? (String) value : null;
            } catch (Throwable again) {
                return null;
            }
        }
    }

    /** 官方 Live View 不可用时，用一条常驻通知兜底。 */
    public static void showOngoing(android.content.Context context, String title, String body) {
        if (!startLiveView(context, title, body)) {
            NotificationManager manager = (NotificationManager) context.getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) {
                manager.createNotificationChannel(new NotificationChannel("marshal", "调度官", NotificationManager.IMPORTANCE_LOW));
            }
            manager.notify(42, new NotificationCompat.Builder(context, "marshal")
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setOngoing(true)
                    .build());
        }
    }

    private static boolean startLiveView(android.content.Context context, String title, String body) {
        try {
            Class<?> type = Class.forName("com.huawei.hms.liveview.LiveView");
            Object client = type.getMethod("getInstance", android.content.Context.class).invoke(null, context);
            type.getMethod("start", String.class, String.class).invoke(client, title, body);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }
}
