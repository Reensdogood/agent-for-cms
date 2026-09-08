using Funnet.Gwanak.Agent.Display.Serial;

namespace Funnet.Gwanak.Agent.Tests.Display.Serial;

internal sealed class FakeSerialTransport(string portName) : ISerialTransport
{
    private readonly Queue<byte> _received = new();
    private readonly Queue<byte[]> _responses = new();
    public List<byte[]> Writes { get; } = [];
    public Exception? ReadException { get; set; }
    public string PortName { get; } = portName;
    public bool IsOpen { get; private set; }

    public void QueueResponse(params byte[] response)
    {
        _responses.Enqueue(response);
    }

    public ValueTask OpenAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IsOpen = true;
        return ValueTask.CompletedTask;
    }

    public void DiscardInput() => _received.Clear();

    public ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Writes.Add(data.ToArray());
        if (_responses.TryDequeue(out var response))
            foreach (var value in response) _received.Enqueue(value);
        return ValueTask.CompletedTask;
    }

    public ValueTask<int> ReadAsync(Memory<byte> buffer, TimeSpan timeout, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (ReadException is not null) throw ReadException;
        var count = Math.Min(buffer.Length, _received.Count);
        for (var index = 0; index < count; index++) buffer.Span[index] = _received.Dequeue();
        return ValueTask.FromResult(count);
    }

    public ValueTask DisposeAsync()
    {
        IsOpen = false;
        return ValueTask.CompletedTask;
    }
}
