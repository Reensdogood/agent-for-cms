using System.IO.Ports;

namespace Funnet.Gwanak.Agent.Display.Serial;

internal sealed record SerialPortConfiguration(
    string PortName,
    int BaudRate,
    int DataBits,
    Parity Parity,
    StopBits StopBits,
    Handshake Handshake)
{
    public static SerialPortConfiguration ForSamsungMdc(string portName)
    {
        if (string.IsNullOrWhiteSpace(portName))
            throw new ArgumentException("COM 포트 이름이 필요합니다.", nameof(portName));

        return new SerialPortConfiguration(
            portName.Trim(),
            9600,
            8,
            Parity.None,
            StopBits.One,
            Handshake.None);
    }
}
