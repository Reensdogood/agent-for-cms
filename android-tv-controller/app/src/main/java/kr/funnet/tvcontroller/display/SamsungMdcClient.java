package kr.funnet.tvcontroller.display;

import org.json.JSONObject;
import org.json.JSONException;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

public final class SamsungMdcClient implements AutoCloseable {
    private static final int RESPONSE_TIMEOUT_MS = 1500;
    private final SerialTransport transport;
    private final int displayId;
    private final String model;

    public SamsungMdcClient(SerialTransport transport, int displayId, String model) {
        this.transport = transport;
        this.displayId = displayId;
        this.model = model;
    }

    public synchronized boolean getPower() throws DisplayException {
        int value = query(SamsungMdcProtocol.POWER);
        if (value == 0) return false;
        if (value == 1) return true;
        throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE,
                String.format("Unknown Samsung power value 0x%02X.", value));
    }

    public synchronized String getInput() throws DisplayException {
        int value = query(SamsungMdcProtocol.INPUT);
        if (value == SamsungMdcProtocol.HDMI1) return "HDMI1";
        if (value == SamsungMdcProtocol.HDMI2) return "HDMI2";
        if (value == SamsungMdcProtocol.HDMI3) return "HDMI3";
        throw new DisplayException(DisplayErrorCode.UNSUPPORTED_COMMAND,
                String.format("현재 입력 0x%02X는 지원하는 HDMI1/HDMI2/HDMI3 범위 밖입니다.", value));
    }

    public synchronized int getVolume() throws DisplayException {
        int value = query(SamsungMdcProtocol.VOLUME);
        if (value <= 100) return value;
        throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE, "TV 볼륨 응답이 0~100 범위를 벗어났습니다: " + value);
    }

    public synchronized JSONObject setPower(boolean on) throws DisplayException, InterruptedException, JSONException {
        setAndVerify(SamsungMdcProtocol.POWER, on ? 1 : 0, 1500);
        return new JSONObject().put("power", on ? "on" : "off");
    }

    public synchronized JSONObject setInput(String input) throws DisplayException, InterruptedException, JSONException {
        String normalized = input == null ? "" : input.trim().toUpperCase(java.util.Locale.ROOT);
        int expected = switch (normalized) {
            case "HDMI1" -> SamsungMdcProtocol.HDMI1;
            case "HDMI2" -> SamsungMdcProtocol.HDMI2;
            case "HDMI3" -> SamsungMdcProtocol.HDMI3;
            default -> throw new DisplayException(DisplayErrorCode.UNSUPPORTED_COMMAND,
                    "input은 HDMI1, HDMI2 또는 HDMI3여야 합니다.");
        };
        if (!SamsungDisplayCapabilities.supportsInput(model, normalized)) {
            throw new DisplayException(DisplayErrorCode.UNSUPPORTED_COMMAND,
                    model + " 모델은 " + normalized + " 입력을 지원하도록 설정되어 있지 않습니다.");
        }
        try {
            setAndVerify(SamsungMdcProtocol.INPUT, expected, 250);
            return new JSONObject().put("input", normalized).put("verification", "confirmed");
        } catch (DisplayException first) {
            Thread.sleep(500);
            try {
                if (normalized.equals(getInput())) {
                    return new JSONObject().put("input", normalized)
                            .put("verification", "confirmed_after_delayed_response");
                }
            } catch (DisplayException ignored) {
                // Preserve the first error in the final diagnostic.
            }
            throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE,
                    "입력 전환 적용 여부를 확인하지 못했습니다. 최초 오류: " + first.getMessage(), first);
        }
    }

    public synchronized JSONObject setVolume(int value) throws DisplayException, InterruptedException, JSONException {
        if (value < 0 || value > 100) throw new IllegalArgumentException("volume은 0~100이어야 합니다.");
        setAndVerify(SamsungMdcProtocol.VOLUME, value, 250);
        return new JSONObject().put("volume", value);
    }

    public synchronized JSONObject status() throws JSONException {
        Result<Boolean> power = readTwice(this::getPower);
        Result<String> input = readTwice(this::getInput);
        Result<Integer> volume = readTwice(this::getVolume);
        Map<String, String> errors = new LinkedHashMap<>();
        if (power.error != null) errors.put("power", power.error);
        if (input.error != null) errors.put("input", input.error);
        if (volume.error != null) errors.put("volume", volume.error);
        boolean connected = power.value != null || input.value != null || volume.value != null;
        boolean standby = Boolean.FALSE.equals(power.value) && input.value == null && volume.value == null;
        JSONObject result = new JSONObject();
        result.put("power", power.value == null ? JSONObject.NULL : power.value ? "on" : "off");
        result.put("input", input.value == null ? JSONObject.NULL : input.value);
        result.put("volume", volume.value == null ? JSONObject.NULL : volume.value);
        result.put("connection", connected ? (standby ? "standby" : "connected") : "timeout");
        result.put("partial", !errors.isEmpty());
        result.put("errors", new JSONObject(errors));
        result.put("retryCount", 2);
        return result;
    }

    private int query(int command) throws DisplayException {
        return exchange(SamsungMdcProtocol.buildGet(command, displayId), command).value();
    }

    private void setAndVerify(int command, int expected, int delayMs) throws DisplayException, InterruptedException {
        SamsungMdcProtocol.Response acknowledgement = exchange(
                SamsungMdcProtocol.buildSet(command, expected, displayId), command);
        if (acknowledgement.value() != expected) {
            throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE,
                    String.format("MDC ACK 값 불일치: expected 0x%02X, received 0x%02X.", expected, acknowledgement.value()));
        }
        Thread.sleep(delayMs);
        int actual = query(command);
        if (actual != expected) {
            throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE,
                    String.format("TV 상태 검증 실패: expected 0x%02X, received 0x%02X.", expected, actual));
        }
    }

    private SamsungMdcProtocol.Response exchange(byte[] request, int expectedCommand) throws DisplayException {
        if (!transport.isOpen()) transport.open();
        transport.discardInput();
        transport.write(request);

        byte[] prefix = new byte[4];
        readHeader(prefix);
        int dataLength = prefix[3] & 0xFF;
        if (dataLength < 3 || dataLength > 64) {
            throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE, "비정상 MDC 응답 길이: " + dataLength);
        }
        byte[] response = new byte[5 + dataLength];
        System.arraycopy(prefix, 0, response, 0, prefix.length);
        readExactly(response, 4, response.length - 4);
        return SamsungMdcProtocol.parseResponse(response, expectedCommand, displayId);
    }

    private void readHeader(byte[] prefix) throws DisplayException {
        byte[] one = new byte[1];
        int skipped = 0;
        while (skipped < 32) {
            readExactly(one, 0, 1);
            if ((one[0] & 0xFF) == SamsungMdcProtocol.HEADER) {
                prefix[0] = one[0];
                readExactly(prefix, 1, 3);
                return;
            }
            skipped++;
        }
        throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE, "MDC 응답 Header 0xAA를 찾지 못했습니다.");
    }

    private void readExactly(byte[] destination, int offset, int length) throws DisplayException {
        int total = 0;
        while (total < length) {
            int read = transport.read(destination, offset + total, length - total, RESPONSE_TIMEOUT_MS);
            if (read <= 0) {
                throw new DisplayException(DisplayErrorCode.NO_DISPLAY_RESPONSE,
                        transport.name() + "에서 완전한 MDC 응답을 받지 못했습니다.");
            }
            total += read;
        }
    }

    private <T> Result<T> readTwice(CheckedSupplier<T> supplier) {
        Exception last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try { return new Result<>(supplier.get(), null); }
            catch (Exception error) {
                last = error;
                if (attempt == 0) try { Thread.sleep(150); } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return new Result<>(null, "조회 중단");
                }
            }
        }
        return new Result<>(null, last == null ? "응답 없음" : last.getMessage());
    }

    @Override public void close() { transport.close(); }

    private interface CheckedSupplier<T> { T get() throws Exception; }
    private record Result<T>(T value, String error) {}
}
