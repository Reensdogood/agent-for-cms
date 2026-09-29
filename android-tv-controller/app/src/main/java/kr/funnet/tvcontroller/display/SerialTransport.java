package kr.funnet.tvcontroller.display;

public interface SerialTransport extends AutoCloseable {
    void open() throws DisplayException;
    boolean isOpen();
    void discardInput();
    void write(byte[] data) throws DisplayException;
    int read(byte[] destination, int offset, int length, int timeoutMs) throws DisplayException;
    String name();
    @Override void close();
}
