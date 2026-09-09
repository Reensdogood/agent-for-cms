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
        var processes = System.Diagnostics.Process.GetProcessesByName("i-Vision.Player");
        var count = 0;
        try { foreach (var process in processes) { process.CloseMainWindow(); count++; } }
        finally { foreach (var process in processes) process.Dispose(); }
        return new { stopped = count };
    }

    private static object RestartIvision()
    {
        string? path = null;
        var processes = System.Diagnostics.Process.GetProcessesByName("i-Vision.Player");
        try { foreach (var process in processes) { try { path ??= process.MainModule?.FileName; } catch { } process.CloseMainWindow(); } }
        finally { foreach (var process in processes) process.Dispose(); }
        if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("i-vision 실행 파일 경로를 찾을 수 없습니다.");
        System.Threading.Thread.Sleep(1000);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true });
        return new { restarted = true, process = "i-Vision.Player" };
    }

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
