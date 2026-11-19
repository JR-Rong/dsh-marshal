package com.rongjunrui.marshalstream;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 原生 SSE 通道。每条流有自己的 id，互不关闭。
 * 干净的服务端结束也会通知 JS，方便重连；Last-Event-ID 用于续传。
 */
@CapacitorPlugin(name = "MarshalStream")
public class MarshalStreamPlugin extends Plugin {

    private final Map<String, Stream> streams = new ConcurrentHashMap<>();

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String token = call.getString("token");
        String id = call.getString("id");
        String lastEventId = call.getString("lastEventId");
        if (id == null || id.isEmpty()) id = "default";
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        closeOne(id);
        Stream stream = new Stream(id);
        streams.put(id, stream);
        final String streamId = id;
        stream.worker = new Thread(() -> pump(stream, url, token, lastEventId));
        stream.worker.setDaemon(true);
        stream.worker.start();
        call.resolve();
    }

    @PluginMethod
    public void pushToken(PluginCall call) {
        JSObject result = new JSObject();
        String token = PushTokens.token;
        String provider = PushTokens.provider;
        if (token == null || token.isEmpty() || provider == null) {
            result.put("ok", false);
            result.put("reason", PushTokens.reason == null ? "unconfigured" : PushTokens.reason);
            call.resolve(result);
            return;
        }
        result.put("ok", true);
        result.put("provider", provider);
        result.put("token", token);
        if (PushTokens.liveToken != null) result.put("liveToken", PushTokens.liveToken);
        call.resolve(result);
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) closeAll();
        else closeOne(id);
        call.resolve();
    }

    private void closeAll() {
        for (String id : streams.keySet()) closeOne(id);
    }

    private void closeOne(String id) {
        Stream stream = streams.remove(id);
        if (stream == null) return;
        stream.running.set(false);
        HttpURLConnection current = stream.connection;
        stream.connection = null;
        if (current != null) {
            try {
                current.disconnect();
            } catch (Exception ignored) {
                // 断开本身失败没有补救手段
            }
        }
        if (stream.worker != null) stream.worker.interrupt();
    }

    private void emit(String streamId, String event, String data, String id) {
        JSObject payload = new JSObject();
        payload.put("streamId", streamId);
        payload.put("event", event);
        payload.put("data", data == null ? "" : data);
        if (id != null && !id.isEmpty()) payload.put("id", id);
        notifyListeners("message", payload);
    }

    private void pump(Stream stream, String url, String token, String lastEventId) {
        HttpURLConnection conn = null;
        boolean terminal = false;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            stream.connection = conn;
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "text/event-stream");
            conn.setRequestProperty("Cache-Control", "no-store");
            if (token != null && !token.isEmpty()) {
                if (token.startsWith("mph1.") || token.startsWith("mnd1.")) {
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                } else {
                    conn.setRequestProperty("x-marshal-token", token);
                }
            }
            if (lastEventId != null && !lastEventId.isEmpty()) {
                conn.setRequestProperty("Last-Event-ID", lastEventId);
            }
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(0);
            conn.connect();
            int status = conn.getResponseCode();
            if (status != 200) {
                terminal = true;
                if (stream.running.get()) emit(stream.id, "error", "HTTP " + status, null);
                return;
            }
            if (stream.running.get()) emit(stream.id, "open", "", null);
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            String eventName = "message";
            String eventId = "";
            StringBuilder data = new StringBuilder();
            String line;
            while (stream.running.get() && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) {
                        emit(stream.id, eventName, data.toString(), eventId);
                    }
                    eventName = "message";
                    data.setLength(0);
                    continue;
                }
                if (line.startsWith(":")) continue;
                if (line.startsWith("event:")) {
                    eventName = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.length() > 5 ? line.substring(5).trim() : "");
                } else if (line.startsWith("id:")) {
                    String value = line.substring(3).trim();
                    if (!value.contains("\u0000")) eventId = value;
                }
            }
            if (stream.running.get()) {
                terminal = true;
                emit(stream.id, "end", "closed", eventId);
            }
        } catch (Exception error) {
            if (stream.running.get() && !terminal) {
                terminal = true;
                emit(stream.id, "error", error.getClass().getSimpleName() + ": " + error.getMessage(), null);
            }
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                    // 同上
                }
            }
        }
    }

    private static final class Stream {
        final String id;
        final AtomicBoolean running = new AtomicBoolean(true);
        HttpURLConnection connection;
        Thread worker;

        Stream(String id) {
            this.id = id;
        }
    }
}
