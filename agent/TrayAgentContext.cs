using Funnet.Gwanak.Agent.Infrastructure;
using Funnet.Gwanak.Agent.Services;
using System.Reflection;
using System.Diagnostics;

namespace Funnet.Gwanak.Agent;

internal sealed class TrayAgentContext : ApplicationContext
{
    private static readonly string AgentVersion = Assembly.GetEntryAssembly()?.GetName().Version?.ToString(3) ?? "-";
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
    private DateTimeOffset _lastInvitationAcceptAttempt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastLoginRecoveryAttempt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastUmeWindowInventory = DateTimeOffset.MinValue;
    private DateTimeOffset _lastUmeSampleTrace = DateTimeOffset.MinValue;
    private bool? _lastTracedMeetingVisible;
    private bool _loginRecoveryActive;
    private int _loginRecoveryAttempts;
    private int _meetingVisibleSamples;
    private int _meetingMissingSamples;
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
            Text = $"funnet-agent {AgentVersion} · 시작 중",
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
                var meetingVisible = _umeController.IsMeetingWindowVisible();
                // 650ms 간격의 전체 표본은 장시간 운영 시 로그를 수십 MB로
                // 키운다. 상태 전환은 항상 남기고, 변동이 없을 때는 10초
                // 간격만 남겨 진단 정보와 운영 부담을 함께 지킨다.
                if (_lastTracedMeetingVisible != meetingVisible || DateTimeOffset.Now - _lastUmeSampleTrace >= TimeSpan.FromSeconds(10))
                {
                    _lastTracedMeetingVisible = meetingVisible;
                    _lastUmeSampleTrace = DateTimeOffset.Now;
                    RuntimeTrace.Write("ume.window.sample", new { meetingVisible, visibleSamples = _meetingVisibleSamples, missingSamples = _meetingMissingSamples });
                }
                if (_umeController.HasUmeWindows() && DateTimeOffset.Now - _lastUmeWindowInventory >= TimeSpan.FromSeconds(10))
                {
                    _lastUmeWindowInventory = DateTimeOffset.Now;
                    RuntimeTrace.Write("ume.window.inventory", _umeController.CaptureWindowInventory());
                }
                if (meetingVisible)
                {
                    _meetingVisibleSamples++;
                    _meetingMissingSamples = 0;
                    // OS별 창 생성 중간 상태나 일시적인 보조창을 회의창으로
                    // 오인하지 않도록 연속 3회(약 2초) 확인 후에만 상태 전환한다.
                    if (_meetingVisibleSamples >= 3 && !_meetingWindowWasVisible)
                    {
                        _meetingWindowWasVisible = true;
                        var fullscreenApplied = _umeController.EnsureMeetingFullscreen();
                        RuntimeTrace.Write("ume.meeting.detected", new { fullscreenApplied });
                    }
                    SetStatus("UME 화상회의 진행 중");
                }
                else
                {
                    _meetingVisibleSamples = 0;
                    _meetingMissingSamples++;
                    // 자동 응답은 제목이 '회의 초대'인 UME 초대 팝업에서만
                    // 녹색 참가 버튼을 찾았을 때 실행한다. 어떤 UME 창도
                    // 매 주기 최상단으로 올리지 않으며, 연속 클릭을 막기
                    // 위해 재시도 간격을 둔다.
                    if (DateTimeOffset.Now - _lastInvitationAcceptAttempt >= TimeSpan.FromSeconds(3))
                    {
                        _lastInvitationAcceptAttempt = DateTimeOffset.Now;
                        var accepted = await _umeController.TryClickForegroundGreenAcceptButtonAsync(cancellationToken);
                        if (accepted) RuntimeTrace.Write("ume.invitation.accept.requested");
                    }
                    // 자동 로그인 체크가 유지돼도 UME가 로그인 화면에 멈추는
                    // 경우가 있다. 5초 간격으로 로그인 화면만 재확인해서
                    // 넓은 파란 로그인 버튼을 다시 누르고, 화면이 사라지면
                    // 복구 완료를 기록한다. 회의·장비 선택 메뉴는 대상이 아니다.
                    if (DateTimeOffset.Now - _lastLoginRecoveryAttempt >= TimeSpan.FromSeconds(5))
                    {
                        _lastLoginRecoveryAttempt = DateTimeOffset.Now;
                        if (_umeController.IsLoginPromptVisible())
                        {
                            var clicked = await _umeController.TryClickLoginButtonAsync(cancellationToken);
                            if (clicked)
                            {
                                _loginRecoveryActive = true;
                                _loginRecoveryAttempts++;
                                RuntimeTrace.Write("ume.login.recovery.requested", new { attempts = _loginRecoveryAttempts });
                            }
                        }
                        else if (_loginRecoveryActive)
                        {
                            RuntimeTrace.Write("ume.login.recovery.completed", new { attempts = _loginRecoveryAttempts });
                            _loginRecoveryActive = false;
                            _loginRecoveryAttempts = 0;
                        }
                    }
                    if (_meetingWindowWasVisible && _meetingMissingSamples >= 3)
                    {
                        _meetingWindowWasVisible = false;
                        // 실제 회의가 끝난 뒤에만 UME 정리와 I-Vision 복귀를 수행한다.
                        _umeController.CloseAllUmeProcesses();
                        _umeController.RestoreIvisionOnly();
                        SetStatus("화상회의 종료 · UME 종료 · i-vision 복귀");
                        _notifyIcon.ShowBalloonTip(1800, "Funnet 관악 Agent", "화상회의 종료를 감지하고 i-vision으로 복귀했습니다.", ToolTipIcon.Info);
                    }
                }
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
        var text = $"funnet-agent {AgentVersion} · {_status}";
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
