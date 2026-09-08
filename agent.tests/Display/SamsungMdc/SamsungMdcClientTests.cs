using Funnet.Gwanak.Agent.Display;
using Funnet.Gwanak.Agent.Display.SamsungMdc;
using Funnet.Gwanak.Agent.Tests.Display.Serial;
using Xunit;

namespace Funnet.Gwanak.Agent.Tests.Display.SamsungMdc;

public sealed class SamsungMdcClientTests
{
    [Fact]
    public async Task QueryPowerWritesGetPacketAndParsesAck()
    {
        var transport = new FakeSerialTransport("COM5");
        transport.QueueResponse(0xAA, 0xFF, 0x00, 0x03, 0x41, 0x11, 0x01, 0x55);
        await using var client = new SamsungMdcClient(transport);

        var state = await client.GetPowerAsync(CancellationToken.None);

        Assert.Equal(SamsungPowerState.On, state);
        Assert.Equal([0xAA, 0x11, 0x00, 0x00, 0x11], Assert.Single(transport.Writes));
    }

    [Fact]
    public async Task SetVolumeRequiresAckAndReadBackVerification()
    {
        var transport = new FakeSerialTransport("COM5");
        transport.QueueResponse(0xAA, 0xFF, 0x00, 0x03, 0x41, 0x12, 0x1E, 0x73);
        transport.QueueResponse(0xAA, 0xFF, 0x00, 0x03, 0x41, 0x12, 0x1E, 0x73);
        await using var client = new SamsungMdcClient(transport);

        await client.SetVolumeAsync(30, CancellationToken.None);

        Assert.Equal(2, transport.Writes.Count);
        Assert.Equal([0xAA, 0x12, 0x00, 0x01, 0x1E, 0x31], transport.Writes[0]);
        Assert.Equal([0xAA, 0x12, 0x00, 0x00, 0x12], transport.Writes[1]);
    }

    [Fact]
    public async Task SetFailsWhenReadBackDoesNotMatch()
    {
        var transport = new FakeSerialTransport("COM5");
        transport.QueueResponse(0xAA, 0xFF, 0x00, 0x03, 0x41, 0x12, 0x1E, 0x73);
        transport.QueueResponse(0xAA, 0xFF, 0x00, 0x03, 0x41, 0x12, 0x1D, 0x72);
        await using var client = new SamsungMdcClient(transport);

        var error = await Assert.ThrowsAsync<DisplayControlException>(() =>
            client.SetVolumeAsync(30, CancellationToken.None));

        Assert.Equal(DisplayErrorCode.NoDisplayResponse, error.Code);
        Assert.Contains("verification failed", error.Message);
    }

    [Fact]
    public async Task IncompleteResponseIsNotReportedAsSuccess()
    {
        var transport = new FakeSerialTransport("COM5");
        await using var client = new SamsungMdcClient(transport);

        var error = await Assert.ThrowsAsync<DisplayControlException>(() => client.GetPowerAsync(CancellationToken.None));

        Assert.Equal(DisplayErrorCode.NoDisplayResponse, error.Code);
    }

    [Fact]
    public async Task SerialTimeoutRemainsASpecificTimeoutFailure()
    {
        var transport = new FakeSerialTransport("COM5")
        {
            ReadException = new DisplayControlException(DisplayErrorCode.Timeout, "test timeout")
        };
        await using var client = new SamsungMdcClient(transport);

        var error = await Assert.ThrowsAsync<DisplayControlException>(() => client.GetPowerAsync(CancellationToken.None));

        Assert.Equal(DisplayErrorCode.Timeout, error.Code);
    }

    [Fact]
    public async Task BrightnessIsExplicitlyUnsupportedUntilQe75tConfirmation()
    {
        var transport = new FakeSerialTransport("COM5");
        await using var client = new SamsungMdcClient(transport);

        var error = await Assert.ThrowsAsync<DisplayControlException>(() => client.GetBrightnessAsync(CancellationToken.None));

        Assert.Equal(DisplayErrorCode.UnsupportedCommand, error.Code);
        Assert.Empty(transport.Writes);
    }
}
