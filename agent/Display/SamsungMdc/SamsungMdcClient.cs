using Funnet.Gwanak.Agent.Display.Serial;

namespace Funnet.Gwanak.Agent.Display.SamsungMdc;

internal sealed class SamsungMdcClient(ISerialTransport transport, byte displayId = SamsungMdcProtocol.DefaultDisplayId)
    : IAsyncDisposable
{
    private static readonly TimeSpan ResponseTimeout = TimeSpan.FromMilliseconds(1500);
    private readonly SemaphoreSlim _exchangeLock = new(1, 1);

    public async Task<SamsungPowerState> GetPowerAsync(CancellationToken cancellationToken)
    {
        var value = await QueryAsync(SamsungMdcCommand.Power, cancellationToken);
        return value switch
        {
            (byte)SamsungPowerState.Off => SamsungPowerState.Off,
            (byte)SamsungPowerState.On => SamsungPowerState.On,
            _ => throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse,
                $"Unknown Samsung power value 0x{value:X2}.")
        };
    }

    public async Task<SamsungInput> GetInputAsync(CancellationToken cancellationToken)
    {
        var value = await QueryAsync(SamsungMdcCommand.InputSource, cancellationToken);
        return value switch
        {
            (byte)SamsungInput.Hdmi1 => SamsungInput.Hdmi1,
            (byte)SamsungInput.Hdmi2 => SamsungInput.Hdmi2,
            _ => throw new DisplayControlException(DisplayErrorCode.UnsupportedCommand,
                $"Current Samsung input 0x{value:X2} is outside the P2 HDMI1/HDMI2 scope.")
        };
    }

    public async Task<int> GetVolumeAsync(CancellationToken cancellationToken)
    {
        var value = await QueryAsync(SamsungMdcCommand.Volume, cancellationToken);
        return value <= 100
            ? value
            : throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse,
                $"Samsung volume response {value} is outside 0-100.");
    }

    public Task SetPowerAsync(SamsungPowerState state, CancellationToken cancellationToken) =>
        SetAndVerifyAsync(SamsungMdcCommand.Power, (byte)state,
            async token => (byte)await GetPowerAsync(token), cancellationToken);

    public Task SetInputAsync(SamsungInput input, CancellationToken cancellationToken) =>
        SetAndVerifyAsync(SamsungMdcCommand.InputSource, (byte)input,
            async token => (byte)await GetInputAsync(token), cancellationToken);

    public Task SetVolumeAsync(int value, CancellationToken cancellationToken)
    {
        ValidatePercentage(value, nameof(value));
        return SetAndVerifyAsync(SamsungMdcCommand.Volume, (byte)value,
            async token => (byte)await GetVolumeAsync(token), cancellationToken);
    }

    public Task<int> GetBrightnessAsync(CancellationToken cancellationToken) =>
        throw BrightnessUnsupported();

    public Task SetBrightnessAsync(int value, CancellationToken cancellationToken)
    {
        ValidatePercentage(value, nameof(value));
        throw BrightnessUnsupported();
    }

    private static DisplayControlException BrightnessUnsupported() => new(
        DisplayErrorCode.UnsupportedCommand,
        "Brightness command 0x25 is not documented for QE75T in Samsung manual BN81-19339A-04 and is disabled until official or hardware confirmation.");

    private async Task<byte> QueryAsync(SamsungMdcCommand command, CancellationToken cancellationToken)
    {
        var response = await ExchangeAsync(SamsungMdcProtocol.BuildGet(command, displayId), command, cancellationToken);
        return response.Value;
    }

    private async Task SetAndVerifyAsync(SamsungMdcCommand command, byte expected,
        Func<CancellationToken, Task<byte>> readState, CancellationToken cancellationToken)
    {
        var acknowledgement = await ExchangeAsync(
            SamsungMdcProtocol.BuildSet(command, expected, displayId), command, cancellationToken);
        if (acknowledgement.Value != expected)
            throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse,
                $"Samsung MDC ACK value mismatch for 0x{(byte)command:X2}: expected 0x{expected:X2}, received 0x{acknowledgement.Value:X2}.");

        await Task.Delay(command == SamsungMdcCommand.Power ? 1500 : 250, cancellationToken);
        var actual = await readState(cancellationToken);
        if (actual != expected)
            throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse,
                $"Samsung display state verification failed for 0x{(byte)command:X2}: expected 0x{expected:X2}, received 0x{actual:X2}.");
    }

    private async Task<SamsungMdcResponse> ExchangeAsync(byte[] request, SamsungMdcCommand expectedCommand,
        CancellationToken cancellationToken)
    {
        await _exchangeLock.WaitAsync(cancellationToken);
        try
        {
            if (!transport.IsOpen) await transport.OpenAsync(cancellationToken);
            transport.DiscardInput();
            await transport.WriteAsync(request, cancellationToken);

            var prefix = new byte[4];
            await ReadExactlyAsync(prefix, cancellationToken);
            var response = new byte[5 + prefix[3]];
            prefix.CopyTo(response, 0);
            await ReadExactlyAsync(response.AsMemory(4), cancellationToken);
            return SamsungMdcProtocol.ParseResponse(response, expectedCommand, displayId);
        }
        finally
        {
            _exchangeLock.Release();
        }
    }

    private async Task ReadExactlyAsync(Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await transport.ReadAsync(buffer[offset..], ResponseTimeout, cancellationToken);
            if (read <= 0)
                throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse,
                    $"{transport.PortName} returned an incomplete Samsung MDC response.");
            offset += read;
        }
    }

    private static void ValidatePercentage(int value, string parameterName)
    {
        if (value is < 0 or > 100) throw new ArgumentOutOfRangeException(parameterName, "Value must be between 0 and 100.");
    }

    public async ValueTask DisposeAsync()
    {
        _exchangeLock.Dispose();
        await transport.DisposeAsync();
    }
}
