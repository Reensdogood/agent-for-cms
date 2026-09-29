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
import java.util.List;

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

    @Override public void open() throws DisplayException {
        if (isOpen()) return;
        List<UsbSerialDriver> drivers = UsbSerialProber.getDefaultProber().findAllDrivers(manager);
        if (drivers.isEmpty()) {
            throw new DisplayException(DisplayErrorCode.DEVICE_NOT_FOUND,
                    "지원되는 FTDI/CP210x/Prolific/CDC USB Serial 장치를 찾지 못했습니다.");
        }
        if (drivers.size() > 1) {
            throw new DisplayException(DisplayErrorCode.DEVICE_NOT_FOUND,
                    "USB Serial 장치가 여러 개입니다. PoC에서는 한 개만 연결해 주세요.");
        }
        UsbSerialDriver driver = drivers.get(0);
        UsbDevice device = driver.getDevice();
        name = device.getProductName() == null
                ? String.format("USB %04X:%04X", device.getVendorId(), device.getProductId())
                : device.getProductName();
        if (!manager.hasPermission(device)) {
            PendingIntent permission = PendingIntent.getBroadcast(context, 0,
                    new Intent(USB_PERMISSION_ACTION).setPackage(context.getPackageName()),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            manager.requestPermission(device, permission);
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
        } catch (Exception error) {
            close();
            throw new DisplayException(DisplayErrorCode.PORT_OPEN_FAILED, "USB Serial 포트를 열지 못했습니다: " + name, error);
        }
    }

    @Override public boolean isOpen() { return port != null && port.isOpen(); }

    @Override public void discardInput() {
        if (port == null) return;
        try { port.purgeHwBuffers(true, false); } catch (Exception ignored) {}
    }

    @Override public void write(byte[] data) throws DisplayException {
        try { port.write(data, 1500); }
        catch (IOException error) { throw new DisplayException(DisplayErrorCode.PORT_OPEN_FAILED, "USB Serial 쓰기 실패", error); }
    }

    @Override public int read(byte[] destination, int offset, int length, int timeoutMs) throws DisplayException {
        byte[] buffer = new byte[length];
        try {
            int read = port.read(buffer, timeoutMs);
            if (read > 0) System.arraycopy(buffer, 0, destination, offset, Math.min(read, length));
            return Math.max(read, 0);
        } catch (IOException error) {
            throw new DisplayException(DisplayErrorCode.TIMEOUT, "USB Serial 읽기 실패 또는 시간 초과", error);
        }
    }

    @Override public String name() { return name; }

    @Override public void close() {
        if (port != null) try { port.close(); } catch (Exception ignored) {}
        if (connection != null) connection.close();
        port = null;
        connection = null;
    }
}
