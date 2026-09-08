using System.Text.Json;
using System.Text.Json.Serialization;

namespace Funnet.Gwanak.Agent;

internal sealed class AgentSettings
{
    public string ServerBaseUrl { get; init; } = "http://127.0.0.1:4170";
    public string EnrollmentKey { get; init; } = "";
    public string LocalName { get; init; } = Environment.MachineName;
    public int HeartbeatSeconds { get; init; } = 30;
    public int CommandPollSeconds { get; init; } = 5;
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
            LocalName = string.IsNullOrWhiteSpace(localName) ? settings.LocalName : localName,
            HeartbeatSeconds = Math.Clamp(settings.HeartbeatSeconds, 10, 600),
            CommandPollSeconds = Math.Clamp(settings.CommandPollSeconds, 2, 60),
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
            localName = LocalName,
            heartbeatSeconds = HeartbeatSeconds,
            commandPollSeconds = CommandPollSeconds,
        };
        var temporary = SettingsFilePath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(sanitized, JsonDefaults.Indented));
        File.Move(temporary, SettingsFilePath, true);
    }
}
