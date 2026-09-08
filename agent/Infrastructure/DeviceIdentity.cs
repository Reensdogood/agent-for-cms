namespace Funnet.Gwanak.Agent.Infrastructure;

internal sealed class DeviceIdentity
{
    public string InstallationId { get; set; } = Guid.NewGuid().ToString();
    public string? DeviceId { get; set; }
    public string? ProtectedDeviceToken { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.Now;
}
