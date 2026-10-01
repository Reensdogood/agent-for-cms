package kr.funnet.tvcontroller.device;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public final class ConferenceIdentityDiagnostics {
    private ConferenceIdentityDiagnostics() {}

    public static JSONObject snapshot(Context context) {
        JSONObject result = new JSONObject();
        put(result, "profile", "yealink-meetingbar-a10");
        put(result, "manufacturer", Build.MANUFACTURER);
        put(result, "model", Build.MODEL);
        put(result, "supportedHardware", isMeetingBarA10());
        put(result, "androidDeviceName", androidDeviceName(context));

        JSONArray applications = visibleConferenceApplications(context);
        put(result, "visibleConferenceApplications", applications);
        put(result, "ucProviderCandidate", inferProvider(applications));

        JSONArray accounts = visibleAccounts(context);
        put(result, "visibleAccounts", accounts);
        put(result, "loginIdentifierReadable", accounts.length() > 0);
        put(result, "loginIdentifierPolicy", accounts.length() > 0
                ? "Android가 이 앱에 명시적으로 공개한 계정만 표시됩니다."
                : "UME/Teams/Zoom 로그인 ID는 다른 앱의 비공개 데이터이므로 연동 API나 계정 공개 권한 없이는 읽을 수 없습니다.");
        return result;
    }

    private static boolean isMeetingBarA10() {
        String hardware = (Build.MANUFACTURER + " " + Build.BRAND + " " + Build.MODEL + " " + Build.DEVICE)
                .toLowerCase(Locale.ROOT);
        return hardware.contains("yealink") && (hardware.contains("a10") || hardware.contains("meetingbar"));
    }

    private static String androidDeviceName(Context context) {
        try {
            String value = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME);
            return value == null || value.isBlank() ? null : value;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static JSONArray visibleConferenceApplications(Context context) {
        JSONArray result = new JSONArray();
        PackageManager packages = context.getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> activities = packages.queryIntentActivities(launcher, PackageManager.MATCH_ALL);
        Set<String> added = new HashSet<>();
        for (ResolveInfo activity : activities) {
            if (activity.activityInfo == null || activity.activityInfo.packageName == null) continue;
            String packageName = activity.activityInfo.packageName;
            if (packageName.equals(context.getPackageName()) || !added.add(packageName)) continue;
            String label = String.valueOf(activity.loadLabel(packages));
            String searchable = (label + " " + packageName).toLowerCase(Locale.ROOT);
            if (!(searchable.contains("ume") || searchable.contains("teams") || searchable.contains("zoom")
                    || searchable.contains("meeting") || searchable.contains("conference") || searchable.contains("yealink"))) continue;
            JSONObject item = new JSONObject();
            put(item, "label", label);
            put(item, "packageName", packageName);
            try {
                PackageInfo info = packages.getPackageInfo(packageName, 0);
                put(item, "versionName", info.versionName);
            } catch (Exception ignored) {
                put(item, "versionName", null);
            }
            result.put(item);
        }
        return result;
    }

    private static JSONArray visibleAccounts(Context context) {
        JSONArray result = new JSONArray();
        try {
            for (Account account : AccountManager.get(context).getAccounts()) {
                JSONObject item = new JSONObject();
                put(item, "name", account.name);
                put(item, "type", account.type);
                result.put(item);
            }
        } catch (Exception ignored) {
            // Android 8+ only exposes accounts explicitly made visible to this package.
        }
        return result;
    }

    private static String inferProvider(JSONArray applications) {
        String text = applications.toString().toLowerCase(Locale.ROOT);
        if (text.contains("ume") || text.contains("com.yealink.ymr.uc")) return "UME";
        if (text.contains("teams") || text.contains("microsoft")) return "Microsoft Teams";
        if (text.contains("zoom")) return "Zoom Rooms";
        if (text.contains("yealink")) return "Yealink/Device Mode";
        return "unknown";
    }

    private static void put(JSONObject target, String key, Object value) {
        try { target.put(key, value == null ? JSONObject.NULL : value); }
        catch (Exception ignored) {}
    }
}
