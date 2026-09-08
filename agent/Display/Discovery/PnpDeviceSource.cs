using System.Management;

namespace Funnet.Gwanak.Agent.Display.Discovery;

internal sealed record PnpDeviceRecord(
    string Name,
    string Description,
    string Manufacturer,
    string PnpDeviceId,
    string Status,
    uint? ConfigManagerErrorCode,
    string Service);

internal interface IPnpDeviceSource
{
    IReadOnlyList<PnpDeviceRecord> Enumerate();
}

internal sealed class WindowsPnpDeviceSource : IPnpDeviceSource
{
    public IReadOnlyList<PnpDeviceRecord> Enumerate()
    {
        using var searcher = new ManagementObjectSearcher(
            "SELECT Name, Description, Manufacturer, PNPDeviceID, Status, ConfigManagerErrorCode, Service FROM Win32_PnPEntity");
        using var results = searcher.Get();
        var devices = new List<PnpDeviceRecord>();
        foreach (ManagementObject item in results)
        {
            using (item)
            {
                devices.Add(new PnpDeviceRecord(
                    Text(item, "Name"),
                    Text(item, "Description"),
                    Text(item, "Manufacturer"),
                    Text(item, "PNPDeviceID"),
                    Text(item, "Status"),
                    Number(item, "ConfigManagerErrorCode"),
                    Text(item, "Service")));
            }
        }
        return devices;
    }

    private static string Text(ManagementBaseObject value, string property) =>
        Convert.ToString(value[property], System.Globalization.CultureInfo.InvariantCulture) ?? "";

    private static uint? Number(ManagementBaseObject value, string property) => value[property] is null
        ? null
        : Convert.ToUInt32(value[property], System.Globalization.CultureInfo.InvariantCulture);
}
