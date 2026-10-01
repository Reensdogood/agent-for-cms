package kr.funnet.tvcontroller.data;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

import kr.funnet.tvcontroller.BuildConfig;
import kr.funnet.tvcontroller.display.SamsungDisplayCapabilities;
import kr.funnet.tvcontroller.display.UsbSerialDiagnostics;

public final class SettingsStore {
    private static final String FILE = "tv_controller_settings";
    private final Context context;
    private final SharedPreferences preferences;

    public SettingsStore(Context context) {
        this.context = context.getApplicationContext();
        Context safeContext = Build.VERSION.SDK_INT >= 24
                ? context.createDeviceProtectedStorageContext() : context;
        preferences = safeContext.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public Context context() { return context; }

    public String serverUrl() {
        if (BuildConfig.PRECONFIGURED) return BuildConfig.DEFAULT_SERVER_URL.replaceAll("/+$", "");
        return preferences.getString("serverUrl", "http://192.168.0.100:4170").replaceAll("/+$", "");
    }

    public String enrollmentKey() {
        if (BuildConfig.PRECONFIGURED) return BuildConfig.DEFAULT_ENROLLMENT_KEY;
        return preferences.getString("enrollmentKey", "");
    }
    public String localName() { return preferences.getString("localName", ""); }
    public String tvModel() {
        if (BuildConfig.PRECONFIGURED && !BuildConfig.DEFAULT_TV_MODEL.isBlank()) return BuildConfig.DEFAULT_TV_MODEL;
        return preferences.getString("tvModel", "LH75QET");
    }
    public int displayId() { return BuildConfig.PRECONFIGURED ? BuildConfig.DEFAULT_DISPLAY_ID : preferences.getInt("displayId", 0); }
    public String regionId() { return BuildConfig.PRECONFIGURED ? BuildConfig.DEFAULT_REGION_ID : ""; }
    public String regionName() { return BuildConfig.PRECONFIGURED ? BuildConfig.DEFAULT_REGION_NAME : "직접 설정"; }
    public String installationId() {
        String existing = preferences.getString("installationId", "");
        if (!existing.isBlank()) return existing;
        String created = UUID.randomUUID().toString();
        preferences.edit().putString("installationId", created).apply();
        return created;
    }

    public void save(String serverUrl, String enrollmentKey, String localName, String tvModel, int displayId) {
        preferences.edit()
                .putString("serverUrl", BuildConfig.PRECONFIGURED ? BuildConfig.DEFAULT_SERVER_URL : serverUrl.trim().replaceAll("/+$", ""))
                .putString("enrollmentKey", BuildConfig.PRECONFIGURED ? BuildConfig.DEFAULT_ENROLLMENT_KEY : enrollmentKey.trim())
                .putString("localName", localName.trim())
                .putString("tvModel", BuildConfig.PRECONFIGURED ? BuildConfig.DEFAULT_TV_MODEL : tvModel)
                .putInt("displayId", BuildConfig.PRECONFIGURED ? BuildConfig.DEFAULT_DISPLAY_ID : displayId)
                .apply();
    }

    public void clearEnrollmentKey() { preferences.edit().remove("enrollmentKey").apply(); }
    public String status() { return preferences.getString("status", "설정 대기"); }
    public void status(String value) { preferences.edit().putString("status", value).apply(); }
    public String powerStatus() { return preferences.getString("powerStatus", "절전 감시 대기"); }
    public long lastWakeAt() { return preferences.getLong("lastWakeAt", 0L); }
    public void powerEvent(String value) {
        preferences.edit()
                .putString("powerStatus", value)
                .putLong("lastWakeAt", System.currentTimeMillis())
                .apply();
    }

    public JSONObject displayHealth(String usbDevice) throws JSONException {
        JSONObject display = new JSONObject();
        display.put("enabled", true);
        display.put("vendor", "samsung");
        display.put("model", tvModel());
        display.put("port", usbDevice == null ? "USB 미연결" : usbDevice);
        display.put("inputSources", new JSONArray(SamsungDisplayCapabilities.inputsForModel(tvModel())));
        display.put("serialDiagnostics", UsbSerialDiagnostics.snapshot());
        return display;
    }

    public JSONObject capabilities() throws JSONException {
        JSONObject capabilities = new JSONObject();
        capabilities.put("displayControl", true);
        capabilities.put("ume", false);
        capabilities.put("ivision", false);
        capabilities.put("windowsShutdown", false);
        capabilities.put("agentUpdate", false);
        capabilities.put("supportedInputs", new JSONArray(SamsungDisplayCapabilities.inputsForModel(tvModel())));
        return capabilities;
    }

    public JSONObject powerHealth() throws JSONException {
        return new JSONObject()
                .put("wakeLock", true)
                .put("watchdog", true)
                .put("lastWakeAt", lastWakeAt() == 0L ? JSONObject.NULL : lastWakeAt())
                .put("status", powerStatus());
    }

    public String completedResult(String commandId) {
        return preferences.getString("commandResult." + commandId, null);
    }

    public void rememberCompleted(String commandId, JSONObject resultEnvelope) {
        String indexRaw = preferences.getString("commandResult.index", "");
        String[] old = indexRaw.isBlank() ? new String[0] : indexRaw.split(",");
        StringBuilder next = new StringBuilder(commandId);
        SharedPreferences.Editor editor = preferences.edit()
                .putString("commandResult." + commandId, resultEnvelope.toString());
        int kept = 1;
        for (String id : old) {
            if (id.isBlank() || id.equals(commandId)) continue;
            if (kept < 99) {
                next.append(',').append(id);
                kept++;
            } else {
                editor.remove("commandResult." + id);
            }
        }
        editor.putString("commandResult.index", next.toString()).apply();
    }
}
