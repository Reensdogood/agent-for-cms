package kr.funnet.tvcontroller.display;

import java.util.Arrays;

public final class SamsungMdcProtocol {
    public static final int HEADER = 0xAA;
    public static final int RESPONSE_COMMAND = 0xFF;
    public static final int POWER = 0x11;
    public static final int VOLUME = 0x12;
    public static final int INPUT = 0x14;
    public static final int HDMI1 = 0x21;
    public static final int HDMI2 = 0x23;
    public static final int HDMI3 = 0x31;
    private static final int ACK = 0x41;
    private static final int NAK = 0x4E;

    private SamsungMdcProtocol() {}

    public static byte[] buildGet(int command, int displayId) {
        return build(command, displayId, new byte[0]);
    }

    public static byte[] buildSet(int command, int value, int displayId) {
        return build(command, displayId, new byte[]{(byte) value});
    }

    public static int checksum(byte[] packetWithoutChecksum) {
        if (packetWithoutChecksum.length == 0 || unsigned(packetWithoutChecksum[0]) != HEADER) {
            throw new IllegalArgumentException("Samsung MDC packet must begin with 0xAA");
        }
        int sum = 0;
        for (int index = 1; index < packetWithoutChecksum.length; index++) sum += unsigned(packetWithoutChecksum[index]);
        return sum & 0xFF;
    }

    public static Response parseResponse(byte[] packet, int expectedCommand, int expectedDisplayId) throws DisplayException {
        if (packet.length < 8 || unsigned(packet[0]) != HEADER || unsigned(packet[1]) != RESPONSE_COMMAND) {
            throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE, "Samsung MDC 응답 형식이 올바르지 않습니다.");
        }
        int dataLength = unsigned(packet[3]);
        if (dataLength < 3 || packet.length != dataLength + 5) {
            throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE, "Samsung MDC 응답 길이가 올바르지 않습니다.");
        }
        int expectedChecksum = checksum(Arrays.copyOf(packet, packet.length - 1));
        if (unsigned(packet[packet.length - 1]) != expectedChecksum) {
            throw new DisplayException(DisplayErrorCode.CHECKSUM_ERROR,
                    String.format("Samsung MDC checksum mismatch: expected 0x%02X, received 0x%02X.",
                            expectedChecksum, unsigned(packet[packet.length - 1])));
        }
        if (unsigned(packet[2]) != expectedDisplayId) {
            throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE,
                    String.format("Samsung MDC display ID mismatch: expected 0x%02X, received 0x%02X.",
                            expectedDisplayId, unsigned(packet[2])));
        }
        if (unsigned(packet[5]) != expectedCommand) {
            throw new DisplayException(DisplayErrorCode.UNSUPPORTED_COMMAND,
                    String.format("Samsung MDC response command mismatch: expected 0x%02X, received 0x%02X.",
                            expectedCommand, unsigned(packet[5])));
        }
        int marker = unsigned(packet[4]);
        if (marker == NAK) {
            throw new DisplayException(DisplayErrorCode.NAK_RECEIVED,
                    String.format("Samsung MDC NAK for 0x%02X; error 0x%02X.", expectedCommand, unsigned(packet[6])));
        }
        if (marker != ACK) {
            throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE,
                    String.format("Unknown Samsung MDC response marker 0x%02X.", marker));
        }
        return new Response(expectedDisplayId, expectedCommand, unsigned(packet[6]));
    }

    private static byte[] build(int command, int displayId, byte[] data) {
        if (displayId < 0 || displayId > 0xFD) throw new IllegalArgumentException("Display ID는 0~253이어야 합니다.");
        byte[] packet = new byte[5 + data.length];
        packet[0] = (byte) HEADER;
        packet[1] = (byte) command;
        packet[2] = (byte) displayId;
        packet[3] = (byte) data.length;
        System.arraycopy(data, 0, packet, 4, data.length);
        packet[packet.length - 1] = (byte) checksum(Arrays.copyOf(packet, packet.length - 1));
        return packet;
    }

    private static int unsigned(byte value) { return value & 0xFF; }
    public record Response(int displayId, int command, int value) {}
}
