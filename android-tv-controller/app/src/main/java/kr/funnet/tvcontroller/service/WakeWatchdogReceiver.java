package kr.funnet.tvcontroller.service;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Log;

import kr.funnet.tvcontroller.data.SettingsStore;

public final class WakeWatchdogReceiver extends BroadcastReceiver {
    private static final String TAG = "FunnetTvController";
    private static final long INTERVAL_MS = 5 * 60_000L;
    private static final int REQUEST_CODE = 7502;

    @Override public void onReceive(Context context, Intent intent) {
        new SettingsStore(context).powerEvent("절전 감시 알람으로 서비스 확인·기동");
        try {
            TvControlService.start(context);
        } catch (RuntimeException error) {
            Log.e(TAG, "watchdog could not start service", error);
        } finally {
            schedule(context);
        }
    }

    public static void schedule(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        PendingIntent operation = PendingIntent.getBroadcast(
                context,
                REQUEST_CODE,
                new Intent(context, WakeWatchdogReceiver.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long triggerAt = SystemClock.elapsedRealtime() + INTERVAL_MS;
        manager.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, operation);
    }
}
