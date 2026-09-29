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
        InstallCrashTracing();
        ApplicationConfiguration.Initialize();
        RuntimeTrace.Write("agent.main.start", new { args = args.Where(x => !x.Contains("key", StringComparison.OrdinalIgnoreCase) && !x.Contains("token", StringComparison.OrdinalIgnoreCase)).ToArray() });

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

        if (args.Any(value => string.Equals(value, "--remote-screen-test", StringComparison.OrdinalIgnoreCase)))
        {
            var result = RemoteControlService.CapturePrimaryScreen();
            var json = JsonSerializer.Serialize(result, JsonDefaults.Indented);
            var reportPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Funnet", "funnet-gwanak-agent", "remote-screen-test.json");
            Directory.CreateDirectory(Path.GetDirectoryName(reportPath)!);
            File.WriteAllText(reportPath, json);
            Console.WriteLine(reportPath);
            return;
        }

        if (args.Any(value => string.Equals(value, "--launch-ivision", StringComparison.OrdinalIgnoreCase)))
        {
            LaunchIvision();
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

        // 설치된 Agent는 반드시 최고 권한 예약 작업의 단일 인스턴스로만 실행한다.
        // 일반 권한 인스턴스를 허용하면 I-Vision 재실행/UAC 브로커가 실패하므로
        // 작업이 없을 때도 일반 권한 트레이를 띄우지 않고 명확히 중단한다.
        var elevated = PrivilegedTaskBroker.IsElevated();
        RuntimeTrace.Write("agent.elevation.check", new { elevated, taskExists = PrivilegedTaskBroker.TaskExists(PrivilegedTaskBroker.AgentTask) });
        if (!elevated)
        {
            if (PrivilegedTaskBroker.TaskExists(PrivilegedTaskBroker.AgentTask))
            {
                RuntimeTrace.Write("agent.elevation.handoff", new { task = PrivilegedTaskBroker.AgentTask, started = PrivilegedTaskBroker.RunAgent() });
                return;
            }

            RuntimeTrace.Write("agent.elevation.missing-task", new { task = PrivilegedTaskBroker.AgentTask });
            MessageBox.Show("Agent 관리자 권한 작업이 등록되지 않았습니다. 설치기를 관리자 권한으로 다시 실행해 주세요.", "Funnet Agent", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        using var mutex = new Mutex(true, @"Local\funnet-gwanak-agent", out var isFirstInstance);
        if (!isFirstInstance)
        {
            // 자동 시작과 수동 실행이 겹쳐도 사용자 화면을 가로채지 않는다.
            // 기존 인스턴스가 계속 트레이에서 동작하므로 중복 실행 요청만 조용히 종료한다.
            RuntimeTrace.Write("agent.instance.duplicate");
            return;
        }

        try
        {
            RuntimeTrace.Write("agent.instance.primary");
            var settings = AgentSettings.Load();
            RuntimeTrace.Write("agent.settings.loaded", new { settings.ServerBaseUrl, settings.LocalName });
            var identityStore = new DeviceIdentityStore();
            using var tray = new TrayAgentContext(settings, identityStore);
            RuntimeTrace.Write("agent.tray.created");
            Application.Run(tray);
            RuntimeTrace.Write("agent.application.run.exited");
        }
        catch (Exception error)
        {
            RuntimeTrace.Write("agent.main.failure", error: error);
            MessageBox.Show($"Agent 시작에 실패했습니다.\n\n{error.Message}\n\n실행 로그를 확인해 주세요.", "Funnet Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void InstallCrashTracing()
    {
        Application.ThreadException += (_, eventArgs) => RuntimeTrace.Write("agent.ui.unhandled-exception", error: eventArgs.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) => RuntimeTrace.Write("agent.unhandled-exception", error: eventArgs.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, eventArgs) =>
        {
            RuntimeTrace.Write("agent.task.unobserved-exception", error: eventArgs.Exception);
            eventArgs.SetObserved();
        };
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

    private static void LaunchIvision()
    {
        const string installDirectory = @"C:\i-Vision Player";
        if (!Directory.Exists(installDirectory)) return;
        using var launchMutex = new Mutex(false, @"Local\Funnet-Ivision-Launch", out var acquired);
        if (!acquired) return;
        try
        {
            LaunchIvisionCore(installDirectory);
        }
        finally { launchMutex.ReleaseMutex(); }
    }

    private static void LaunchIvisionCore(string installDirectory)
    {

        // PlayAgent가 스케줄·감시를 담당하므로 Player만 띄우면 화면은 보여도
        // 스케줄이 반영되지 않는다. 이미 실행 중인 프로세스는 재생성하지 않는다.
        var playAgent = Directory.GetFiles(installDirectory, "*.exe", SearchOption.TopDirectoryOnly)
            .FirstOrDefault(path => Path.GetFileNameWithoutExtension(path).Contains("PlayAgent", StringComparison.OrdinalIgnoreCase));
        var hasPlayAgent = !string.IsNullOrWhiteSpace(playAgent);
        if (hasPlayAgent && !IsProcessRunning("i-Vision.PlayAgent")) { RuntimeTrace.Write("ivision.playagent.start", new { path = playAgent }); StartIvisionProcess(playAgent!); }

        // PlayAgent가 Player를 감시·생성하는 설치본에서는 Player를 직접
        // 실행하지 않는다. 이 규칙이 중복 공백창을 막는 핵심이다.
        if (hasPlayAgent) { RuntimeTrace.Write("ivision.player.delegated-to-playagent"); return; }
        var player = Path.Combine(installDirectory, "i-Vision.Player.exe");
        if (File.Exists(player) && !IsProcessRunning("i-Vision.Player"))
            RuntimeTrace.Write("ivision.player.start", new { path = player }); StartIvisionProcess(player);
    }

    private static void StartIvisionProcess(string path)
    {
        Process.Start(new ProcessStartInfo(path)
        {
            UseShellExecute = true,
            WorkingDirectory = Path.GetDirectoryName(path) ?? AppContext.BaseDirectory,
        });
    }

    private static bool IsProcessRunning(string processName)
        => Process.GetProcessesByName(processName).Any(process => { process.Dispose(); return true; });
}
