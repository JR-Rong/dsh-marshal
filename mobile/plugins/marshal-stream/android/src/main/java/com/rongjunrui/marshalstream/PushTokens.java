package com.rongjunrui.marshalstream;

/** 原生壳拿到的推送令牌。拿不到时 reason 写明原因，不把空串当成成功。 */
public final class PushTokens {
    public static volatile String provider;
    public static volatile String token;
    public static volatile String liveToken;
    public static volatile String reason = "unconfigured";

    private PushTokens() {}
}
