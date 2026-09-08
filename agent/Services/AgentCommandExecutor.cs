namespace Funnet.Gwanak.Agent.Services;

internal sealed class AgentCommandExecutor(AgentApiClient apiClient, HealthCollector healthCollector)
{
    private readonly PackageDeploymentService _packageDeployment = new(apiClient);
    private readonly UmeWindowController _umeController = new();

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
                    "ume.package.download" => await DownloadAsync(command, cancellationToken),
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
}
