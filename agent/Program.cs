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
            var names = new[] { "i-Vision.Player", "i-Vision.PlayAgent" };
            var rows = new List<Dictionary<string, object?>>();
            foreach (var name in names) foreach (var process in Process.GetProcessesByName(name))
            {
                var row = new Dictionary<string, object?> { ["name"] = process.ProcessName, ["pid"] = process.Id };
                try { row["path"] = process.MainModule?.FileName; row["hasMainWindow"] = process.MainWindowHandle != IntPtr.Zero; row["canClose"] = !process.HasExited; row["startedAt"] = process.StartTime; var info = new ManagementObjectSearcher($"SELECT ParentProcessId, CommandLine FROM Win32_Process WHERE ProcessId = {process.Id}").Get().Cast<ManagementObject>().FirstOrDefault(); row["parentPid"] = info?["ParentProcessId"]; row["commandLine"] = info?["CommandLine"]; }
                catch (Exception error) { row["error"] = error.Message; }
                finally { process.Dispose(); }
                rows.Add(row);
            }
            var report = JsonSerializer.Serialize(new { timestamp = DateTimeOffset.Now, processes = rows }, JsonDefaults.Indented);
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
}
