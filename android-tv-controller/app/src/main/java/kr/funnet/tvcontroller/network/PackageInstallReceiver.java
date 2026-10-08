package kr.funnet.tvcontroller.network;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.widget.Toast;

import kr.funnet.tvcontroller.data.SettingsStore;

public final class PackageInstallReceiver extends BroadcastReceiver {
    public static final String ACTION_INSTALL_RESULT = "kr.funnet.tvcontroller.TAILSCALE_INSTALL_RESULT";

    @Override public void onReceive(Context context, Intent intent) {
        if (!ACTION_INSTALL_RESULT.equals(intent.getAction())) return;
        SettingsStore settings = new SettingsStore(context);
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmation == null) {
                settings.vpnInstallStatus("설치 승인 화면을 받지 못함");
                return;
            }
            settings.vpnInstallStatus("설치 승인 화면 표시");
            confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(confirmation);
            } catch (Exception error) {
                settings.vpnInstallStatus("설치 승인 화면 차단: " + error.getClass().getSimpleName());
                Toast.makeText(context, "A10이 설치 승인 화면을 차단했습니다.", Toast.LENGTH_LONG).show();
            }
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            settings.vpnInstallStatus("Tailscale 설치 완료");
            Toast.makeText(context, "Tailscale 설치가 완료됐습니다.", Toast.LENGTH_LONG).show();
            TailscaleInstaller.launch(context);
            return;
        }
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        settings.vpnInstallStatus("설치 실패 · 코드 " + status + (message == null ? "" : " · " + message));
        Toast.makeText(context, "Tailscale 설치 실패: " + (message == null ? status : message), Toast.LENGTH_LONG).show();
    }
}
