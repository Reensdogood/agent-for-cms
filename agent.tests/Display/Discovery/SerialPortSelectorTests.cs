using Funnet.Gwanak.Agent.Display.Discovery;
using Xunit;

namespace Funnet.Gwanak.Agent.Tests.Display.Discovery;

public sealed class SerialPortSelectorTests
{
    [Fact]
    public void ExistingConfiguredPortHasFirstPriority()
    {
        var selected = SerialPortSelector.Select([Port("COM4", false), Port("COM5", true)], "COM4");
        Assert.Equal("COM4", selected.PortName);
        Assert.Equal(SerialPortSelectionSource.Configured, selected.Source);
        Assert.True(selected.RequiresSamsungProbe);
    }

    [Fact]
    public void SingleProlificCandidateBeatsRecommendedDefault()
    {
        var selected = SerialPortSelector.Select([Port("COM3", false), Port("COM5", true)], null);
        Assert.Equal("COM5", selected.PortName);
        Assert.Equal(SerialPortSelectionSource.ProlificCandidate, selected.Source);
    }

    [Fact]
    public void MultipleProlificCandidatesRequireConfiguration()
    {
        var selected = SerialPortSelector.Select([Port("COM4", true), Port("COM5", true)], null);
        Assert.True(selected.ConfigurationRequired);
        Assert.Null(selected.PortName);
    }

    [Fact]
    public void Com3IsOnlyAProbeCandidateNotAHardcodedSelection()
    {
        var selected = SerialPortSelector.Select([Port("COM3", false), Port("COM7", false)], null);
        Assert.Equal("COM3", selected.PortName);
        Assert.Equal(SerialPortSelectionSource.RecommendedDefault, selected.Source);
        Assert.True(selected.RequiresSamsungProbe);

        var missing = SerialPortSelector.Select([], null);
        Assert.Null(missing.PortName);
        Assert.True(missing.ConfigurationRequired);
    }

    private static SerialDeviceInfo Port(string portName, bool prolific) => new(
        portName, $"Device ({portName})", "Serial", prolific ? "Prolific" : "Generic",
        prolific ? @"USB\VID_067B" : @"ACPI\PNP0501", "OK", 0,
        prolific ? SerialAdapterDriverStatus.Installed : SerialAdapterDriverStatus.Unknown,
        prolific, prolific ? ["prolific-usb-vendor-id"] : []);
}
