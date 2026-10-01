package kr.funnet.tvcontroller.display;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** Collects read-only USB host evidence without requiring root or opening a serial port. */
public final class UsbPlatformDiagnostics {
    private static volatile JSONObject lastUsbEvent;

    private UsbPlatformDiagnostics() {}

    public static void recordEvent(Intent intent) {
        JSONObject event = new JSONObject();
        put(event, "action", intent == null ? null : intent.getAction());
        put(event, "at", System.currentTimeMillis());
        UsbDevice device = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class)
                : intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
        if (device != null) {
            put(event, "deviceName", device.getDeviceName());
            put(event, "productName", device.getProductName());
            put(event, "vendorId", hexId(device.getVendorId()));
            put(event, "productId", hexId(device.getProductId()));
        }
        lastUsbEvent = event;
    }

    public static JSONObject snapshot(Context context) {
        JSONObject result = new JSONObject();
        PackageManager packages = context.getPackageManager();
        put(result, "androidRelease", Build.VERSION.RELEASE);
        put(result, "androidApi", Build.VERSION.SDK_INT);
        put(result, "usbHostFeature", packages.hasSystemFeature(PackageManager.FEATURE_USB_HOST));
        put(result, "usbAccessoryFeature", packages.hasSystemFeature(PackageManager.FEATURE_USB_ACCESSORY));
        put(result, "driverBundle", "usb-serial-for-android 3.9.0");
        put(result, "bundledDrivers", new JSONArray()
                .put("FtdiSerialDriver")
                .put("ProlificSerialDriver")
                .put("Cp2102SerialDriver")
                .put("CdcAcmSerialDriver")
                .put("Ch34xSerialDriver"));
        put(result, "standardFtdiFt232r", "0x0403:0x6001");
        put(result, "lastUsbEvent", lastUsbEvent == null ? JSONObject.NULL : copy(lastUsbEvent));
        put(result, "sysfs", sysfsSnapshot());
        return result;
    }

    private static JSONObject sysfsSnapshot() {
        JSONObject result = new JSONObject();
        File root = new File("/sys/bus/usb/devices");
        put(result, "path", root.getAbsolutePath());
        put(result, "exists", root.exists());
        put(result, "readable", root.canRead());
        JSONArray devices = new JSONArray();
        try {
            File[] entries = root.listFiles();
            if (entries == null) {
                put(result, "status", "not_listable");
            } else {
                for (File entry : entries) {
                    String vendor = read(entry, "idVendor");
                    String product = read(entry, "idProduct");
                    if (vendor == null || product == null) continue;
                    JSONObject device = new JSONObject();
                    put(device, "node", entry.getName());
                    put(device, "vendorId", "0x" + vendor.toUpperCase());
                    put(device, "productId", "0x" + product.toUpperCase());
                    put(device, "manufacturer", read(entry, "manufacturer"));
                    put(device, "product", read(entry, "product"));
                    put(device, "authorized", read(entry, "authorized"));
                    put(device, "busNumber", read(entry, "busnum"));
                    put(device, "deviceNumber", read(entry, "devnum"));
                    put(device, "speedMbps", read(entry, "speed"));
                    devices.put(device);
                    if (devices.length() >= 32) break;
                }
                put(result, "status", "ok");
            }
        } catch (Exception error) {
            put(result, "status", "error");
            put(result, "error", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        put(result, "deviceCount", devices.length());
        put(result, "devices", devices);
        return result;
    }

    private static String read(File directory, String name) {
        try {
            File file = new File(directory, name);
            if (!file.isFile() || !file.canRead()) return null;
            try (FileInputStream input = new FileInputStream(file);
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[256];
                int total = 0;
                int count;
                while ((count = input.read(buffer)) > 0 && total < 4096) {
                    int safeCount = Math.min(count, 4096 - total);
                    output.write(buffer, 0, safeCount);
                    total += safeCount;
                }
                return output.toString(StandardCharsets.UTF_8.name()).trim();
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String hexId(int value) { return String.format("0x%04X", value); }

    private static JSONObject copy(JSONObject value) {
        try { return new JSONObject(value.toString()); }
        catch (Exception ignored) { return new JSONObject(); }
    }

    private static void put(JSONObject target, String key, Object value) {
        try { target.put(key, value == null ? JSONObject.NULL : value); }
        catch (Exception ignored) {}
    }
}
