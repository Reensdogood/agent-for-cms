package kr.funnet.tvcontroller.display;

public final class DisplayException extends Exception {
    private final DisplayErrorCode code;

    public DisplayException(DisplayErrorCode code, String message) {
        super(message);
        this.code = code;
    }

    public DisplayException(DisplayErrorCode code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public DisplayErrorCode code() { return code; }
}
