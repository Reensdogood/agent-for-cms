namespace Funnet.Gwanak.Agent.Models;

internal sealed record UmeInstallation(
    string Name,
    string Version,
    string Path,
    bool Running);

internal sealed record HealthPayload(
    string InstallationId,
    string LocalName,
    string MachineName,
    string AgentVersion,
    string OsVersion,
    DateTimeOffset Timestamp,
    string? ForegroundApp,
    bool IvisionRunning,
    UmeInstallation? Ume,
    IReadOnlyList<UmeInstallation> InstalledUmeVersions)
{
    public DisplayHealth Display { get; init; } = new(false, null, null, null);
}

internal sealed record DisplayHealth(bool Enabled, string? Vendor, string? Model, string? Port);
