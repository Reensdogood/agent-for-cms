namespace Funnet.Gwanak.Agent.Display.Discovery;

internal enum SerialAdapterDriverStatus
{
    Installed,
    Missing,
    Error,
    DeviceNotDetected,
    Unknown,
}

internal sealed record SerialDeviceInfo(
    string? PortName,
    string DeviceName,
    string Description,
    string Manufacturer,
    string PnpDeviceId,
    string DeviceStatus,
    uint? ProblemCode,
    SerialAdapterDriverStatus DriverStatus,
    bool IsProlificCandidate,
    IReadOnlyList<string> MatchEvidence);

internal sealed record SerialAdapterInventory(
    IReadOnlyList<SerialDeviceInfo> Devices,
    SerialAdapterDriverStatus ProlificDriverStatus);

internal enum SerialPortSelectionSource
{
    Configured,
    ProlificCandidate,
    RecommendedDefault,
    OnlyAvailablePort,
    ConfigurationRequired,
}

internal sealed record SerialPortSelection(
    string? PortName,
    SerialPortSelectionSource Source,
    bool RequiresSamsungProbe,
    bool ConfigurationRequired,
    string? PreviouslyConfiguredPort,
    string Reason);
