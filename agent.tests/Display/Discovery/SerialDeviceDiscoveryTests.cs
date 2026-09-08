using Funnet.Gwanak.Agent.Display.Discovery;
using Xunit;

namespace Funnet.Gwanak.Agent.Tests.Display.Discovery;

public sealed class SerialDeviceDiscoveryTests
{
    [Fact]
    public void DetectsPl23xxUsingMultipleDeviceSignals()
    {
        var source = new FakePnpDeviceSource(new PnpDeviceRecord(
            "Prolific USB-to-Serial Comm Port (COM5)", "USB Serial Port", "Prolific Technology Inc.",
            @"USB\VID_067B&PID_23A3\ABC", "OK", 0, "Ser2pl64"));

        var inventory = new SerialDeviceDiscovery(source).Discover();

        var device = Assert.Single(inventory.Devices);
        Assert.True(device.IsProlificCandidate);
        Assert.Equal("COM5", device.PortName);
        Assert.Equal(SerialAdapterDriverStatus.Installed, device.DriverStatus);
        Assert.Contains("prolific-usb-vendor-id", device.MatchEvidence);
        Assert.Contains("prolific-brand", device.MatchEvidence);
        Assert.Equal(SerialAdapterDriverStatus.Installed, inventory.ProlificDriverStatus);
    }

    [Fact]
    public void ReportsDriverMissingWithoutInventingAComPort()
    {
        var source = new FakePnpDeviceSource(new PnpDeviceRecord(
            "Prolific PL2303 USB-to-Serial Controller", "PL23XX USB Serial", "Prolific",
            @"USB\VID_067B&PID_2303\MISSING", "Error", 28, ""));

        var inventory = new SerialDeviceDiscovery(source).Discover();

        var device = Assert.Single(inventory.Devices);
        Assert.Null(device.PortName);
        Assert.Equal(SerialAdapterDriverStatus.Missing, device.DriverStatus);
        Assert.Equal(SerialAdapterDriverStatus.Missing, inventory.ProlificDriverStatus);
    }

    [Fact]
    public void DoesNotIdentifyADeviceFromOnlyOneGenericString()
    {
        var source = new FakePnpDeviceSource(new PnpDeviceRecord(
            "Generic USB Device (COM8)", "Communications Port", "Generic", @"USB\VID_1234&PID_5678", "OK", 0, "usbser"));

        var device = Assert.Single(new SerialDeviceDiscovery(source).Discover().Devices);

        Assert.False(device.IsProlificCandidate);
        Assert.Equal(SerialAdapterDriverStatus.DeviceNotDetected,
            new SerialDeviceDiscovery(source).Discover().ProlificDriverStatus);
    }

    private sealed class FakePnpDeviceSource(params PnpDeviceRecord[] devices) : IPnpDeviceSource
    {
        public IReadOnlyList<PnpDeviceRecord> Enumerate() => devices;
    }
}
