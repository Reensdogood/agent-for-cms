namespace Funnet.Gwanak.Agent.Display.SamsungMdc;

internal enum SamsungMdcCommand : byte
{
    Power = 0x11,
    Volume = 0x12,
    InputSource = 0x14,
}

internal enum SamsungPowerState : byte
{
    Off = 0x00,
    On = 0x01,
}

internal enum SamsungInput : byte
{
    Hdmi1 = 0x21,
    Hdmi2 = 0x23,
}

internal sealed record SamsungMdcResponse(
    byte DisplayId,
    SamsungMdcCommand Command,
    byte Value,
    bool Acknowledged);

internal static class SamsungMdcProtocol
{
    public const byte Header = 0xAA;
    public const byte ResponseCommand = 0xFF;
    public const byte DefaultDisplayId = 0x00;
    private const byte Acknowledged = 0x41;
    private const byte NotAcknowledged = 0x4E;

    public static byte[] BuildGet(SamsungMdcCommand command, byte displayId = DefaultDisplayId) =>
        Build(command, displayId, []);

    public static byte[] BuildSet(SamsungMdcCommand command, byte value, byte displayId = DefaultDisplayId) =>
        Build(command, displayId, [value]);

    public static byte CalculateChecksum(ReadOnlySpan<byte> packetWithoutChecksum)
    {
        if (packetWithoutChecksum.Length == 0 || packetWithoutChecksum[0] != Header)
            throw new ArgumentException("Samsung MDC packet must begin with 0xAA.", nameof(packetWithoutChecksum));
        var sum = 0;
        for (var index = 1; index < packetWithoutChecksum.Length; index++) sum += packetWithoutChecksum[index];
        return unchecked((byte)sum);
    }

    public static SamsungMdcResponse ParseResponse(ReadOnlySpan<byte> packet,
        SamsungMdcCommand expectedCommand, byte expectedDisplayId = DefaultDisplayId)
    {
        if (packet.Length < 8 || packet[0] != Header || packet[1] != ResponseCommand)
            throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse, "Samsung MDC 응답 형식이 올바르지 않습니다.");
        var dataLength = packet[3];
        if (dataLength < 3 || packet.Length != dataLength + 5)
            throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse, "Samsung MDC 응답 길이가 올바르지 않습니다.");
        var expectedChecksum = CalculateChecksum(packet[..^1]);
        if (packet[^1] != expectedChecksum)
            throw new DisplayControlException(DisplayErrorCode.ChecksumError,
                $"Samsung MDC checksum mismatch: expected 0x{expectedChecksum:X2}, received 0x{packet[^1]:X2}.");
        if (packet[2] != expectedDisplayId)
            throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse,
                $"Samsung MDC display ID mismatch: expected 0x{expectedDisplayId:X2}, received 0x{packet[2]:X2}.");
        if (packet[5] != (byte)expectedCommand)
            throw new DisplayControlException(DisplayErrorCode.UnsupportedCommand,
                $"Samsung MDC response command mismatch: expected 0x{(byte)expectedCommand:X2}, received 0x{packet[5]:X2}.");

        if (packet[4] == NotAcknowledged)
            throw new DisplayControlException(DisplayErrorCode.NakReceived,
                $"Samsung MDC NAK received for 0x{packet[5]:X2}; error 0x{packet[6]:X2}.");
        if (packet[4] != Acknowledged)
            throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse,
                $"Unknown Samsung MDC response marker 0x{packet[4]:X2}.");

        return new SamsungMdcResponse(packet[2], expectedCommand, packet[6], true);
    }

    private static byte[] Build(SamsungMdcCommand command, byte displayId, ReadOnlySpan<byte> data)
    {
        if (displayId == 0xFE)
            throw new ArgumentOutOfRangeException(nameof(displayId), "Broadcast ID does not return ACK and is not allowed by the Agent.");
        var packet = new byte[5 + data.Length];
        packet[0] = Header;
        packet[1] = (byte)command;
        packet[2] = displayId;
        packet[3] = checked((byte)data.Length);
        data.CopyTo(packet.AsSpan(4));
        packet[^1] = CalculateChecksum(packet.AsSpan(0, packet.Length - 1));
        return packet;
    }
}
