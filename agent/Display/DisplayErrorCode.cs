namespace Funnet.Gwanak.Agent.Display;

internal enum DisplayErrorCode
{
    DriverMissing,
    DeviceNotFound,
    PortNotFound,
    PortBusy,
    PortOpenFailed,
    NoDisplayResponse,
    ChecksumError,
    NakReceived,
    Timeout,
    UnsupportedCommand,
}

internal sealed class DisplayControlException : Exception
{
    public DisplayControlException(DisplayErrorCode code, string message, Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
    }

    public DisplayErrorCode Code { get; }
}
