package com.rongjunrui.marshal.mobile;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.google.firebase.messaging.FirebaseMessaging;
import com.huawei.hms.aaid.HmsInstanceId;
import com.rongjunrui.marshalstream.PushTokens;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {
    private static final int POST_NOTIFICATIONS = 41;
    private static final int ONGOING_ID = 42;
    private static final String PREFS = "marshal-push";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, POST_NOTIFICATIONS);
        }
        PushTokens.bind(this);
        PushTokens.onLive = new PushTokens.LiveNotice() {
            @Override public void show(String title, String body) { showOngoing(MainActivity.this, title, body); }
            @Override public void clear() { cancelOngoing(MainActivity.this); }
        };
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            if (token != null && !token.isEmpty()) PushTokens.update("fcm", token);
        });
        new Thread(this::readHuaweiToken).start();
    }

    /** 需要 app/agconnect-services.json，并让 AGConnect 自动初始化。没有这份配置就不编造令牌。 */
    private void readHuaweiToken() {
        try {
            String appId = agconnectAppId();
            if (appId == null || appId.isEmpty()) return;
            String token = HmsInstanceId.getInstance(this).getToken(appId, "HCM");
            if (token != null && !token.isEmpty()) PushTokens.update("huawei", token);
        } catch (Throwable ignored) { /* 未配置华为时保持 unconfigured */ }
    }

    private String agconnectAppId() {
        try (java.io.InputStream in = getAssets().open("agconnect-services.json")) {
            byte[] bytes = in.readAllBytes();
            JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            JSONObject client = json.optJSONObject("client");
            return client == null ? null : client.optString("app_id", null);
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static void showOngoing(android.content.Context context, String title, String body) {
        NotificationManager manager = (NotificationManager) context.getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel("marshal", "调度官", NotificationManager.IMPORTANCE_LOW));
        }
        manager.notify(ONGOING_ID, new NotificationCompat.Builder(context, "marshal")
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setOngoing(true)
                .build());
    }

    public static void cancelOngoing(android.content.Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(NOTIFICATION_SERVICE);
        manager.cancel(ONGOING_ID);
    }
}
