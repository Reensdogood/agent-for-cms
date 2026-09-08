using System.Text.Json;

namespace Funnet.Gwanak.Agent;

internal static class JsonDefaults
{
    public static readonly JsonSerializerOptions Standard = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    public static readonly JsonSerializerOptions Indented = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };
}
