namespace Funnet.Gwanak.Agent.Services;

using System.Diagnostics;
using Funnet.Gwanak.Agent.Display.Serial;
using Funnet.Gwanak.Agent.Display.SamsungMdc;
using Funnet.Gwanak.Agent.Display;
using Funnet.Gwanak.Agent.Infrastructure;

internal sealed class AgentCommandExecutor(AgentApiClient apiClient, HealthCollector healthCollector, UmeWindowController umeController, AgentSettings settings)
{
    private readonly PackageDeploymentService _packageDeployment = new(apiClient);
    private readonly UmeWindowController _umeController = umeController;
    private readonly AgentSettings _settings = settings;

    public async Task<int> ExecutePendingAsync(CancellationToken cancellationToken)
    {
        var completed = 0;
        foreach (var command in await apiClient.GetCommandsAsync(cancellationToken))
        {
            RuntimeTrace.Write("command.start", new { command.Id, command.Type });
            try
            {
                object result = command.Type switch
                {
                    "health.probe" => await ProbeAsync(cancellationToken),
                    "ume.activate" => await ActivateUmeAsync(cancellationToken),
                    "ume.hide" => _umeController.CloseAndRestoreIvision(),
                    "ivision.stop" => StopIvision(),
                    "ivision.restart" => RestartIvision(),
                    "windows.shutdown" => ScheduleWindowsShutdown(),
                    "ume.package.download" => await DownloadAsync(command, cancellationToken),
                    "agent.package.download" => await DownloadAgentAsync(command, cancellationToken),
                    "display.power" => await DisplayPowerAsync(command, cancellationToken),
                    "display.input" => await DisplayInputAsync(command, cancellationToken),
                    "display.volume" => await DisplayVolumeAsync(command, cancellationToken),
                    "display.status" => await DisplayStatusAsync(cancellationToken),
                    "remote.screen.capture" => RemoteControlService.CapturePrimaryScreen(),
                    "remote.input.key" => RemoteControlService.SendKey(command.Payload.GetProperty("key").GetString() ?? ""),
                    "remote.input.click" => RemoteControlService.Click(command.Payload.GetProperty("x").GetInt32(), command.Payload.GetProperty("y").GetInt32()),
                    _ => throw new InvalidOperationException("지원하지 않는 명령입니다."),
                };
                await apiClient.CompleteCommandAsync(command.Id, true, result, cancellationToken);
                RuntimeTrace.Write("command.success", new { command.Id, command.Type });
                completed++;
                // 설치기가 기존 Agent를 종료하기 전에 서버에 완료를 확정한다.
                // 완료 응답 이후에만 설치기를 시작해야 delivered 명령 재전달로
                // 업데이트 설치기가 중복 실행되지 않는다.
                if (result is PackageDeploymentService.AgentPackage agentPackage)
                {
                    PackageDeploymentService.StartAgentUpdate(agentPackage);
                    return completed;
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                RuntimeTrace.Write("command.failure", new { command.Id, command.Type }, exception);
                await apiClient.CompleteCommandAsync(command.Id, false, new { error = exception.Message }, cancellationToken);
            }
        }
        return completed;
    }

    private async Task<object> DisplayPowerAsync(AgentApiClient.AgentCommand command, CancellationToken ct)
    { await using var client = CreateDisplayClient(); var on = command.Payload.GetProperty("on").GetBoolean(); await client.SetPowerAsync(on ? SamsungPowerState.On : SamsungPowerState.Off, ct); return new { power = on ? "on" : "off" }; }
    private async Task<object> DisplayInputAsync(AgentApiClient.AgentCommand command, CancellationToken ct)
    {
        await using var client = CreateDisplayClient();
        var input = command.Payload.GetProperty("input").GetString() switch
        {
            "HDMI1" => SamsungInput.Hdmi1,
            "HDMI2" => SamsungInput.Hdmi2,
            _ => throw new InvalidOperationException("input은 HDMI1 또는 HDMI2여야 합니다.")
        };
        try
        {
            await client.SetInputAsync(input, ct);
            return new { input = input.ToString(), verification = "confirmed" };
        }
        catch (Exception error) when (error is DisplayControlException)
        {
            // 일부 QET 패널은 입력 전환 직후 MDC ACK/검증 응답이 늦다.
            // 명령이 실제로 적용되었는지 한 번 더 읽어 오래된 상태를 실패로 남기지 않는다.
            await Task.Delay(500, ct);
            try
            {
                var actual = await client.GetInputAsync(ct);
                if (actual == input)
                    return new { input = input.ToString(), verification = "confirmed_after_delayed_response" };
            }
            catch (Exception retryError) when (retryError is DisplayControlException)
            {
                // 최초 오류를 보존해 서버에 원인을 전달한다.
            }
            throw new DisplayControlException(DisplayErrorCode.NoDisplayResponse,
                $"입력 전환 응답이 지연되었고 {input} 적용 여부를 확인하지 못했습니다. 최초 오류: {error.Message}");
        }
    }
    private async Task<object> DisplayVolumeAsync(AgentApiClient.AgentCommand command, CancellationToken ct)
    { await using var client = CreateDisplayClient(); var value = command.Payload.GetProperty("value").GetInt32(); await client.SetVolumeAsync(value, ct); return new { volume = value }; }
    private async Task<object> DisplayStatusAsync(CancellationToken ct)
    {
        await using var client = CreateDisplayClient();
        var power = await TryReadAsync("power", () => client.GetPowerAsync(ct), ct);
        var input = await TryReadAsync("input", () => client.GetInputAsync(ct), ct);
        var volume = await TryReadAsync("volume", () => client.GetVolumeAsync(ct), ct);

        var errors = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (power.Error is not null) errors["power"] = power.Error;
        if (input.Error is not null) errors["input"] = input.Error;
        if (volume.Error is not null) errors["volume"] = volume.Error;
        var connected = power.Value is not null || input.Value is not null || volume.Value is not null;
        var standby = power.Value is SamsungPowerState.Off && input.Value is null && volume.Value is null;
        return new
        {
            power = power.Value is SamsungPowerState p ? p == SamsungPowerState.On ? "on" : "off" : null,
            input = input.Value is SamsungInput i ? i == SamsungInput.Hdmi1 ? "HDMI1" : "HDMI2" : null,
            volume = volume.Value,
            connection = connected ? (standby ? "standby" : "connected") : "timeout",
            partial = errors.Count > 0,
            errors,
            retryCount = 2
        };
    }

    private static async Task<(T? Value, string? Error)> TryReadAsync<T>(string name, Func<Task<T>> read, CancellationToken ct) where T : struct
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 2; attempt++)
        {
            try { return (await read(), null); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                last = ex;
                if (attempt < 2) await Task.Delay(150, ct);
            }
        }
        return (default, $"{name}: {last?.Message ?? "응답 없음"}");
    }
    private SamsungMdcClient CreateDisplayClient()
    { if (!_settings.Display.Enabled || string.IsNullOrWhiteSpace(_settings.Display.Port)) throw new DisplayControlException(DisplayErrorCode.PortNotFound, "Samsung display is not enabled or port is not configured."); var transport = new WindowsSerialTransportFactory().Create(SerialPortConfiguration.ForSamsungMdc(_settings.Display.Port)); return new SamsungMdcClient(transport); }

    private async Task<object> ActivateUmeAsync(CancellationToken cancellationToken)
    {
        if (GetIvisionProcesses().Length > 0) StopIvision();
        return await _umeController.ActivateAsync(cancellationToken);
    }

    private static object StopIvision()
    {
        // PlayAgent가 Player를 감시하므로 자식만 종료하면 즉시 다시 생성된다.
        // 시작 시점에 부모 체인을 캡처하고, 자식 -> 감시자 -> 런처 순서로 닫는다.
        var tree = CaptureIvisionTree();
        var stopped = 0;
        // 최상위 감시자부터 중지해야 PlayAgent/Player 재생성이 일어나지 않는다.
        foreach (var process in tree.Where(p => p.Name.Contains("Updater", StringComparison.OrdinalIgnoreCase)))
            stopped += CloseOrKill(process.Process);
        foreach (var process in tree.Where(p => p.Name.Contains("Manager", StringComparison.OrdinalIgnoreCase)))
            stopped += KillProcess(process.Process);
        foreach (var process in tree.Where(p => p.Name.Equals("i-Vision.Player", StringComparison.OrdinalIgnoreCase)))
            stopped += CloseOrKill(process.Process);
        WaitForIvisionExit(1500);
        foreach (var process in tree.Where(p => p.Name.Equals("i-Vision.PlayAgent", StringComparison.OrdinalIgnoreCase)))
            stopped += KillProcess(process.Process);
        foreach (var process in tree.Where(p => p.IsIvisionFolder && !p.Name.Equals("i-Vision.Player", StringComparison.OrdinalIgnoreCase) && !p.Name.Equals("i-Vision.PlayAgent", StringComparison.OrdinalIgnoreCase)))
            stopped += KillProcess(process.Process);
        for (var attempt = 0; attempt < 6 && GetIvisionProcesses().Length > 0; attempt++)
        {
            foreach (var process in GetIvisionProcesses()) { stopped += KillProcess(process); }
            // i-Vision tray/launcher가 별도 부모로 남아 있으면 Process.Kill만으로
            // 재생성이 발생할 수 있으므로 이미지 전체를 Windows에 함께 종료시킨다.
            RunTaskKill("i-Vision.PlayAgent.exe");
            RunTaskKill("i-Vision.Player.exe");
            RunTaskKill("iVision.Manager.exe");
            RunTaskKill("iVisionUpdater.exe");
            System.Threading.Thread.Sleep(350);
        }
        var remaining = GetIvisionProcesses();
        try { if (remaining.Length > 0) throw new InvalidOperationException("i-vision 감시 프로세스가 종료되지 않았습니다. 런처가 다시 실행하지 않도록 PlayAgent와 상위 런처를 함께 종료해야 합니다."); }
        finally { foreach (var process in remaining) process.Dispose(); }
        return new { stopped, running = false };
    }

    private static object RestartIvision()
    {
        var processes = GetIvisionProcesses();
        foreach (var process in processes) process.Dispose();
        StopIvision();
        var path = @"C:\i-Vision Player\iVisionUpdater.exe";
        if (!File.Exists(path)) throw new InvalidOperationException("iVisionUpdater.exe를 찾을 수 없습니다.");
        System.Threading.Thread.Sleep(1000);
        // 이미 설치 시 등록된 관리자 권한 작업이 있으면 Agent 자신의 토큰과
        // 무관하게 작업을 실행할 수 있어야 한다. 기존 코드는 먼저
        // IsElevated()를 검사해 일반 토큰 Agent가 정상 등록된 작업까지
        // 실행하지 못하게 막고 있었다.
        if (!PrivilegedTaskBroker.TaskExists(PrivilegedTaskBroker.IvisionLauncherTask))
        {
            if (!EnsureIvisionLauncherTask(path))
                throw new InvalidOperationException("i-vision 관리자 권한 실행 작업이 등록되지 않았습니다. Agent 설치를 관리자 권한으로 다시 진행해 주세요.");
        }
        if (!PrivilegedTaskBroker.RunIvisionLauncher())
            throw new InvalidOperationException("i-vision 관리자 권한 실행 예약 작업을 시작하지 못했습니다.");
        return new { restarted = true, processes = new[] { "i-Vision.PlayAgent", "i-Vision.Player" }, elevation = "privileged-task-broker" };
    }

    private static bool EnsureIvisionLauncherTask(string executable)
    {
        try
        {
            // 이전 버전은 ONCE 작업과 이전 exe 경로를 남길 수 있다. 재실행 시
            // 현재 Agent 경로로 작업을 원자적으로 갱신해 Win10에서도 동일하게 동작시킨다.
            if (!PrivilegedTaskBroker.IsElevated()) return false;
            using (var delete = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Delete /TN \"{PrivilegedTaskBroker.IvisionLauncherTask}\" /F")
            { CreateNoWindow = true, UseShellExecute = false })) delete?.WaitForExit(3000);
            using var create = Process.Start(new ProcessStartInfo("schtasks.exe",
                $"/Create /TN \"{PrivilegedTaskBroker.IvisionLauncherTask}\" /TR \"\\\"{executable}\\\"\" /SC ONDEMAND /RL HIGHEST /F")
            { CreateNoWindow = true, UseShellExecute = false });
            create?.WaitForExit(5000);
            return create is not null && create.ExitCode == 0;
        }
        catch { return false; }
    }

    private static object ScheduleWindowsShutdown()
    {
        _ = Task.Run(async () =>
        {
            await Task.Delay(1500);
            try { Process.Start(new ProcessStartInfo("shutdown.exe", "/s /t 0 /f") { CreateNoWindow = true, UseShellExecute = false }); }
            catch { }
        });
        return new { scheduled = true, action = "shutdown", delaySeconds = 1.5 };
    }

    private sealed record IvisionProcess(System.Diagnostics.Process Process, string Name, string? Path, bool IsIvisionFolder);

    private static List<IvisionProcess> CaptureIvisionTree()
    {
        var result = new Dictionary<int, IvisionProcess>();
        foreach (var process in GetIvisionProcesses())
        {
            try { AddWithParents(process, result); }
            catch { process.Dispose(); }
        }
        return result.Values.ToList();
    }

    private static void AddWithParents(System.Diagnostics.Process process, Dictionary<int, IvisionProcess> result)
    {
        if (result.ContainsKey(process.Id)) { process.Dispose(); return; }
        string? path = null;
        try { path = process.MainModule?.FileName; } catch { }
        result[process.Id] = new IvisionProcess(process, process.ProcessName, path, path?.StartsWith(@"C:\i-Vision Player\", StringComparison.OrdinalIgnoreCase) == true);
        try
        {
            using var query = new System.Management.ManagementObjectSearcher($"SELECT ParentProcessId FROM Win32_Process WHERE ProcessId = {process.Id}");
            var parentValue = query.Get().Cast<System.Management.ManagementObject>().FirstOrDefault()?["ParentProcessId"];
            if (parentValue is null) return;
            var parent = System.Diagnostics.Process.GetProcessById(Convert.ToInt32(parentValue));
            if (parent.Id != process.Id) AddWithParents(parent, result);
        }
        catch { }
    }

    private static int CloseOrKill(System.Diagnostics.Process process)
    {
        try { if (!process.HasExited) process.CloseMainWindow(); } catch { }
        try { if (!process.WaitForExit(800)) return KillProcess(process); return 1; }
        catch { return KillProcess(process); }
    }

    private static int KillProcess(System.Diagnostics.Process process)
    {
        try { if (!process.HasExited) { process.Kill(true); process.WaitForExit(1200); return 1; } return 0; }
        catch { return 0; }
        finally { process.Dispose(); }
    }

    private static void RunTaskKill(string imageName)
    {
        try
        {
            using var command = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("taskkill", $"/F /T /IM \"{imageName}\"")
            { CreateNoWindow = true, UseShellExecute = false });
            command?.WaitForExit(1500);
        }
        catch { }
    }

    private static void WaitForIvisionExit(int milliseconds)
    {
        var until = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < until)
        {
            var processes = GetIvisionProcesses();
            var running = processes.Length > 0;
            foreach (var process in processes) process.Dispose();
            if (!running) return;
            System.Threading.Thread.Sleep(150);
        }
    }

    private static System.Diagnostics.Process[] GetIvisionProcesses()
        => System.Diagnostics.Process.GetProcesses()
            .Where(process =>
            {
                try
                {
                    var name = process.ProcessName;
                    // MainModule 접근은 권한에 따라 실패할 수 있다. 이름으로 먼저
                    // 식별해야 관리자 권한으로 실행된 i-Vision도 누락되지 않는다.
                    if (name.Contains("i-vision", StringComparison.OrdinalIgnoreCase)
                        || name.Contains("ivision", StringComparison.OrdinalIgnoreCase)) return true;
                    var path = process.MainModule?.FileName ?? "";
                    return (name.Contains("updater", StringComparison.OrdinalIgnoreCase) && path.Contains("i-Vision Player", StringComparison.OrdinalIgnoreCase))
                        || path.Contains(@"i-Vision Player", StringComparison.OrdinalIgnoreCase);
                }
                catch { process.Dispose(); return false; }
            })
            .ToArray();

    private async Task<object> ProbeAsync(CancellationToken cancellationToken)
    {
        var health = healthCollector.Collect();
        await apiClient.SendHeartbeatAsync(health, cancellationToken);
        return health;
    }

    private Task<object> DownloadAsync(AgentApiClient.AgentCommand command, CancellationToken cancellationToken)
    {
        var payload = command.Payload;
        return _packageDeployment.DownloadAsync(
            payload.GetProperty("downloadPath").GetString() ?? throw new InvalidOperationException("downloadPath 누락"),
            payload.GetProperty("fileName").GetString() ?? throw new InvalidOperationException("fileName 누락"),
            payload.GetProperty("version").GetString() ?? throw new InvalidOperationException("version 누락"),
            payload.GetProperty("sha256").GetString() ?? throw new InvalidOperationException("sha256 누락"),
            payload.TryGetProperty("sizeBytes", out var size) ? size.GetInt64() : 0,
            cancellationToken);
    }

    private Task<object> DownloadAgentAsync(AgentApiClient.AgentCommand command, CancellationToken cancellationToken)
    {
        var payload = command.Payload;
        return _packageDeployment.DownloadAgentAsync(
            payload.GetProperty("downloadPath").GetString() ?? throw new InvalidOperationException("downloadPath 누락"),
            payload.GetProperty("fileName").GetString() ?? throw new InvalidOperationException("fileName 누락"),
            payload.GetProperty("version").GetString() ?? throw new InvalidOperationException("version 누락"),
            payload.GetProperty("sha256").GetString() ?? throw new InvalidOperationException("sha256 누락"),
            payload.TryGetProperty("sizeBytes", out var size) ? size.GetInt64() : 0,
            cancellationToken);
    }
}
