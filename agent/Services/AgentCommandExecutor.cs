namespace Funnet.Gwanak.Agent.Services;

using Funnet.Gwanak.Agent.Display.Serial;
using Funnet.Gwanak.Agent.Display.SamsungMdc;
using Funnet.Gwanak.Agent.Display;

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
            try
            {
                object result = command.Type switch
                {
                    "health.probe" => await ProbeAsync(cancellationToken),
                    "ume.activate" => await _umeController.ActivateAsync(cancellationToken),
                    "ume.hide" => _umeController.HideAndRestoreDid(),
                    "ivision.stop" => StopIvision(),
                    "ivision.restart" => RestartIvision(),
                    "ume.package.download" => await DownloadAsync(command, cancellationToken),
                    "agent.package.download" => await DownloadAgentAsync(command, cancellationToken),
                    "display.power" => await DisplayPowerAsync(command, cancellationToken),
                    "display.input" => await DisplayInputAsync(command, cancellationToken),
                    "display.volume" => await DisplayVolumeAsync(command, cancellationToken),
                    _ => throw new InvalidOperationException("지원하지 않는 명령입니다."),
                };
                await apiClient.CompleteCommandAsync(command.Id, true, result, cancellationToken);
                completed++;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                await apiClient.CompleteCommandAsync(command.Id, false, new { error = exception.Message }, cancellationToken);
            }
        }
        return completed;
    }

    private async Task<object> DisplayPowerAsync(AgentApiClient.AgentCommand command, CancellationToken ct)
    { await using var client = CreateDisplayClient(); var on = command.Payload.GetProperty("on").GetBoolean(); await client.SetPowerAsync(on ? SamsungPowerState.On : SamsungPowerState.Off, ct); return new { power = on ? "on" : "off" }; }
    private async Task<object> DisplayInputAsync(AgentApiClient.AgentCommand command, CancellationToken ct)
    { await using var client = CreateDisplayClient(); var input = command.Payload.GetProperty("input").GetString() switch { "HDMI1" => SamsungInput.Hdmi1, "HDMI2" => SamsungInput.Hdmi2, _ => throw new InvalidOperationException("input은 HDMI1 또는 HDMI2여야 합니다.") }; await client.SetInputAsync(input, ct); return new { input = input.ToString() }; }
    private async Task<object> DisplayVolumeAsync(AgentApiClient.AgentCommand command, CancellationToken ct)
    { await using var client = CreateDisplayClient(); var value = command.Payload.GetProperty("value").GetInt32(); await client.SetVolumeAsync(value, ct); return new { volume = value }; }
    private SamsungMdcClient CreateDisplayClient()
    { if (!_settings.Display.Enabled || string.IsNullOrWhiteSpace(_settings.Display.Port)) throw new DisplayControlException(DisplayErrorCode.PortNotFound, "Samsung display is not enabled or port is not configured."); var transport = new WindowsSerialTransportFactory().Create(SerialPortConfiguration.ForSamsungMdc(_settings.Display.Port)); return new SamsungMdcClient(transport); }

    private static object StopIvision()
    {
        // PlayAgent가 Player를 감시하므로 자식만 종료하면 즉시 다시 생성된다.
        // 시작 시점에 부모 체인을 캡처하고, 자식 -> 감시자 -> 런처 순서로 닫는다.
        var tree = CaptureIvisionTree();
        var stopped = 0;
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
            System.Threading.Thread.Sleep(350);
        }
        var remaining = GetIvisionProcesses();
        try { if (remaining.Length > 0) throw new InvalidOperationException("i-vision 감시 프로세스가 종료되지 않았습니다. 런처가 다시 실행하지 않도록 PlayAgent와 상위 런처를 함께 종료해야 합니다."); }
        finally { foreach (var process in remaining) process.Dispose(); }
        return new { stopped, running = false };
    }

    private static object RestartIvision()
    {
        string? path = null;
        var processes = GetIvisionProcesses();
        try { foreach (var process in processes) { try { if (process.ProcessName.Equals("i-Vision.Player", StringComparison.OrdinalIgnoreCase)) path ??= process.MainModule?.FileName; } catch { } } }
        finally { foreach (var process in processes) process.Dispose(); }
        StopIvision();
        if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("i-vision 실행 파일 경로를 찾을 수 없습니다.");
        System.Threading.Thread.Sleep(1000);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true, WorkingDirectory = System.IO.Path.GetDirectoryName(path) });
        return new { restarted = true, process = "i-Vision.Player" };
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
                    var path = process.MainModule?.FileName ?? "";
                    return name.Contains("i-vision", StringComparison.OrdinalIgnoreCase)
                        || name.Contains("ivision", StringComparison.OrdinalIgnoreCase)
                        || (name.Contains("updater", StringComparison.OrdinalIgnoreCase) && path.Contains("i-Vision Player", StringComparison.OrdinalIgnoreCase))
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
