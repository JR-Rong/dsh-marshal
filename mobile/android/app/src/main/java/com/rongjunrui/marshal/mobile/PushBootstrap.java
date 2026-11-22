package com.rongjunrui.marshal.mobile;

import android.content.Context;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.rongjunrui.marshalstream.PushTokens;

/** 没有 google-services.json 时 Firebase 不会初始化。这时不能调用 getToken，否则进程在启动时崩溃。 */
public final class PushBootstrap {
    public interface FirebaseTokens {
        boolean configured();
        void requestToken();
    }

    private PushBootstrap() {}

    public static void readFirebase(FirebaseTokens tokens) {
        try {
            if (tokens == null || !tokens.configured()) return;
            tokens.requestToken();
        } catch (Throwable ignored) { /* 未配置或初始化失败时保持没有 FCM 令牌 */ }
    }

    public static void readFirebase(Context context) {
        readFirebase(new FirebaseTokens() {
            @Override public boolean configured() {
                return !FirebaseApp.getApps(context).isEmpty();
            }

            @Override public void requestToken() {
                FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
                    if (token != null && !token.isEmpty()) PushTokens.update("fcm", token);
                });
            }
        });
    }
}
