package kr.funnet.tvcontroller.network;

import android.app.Activity;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;

import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;

import kr.funnet.tvcontroller.BuildConfig;
import kr.funnet.tvcontroller.data.SettingsStore;

/** Downloads and installs the unmodified APK from Tailscale's official stable package track. */
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
        SettingsStore settings = new SettingsStore(activity);
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            settings.vpnInstallStatus("외부 APK 설치 권한 승인 필요");
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
            long id = manager.enqueue(request);
            settings.tailscaleDownloadId(id);
            settings.vpnInstallStatus("공식 APK 다운로드 중");
            return id;
        } catch (Exception error) {
            settings.vpnInstallStatus("다운로드 실패: " + safeMessage(error));
            Toast.makeText(activity, "Tailscale 다운로드 실패: " + safeMessage(error), Toast.LENGTH_LONG).show();
            return -1L;
        }
    }

    public static void resumePendingInstall(Activity activity) {
        SettingsStore settings = new SettingsStore(activity);
        long downloadId = settings.tailscaleDownloadId();
        if (downloadId < 0 || isInstalled(activity)) return;
        DownloadManager manager = activity.getSystemService(DownloadManager.class);
        if (manager == null) return;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) {
                settings.vpnInstallStatus("다운로드 기록을 찾지 못함");
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_PENDING || status == DownloadManager.STATUS_RUNNING
                    || status == DownloadManager.STATUS_PAUSED) return;
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                settings.vpnInstallStatus("다운로드 실패 · 코드 " + reason);
                settings.tailscaleDownloadId(-1L);
                return;
            }
        }
        Uri apk = manager.getUriForDownloadedFile(downloadId);
        settings.tailscaleDownloadId(-1L);
        if (apk == null) {
            settings.vpnInstallStatus("다운로드 APK URI 확인 실패");
            return;
        }
        settings.vpnInstallStatus("APK 무결성 검증 중");
        new Thread(() -> verifyAndInstall(activity, apk), "tailscale-apk-installer").start();
    }

    private static void verifyAndInstall(Activity activity, Uri apk) {
        SettingsStore settings = new SettingsStore(activity);
        try {
            verifySha256(activity, apk);
            PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(PACKAGE_NAME);
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
            int sessionId = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(sessionId);
                 InputStream input = activity.getContentResolver().openInputStream(apk);
                 OutputStream output = session.openWrite("tailscale.apk", 0, -1)) {
                if (input == null) throw new IllegalStateException("다운로드 APK를 다시 열 수 없습니다.");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) if (read > 0) output.write(buffer, 0, read);
                session.fsync(output);
                Intent result = new Intent(activity, PackageInstallReceiver.class)
                        .setAction(PackageInstallReceiver.ACTION_INSTALL_RESULT);
                PendingIntent pending = PendingIntent.getBroadcast(activity, sessionId, result,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                settings.vpnInstallStatus("Android 설치 승인 대기");
                session.commit(pending.getIntentSender());
            }
        } catch (Exception error) {
            settings.vpnInstallStatus("설치 세션 실패: " + safeMessage(error));
            activity.runOnUiThread(() -> Toast.makeText(activity,
                    "Tailscale 설치 준비 실패: " + safeMessage(error), Toast.LENGTH_LONG).show());
        }
    }

    private static void verifySha256(Context context, Uri apk) throws Exception {
        try (InputStream input = context.getContentResolver().openInputStream(apk)) {
            if (input == null) throw new IllegalStateException("다운로드 파일을 열 수 없습니다.");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) if (read > 0) digest.update(buffer, 0, read);
            StringBuilder actual = new StringBuilder();
            for (byte value : digest.digest()) actual.append(String.format("%02x", value & 0xff));
            if (!BuildConfig.TAILSCALE_APK_SHA256.equalsIgnoreCase(actual.toString())) {
                throw new SecurityException("공식 SHA-256과 일치하지 않습니다.");
            }
        }
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }
}
