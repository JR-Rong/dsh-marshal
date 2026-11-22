package com.rongjunrui.marshal.mobile;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.huawei.hms.aaid.HmsInstanceId;
import com.rongjunrui.marshalstream.PushTokens;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {
    private static final int POST_NOTIFICATIONS = 41;
    private static final int ONGOING_ID = 42;
    private static final int COLOR_LIGHT_BG = 0xFFF2F2F7;
    private static final int COLOR_DARK_BG = 0xFF000000;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBars();
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, POST_NOTIFICATIONS);
        }
        PushTokens.bind(this);
        PushTokens.onLive = new PushTokens.LiveNotice() {
            @Override public void show(String title, String body) { showOngoing(MainActivity.this, title, body); }
            @Override public void clear() { cancelOngoing(MainActivity.this); }
        };
        PushBootstrap.readFirebase(this);
        new Thread(this::readHuaweiToken).start();
    }

    @Override
    public void onResume() {
        super.onResume();
        applySystemBars();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBars();
    }

    /** 同步状态栏与导航栏明暗图标，兼容 Android 12/EMUI 与 Android 15+。 */
    @SuppressWarnings("deprecation")
    private void applySystemBars() {
        int nightMask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = nightMask == Configuration.UI_MODE_NIGHT_YES;
        Window window = getWindow();
        if (window == null) return;
        View decor = window.getDecorView();
        if (Build.VERSION.SDK_INT < 35) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            int bg = dark ? COLOR_DARK_BG : COLOR_LIGHT_BG;
            window.setStatusBarColor(bg);
            window.setNavigationBarColor(bg);
            int flags = decor.getSystemUiVisibility();
            if (dark) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= 26) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            } else {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            decor.setSystemUiVisibility(flags);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
        if (controller != null) {
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
        }
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
