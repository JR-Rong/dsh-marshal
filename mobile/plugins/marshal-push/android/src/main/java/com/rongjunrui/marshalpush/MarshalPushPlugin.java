package com.rongjunrui.marshalpush;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 推送入口。FCM 与华为 Push Kit 的密钥在 Hub 配置里，不写进应用。
 * 华为/鸿蒙没有 GMS 时尝试实况窗；类不存在就退回一条持续通知。
 */
@CapacitorPlugin(name = "MarshalPush")
public class MarshalPushPlugin extends Plugin {
    private static final String CHANNEL = "marshal-live";

    @PluginMethod
    public void token(PluginCall call) {
        boolean huawei = isHuawei();
        JSObject result = new JSObject();
        result.put("provider", huawei ? "huawei" : "fcm");
        result.put("token", "");
        call.resolve(result);
    }

    @PluginMethod
    public void updateLive(PluginCall call) {
        String title = call.getString("title", "调度官");
        String body = call.getString("body", "");
        boolean running = Boolean.TRUE.equals(call.getBoolean("running", false));
        if (!showHuaweiLiveView(title, body, running)) showOngoing(title, body, running);
        call.resolve();
    }

    private boolean isHuawei() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        return maker.contains("huawei") || maker.contains("honor");
    }

    /** 反射调用 HMS 实况窗。没有 Live View Kit 时返回 false。 */
    private boolean showHuaweiLiveView(String title, String body, boolean running) {
        try {
            Class<?> kit = Class.forName("com.huawei.hms.kit.awareness.liveview.LiveView");
            Object instance = kit.getMethod("getInstance", Context.class).invoke(null, getContext());
            kit.getMethod("update", String.class, String.class, boolean.class).invoke(instance, title, body, running);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void showOngoing(String title, String body, boolean running) {
        Context context = getContext();
        if (context == null) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "调度官", NotificationManager.IMPORTANCE_LOW);
            manager.createNotificationChannel(channel);
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(context, CHANNEL)
            : new Notification.Builder(context);
        int icon = context.getResources().getIdentifier("ic_stat_notify", "drawable", context.getPackageName());
        builder.setContentTitle(title).setContentText(body).setSmallIcon(icon == 0 ? android.R.drawable.stat_notify_sync : icon).setOngoing(running);
        manager.notify(7101, builder.build());
    }
}
