using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
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
            Display = new DisplayHealth(_settings.Display.Enabled, _settings.Display.Vendor, _settings.Display.Model, _settings.Display.Port)
        };
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
