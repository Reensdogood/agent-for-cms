package kr.funnet.tvcontroller.network;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;

import java.io.InputStream;
import java.security.MessageDigest;

import kr.funnet.tvcontroller.BuildConfig;

/** Installs the unmodified APK published on Tailscale's official stable package track. */
public final class TailscaleInstaller {
    public static final String PACKAGE_NAME = "com.tailscale.ipn";

    private TailscaleInstaller() {}

    public static boolean isInstalled(Context context) {
        try {
            context.getPackageManager().getPackageInfo(PACKAGE_NAME, 0);
            return true;
        } catch (PackageManager.NameNotFoundException ignored) {
            return false;
        }
    }

    public static boolean launch(Context context) {
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(PACKAGE_NAME);
        if (intent == null) return false;
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
        return true;
    }

    public static long download(Activity activity) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            Intent permission = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(permission);
            Toast.makeText(activity, "이 앱의 APK 설치를 허용한 후 버튼을 다시 눌러 주세요.", Toast.LENGTH_LONG).show();
            return -1L;
        }
        try {
            DownloadManager manager = activity.getSystemService(DownloadManager.class);
            if (manager == null) throw new IllegalStateException("Android DownloadManager를 사용할 수 없습니다.");
            String fileName = "tailscale-android-universal-" + BuildConfig.TAILSCALE_VERSION
                    + "-" + System.currentTimeMillis() + ".apk";
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(BuildConfig.TAILSCALE_APK_URL))
                    .setTitle("Tailscale " + BuildConfig.TAILSCALE_VERSION)
                    .setDescription("Funnet A10 원격 관리 VPN 설치 파일")
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, fileName);
            return manager.enqueue(request);
        } catch (Exception error) {
            Toast.makeText(activity, "Tailscale 다운로드 실패: " + safeMessage(error), Toast.LENGTH_LONG).show();
            return -1L;
        }
    }

    public static void installDownloaded(Activity activity, long downloadId) {
        DownloadManager manager = activity.getSystemService(DownloadManager.class);
        if (manager == null) return;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) return;
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                Toast.makeText(activity, "Tailscale APK 다운로드가 완료되지 않았습니다.", Toast.LENGTH_LONG).show();
                return;
            }
        }
        Uri apk = manager.getUriForDownloadedFile(downloadId);
        if (apk == null) {
            Toast.makeText(activity, "다운로드한 Tailscale APK를 찾지 못했습니다.", Toast.LENGTH_LONG).show();
            return;
        }
        new Thread(() -> verifyAndInstall(activity, apk), "tailscale-apk-verifier").start();
    }

    private static void verifyAndInstall(Activity activity, Uri apk) {
        try (InputStream input = activity.getContentResolver().openInputStream(apk)) {
            if (input == null) throw new IllegalStateException("다운로드 파일을 열 수 없습니다.");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) if (read > 0) digest.update(buffer, 0, read);
            StringBuilder actual = new StringBuilder();
            for (byte value : digest.digest()) actual.append(String.format("%02x", value & 0xff));
            if (!BuildConfig.TAILSCALE_APK_SHA256.equalsIgnoreCase(actual.toString())) {
                throw new SecurityException("공식 SHA-256과 일치하지 않습니다. 설치를 중단했습니다.");
            }
            activity.runOnUiThread(() -> {
                Intent install = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(apk, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try { activity.startActivity(install); }
                catch (Exception error) {
                    Toast.makeText(activity, "APK 설치 화면을 열 수 없습니다: " + safeMessage(error), Toast.LENGTH_LONG).show();
                }
            });
        } catch (Exception error) {
            activity.runOnUiThread(() -> Toast.makeText(activity,
                    "Tailscale APK 검증 실패: " + safeMessage(error), Toast.LENGTH_LONG).show());
        }
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }
}
