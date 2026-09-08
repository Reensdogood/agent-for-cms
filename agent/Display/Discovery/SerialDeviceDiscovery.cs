using System.Text.RegularExpressions;

namespace Funnet.Gwanak.Agent.Display.Discovery;

internal sealed partial class SerialDeviceDiscovery(IPnpDeviceSource source)
{
    private const uint DriverNotInstalledProblemCode = 28;

    public SerialAdapterInventory Discover()
    {
        var devices = source.Enumerate()
            .Select(ToSerialDevice)
            .Where(device => device.PortName is not null || device.IsProlificCandidate)
            .OrderBy(device => PortNumber(device.PortName))
            .ThenBy(device => device.DeviceName, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var candidates = devices.Where(device => device.IsProlificCandidate).ToList();
        var overall = candidates.Count == 0
            ? SerialAdapterDriverStatus.DeviceNotDetected
            : candidates.Any(device => device.DriverStatus == SerialAdapterDriverStatus.Installed)
                ? SerialAdapterDriverStatus.Installed
                : candidates.Any(device => device.DriverStatus == SerialAdapterDriverStatus.Missing)
                    ? SerialAdapterDriverStatus.Missing
                    : candidates.Any(device => device.DriverStatus == SerialAdapterDriverStatus.Error)
                        ? SerialAdapterDriverStatus.Error
                        : SerialAdapterDriverStatus.Unknown;
        return new SerialAdapterInventory(devices, overall);
    }

    private static SerialDeviceInfo ToSerialDevice(PnpDeviceRecord device)
    {
        var combined = string.Join(" ", device.Name, device.Description, device.Manufacturer, device.PnpDeviceId);
        var evidence = new List<string>();
        if (device.PnpDeviceId.Contains("VID_067B", StringComparison.OrdinalIgnoreCase)) evidence.Add("prolific-usb-vendor-id");
        if (combined.Contains("NEXT-340PL", StringComparison.OrdinalIgnoreCase)) evidence.Add("next-340pl-product");
        if (combined.Contains("Prolific", StringComparison.OrdinalIgnoreCase)) evidence.Add("prolific-brand");
        if (combined.Contains("PL2303", StringComparison.OrdinalIgnoreCase) ||
            combined.Contains("PL23XX", StringComparison.OrdinalIgnoreCase)) evidence.Add("pl23xx-chip-family");
        if ((combined.Contains("USB", StringComparison.OrdinalIgnoreCase) && combined.Contains("Serial", StringComparison.OrdinalIgnoreCase)) ||
            combined.Contains("USB-to-Serial", StringComparison.OrdinalIgnoreCase)) evidence.Add("usb-serial-class");

        var candidate = evidence.Contains("prolific-usb-vendor-id") || evidence.Distinct().Count() >= 2;
        var port = PortNameRegex().Match(device.Name) is { Success: true } match
            ? match.Groups[1].Value.ToUpperInvariant()
            : null;
        var driverStatus = !candidate
            ? SerialAdapterDriverStatus.Unknown
            : device.ConfigManagerErrorCode == DriverNotInstalledProblemCode
                ? SerialAdapterDriverStatus.Missing
                : device.ConfigManagerErrorCode is > 0
                    ? SerialAdapterDriverStatus.Error
                    : port is not null && device.Status.Equals("OK", StringComparison.OrdinalIgnoreCase)
                        ? SerialAdapterDriverStatus.Installed
                        : SerialAdapterDriverStatus.Unknown;

        return new SerialDeviceInfo(
            port,
            device.Name,
            device.Description,
            device.Manufacturer,
            device.PnpDeviceId,
            device.Status,
            device.ConfigManagerErrorCode,
            driverStatus,
            candidate,
            evidence.Distinct().ToArray());
    }

    private static int PortNumber(string? portName) => portName is not null &&
                                                       int.TryParse(portName.AsSpan(3), out var value)
        ? value
        : int.MaxValue;

    [GeneratedRegex(@"\((COM\d+)\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PortNameRegex();
}
