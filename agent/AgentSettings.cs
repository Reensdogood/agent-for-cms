using System.Text.Json;
using System.Text.Json.Serialization;

namespace Funnet.Gwanak.Agent;

internal sealed class AgentSettings
{
    public string ServerBaseUrl { get; init; } = "http://127.0.0.1:4170";
    public string EnrollmentKey { get; init; } = "";
    // 등록 키 원문을 저장하지 않고도 설치기가 다른 지역 설치인지 판단할 수 있는
    // SHA-256 지문이다. 장비 토큰을 다른 지역으로 잘못 재사용하지 않는다.
    public string EnrollmentKeyFingerprint { get; init; } = "";
    public string LocalName { get; init; } = Environment.MachineName;
    public int HeartbeatSeconds { get; init; } = 30;
    public int CommandPollSeconds { get; init; } = 5;
    public DisplaySettings Display { get; init; } = new();
    [JsonIgnore]
    public string SettingsFilePath { get; init; } = "";

    public static AgentSettings Load()
    {
        var explicitPath = Environment.GetEnvironmentVariable("FUNNET_AGENT_SETTINGS");
        var filePath = string.IsNullOrWhiteSpace(explicitPath)
            ? Path.Combine(AppContext.BaseDirectory, "agent-settings.json")
            : explicitPath;

        AgentSettings settings = new();
        if (File.Exists(filePath))
        {
            var json = File.ReadAllText(filePath);
            settings = JsonSerializer.Deserialize<AgentSettings>(json, JsonDefaults.Standard) ?? new AgentSettings();
        }

        var serverUrl = Environment.GetEnvironmentVariable("FUNNET_SERVER_URL");
        var enrollmentKey = Environment.GetEnvironmentVariable("FUNNET_ENROLLMENT_KEY");
        var localName = Environment.GetEnvironmentVariable("FUNNET_DEVICE_NAME");
        return new AgentSettings
        {
            ServerBaseUrl = string.IsNullOrWhiteSpace(serverUrl) ? settings.ServerBaseUrl : serverUrl,
            EnrollmentKey = string.IsNullOrWhiteSpace(enrollmentKey) ? settings.EnrollmentKey : enrollmentKey,
            EnrollmentKeyFingerprint = settings.EnrollmentKeyFingerprint,
            LocalName = string.IsNullOrWhiteSpace(localName) ? settings.LocalName : localName,
            HeartbeatSeconds = Math.Clamp(settings.HeartbeatSeconds, 10, 600),
            CommandPollSeconds = Math.Clamp(settings.CommandPollSeconds, 2, 60),
            Display = settings.Display ?? new DisplaySettings(),
            SettingsFilePath = filePath,
        };
    }

    public void RemoveEnrollmentKeyFromFile()
    {
        if (string.IsNullOrWhiteSpace(SettingsFilePath) || !File.Exists(SettingsFilePath)) return;
        var sanitized = new
        {
            serverBaseUrl = ServerBaseUrl,
            enrollmentKey = "",
            enrollmentKeyFingerprint = EnrollmentKeyFingerprint,
            localName = LocalName,
            heartbeatSeconds = HeartbeatSeconds,
            commandPollSeconds = CommandPollSeconds,
            display = Display,
        };
        var temporary = SettingsFilePath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(sanitized, JsonDefaults.Indented));
        File.Move(temporary, SettingsFilePath, true);
    }
}

internal sealed class DisplaySettings
{
    public bool Enabled { get; init; }
    public string Vendor { get; init; } = "samsung";
    public string Model { get; init; } = "LH75QET";
    public string? Port { get; init; }
}
