package kr.funnet.tvcontroller.display;

import org.json.JSONException;
import org.json.JSONObject;

public final class UsbSerialDiagnostics {
    private static JSONObject current = initial();

    private UsbSerialDiagnostics() {}

    private static JSONObject initial() {
        JSONObject value = new JSONObject();
        safePut(value, "stage", "not_probed");
        safePut(value, "updatedAt", System.currentTimeMillis());
        return value;
    }

    public static synchronized void replace(JSONObject value) {
        current = value == null ? initial() : copy(value);
        safePut(current, "updatedAt", System.currentTimeMillis());
    }

    public static synchronized void update(String key, Object value) {
        safePut(current, key, value == null ? JSONObject.NULL : value);
        safePut(current, "updatedAt", System.currentTimeMillis());
    }

    public static synchronized void recordTx(byte[] bytes) {
        safePut(current, "lastTxHex", hex(bytes, bytes == null ? 0 : bytes.length));
        safePut(current, "lastTxBytes", bytes == null ? 0 : bytes.length);
        safePut(current, "lastTxAt", System.currentTimeMillis());
        safePut(current, "stage", "request_sent");
    }

    public static synchronized void recordRx(byte[] bytes, int count) {
        safePut(current, "lastRxBytes", Math.max(count, 0));
        safePut(current, "lastRxAt", System.currentTimeMillis());
        if (count > 0) {
            safePut(current, "lastRxHex", hex(bytes, count));
            safePut(current, "stage", "response_received");
        } else {
            safePut(current, "lastRxHex", "");
            safePut(current, "stage", "response_timeout");
        }
    }

    public static synchronized void failure(String stage, String code, String message) {
        safePut(current, "stage", stage);
        safePut(current, "errorCode", code == null ? JSONObject.NULL : code);
        safePut(current, "error", message == null ? JSONObject.NULL : message);
        safePut(current, "updatedAt", System.currentTimeMillis());
    }

    public static synchronized JSONObject snapshot() { return copy(current); }

    private static JSONObject copy(JSONObject source) {
        try { return new JSONObject(source == null ? "{}" : source.toString()); }
        catch (JSONException ignored) { return new JSONObject(); }
    }

    private static void safePut(JSONObject target, String key, Object value) {
        try { target.put(key, value); } catch (JSONException ignored) {}
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
