package kr.funnet.tvcontroller.network;

import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import kr.funnet.tvcontroller.BuildConfig;

import kr.funnet.tvcontroller.data.SecureTokenStore;
import kr.funnet.tvcontroller.data.SettingsStore;
import kr.funnet.tvcontroller.device.ConferenceIdentityDiagnostics;
import kr.funnet.tvcontroller.device.NetworkIdentity;

public final class ServerClient {
    private final SettingsStore settings;
    private final SecureTokenStore tokenStore;

    public ServerClient(SettingsStore settings, SecureTokenStore tokenStore) {
        this.settings = settings;
        this.tokenStore = tokenStore;
    }

    public SecureTokenStore.Credentials ensureRegistered() throws Exception {
        SecureTokenStore.Credentials existing = tokenStore.load();
        if (existing != null) return existing;
        if (settings.enrollmentKey().isBlank()) throw new IOException("최초 등록에 필요한 등록 키가 비어 있습니다.");
        JSONObject body = baseHealth(null);
        Response response = request("POST", "/api/agent/register", body, null, settings.enrollmentKey());
        JSONObject json = new JSONObject(response.body);
        String deviceId = json.getString("deviceId");
        String token = json.getString("deviceToken");
        tokenStore.save(deviceId, token);
        settings.clearEnrollmentKey();
        return new SecureTokenStore.Credentials(deviceId, token);
    }

    public void heartbeat(String usbDevice) throws Exception {
        SecureTokenStore.Credentials credentials = ensureRegistered();
        request("POST", "/api/agent/heartbeat", baseHealth(usbDevice), credentials.token(), null);
    }

    public JSONArray commands() throws Exception {
        SecureTokenStore.Credentials credentials = ensureRegistered();
        Response response = request("GET", "/api/agent/commands", null, credentials.token(), null);
        return new JSONObject(response.body).optJSONArray("commands");
    }

    public void complete(String commandId, JSONObject envelope) throws Exception {
        SecureTokenStore.Credentials credentials = ensureRegistered();
        request("POST", "/api/agent/commands/" + commandId + "/result", envelope, credentials.token(), null);
    }

    private JSONObject baseHealth(String usbDevice) throws JSONException {
        JSONObject health = new JSONObject();
        health.put("installationId", settings.installationId());
        health.put("localName", settings.localName());
        health.put("machineName", Build.MANUFACTURER + " " + Build.MODEL);
        health.put("agentVersion", "Yealink MeetingBar A10 " + BuildConfig.VERSION_NAME);
        health.put("deviceProfile", "yealink-meetingbar-a10");
        health.put("localIpAddress", NetworkIdentity.localIpv4Address());
        health.put("vpn", VpnDiagnostics.snapshot(settings.context()));
        health.put("conferenceIdentity", ConferenceIdentityDiagnostics.snapshot(settings.context()));
        if (!settings.regionId().isBlank()) health.put("provisionedRegionId", settings.regionId());
        health.put("osVersion", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        health.put("timestamp", java.time.OffsetDateTime.now().toString());
        health.put("foregroundApp", "MeetingBar A10 TV Controller");
        health.put("ivisionRunning", false);
        health.put("ume", JSONObject.NULL);
        health.put("installedUmeVersions", new JSONArray());
        health.put("platform", "android");
        health.put("capabilities", settings.capabilities());
        health.put("display", settings.displayHealth(usbDevice));
        health.put("power", settings.powerHealth());
        return health;
    }

    private Response request(String method, String path, JSONObject body, String bearer, String enrollmentKey) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(settings.serverUrl() + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(12000);
        connection.setRequestProperty("Accept", "application/json");
        if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
        if (enrollmentKey != null) connection.setRequestProperty("X-Enrollment-Key", enrollmentKey);
        if (body != null) {
            byte[] encoded = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(encoded.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(encoded); }
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String response = readAll(stream);
        connection.disconnect();
        if (status < 200 || status >= 300) {
            String message = response;
            try { message = new JSONObject(response).optString("error", response); } catch (Exception ignored) {}
            throw new IOException("서버 HTTP " + status + ": " + message);
        }
        return new Response(status, response);
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) result.append(line);
        }
        return result.toString();
    }

    private record Response(int status, String body) {}
}
