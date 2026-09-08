using System.IO.Ports;
using Funnet.Gwanak.Agent.Display.Serial;
using Xunit;

namespace Funnet.Gwanak.Agent.Tests.Display.Serial;

public sealed class SerialPortConfigurationTests
{
    [Fact]
    public void SamsungMdcDefaultsUseOfficial9600EightNOneSettings()
    {
        var configuration = SerialPortConfiguration.ForSamsungMdc("COM7");

        Assert.Equal("COM7", configuration.PortName);
        Assert.Equal(9600, configuration.BaudRate);
        Assert.Equal(8, configuration.DataBits);
        Assert.Equal(Parity.None, configuration.Parity);
        Assert.Equal(StopBits.One, configuration.StopBits);
        Assert.Equal(Handshake.None, configuration.Handshake);
    }

    [Fact]
    public void SamsungMdcDefaultsDoNotSelectAComputerSpecificPort()
    {
        Assert.Throws<ArgumentException>(() => SerialPortConfiguration.ForSamsungMdc("  "));
    }
}
