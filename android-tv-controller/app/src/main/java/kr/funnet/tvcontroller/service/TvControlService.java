package kr.funnet.tvcontroller.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import kr.funnet.tvcontroller.MainActivity;
import kr.funnet.tvcontroller.R;
import kr.funnet.tvcontroller.data.SecureTokenStore;
import kr.funnet.tvcontroller.data.SettingsStore;
import kr.funnet.tvcontroller.display.DisplayException;
import kr.funnet.tvcontroller.display.SamsungMdcClient;
import kr.funnet.tvcontroller.display.UsbSerialTransport;
import kr.funnet.tvcontroller.display.UsbSerialDiagnostics;
import kr.funnet.tvcontroller.display.UsbPlatformDiagnostics;
import kr.funnet.tvcontroller.network.ServerClient;
import kr.funnet.tvcontroller.network.AdminPageProbe;

public final class TvControlService extends Service {
    private static final String TAG = "FunnetTvController";
    private static final String CHANNEL = "tv-control";
    private static final int NOTIFICATION_ID = 7501;
    private final AtomicBoolean running = new AtomicBoolean();
    private ExecutorService worker;
    private SettingsStore settings;
    private ServerClient server;
    private PowerManager.WakeLock wakeLock;
    private volatile String usbName = "USB 미확인";
    private volatile long lastHeartbeat;
    private volatile long lastUsbProbe;
    private volatile long lastLoopTick;

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            UsbPlatformDiagnostics.recordEvent(intent);
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
                usbName = "USB 분리됨";
                updateStatus("USB Serial 분리됨");
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction())
                    || UsbSerialTransport.USB_PERMISSION_ACTION.equals(intent.getAction())) {
                usbName = "USB 연결 감지";
                lastUsbProbe = 0;
                updateStatus("USB Serial 연결 감지 · 재연결 대기");
            }
        }
    };

    public static void start(Context context) {
        Intent intent = new Intent(context, TvControlService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
        else context.startService(intent);
    }

    @Override public void onCreate() {
        super.onCreate();
        settings = new SettingsStore(this);
        server = new ServerClient(settings, new SecureTokenStore(this));
        createNotificationChannel();
        Notification notification = notification("서비스 시작 중");
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else startForeground(NOTIFICATION_ID, notification);
        IntentFilter filter = new IntentFilter();
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        filter.addAction(UsbSerialTransport.USB_PERMISSION_ACTION);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(usbReceiver, filter);
        worker = Executors.newSingleThreadExecutor();
        acquireWakeLock();
        WakeWatchdogReceiver.schedule(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (running.compareAndSet(false, true)) worker.execute(this::runLoop);
        return START_STICKY;
    }

    private void runLoop() {
        int consecutiveErrors = 0;
        lastLoopTick = SystemClock.elapsedRealtime();
        while (running.get()) {
            try {
                long elapsed = SystemClock.elapsedRealtime();
                long gap = elapsed - lastLoopTick;
                lastLoopTick = elapsed;
                if (gap > 90_000L) {
                    settings.powerEvent("긴 실행 중단 감지 후 복구 · " + (gap / 1000L) + "초");
                    Log.w(TAG, "long control-loop pause detected: " + gap + "ms");
                }
                long now = System.currentTimeMillis();
                if (now - lastUsbProbe >= 30_000) probeUsb();
                if (now - lastHeartbeat >= 30_000) {
                    server.heartbeat(usbName);
                    lastHeartbeat = now;
                }
                JSONArray commands = server.commands();
                if (commands != null) {
                    for (int index = 0; index < commands.length() && running.get(); index++) {
                        processCommand(commands.getJSONObject(index));
                    }
                }
                consecutiveErrors = 0;
                updateStatus("서버 연결 정상 · " + usbName);
                sleep(5000);
            } catch (Exception error) {
                consecutiveErrors++;
                updateStatus("연결 오류: " + safeMessage(error));
                Log.w(TAG, "control loop failure", error);
                sleep(Math.min(30_000, 2000L * consecutiveErrors));
            }
        }
    }

    private void probeUsb() {
        lastUsbProbe = System.currentTimeMillis();
        try {
            usbName = UsbSerialTransport.inspect(this);
        } catch (DisplayException error) {
            usbName = error.code().name();
            updateStatus("USB 확인: " + safeMessage(error));
        }
    }

    private void processCommand(JSONObject command) throws Exception {
        String id = command.getString("id");
        String cached = settings.completedResult(id);
        if (cached != null) {
            server.complete(id, new JSONObject(cached));
            return;
        }
        JSONObject envelope;
        try {
            String type = command.getString("type");
            UsbSerialDiagnostics.beginCommand(id, type);
            JSONObject result = execute(type, command.optJSONObject("payload"));
            UsbSerialDiagnostics.finishCommand(true);
            envelope = new JSONObject().put("success", true).put("result", result);
        } catch (Exception error) {
            UsbSerialDiagnostics.finishCommand(false);
            JSONObject failure = new JSONObject().put("error", safeMessage(error));
            if (error instanceof DisplayException display) failure.put("code", display.code().name());
            failure.put("serialDiagnostics", UsbSerialDiagnostics.snapshot());
            envelope = new JSONObject().put("success", false).put("result", failure);
        }
        settings.rememberCompleted(id, envelope);
        server.complete(id, envelope);
        server.heartbeat(usbName);
        lastHeartbeat = System.currentTimeMillis();
    }

    private JSONObject execute(String type, JSONObject payload) throws Exception {
        if ("health.probe".equals(type)) {
            server.heartbeat(usbName);
            lastHeartbeat = System.currentTimeMillis();
            return new JSONObject().put("platform", "android").put("status", "ok");
        }
        if ("a10.admin.probe".equals(type)) return AdminPageProbe.run(this);
        if (!type.startsWith("display.")) throw new IllegalArgumentException("Android 앱에서 지원하지 않는 명령입니다: " + type);
        try (UsbSerialTransport transport = new UsbSerialTransport(this);
             SamsungMdcClient client = new SamsungMdcClient(transport, settings.displayId(), settings.tvModel())) {
            transport.open();
            usbName = transport.name();
            return switch (type) {
                case "display.power" -> client.setPower(payload != null && payload.getBoolean("on"));
                case "display.input" -> client.setInput(payload == null ? "" : payload.getString("input").toUpperCase(Locale.ROOT));
                case "display.volume" -> client.setVolume(payload == null ? -1 : payload.getInt("value"));
                case "display.status" -> client.status();
                default -> throw new IllegalArgumentException("지원하지 않는 TV 명령입니다: " + type);
            };
        }
    }

    private void updateStatus(String value) {
        settings.status(value);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification(value));
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setContentTitle("Yealink MeetingBar A10 TV Controller")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_tv_control)
                .setOngoing(true)
                .setContentIntent(content)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "TV 제어 서비스", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("USB Serial을 이용한 삼성 TV 상시 제어");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                getPackageName() + ":tv-control");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
        settings.powerEvent("CPU 절전 방지 활성");
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private static void sleep(long milliseconds) {
        try { Thread.sleep(milliseconds); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); }
    }

    @Override public void onDestroy() {
        running.set(false);
        if (worker != null) worker.shutdownNow();
        try { unregisterReceiver(usbReceiver); } catch (Exception ignored) {}
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        WakeWatchdogReceiver.schedule(this);
        super.onDestroy();
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        WakeWatchdogReceiver.schedule(this);
        super.onTaskRemoved(rootIntent);
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
