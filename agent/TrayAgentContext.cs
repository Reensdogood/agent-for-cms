using Funnet.Gwanak.Agent.Infrastructure;
using Funnet.Gwanak.Agent.Services;
using System.Reflection;
using System.Diagnostics;

namespace Funnet.Gwanak.Agent;

internal sealed class TrayAgentContext : ApplicationContext
{
    private readonly AgentSettings _settings;
    private readonly DeviceIdentity _identity;
    private readonly HealthCollector _healthCollector;
    private readonly AgentApiClient _apiClient;
    private readonly UmeWindowController _umeController = new();
    private readonly AgentCommandExecutor _commandExecutor;
    private readonly NotifyIcon _notifyIcon;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private DateTimeOffset _lastHeartbeat = DateTimeOffset.MinValue;
    private bool _meetingWindowWasVisible;
    private string _status = "시작 중";

    public TrayAgentContext(AgentSettings settings, DeviceIdentityStore identityStore)
    {
        _settings = settings;
        _identity = identityStore.LoadOrCreate();
        _healthCollector = new HealthCollector(settings, _identity);
        _apiClient = new AgentApiClient(settings, identityStore, _identity);
        _commandExecutor = new AgentCommandExecutor(_apiClient, _healthCollector, _umeController, _settings);
        _meetingWindowWasVisible = _umeController.IsMeetingWindowVisible();

        var menu = new ContextMenuStrip();
        menu.Items.Add(new ToolStripMenuItem("설정", null, (_, _) => OpenSettings()));
        menu.Items.Add(new ToolStripMenuItem("Agent 재시작", null, (_, _) => RestartAgent()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("종료", null, (_, _) => ExitAgent()));

        _notifyIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = "funnet-gwanak-agent · 시작 중",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _notifyIcon.DoubleClick += async (_, _) => await SendHealthNowAsync();

        _ = Task.Run(() => RunAsync(_stop.Token));
        _ = Task.Run(() => WatchUmeAcceptButtonAsync(_stop.Token));
    }

    private static Icon LoadTrayIcon()
    {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("FunnetTrayIcon");
        return stream is null ? SystemIcons.Application : new Icon(stream);
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var health = _healthCollector.Collect();
                await _apiClient.EnsureRegisteredAsync(health, cancellationToken);
                if (DateTimeOffset.Now - _lastHeartbeat >= TimeSpan.FromSeconds(_settings.HeartbeatSeconds))
                    await SendHeartbeatCoreAsync(health, cancellationToken);

                await _commandExecutor.ExecutePendingAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
            catch (Exception exception)
            {
                SetStatus($"연결 오류: {exception.Message}");
            }

            try { await Task.Delay(TimeSpan.FromSeconds(_settings.CommandPollSeconds), cancellationToken); }
            catch (OperationCanceledException) { }
        }
    }

    private async Task WatchUmeAcceptButtonAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var meetingVisible = _umeController.PrioritizeMeetingWindowIfVisible();
                if (meetingVisible)
                {
                    _meetingWindowWasVisible = true;
                    SetStatus("UME 화상회의 진행 중");
                }
                else if (_meetingWindowWasVisible)
                {
                    _meetingWindowWasVisible = false;
                    // 회의가 끝나면 UME 본창·빈 보조창·트레이 프로세스를 모두
                    // 종료해 i-Vision을 가리지 않게 한다. 다음 UME 실행 명령에서
                    // 필요한 UME 프로세스를 새로 시작한다.
                    _umeController.CloseAllUmeProcesses();
                    _umeController.RestoreIvisionOnly();
                    SetStatus("화상회의 종료 · UME 종료 · i-vision 복귀");
                    _notifyIcon.ShowBalloonTip(1800, "Funnet 관악 Agent", "화상회의 종료를 감지하고 i-vision으로 복귀했습니다.", ToolTipIcon.Info);
                }

                var clicked = await _umeController.TryClickForegroundGreenAcceptButtonAsync(cancellationToken);
                if (clicked) SetStatus("UME 참가 버튼 자동 클릭");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
            catch { }

            try { await Task.Delay(650, cancellationToken); }
            catch (OperationCanceledException) { }
        }
    }

    private async Task SendHealthNowAsync()
    {
        try
        {
            var health = _healthCollector.Collect();
            await _apiClient.EnsureRegisteredAsync(health, _stop.Token);
            await SendHeartbeatCoreAsync(health, _stop.Token);
            _notifyIcon.ShowBalloonTip(2500, "Funnet 관악 Agent", "상태를 서버에 전송했습니다.", ToolTipIcon.Info);
        }
        catch (Exception exception)
        {
            SetStatus($"전송 실패: {exception.Message}");
            _notifyIcon.ShowBalloonTip(3000, "상태 전송 실패", exception.Message, ToolTipIcon.Warning);
        }
    }

    private async Task SendHeartbeatCoreAsync(Models.HealthPayload health, CancellationToken cancellationToken)
    {
        if (!await _sendLock.WaitAsync(0, cancellationToken)) return;
        try
        {
            await _apiClient.SendHeartbeatAsync(health, cancellationToken);
            _lastHeartbeat = DateTimeOffset.Now;
            SetStatus($"정상 · UME {health.Ume?.Version ?? "미감지"}");
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private void SetStatus(string status)
    {
        _status = status;
        var text = $"funnet-gwanak-agent · {_status}";
        if (text.Length > 63) text = text[..63];
        if (_notifyIcon.Text != text) _notifyIcon.Text = text;
    }

    private void ExitAgent()
    {
        _stop.Cancel();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _apiClient.Dispose();
        ExitThread();
    }

    private void OpenSettings()
    {
        try
        {
            var setup = Path.Combine(AppContext.BaseDirectory, "funnet-agent-setup.exe");
            if (!File.Exists(setup)) setup = Path.Combine(AppContext.BaseDirectory, "funnet-gwanak-agent-setup.exe");
            if (File.Exists(setup)) Process.Start(new ProcessStartInfo(setup, "--configure") { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(setup) });
            else Process.Start(new ProcessStartInfo("notepad.exe", $"\"{_settings.SettingsFilePath}\"") { UseShellExecute = true });
        }
        catch (Exception exception) { SetStatus($"설정 열기 실패: {exception.Message}"); }
    }

    private void RestartAgent()
    {
        try
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Agent 실행 경로를 확인할 수 없습니다.");
            Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true, WorkingDirectory = AppContext.BaseDirectory });
            ExitAgent();
        }
        catch (Exception exception) { SetStatus($"재시작 실패: {exception.Message}"); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _stop.Cancel();
            _notifyIcon.Dispose();
            _apiClient.Dispose();
            _sendLock.Dispose();
            _stop.Dispose();
        }
        base.Dispose(disposing);
    }
}
