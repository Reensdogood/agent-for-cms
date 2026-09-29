package kr.funnet.tvcontroller.display;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;

import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class UsbSerialTransport implements SerialTransport {
    public static final String USB_PERMISSION_ACTION = "kr.funnet.tvcontroller.USB_PERMISSION";
    private final Context context;
    private final UsbManager manager;
    private UsbSerialPort port;
    private UsbDeviceConnection connection;
    private String name = "USB 미연결";

    public UsbSerialTransport(Context context) {
        this.context = context.getApplicationContext();
        this.manager = (UsbManager) context.getSystemService(Context.USB_SERVICE);
    }

    /**
     * Enumerates the attached USB serial device without claiming its interface or opening the port.
     * This is safe to call from the periodic service heartbeat.
     */
    public static String inspect(Context context) throws DisplayException {
        UsbSerialTransport transport = new UsbSerialTransport(context);
        List<UsbSerialDriver> drivers = transport.scanDrivers();
        UsbSerialDriver driver = transport.requireSingleDriver(drivers);
        UsbDevice device = driver.getDevice();
        transport.select(driver);
        if (!transport.manager.hasPermission(device)) {
            transport.requestPermission(device);
            UsbSerialDiagnostics.failure("permission_required", DisplayErrorCode.USB_PERMISSION_REQUIRED.name(),
                    "USB 접근 권한 승인을 기다리고 있습니다.");
            throw new DisplayException(DisplayErrorCode.USB_PERMISSION_REQUIRED,
                    "USB 접근 권한을 허용해 주세요: " + transport.name);
        }
        UsbSerialDiagnostics.update("stage", "device_ready");
        UsbSerialDiagnostics.update("portOpen", false);
        return transport.name + " · " + driver.getClass().getSimpleName();
    }

    @Override public void open() throws DisplayException {
        if (isOpen()) return;
        List<UsbSerialDriver> drivers = scanDrivers();
        UsbSerialDriver driver = requireSingleDriver(drivers);
        UsbDevice device = driver.getDevice();
        select(driver);
        if (!manager.hasPermission(device)) {
            requestPermission(device);
            UsbSerialDiagnostics.failure("permission_required", DisplayErrorCode.USB_PERMISSION_REQUIRED.name(),
                    "USB 접근 권한 승인을 기다리고 있습니다.");
            throw new DisplayException(DisplayErrorCode.USB_PERMISSION_REQUIRED,
                    "USB 접근 권한을 허용해 주세요: " + name);
        }
        connection = manager.openDevice(device);
        if (connection == null) throw new DisplayException(DisplayErrorCode.PORT_OPEN_FAILED, "USB 장치를 열 수 없습니다: " + name);
        try {
            port = driver.getPorts().get(0);
            port.open(connection);
            port.setParameters(9600, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
            try { port.setDTR(false); } catch (Exception ignored) {}
            try { port.setRTS(false); } catch (Exception ignored) {}
            discardInput();
            UsbSerialDiagnostics.update("permission", true);
            UsbSerialDiagnostics.update("portOpen", true);
            UsbSerialDiagnostics.update("stage", "port_open");
        } catch (Exception error) {
            close();
            UsbSerialDiagnostics.failure("port_open_failed", DisplayErrorCode.PORT_OPEN_FAILED.name(), error.getMessage());
            throw new DisplayException(DisplayErrorCode.PORT_OPEN_FAILED, "USB Serial 포트를 열지 못했습니다: " + name, error);
        }
    }

    private List<UsbSerialDriver> scanDrivers() {
        List<UsbSerialDriver> drivers = UsbSerialProber.getDefaultProber().findAllDrivers(manager);
        Map<Integer, UsbSerialDriver> driversByDevice = new HashMap<>();
        for (UsbSerialDriver candidate : drivers) driversByDevice.put(candidate.getDevice().getDeviceId(), candidate);
        JSONArray detected = new JSONArray();
        for (UsbDevice candidate : manager.getDeviceList().values()) {
            UsbSerialDriver matched = driversByDevice.get(candidate.getDeviceId());
            JSONObject item = new JSONObject();
            put(item, "deviceName", candidate.getDeviceName());
            put(item, "productName", candidate.getProductName());
            put(item, "manufacturerName", candidate.getManufacturerName());
            put(item, "vendorId", String.format("0x%04X", candidate.getVendorId()));
            put(item, "productId", String.format("0x%04X", candidate.getProductId()));
            put(item, "permission", manager.hasPermission(candidate));
            put(item, "driver", matched == null ? JSONObject.NULL : matched.getClass().getSimpleName());
            put(item, "portCount", matched == null ? 0 : matched.getPorts().size());
            detected.put(item);
        }
        JSONObject diagnostic = new JSONObject();
        put(diagnostic, "stage", "usb_enumerated");
        put(diagnostic, "detectedDeviceCount", manager.getDeviceList().size());
        put(diagnostic, "supportedDriverCount", drivers.size());
        put(diagnostic, "devices", detected);
        put(diagnostic, "serialParameters", "9600 8N1 · flow control none");
        UsbSerialDiagnostics.replace(diagnostic);
        return drivers;
    }

    private UsbSerialDriver requireSingleDriver(List<UsbSerialDriver> drivers) throws DisplayException {
        if (drivers.isEmpty()) {
            UsbSerialDiagnostics.failure("driver_not_found", DisplayErrorCode.DEVICE_NOT_FOUND.name(),
                    "USB 장치는 열거됐지만 지원되는 USB Serial 드라이버를 찾지 못했습니다.");
            throw new DisplayException(DisplayErrorCode.DEVICE_NOT_FOUND,
                    "지원되는 FTDI/CP210x/Prolific/CDC USB Serial 장치를 찾지 못했습니다.");
        }
        if (drivers.size() > 1) {
            UsbSerialDiagnostics.failure("multiple_serial_devices", DisplayErrorCode.DEVICE_NOT_FOUND.name(),
                    "지원되는 USB Serial 장치가 여러 개 감지됐습니다.");
            throw new DisplayException(DisplayErrorCode.DEVICE_NOT_FOUND,
                    "USB Serial 장치가 여러 개입니다. PoC에서는 한 개만 연결해 주세요.");
        }
        return drivers.get(0);
    }

    private void select(UsbSerialDriver driver) {
        UsbDevice device = driver.getDevice();
        name = device.getProductName() == null
                ? String.format("USB %04X:%04X", device.getVendorId(), device.getProductId())
                : device.getProductName();
        UsbSerialDiagnostics.update("selectedProductName", name);
        UsbSerialDiagnostics.update("selectedVendorId", String.format("0x%04X", device.getVendorId()));
        UsbSerialDiagnostics.update("selectedProductId", String.format("0x%04X", device.getProductId()));
        UsbSerialDiagnostics.update("selectedDriver", driver.getClass().getSimpleName());
        UsbSerialDiagnostics.update("permission", manager.hasPermission(device));
    }

    private void requestPermission(UsbDevice device) {
        PendingIntent permission = PendingIntent.getBroadcast(context, 0,
                new Intent(USB_PERMISSION_ACTION).setPackage(context.getPackageName()),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        manager.requestPermission(device, permission);
    }

    @Override public boolean isOpen() { return port != null && port.isOpen(); }

    @Override public void discardInput() {
        if (port == null) return;
        try { port.purgeHwBuffers(true, false); } catch (Exception ignored) {}
    }

    @Override public void write(byte[] data) throws DisplayException {
        try { port.write(data, 1500); UsbSerialDiagnostics.recordTx(data); }
        catch (IOException error) { UsbSerialDiagnostics.failure("write_failed", DisplayErrorCode.PORT_OPEN_FAILED.name(), error.getMessage()); throw new DisplayException(DisplayErrorCode.PORT_OPEN_FAILED, "USB Serial 쓰기 실패", error); }
    }

    @Override public int read(byte[] destination, int offset, int length, int timeoutMs) throws DisplayException {
        byte[] buffer = new byte[length];
        try {
            int read = port.read(buffer, timeoutMs);
            if (read > 0) System.arraycopy(buffer, 0, destination, offset, Math.min(read, length));
            UsbSerialDiagnostics.recordRx(buffer, read);
            return Math.max(read, 0);
        } catch (IOException error) {
            UsbSerialDiagnostics.failure("read_failed", DisplayErrorCode.TIMEOUT.name(), error.getMessage());
            throw new DisplayException(DisplayErrorCode.TIMEOUT, "USB Serial 읽기 실패 또는 시간 초과", error);
        }
    }

    @Override public String name() { return name; }

    private static void put(JSONObject target, String key, Object value) {
        try { target.put(key, value == null ? JSONObject.NULL : value); } catch (JSONException ignored) {}
    }

    @Override public void close() {
        if (port != null) try { port.close(); } catch (Exception ignored) {}
        if (connection != null) connection.close();
        port = null;
        connection = null;
        UsbSerialDiagnostics.update("portOpen", false);
    }
}
