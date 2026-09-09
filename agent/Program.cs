using System.Text.Json;
using System.Diagnostics;
using System.Management;
using Funnet.Gwanak.Agent.Infrastructure;
using Funnet.Gwanak.Agent.Services;
using Funnet.Gwanak.Agent.Display.Discovery;

namespace Funnet.Gwanak.Agent;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        if (args.Any(value => string.Equals(value, "--display-port-test", StringComparison.OrdinalIgnoreCase)))
        {
            var inventory = new SerialDeviceDiscovery(new WindowsPnpDeviceSource()).Discover();
            var selection = SerialPortSelector.Select(inventory.Devices, configuredPort: null);
            Console.WriteLine(JsonSerializer.Serialize(new { inventory, selection }, JsonDefaults.Indented));
            return;
        }

        if (args.Any(value => string.Equals(value, "--self-test", StringComparison.OrdinalIgnoreCase)))
        {
            var selfTestSettings = AgentSettings.Load();
            var selfTestIdentityStore = new DeviceIdentityStore();
            var collector = new HealthCollector(selfTestSettings, selfTestIdentityStore.LoadOrCreate());
            var health = collector.Collect();
            Console.WriteLine(JsonSerializer.Serialize(health, JsonDefaults.Indented));
            return;
        }

        if (args.Any(value => string.Equals(value, "--diagnose-ivision", StringComparison.OrdinalIgnoreCase)))
        {
            var rows = new List<Dictionary<string, object?>>();
            // 이름이 Player/PlayAgent로 고정되지 않은 Updater·Launcher도 포함한다.
            foreach (var process in Process.GetProcesses().Where(IsIvisionRelatedProcess))
            {
                var row = new Dictionary<string, object?> { ["name"] = process.ProcessName, ["pid"] = process.Id };
                try { row["path"] = process.MainModule?.FileName; row["hasMainWindow"] = process.MainWindowHandle != IntPtr.Zero; row["canClose"] = !process.HasExited; row["startedAt"] = process.StartTime; var info = new ManagementObjectSearcher($"SELECT ParentProcessId, CommandLine FROM Win32_Process WHERE ProcessId = {process.Id}").Get().Cast<ManagementObject>().FirstOrDefault(); row["parentPid"] = info?["ParentProcessId"]; row["commandLine"] = info?["CommandLine"]; }
                catch (Exception error) { row["error"] = error.Message; }
                finally { process.Dispose(); }
                rows.Add(row);
            }
            var report = JsonSerializer.Serialize(new { timestamp = DateTimeOffset.Now, processes = rows, startup = CollectIvisionStartupEntries() }, JsonDefaults.Indented);
            var reportPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Funnet", "funnet-gwanak-agent", "ivision-diagnostic.json");
            Directory.CreateDirectory(Path.GetDirectoryName(reportPath)!);
            File.WriteAllText(reportPath, report);
            MessageBox.Show($"i-vision 진단이 완료되었습니다.\n\n결과 파일:\n{reportPath}", "Funnet Agent 진단", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        if (args.Any(value => string.Equals(value, "--once", StringComparison.OrdinalIgnoreCase)))
        {
            var onceSettings = AgentSettings.Load();
            var onceIdentityStore = new DeviceIdentityStore();
            var onceIdentity = onceIdentityStore.LoadOrCreate();
            var collector = new HealthCollector(onceSettings, onceIdentity);
            var health = collector.Collect();
            using var api = new AgentApiClient(onceSettings, onceIdentityStore, onceIdentity);
            api.EnsureRegisteredAsync(health, CancellationToken.None).GetAwaiter().GetResult();
            api.SendHeartbeatAsync(health, CancellationToken.None).GetAwaiter().GetResult();
            var executor = new AgentCommandExecutor(api, collector, new UmeWindowController(), onceSettings);
            executor.ExecutePendingAsync(CancellationToken.None).GetAwaiter().GetResult();
            Console.WriteLine(JsonSerializer.Serialize(health, JsonDefaults.Indented));
            return;
        }

        using var mutex = new Mutex(true, @"Local\funnet-gwanak-agent", out var isFirstInstance);
        if (!isFirstInstance)
        {
            MessageBox.Show("funnet-gwanak-agent가 이미 실행 중입니다.", "Funnet 관악 Agent",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var settings = AgentSettings.Load();
        var identityStore = new DeviceIdentityStore();
        Application.Run(new TrayAgentContext(settings, identityStore));
    }

    private static bool IsIvisionRelatedProcess(Process process)
    {
        try
        {
            var name = process.ProcessName;
            var path = process.MainModule?.FileName ?? "";
            return name.Contains("ivision", StringComparison.OrdinalIgnoreCase)
                || name.Contains("i-vision", StringComparison.OrdinalIgnoreCase)
                || name.Contains("updater", StringComparison.OrdinalIgnoreCase) && path.Contains("i-vision", StringComparison.OrdinalIgnoreCase)
                || path.Contains(@"i-Vision Player", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static object CollectIvisionStartupEntries()
    {
        var result = new List<object>();
        try
        {
            using var run = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
            if (run is not null)
                foreach (var name in run.GetValueNames())
                {
                    var value = run.GetValue(name)?.ToString() ?? "";
                    if (name.Contains("ivision", StringComparison.OrdinalIgnoreCase) || value.Contains("i-vision", StringComparison.OrdinalIgnoreCase)) result.Add(new { type = "run", name, value });
                }
        }
        catch { }
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT Name, State, PathName FROM Win32_Service");
            foreach (ManagementObject service in searcher.Get())
            {
                var name = service["Name"]?.ToString() ?? ""; var path = service["PathName"]?.ToString() ?? "";
                if (name.Contains("ivision", StringComparison.OrdinalIgnoreCase) || path.Contains("i-vision", StringComparison.OrdinalIgnoreCase)) result.Add(new { type = "service", name, state = service["State"]?.ToString(), value = path });
            }
        }
        catch { }
        return result;
    }
}
