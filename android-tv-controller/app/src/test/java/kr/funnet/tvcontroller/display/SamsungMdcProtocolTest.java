package kr.funnet.tvcontroller.display;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class SamsungMdcProtocolTest {
    @Test public void buildsPacketsIdenticalToWindowsAgent() {
        assertArrayEquals(bytes(0xAA, 0x11, 0x00, 0x00, 0x11), SamsungMdcProtocol.buildGet(0x11, 0));
        assertArrayEquals(bytes(0xAA, 0x11, 0x00, 0x01, 0x01, 0x13), SamsungMdcProtocol.buildSet(0x11, 1, 0));
        assertArrayEquals(bytes(0xAA, 0x14, 0x00, 0x01, 0x21, 0x36), SamsungMdcProtocol.buildSet(0x14, 0x21, 0));
        assertArrayEquals(bytes(0xAA, 0x14, 0x00, 0x01, 0x23, 0x38), SamsungMdcProtocol.buildSet(0x14, 0x23, 0));
        assertArrayEquals(bytes(0xAA, 0x14, 0x00, 0x01, 0x31, 0x46), SamsungMdcProtocol.buildSet(0x14, 0x31, 0));
        assertArrayEquals(bytes(0xAA, 0x12, 0x00, 0x01, 0x1E, 0x31), SamsungMdcProtocol.buildSet(0x12, 30, 0));
    }

    @Test public void parsesValidAcknowledgement() throws Exception {
        SamsungMdcProtocol.Response response = SamsungMdcProtocol.parseResponse(
                bytes(0xAA, 0xFF, 0x00, 0x03, 0x41, 0x11, 0x01, 0x55), 0x11, 0);
        assertEquals(1, response.value());
    }

    @Test public void rejectsBadChecksum() {
        DisplayException error = assertThrows(DisplayException.class, () -> SamsungMdcProtocol.parseResponse(
                bytes(0xAA, 0xFF, 0x00, 0x03, 0x41, 0x11, 0x01, 0x00), 0x11, 0));
        assertEquals(DisplayErrorCode.CHECKSUM_ERROR, error.code());
    }

    @Test public void preservesNakError() {
        DisplayException error = assertThrows(DisplayException.class, () -> SamsungMdcProtocol.parseResponse(
                bytes(0xAA, 0xFF, 0x00, 0x03, 0x4E, 0x11, 0x01, 0x62), 0x11, 0));
        assertEquals(DisplayErrorCode.NAK_RECEIVED, error.code());
    }

    @Test public void rejectsBroadcastId() {
        assertThrows(IllegalArgumentException.class, () -> SamsungMdcProtocol.buildGet(0x11, 0xFE));
    }

    private static byte[] bytes(int... values) {
        byte[] result = new byte[values.length];
        for (int index = 0; index < values.length; index++) result[index] = (byte) values[index];
        return result;
    }
}
