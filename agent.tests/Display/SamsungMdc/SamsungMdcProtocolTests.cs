using Funnet.Gwanak.Agent.Display;
using Funnet.Gwanak.Agent.Display.SamsungMdc;
using Xunit;

namespace Funnet.Gwanak.Agent.Tests.Display.SamsungMdc;

public sealed class SamsungMdcProtocolTests
{
    [Fact]
    public void ChecksumExcludesHeaderAndKeepsLowEightBits()
    {
        Assert.Equal(0x12, SamsungMdcProtocol.CalculateChecksum([0xAA, 0x11, 0xFF, 0x01, 0x01]));
    }

    [Fact]
    public void BuildsPowerPackets()
    {
        Assert.Equal([0xAA, 0x11, 0x00, 0x00, 0x11],
            SamsungMdcProtocol.BuildGet(SamsungMdcCommand.Power));
        Assert.Equal([0xAA, 0x11, 0x00, 0x01, 0x01, 0x13],
            SamsungMdcProtocol.BuildSet(SamsungMdcCommand.Power, (byte)SamsungPowerState.On));
        Assert.Equal([0xAA, 0x11, 0x00, 0x01, 0x00, 0x12],
            SamsungMdcProtocol.BuildSet(SamsungMdcCommand.Power, (byte)SamsungPowerState.Off));
    }

    [Fact]
    public void BuildsHdmiPacketsFromNamedValues()
    {
        Assert.Equal([0xAA, 0x14, 0x00, 0x01, 0x21, 0x36],
            SamsungMdcProtocol.BuildSet(SamsungMdcCommand.InputSource, (byte)SamsungInput.Hdmi1));
        Assert.Equal([0xAA, 0x14, 0x00, 0x01, 0x23, 0x38],
            SamsungMdcProtocol.BuildSet(SamsungMdcCommand.InputSource, (byte)SamsungInput.Hdmi2));
        Assert.Equal([0xAA, 0x14, 0x00, 0x01, 0x31, 0x46],
            SamsungMdcProtocol.BuildSet(SamsungMdcCommand.InputSource, (byte)SamsungInput.Hdmi3));
    }

    [Fact]
    public void BuildsVolumePacket()
    {
        Assert.Equal([0xAA, 0x12, 0x00, 0x01, 0x1E, 0x31],
            SamsungMdcProtocol.BuildSet(SamsungMdcCommand.Volume, 30));
    }

    [Fact]
    public void ParsesAcknowledgement()
    {
        var response = SamsungMdcProtocol.ParseResponse(
            [0xAA, 0xFF, 0x00, 0x03, 0x41, 0x11, 0x01, 0x55], SamsungMdcCommand.Power);

        Assert.True(response.Acknowledged);
        Assert.Equal(1, response.Value);
    }

    [Fact]
    public void ParsesNakAsSpecificFailure()
    {
        var exception = Assert.Throws<DisplayControlException>(() => SamsungMdcProtocol.ParseResponse(
            [0xAA, 0xFF, 0x00, 0x03, 0x4E, 0x11, 0x01, 0x62], SamsungMdcCommand.Power));

        Assert.Equal(DisplayErrorCode.NakReceived, exception.Code);
        Assert.Contains("error 0x01", exception.Message);
    }

    [Fact]
    public void RejectsInvalidChecksum()
    {
        var exception = Assert.Throws<DisplayControlException>(() => SamsungMdcProtocol.ParseResponse(
            [0xAA, 0xFF, 0x00, 0x03, 0x41, 0x11, 0x01, 0x00], SamsungMdcCommand.Power));

        Assert.Equal(DisplayErrorCode.ChecksumError, exception.Code);
    }

    [Fact]
    public void BroadcastIdIsRejectedBecauseItCannotAcknowledge()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            SamsungMdcProtocol.BuildGet(SamsungMdcCommand.Power, 0xFE));
    }
}
