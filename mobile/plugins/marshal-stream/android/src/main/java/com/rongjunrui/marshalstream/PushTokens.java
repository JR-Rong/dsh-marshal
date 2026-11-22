package com.rongjunrui.marshalstream;

/** 原生壳拿到的推送令牌。拿不到时 reason 写明原因，不把空串当成成功。 */
public final class PushTokens {
    public static volatile String provider;
    public static volatile String token;
    public static volatile String liveToken;
    public static volatile String reason = "unconfigured";
    public static volatile Runnable onChange;
    public interface LiveNotice {
        void show(String title, String body);
        void clear();
    }
    public static volatile LiveNotice onLive;
    private static android.content.SharedPreferences prefs;

    private PushTokens() {}

    public static void bind(android.content.Context context) {
        prefs = context.getSharedPreferences("marshal-push", android.content.Context.MODE_PRIVATE);
        String savedProvider = prefs.getString("provider", null);
        String savedToken = prefs.getString("token", null);
        if (savedProvider != null && savedToken != null && !savedToken.isEmpty()) {
            provider = savedProvider;
            token = savedToken;
            reason = null;
        }
    }

    public static void update(String nextProvider, String nextToken) {
        if (nextToken == null || nextToken.isEmpty()) return;
        boolean changed = !nextToken.equals(token) || nextProvider == null || !nextProvider.equals(provider);
        provider = nextProvider;
        token = nextToken;
        reason = null;
        if (prefs != null) prefs.edit().putString("provider", provider).putString("token", token).apply();
        if (changed && onChange != null) onChange.run();
    }
}
