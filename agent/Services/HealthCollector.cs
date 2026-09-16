using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32;
using Funnet.Gwanak.Agent.Infrastructure;
using Funnet.Gwanak.Agent.Models;

namespace Funnet.Gwanak.Agent.Services;

internal sealed class HealthCollector
{
    private readonly AgentSettings _settings;
    private readonly DeviceIdentity _identity;
    private readonly UmeDetector _umeDetector = new();

    public HealthCollector(AgentSettings settings, DeviceIdentity identity)
    {
        _settings = settings;
        _identity = identity;
    }

    public HealthPayload Collect()
    {
        var versions = _umeDetector.DetectAll();
        var os = ReadOsInfo();
        return new HealthPayload(
            _identity.InstallationId,
            _settings.LocalName,
            Environment.MachineName,
            Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.1.0",
            Environment.OSVersion.VersionString,
            DateTimeOffset.Now,
            GetForegroundProcessName(),
            IsProcessRunning("i-Vision.Player") || IsProcessRunning("i-Vision.PlayAgent"),
            versions.FirstOrDefault(),
            versions)
        {
            Display = new DisplayHealth(_settings.Display.Enabled, _settings.Display.Vendor, _settings.Display.Model, _settings.Display.Port),
            OsEdition = os.Edition,
            OsDisplayVersion = os.DisplayVersion,
            OsBuild = os.Build,
            OsRevision = os.Revision,
            AgentElevated = IsAgentElevated()
        };
    }

    private static bool IsAgentElevated()
    {
        try { using var identity = WindowsIdentity.GetCurrent(); return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator); }
        catch { return false; }
    }

    private static (string? Edition, string? DisplayVersion, int? Build, int? Revision) ReadOsInfo()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            if (key is null) return (null, null, null, null);
            var product = key.GetValue("ProductName")?.ToString();
            var edition = key.GetValue("EditionID")?.ToString();
            var displayVersion = key.GetValue("DisplayVersion")?.ToString() ?? key.GetValue("ReleaseId")?.ToString();
            var build = int.TryParse(key.GetValue("CurrentBuildNumber")?.ToString(), out var parsedBuild) ? parsedBuild : (int?)null;
            var revision = int.TryParse(key.GetValue("UBR")?.ToString(), out var parsedRevision) ? parsedRevision : (int?)null;
            var label = string.IsNullOrWhiteSpace(edition) ? product : $"{product} ({edition})";
            return (label, displayVersion, build, revision);
        }
        catch { return (null, null, null, null); }
    }

    private static bool IsProcessRunning(string processName)
    {
        var processes = Process.GetProcessesByName(processName);
        try { return processes.Length > 0; }
        finally { foreach (var process in processes) process.Dispose(); }
    }

    private static string? GetForegroundProcessName()
    {
        try
        {
            var window = GetForegroundWindow();
            if (window == IntPtr.Zero) return null;
            GetWindowThreadProcessId(window, out var processId);
            using var process = Process.GetProcessById((int)processId);
            return process.ProcessName;
        }
        catch { return null; }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
