using System.IO.Ports;

namespace Funnet.Gwanak.Agent.Display.Serial;

internal sealed class WindowsSerialTransportFactory : ISerialTransportFactory
{
    public ISerialTransport Create(SerialPortConfiguration configuration) => new WindowsSerialTransport(configuration);
}

internal sealed class WindowsSerialTransport : ISerialTransport
{
    private readonly SerialPort _port;

    public WindowsSerialTransport(SerialPortConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        _port = new SerialPort(
            configuration.PortName,
            configuration.BaudRate,
            configuration.Parity,
            configuration.DataBits,
            configuration.StopBits)
        {
            Handshake = configuration.Handshake,
            DtrEnable = false,
            RtsEnable = false,
            ReadTimeout = Timeout.Infinite,
            WriteTimeout = 2_000,
        };
    }

    public string PortName => _port.PortName;
    public bool IsOpen => _port.IsOpen;

    public ValueTask OpenAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            _port.Open();
            return ValueTask.CompletedTask;
        }
        catch (UnauthorizedAccessException exception)
        {
            throw new DisplayControlException(DisplayErrorCode.PortBusy,
                $"{PortName} 포트를 다른 프로세스가 사용 중이거나 접근할 수 없습니다.", exception);
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException or ArgumentException)
        {
            throw new DisplayControlException(DisplayErrorCode.PortOpenFailed,
                $"{PortName} 포트를 열 수 없습니다.", exception);
        }
    }

    public void DiscardInput()
    {
        EnsureOpen();
        _port.DiscardInBuffer();
    }

    public async ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
    {
        EnsureOpen();
        try
        {
            await _port.BaseStream.WriteAsync(data, cancellationToken);
            await _port.BaseStream.FlushAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is IOException or TimeoutException or InvalidOperationException)
        {
            throw new DisplayControlException(DisplayErrorCode.PortOpenFailed,
                $"{PortName} 포트에 데이터를 쓸 수 없습니다.", exception);
        }
    }

    public async ValueTask<int> ReadAsync(Memory<byte> buffer, TimeSpan timeout, CancellationToken cancellationToken)
    {
        EnsureOpen();
        if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
        try
        {
            var readTask = _port.BaseStream.ReadAsync(buffer, cancellationToken).AsTask();
            var completed = await Task.WhenAny(readTask, Task.Delay(timeout, cancellationToken));
            if (completed != readTask)
                throw new DisplayControlException(DisplayErrorCode.Timeout,
                    $"{PortName} 포트 응답 시간이 초과되었습니다.");
            return await readTask;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException)
        {
            throw new DisplayControlException(DisplayErrorCode.PortOpenFailed,
                $"{PortName} 포트에서 데이터를 읽을 수 없습니다.", exception);
        }
    }

    private void EnsureOpen()
    {
        if (!_port.IsOpen)
            throw new DisplayControlException(DisplayErrorCode.PortOpenFailed, $"{PortName} 포트가 열려 있지 않습니다.");
    }

    public ValueTask DisposeAsync()
    {
        if (_port.IsOpen) _port.Close();
        _port.Dispose();
        return ValueTask.CompletedTask;
    }
}
