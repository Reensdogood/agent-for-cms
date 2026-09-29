using System.Text.Json;
using Microsoft.Win32;

namespace Funnet.Gwanak.Agent.Infrastructure;

internal static class RuntimeTrace
{
    private static readonly object Gate = new();
    private static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Funnet", "funnet-gwanak-agent", "logs");
    internal static void Write(string eventName, object? data = null, Exception? error = null)
    {
        try
        {
            Directory.CreateDirectory(Root);
            var os = ReadOs();
            var record = new { timestamp = DateTimeOffset.UtcNow, eventName, os.family, os.edition, os.release, os.build, data, error = error is null ? null : new { type = error.GetType().FullName, message = error.Message } };
            lock (Gate) File.AppendAllText(Path.Combine(Root, $"runtime-{os.family}.jsonl"), JsonSerializer.Serialize(record) + Environment.NewLine);
        }
        catch { }
    }
    private static (string family, string? edition, string? release, int? build) ReadOs()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            var product = key?.GetValue("ProductName")?.ToString() ?? "Windows";
            var build = int.TryParse(key?.GetValue("CurrentBuildNumber")?.ToString(), out var value) ? value : Environment.OSVersion.Version.Build;
            return (build >= 22000 ? "windows11" : build >= 19041 ? "windows10" : "windows-other", key?.GetValue("EditionID")?.ToString() ?? product, key?.GetValue("DisplayVersion")?.ToString() ?? key?.GetValue("ReleaseId")?.ToString(), build);
        }
        catch { return ("windows-unknown", null, null, null); }
    }
}
