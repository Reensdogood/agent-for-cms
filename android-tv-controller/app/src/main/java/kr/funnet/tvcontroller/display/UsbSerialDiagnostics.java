package kr.funnet.tvcontroller.display;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;

public final class UsbSerialDiagnostics {
    private static JSONObject current = initial();

    private UsbSerialDiagnostics() {}

    private static JSONObject initial() {
        JSONObject value = new JSONObject();
        safePut(value, "stage", "not_probed");
        safePut(value, "updatedAt", System.currentTimeMillis());
        return value;
    }

    /** Refreshes USB inventory without erasing the most recent command trace. */
    public static synchronized void refreshUsb(JSONObject value) {
        if (value != null) {
            Iterator<String> keys = value.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!"stage".equals(key)) safePut(current, key, value.opt(key));
            }
            safePut(current, "usbStage", value.optString("stage", "usb_enumerated"));
        }
        safePut(current, "updatedAt", System.currentTimeMillis());
    }

    public static synchronized void update(String key, Object value) {
        safePut(current, key, value == null ? JSONObject.NULL : value);
        safePut(current, "updatedAt", System.currentTimeMillis());
        if ("stage".equals(key)) event(String.valueOf(value));
    }

    public static synchronized void ready() {
        safePut(current, "usbStage", "device_ready");
        if (!current.has("lastCommandAt")) safePut(current, "stage", "device_ready");
        safePut(current, "updatedAt", System.currentTimeMillis());
    }

    public static synchronized void beginCommand(String id, String type) {
        String[] transientKeys = {
                "lastTxHex", "lastTxBytes", "lastTxAt", "lastRxHex", "lastRxBytes", "lastRxAt",
                "portOpenedAt", "portClosedAt", "errorCode", "error"
        };
        for (String key : transientKeys) current.remove(key);
        safePut(current, "lastCommandId", id);
        safePut(current, "lastCommandType", type);
        safePut(current, "lastCommandAt", System.currentTimeMillis());
        safePut(current, "stage", "command_received");
        safePut(current, "updatedAt", System.currentTimeMillis());
        event("command_received");
    }

    public static synchronized void finishCommand(boolean success) {
        safePut(current, "lastCommandSuccess", success);
        safePut(current, "lastCommandCompletedAt", System.currentTimeMillis());
        safePut(current, "updatedAt", System.currentTimeMillis());
        event(success ? "command_completed" : "command_failed");
    }

    public static synchronized void recordTx(byte[] bytes) {
        safePut(current, "lastTxHex", hex(bytes, bytes == null ? 0 : bytes.length));
        safePut(current, "lastTxBytes", bytes == null ? 0 : bytes.length);
        safePut(current, "lastTxAt", System.currentTimeMillis());
        safePut(current, "stage", "request_sent");
        event("request_sent");
    }

    public static synchronized void recordRx(byte[] bytes, int count) {
        safePut(current, "lastRxBytes", Math.max(count, 0));
        safePut(current, "lastRxAt", System.currentTimeMillis());
        if (count > 0) {
            safePut(current, "lastRxHex", hex(bytes, count));
            safePut(current, "stage", "response_received");
            event("response_received");
        } else {
            safePut(current, "lastRxHex", "");
            safePut(current, "stage", "response_timeout");
            event("response_timeout");
        }
    }

    public static synchronized void failure(String stage, String code, String message) {
        safePut(current, "stage", stage);
        safePut(current, "errorCode", code == null ? JSONObject.NULL : code);
        safePut(current, "error", message == null ? JSONObject.NULL : message);
        safePut(current, "updatedAt", System.currentTimeMillis());
        event(stage);
    }

    public static synchronized JSONObject snapshot() { return copy(current); }

    private static JSONObject copy(JSONObject source) {
        try { return new JSONObject(source == null ? "{}" : source.toString()); }
        catch (JSONException ignored) { return new JSONObject(); }
    }

    private static void safePut(JSONObject target, String key, Object value) {
        try { target.put(key, value); } catch (JSONException ignored) {}
    }

    private static void event(String name) {
        try {
            JSONArray events = current.optJSONArray("events");
            if (events == null) events = new JSONArray();
            events.put(new JSONObject().put("event", name).put("at", System.currentTimeMillis()));
            while (events.length() > 40) events.remove(0);
            current.put("events", events);
        } catch (JSONException ignored) {}
    }

    private static String hex(byte[] bytes, int count) {
        if (bytes == null || count <= 0) return "";
        StringBuilder value = new StringBuilder();
        int safeCount = Math.min(Math.min(count, bytes.length), 96);
        for (int index = 0; index < safeCount; index++) {
            if (index > 0) value.append(' ');
            value.append(String.format("%02X", bytes[index] & 0xFF));
        }
        return value.toString();
    }
}
