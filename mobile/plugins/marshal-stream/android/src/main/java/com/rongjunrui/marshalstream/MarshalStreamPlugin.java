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
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 原生 SSE 通道。
 *
 * 为什么需要它：WebView 里的事件源受同源策略限制，而手机端要直连 hub 的
 * /marshal/api/stream。这里用原生 HTTP 读流，按 SSE 规范切分事件后回传 JS，
 * 不引入任何第三方依赖，也不监听端口（仍是纯客户端）。
 */
@CapacitorPlugin(name = "MarshalStream")
public class MarshalStreamPlugin extends Plugin {

    private HttpURLConnection connection;
    private Thread worker;
    private final AtomicBoolean running = new AtomicBoolean(false);

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String token = call.getString("token");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        close();
        running.set(true);
        worker = new Thread(() -> pump(url, token));
        worker.setDaemon(true);
        worker.start();
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        close();
        call.resolve();
    }

    private void close() {
        running.set(false);
        HttpURLConnection current = connection;
        connection = null;
        if (current != null) {
            try {
                current.disconnect();
            } catch (Exception ignored) {
                // 断开本身失败没有补救手段
            }
        }
        Thread thread = worker;
        worker = null;
        if (thread != null) {
            thread.interrupt();
        }
    }

    private void pump(String url, String token) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            connection = conn;
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "text/event-stream");
            conn.setRequestProperty("Cache-Control", "no-store");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("x-marshal-token", token);
            }
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(0);
            conn.connect();
            int status = conn.getResponseCode();
            if (status != 200) {
                JSObject payload = new JSObject();
                payload.put("event", "error");
                payload.put("data", "HTTP " + status);
                notifyListeners("message", payload);
                return;
            }
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            String eventName = "message";
            StringBuilder data = new StringBuilder();
            String line;
            while (running.get() && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) {
                        JSObject payload = new JSObject();
                        payload.put("event", eventName);
                        payload.put("data", data.toString());
                        notifyListeners("message", payload);
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
                    data.append(line.substring(5).trim());
                }
            }
        } catch (Exception error) {
            if (running.get()) {
                JSObject payload = new JSObject();
                payload.put("event", "error");
                payload.put("data", error.getClass().getSimpleName() + ": " + error.getMessage());
                notifyListeners("message", payload);
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
}
