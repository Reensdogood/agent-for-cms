namespace Funnet.Gwanak.Agent.Display.Serial;

internal interface ISerialTransport : IAsyncDisposable
{
    string PortName { get; }
    bool IsOpen { get; }
    ValueTask OpenAsync(CancellationToken cancellationToken);
    void DiscardInput();
    ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken);
    ValueTask<int> ReadAsync(Memory<byte> buffer, TimeSpan timeout, CancellationToken cancellationToken);
}

internal interface ISerialTransportFactory
{
    ISerialTransport Create(SerialPortConfiguration configuration);
}
