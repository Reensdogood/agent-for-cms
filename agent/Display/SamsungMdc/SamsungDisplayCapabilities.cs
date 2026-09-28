namespace Funnet.Gwanak.Agent.Display.SamsungMdc;

internal static class SamsungDisplayCapabilities
{
    private static readonly SamsungInput[] TwoHdmiInputs = [SamsungInput.Hdmi1, SamsungInput.Hdmi2];
    private static readonly SamsungInput[] ThreeHdmiInputs = [SamsungInput.Hdmi1, SamsungInput.Hdmi2, SamsungInput.Hdmi3];

    // 설치기에서 선택하는 QBC 계열(LH65/75/85QBC 및 세부 SKU)은 HDMI 입력 3개를 제공한다.
    // 모델 문자열이 세부 SKU로 바뀌어도 동일 계열을 안전하게 인식한다.
    public static IReadOnlyList<SamsungInput> InputsForModel(string? model) =>
        model?.Contains("QBC", StringComparison.OrdinalIgnoreCase) == true
            ? ThreeHdmiInputs
            : TwoHdmiInputs;

    public static bool SupportsInput(string? model, SamsungInput input) => InputsForModel(model).Contains(input);

    public static bool TryParseInput(string? value, out SamsungInput input)
    {
        input = value?.Trim().ToUpperInvariant() switch
        {
            "HDMI1" => SamsungInput.Hdmi1,
            "HDMI2" => SamsungInput.Hdmi2,
            "HDMI3" => SamsungInput.Hdmi3,
            _ => default,
        };
        return value?.Trim().ToUpperInvariant() is "HDMI1" or "HDMI2" or "HDMI3";
    }

    public static string NameOf(SamsungInput input) => input switch
    {
        SamsungInput.Hdmi1 => "HDMI1",
        SamsungInput.Hdmi2 => "HDMI2",
        SamsungInput.Hdmi3 => "HDMI3",
        _ => throw new ArgumentOutOfRangeException(nameof(input)),
    };
}
