namespace Funnet.Gwanak.Agent.Display.Discovery;

internal static class SerialPortSelector
{
    public static SerialPortSelection Select(IReadOnlyList<SerialDeviceInfo> devices, string? configuredPort)
    {
        var available = devices.Where(device => device.PortName is not null).ToList();
        if (!string.IsNullOrWhiteSpace(configuredPort))
        {
            var configured = available.FirstOrDefault(device =>
                device.PortName!.Equals(configuredPort.Trim(), StringComparison.OrdinalIgnoreCase));
            if (configured is not null)
                return Candidate(configured.PortName!, SerialPortSelectionSource.Configured, configuredPort,
                    "저장된 COM 포트가 현재 장치 목록에 있습니다. Samsung MDC probe가 필요합니다.");
        }

        var prolific = available.Where(device => device.IsProlificCandidate &&
                                                   device.DriverStatus == SerialAdapterDriverStatus.Installed).ToList();
        if (prolific.Count == 1)
            return Candidate(prolific[0].PortName!, SerialPortSelectionSource.ProlificCandidate, configuredPort,
                "정상 상태인 NEXT-340PL/Prolific 후보가 하나입니다. Samsung MDC probe가 필요합니다.");
        if (prolific.Count > 1)
            return Required(configuredPort, "정상 상태인 NEXT-340PL/Prolific 후보가 여러 개라 자동 선택하지 않습니다.");

        var recommended = available.FirstOrDefault(device => device.PortName!.Equals("COM3", StringComparison.OrdinalIgnoreCase));
        if (recommended is not null)
            return Candidate(recommended.PortName!, SerialPortSelectionSource.RecommendedDefault, configuredPort,
                "추천 기본 포트가 존재하지만 강제 확정하지 않습니다. Samsung MDC probe가 필요합니다.");
        if (available.Count == 1)
            return Candidate(available[0].PortName!, SerialPortSelectionSource.OnlyAvailablePort, configuredPort,
                "사용 가능한 직렬 포트가 하나입니다. Samsung MDC probe가 필요합니다.");

        return Required(configuredPort, available.Count == 0
            ? "사용 가능한 COM 포트가 없습니다."
            : "사용 가능한 포트가 여러 개이고 확정 가능한 Prolific 후보가 없습니다.");
    }

    private static SerialPortSelection Candidate(string portName, SerialPortSelectionSource source,
        string? configuredPort, string reason) =>
        new(portName, source, true, false, configuredPort, reason);

    private static SerialPortSelection Required(string? configuredPort, string reason) =>
        new(null, SerialPortSelectionSource.ConfigurationRequired, false, true, configuredPort, reason);
}
