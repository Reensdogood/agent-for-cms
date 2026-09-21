using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Funnet.Gwanak.Agent.Infrastructure;
using Funnet.Gwanak.Agent.Models;

namespace Funnet.Gwanak.Agent.Services;

internal sealed class AgentApiClient : IDisposable
{
    private readonly AgentSettings _settings;
    private readonly DeviceIdentityStore _identityStore;
    private readonly DeviceIdentity _identity;
    private readonly HttpClient _http;

    public AgentApiClient(AgentSettings settings, DeviceIdentityStore identityStore, DeviceIdentity identity)
    {
        _settings = settings;
        _identityStore = identityStore;
        _identity = identity;
        _http = new HttpClient
        {
            BaseAddress = new Uri(settings.ServerBaseUrl.TrimEnd('/') + "/"),
            Timeout = TimeSpan.FromSeconds(12),
        };
    }

    public async Task EnsureRegisteredAsync(HealthPayload health, CancellationToken cancellationToken)
    {
        var token = _identityStore.GetDeviceToken(_identity);
        if (!string.IsNullOrWhiteSpace(_identity.DeviceId) && !string.IsNullOrWhiteSpace(token)) return;
        if (string.IsNullOrWhiteSpace(_settings.EnrollmentKey))
            throw new InvalidOperationException("장비 등록 키가 설정되지 않았습니다.");

        using var request = new HttpRequestMessage(HttpMethod.Post, "api/agent/register");
        request.Headers.Add("X-Enrollment-Key", _settings.EnrollmentKey);
        request.Content = JsonContent.Create(new
        {
            installationId = health.InstallationId,
            localName = health.LocalName,
            machineName = health.MachineName,
            agentVersion = health.AgentVersion,
        }, options: JsonDefaults.Standard);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, "장비 등록", cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<RegisterResponse>(JsonDefaults.Standard, cancellationToken)
                     ?? throw new InvalidOperationException("장비 등록 응답이 비어 있습니다.");
        _identityStore.SetDeviceCredentials(_identity, result.DeviceId, result.DeviceToken);
        _settings.RemoveEnrollmentKeyFromFile();
    }

    public async Task SendHeartbeatAsync(HealthPayload health, CancellationToken cancellationToken)
    {
        using var request = DeviceRequest(HttpMethod.Post, "api/agent/heartbeat");
        request.Content = JsonContent.Create(health, options: JsonDefaults.Standard);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, "상태 전송", cancellationToken);
    }

    public async Task<IReadOnlyList<AgentCommand>> GetCommandsAsync(CancellationToken cancellationToken)
    {
        using var request = DeviceRequest(HttpMethod.Get, "api/agent/commands");
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, "명령 조회", cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<CommandListResponse>(JsonDefaults.Standard, cancellationToken);
        return result?.Commands ?? [];
    }

    public async Task CompleteCommandAsync(string commandId, bool success, object result, CancellationToken cancellationToken)
    {
        using var request = DeviceRequest(HttpMethod.Post, $"api/agent/commands/{commandId}/result");
        request.Content = JsonContent.Create(new { success, result }, options: JsonDefaults.Standard);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, "명령 결과 전송", cancellationToken);
    }

    public async Task DownloadPackageAsync(string relativePath, string destination, CancellationToken cancellationToken)
    {
        using var request = DeviceRequest(HttpMethod.Get, relativePath.TrimStart('/'));
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        await EnsureSuccessAsync(response, "파일 다운로드", cancellationToken);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = destination + ".download";
        try
        {
            await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
            {
                await input.CopyToAsync(output, cancellationToken);
                await output.FlushAsync(cancellationToken);
            }
            File.Move(temporary, destination, true);
        }
        catch
        {
            if (File.Exists(temporary)) File.Delete(temporary);
            throw;
        }
    }

    private HttpRequestMessage DeviceRequest(HttpMethod method, string path)
    {
        var token = _identityStore.GetDeviceToken(_identity)
                    ?? throw new InvalidOperationException("장비 토큰이 없습니다.");
        var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return request;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, string operation, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        var serverMessage = body;
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
                serverMessage = error.GetString() ?? body;
        }
        catch { }
        if (string.IsNullOrWhiteSpace(serverMessage)) serverMessage = response.ReasonPhrase ?? "응답 내용 없음";
        RuntimeTrace.Write("agent.http.failure", new
        {
            operation,
            statusCode = (int)response.StatusCode,
            path = response.RequestMessage?.RequestUri?.AbsolutePath,
            serverMessage,
        });
        throw new InvalidOperationException($"{operation} 실패 (HTTP {(int)response.StatusCode}): {serverMessage}");
    }

    public void Dispose() => _http.Dispose();

    private sealed record RegisterResponse(string DeviceId, string DeviceToken, bool Approved);
    internal sealed record AgentCommand(string Id, string Type, JsonElement Payload, DateTimeOffset CreatedAt);
    private sealed record CommandListResponse(IReadOnlyList<AgentCommand> Commands);
}
