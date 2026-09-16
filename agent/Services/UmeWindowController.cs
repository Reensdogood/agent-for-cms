using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace Funnet.Gwanak.Agent.Services;

internal sealed class UmeWindowController
{
    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;
    private const long WsCaption = 0x00C00000L;
    private const long WsThickFrame = 0x00040000L;
    private const long WsMinimizeBox = 0x00020000L;
    private const long WsMaximizeBox = 0x00010000L;
    private const long WsSysMenu = 0x00080000L;
    private const long WsExDlgModalFrame = 0x00000001L;
    private const long WsExClientEdge = 0x00000200L;
    private const long WsExStaticEdge = 0x00020000L;
    private const uint SwpFrameChanged = 0x0020;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoOwnerZOrder = 0x0200;
    private const uint SwpShowWindow = 0x0040;
    private const uint SwpHideWindow = 0x0080;
    private const int SwRestore = 9;
    private const int SwMinimize = 6;
    private const int SwHide = 0;
    private const uint InputMouse = 0;
    private const uint MouseEventFLeftDown = 0x0002;
    private const uint MouseEventFLeftUp = 0x0004;
    private static readonly IntPtr HwndTop = new(0);
    private static readonly IntPtr HwndBottom = new(1);
    private static readonly IntPtr HwndTopmost = new(-1);
    private static readonly IntPtr HwndNoTopmost = new(-2);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetLastActivePopup(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder className, int maxCount);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong32(IntPtr window, int index, int value);
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

    public async Task<object> ActivateAsync(CancellationToken cancellationToken)
    {
        var installation = new UmeDetector().DetectPreferred()
                           ?? throw new InvalidOperationException("설치된 UME를 찾을 수 없습니다.");
        // 프로세스가 남아 있어도 창이 사라진 UME가 있을 수 있다. 이 경우
        // "이미 실행 중"으로 간주해 Start를 건너뛰면 서버 재실행 명령이 무반응이 된다.
        // 먼저 현재 표시 창을 확인하고, 표시 창이 없을 때만 실행 파일을 다시 호출한다.
        var existingWindows = FindWindows(IsUmeProcess, visibleOnly: true);
        if (existingWindows.Count == 0)
        {
            // 단일 인스턴스 UME는 프로세스가 남아 있을 때 새 실행 요청을 무시하고
            // 기존 숨은 창만 유지할 수 있다. 숨은 창을 먼저 복원해 재실행을 유도한다.
            // UME는 프로세스 하나 안에 툴바/카메라/소켓 알림 등 숨은
            // 보조창을 다수 만든다. 이를 전부 복원하면 창이 우르르
            // 나타나므로 실제 클라이언트/회의창만 복원한다.
            var hiddenCandidates = FindWindows(IsUmeProcess, visibleOnly: false)
                .Select(ToWindowInfo)
                .Where(info => IsMeetingWindow(info) || IsMainWindowCandidate(info, Screen.PrimaryScreen?.Bounds ?? Rectangle.Empty))
                .ToList();
            var restoredClientWindows = hiddenCandidates.Where(IsMeetingWindow).ToList();
            var main = hiddenCandidates.Where(info => !IsMeetingWindow(info))
                .OrderByDescending(info => info.Bounds.Width * info.Bounds.Height).FirstOrDefault();
            if (main is not null) restoredClientWindows.Add(main);
            foreach (var hiddenInfo in restoredClientWindows) ShowWindow(hiddenInfo.Handle, SwRestore);
            // 숨은 클라이언트 창을 복원한 경우에는 UME를 새로 호출하지 않는다.
            // UME global은 단일 인스턴스지만 새 호출 시 검은 보조창을 여러 개 만들 수 있다.
            // UME가 프로세스만 남긴 상태에서는 새 인스턴스를 만들지 않는다.
            // 단일 인스턴스 구현이 새 호출을 무시하거나 빈 창을 여러 개 만드는 것을 방지한다.
            var umeProcessRunning = Process.GetProcesses().Any(IsUmeProcess);
            if (restoredClientWindows.Count == 0 && !umeProcessRunning)
            {
                Process.Start(new ProcessStartInfo(installation.Path)
                {
                    UseShellExecute = true,
                    WorkingDirectory = Path.GetDirectoryName(installation.Path) ?? AppContext.BaseDirectory,
                });
            }
        }

        List<WindowInfo> windows = existingWindows.Select(ToWindowInfo).ToList();
        for (var attempt = 0; attempt < 120 && windows.Count == 0; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(250, cancellationToken);
            windows = FindWindows(IsUmeProcess, visibleOnly: true).Select(ToWindowInfo).ToList();
        }
        if (windows.Count == 0) throw new InvalidOperationException("UME 창이 제한 시간 안에 나타나지 않았습니다.");

        var bounds = Screen.PrimaryScreen?.Bounds ?? throw new InvalidOperationException("주 디스플레이를 찾을 수 없습니다.");
        var mainWindowsPrepared = 0;
        foreach (var info in windows)
        {
            var window = info.Handle;
            ShowWindow(window, SwRestore);
            if (IsMeetingWindow(info))
            {
                MakeBorderlessFullscreen(window, bounds);
                continue;
            }

            if (IsMainWindowCandidate(info, bounds))
            {
                RestoreNormalClientWindow(window);
                mainWindowsPrepared++;
            }
        }
        var promotedMeeting = PromoteMeetingWindow(bounds);
        // 화상회의 본창이 아직 없으면 UME 클라이언트 창을 Foreground로 올리지 않는다.
        // 대기/로그인 화면은 사용자의 다른 작업을 방해하지 않아야 하며, 회의창이
        // 실제로 생성된 뒤에만 최상위·참가 버튼 자동 처리를 수행한다.
        var acceptClick = promotedMeeting is IntPtr meeting
            ? await TryClickGreenAcceptButtonAsync(meeting, bounds, cancellationToken)
            : new { attempted = false, clicked = false, method = "deferred-until-meeting", elapsedMs = 0, loginRecoveryClicked = false, reason = "화상회의 창 대기 중" };
        promotedMeeting = PromoteMeetingWindow(bounds);
        if (promotedMeeting is null) MinimizeClientWindows(bounds);
        return new
        {
            installation.Name,
            installation.Version,
            windowCount = windows.Count,
            mainWindowsPrepared,
            meetingWindowPrioritized = promotedMeeting is not null,
            meetingFullscreenApplied = promotedMeeting is not null,
            monitor = new { bounds.X, bounds.Y, bounds.Width, bounds.Height },
            acceptClick
        };
    }

    public object HideAndRestoreDid()
    {
        var umeWindows = FindWindows(IsUmeProcess, visibleOnly: true);
        foreach (var window in umeWindows) ShowWindow(window, SwHide);
        return RestoreIvision(umeWindows.Count);
    }

    public object CloseAllUmeProcesses()
    {
        var stopped = 0;
        var processes = Process.GetProcesses().Where(IsUmeProcess).ToList();
        try
        {
            // 정상 종료를 먼저 요청해 UME가 세션·트레이 상태를 정리할 시간을 준다.
            foreach (var process in processes)
            {
                try { if (!process.HasExited) process.CloseMainWindow(); } catch { }
            }
            foreach (var process in processes)
            {
                try
                {
                    if (!process.HasExited && process.WaitForExit(900)) stopped++;
                }
                catch { }
            }
            // 빈 창·보조 프로세스처럼 메인 창이 없는 잔존 프로세스도 정리한다.
            foreach (var process in Process.GetProcesses().Where(IsUmeProcess).ToList())
            {
                try
                {
                    if (!process.HasExited) { process.Kill(true); process.WaitForExit(1200); stopped++; }
                }
                catch { }
                finally { process.Dispose(); }
            }
            return new { stopped, remaining = CountUmeProcesses() };
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }
    }

    public bool IsMeetingWindowVisible() => FindWindows(IsUmeProcess, visibleOnly: true)
        .Select(ToWindowInfo).Any(IsMeetingWindow);

    public object RestoreIvisionOnly()
    {
        MinimizeClientWindows(Screen.PrimaryScreen?.Bounds ?? Rectangle.Empty);
        return RestoreIvision();
    }

    private static object RestoreIvision(int umeWindowsHidden = 0)
    {
        var didWindows = FindWindows(IsIvisionProcess, visibleOnly: false);
        var restored = false;
        if (didWindows.Count > 0)
        {
            var target = didWindows[^1];
            foreach (var window in didWindows) ShowWindow(window, SwRestore);
            BringWindowToTop(target);
            restored = SetForegroundWindow(target);
        }
        else
        {
            var defaultPath = @"C:\i-Vision Player\i-Vision.Player.exe";
            if (File.Exists(defaultPath)) restored = StartIvisionWithHighestTask(defaultPath);
        }
        return new { umeWindowsHidden, iVisionWindowFound = didWindows.Count > 0, iVisionForegroundRequested = restored, iVisionStarted = didWindows.Count == 0 && restored };
    }

    private static bool StartIvisionWithHighestTask(string fallbackPath)
    {
        try
        {
            using var run = Process.Start(new ProcessStartInfo("schtasks.exe", "/Run /TN \"Funnet i-Vision Launcher\"")
            { CreateNoWindow = true, UseShellExecute = false });
            run?.WaitForExit(5000);
            if (run is not null && run.ExitCode == 0) return true;
        }
        catch { }

        // 직접 실행으로 대체하면 관리자 권한 UAC가 다시 나타난다.
        // 예약 작업이 없거나 실행에 실패한 경우에는 조용히 실패시켜
        // 사용자 작업을 가로채지 않고 Agent 로그에 원인을 남긴다.
        return false;
    }

    public bool PrioritizeMeetingWindowIfVisible()
    {
        // UME 보조창은 종료/숨김하지 않고 백그라운드로만 보낸다.
        // 강제 숨김은 Yealink Room Connector와 UME 내부 상태를 깨뜨릴 수 있다.
        SendUmeAuxiliaryWindowsToBackground();
        var bounds = Screen.PrimaryScreen?.Bounds ?? Rectangle.Empty;
        if (bounds.IsEmpty) return false;
        if (PromoteUmePopupIfVisible()) return true;
        // UME의 더보기/설정/확인 팝업이 열려 있으면 팝업을 현재 입력 창으로
        // 존중한다. 회의 본창을 다시 Z-order 최상단으로 올리면 팝업이 가려진다.
        var foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero && IsUmeWindow(foreground))
        {
            var foregroundInfo = ToWindowInfo(foreground);
            if (!IsMeetingWindow(foregroundInfo) && !IsMainWindowCandidate(foregroundInfo, bounds)) return true;
        }
        RestoreVisibleClientWindows(bounds);
        return PromoteMeetingWindow(bounds) is not null;
    }

    public async Task<bool> TryClickForegroundGreenAcceptButtonAsync(CancellationToken cancellationToken)
    {
        if (PromoteUmePopupIfVisible()) return false;
        var foreground = GetForegroundWindow();
        var bounds = Screen.PrimaryScreen?.Bounds ?? Rectangle.Empty;
        if (bounds.IsEmpty) return false;
        if (foreground == IntPtr.Zero || !IsUmeWindow(foreground))
        {
            var hasInviteCandidate = FindBestGreenButtonTarget(bounds) is not null;
            if (!hasInviteCandidate) return false;
        }
        PromoteMeetingWindow(bounds);
        var target = FindBestGreenButtonTarget(bounds);
        if (target is not null)
        {
            BringWindowToTop(target.Window);
            SetForegroundWindow(target.Window);
            await Task.Delay(120, cancellationToken);
            ClickScreenPoint(target.Candidate.CenterX, target.Candidate.CenterY);
            await Task.Delay(250, cancellationToken);
            PromoteMeetingWindow(bounds);
            return true;
        }
        PromoteMeetingWindow(bounds);
        await Task.Delay(250, cancellationToken);
        return false;
    }

    private static List<IntPtr> FindWindows(Func<Process, bool> predicate, bool visibleOnly)
    {
        List<IntPtr> result = [];
        EnumWindows((window, _) =>
        {
            if (visibleOnly && !IsWindowVisible(window)) return true;
            GetWindowThreadProcessId(window, out var processId);
            try
            {
                using var process = Process.GetProcessById((int)processId);
                if (predicate(process)) result.Add(window);
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private static bool IsUmeWindow(IntPtr window)
    {
        GetWindowThreadProcessId(window, out var processId);
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return IsUmeProcess(process);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsUmeProcess(Process process) =>
        process.ProcessName.Equals("UME", StringComparison.OrdinalIgnoreCase) ||
        process.ProcessName.Equals("UME global", StringComparison.OrdinalIgnoreCase);

    private static WindowInfo ToWindowInfo(IntPtr window)
    {
        GetWindowRect(window, out var rect);
        var text = new StringBuilder(256);
        GetWindowText(window, text, text.Capacity);
        var className = new StringBuilder(256);
        GetClassName(window, className, className.Capacity);
        return new WindowInfo(window, text.ToString(), className.ToString(), Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom));
    }

    private static bool IsMeetingWindow(WindowInfo info) =>
        info.Title.Contains("회의", StringComparison.OrdinalIgnoreCase)
        || info.Title.Contains("meeting", StringComparison.OrdinalIgnoreCase)
        || info.Title.Contains("conference", StringComparison.OrdinalIgnoreCase);

    private static bool IsMainWindowCandidate(WindowInfo info, Rectangle monitorBounds)
    {
        if (IsMeetingWindow(info)) return false;
        if (info.Bounds.Width < 600 || info.Bounds.Height < 400) return false;
        var monitorArea = monitorBounds.Width * monitorBounds.Height;
        var windowArea = info.Bounds.Width * info.Bounds.Height;
        return monitorArea <= 0 || windowArea >= monitorArea * 0.15;
    }

    private static IntPtr? PromoteMeetingWindow(Rectangle bounds)
    {
        var meeting = FindWindows(IsUmeProcess, visibleOnly: true)
            .Select(ToWindowInfo)
            .FirstOrDefault(IsMeetingWindow);
        if (meeting is null) return null;
        MakeBorderlessFullscreen(meeting.Handle, bounds);
        return meeting.Handle;
    }

    public async Task<bool> TryClickLoginButtonAsync(CancellationToken cancellationToken)
    {
        var bounds = Screen.PrimaryScreen?.Bounds ?? Rectangle.Empty;
        if (bounds.IsEmpty) return false;
        var target = FindBestBlueLoginButtonTarget(bounds);
        if (target is null) return false;
        BringWindowToTop(target.Window);
        SetForegroundWindow(target.Window);
        await Task.Delay(120, cancellationToken);
        ClickScreenPoint(target.Candidate.CenterX, target.Candidate.CenterY);
        return true;
    }

    private static int CountUmeProcesses()
    {
        var processes = Process.GetProcesses();
        try { return processes.Count(IsUmeProcess); }
        finally { foreach (var process in processes) process.Dispose(); }
    }

    private static bool PromoteUmePopupIfVisible()
    {
        var bounds = Screen.PrimaryScreen?.Bounds ?? Rectangle.Empty;
        // 더보기/카메라/마이크 선택창은 UME가 소유한 모달 팝업으로 생성될 수 있다.
        // EnumWindows에서 제목이 비어 있거나 자식 UI로 보이는 경우에도
        // 소유 창의 마지막 활성 팝업을 우선해 회의 본창이 덮지 않도록 한다.
        foreach (var owner in FindWindows(IsUmeProcess, visibleOnly: true))
        {
            var popupHandle = GetLastActivePopup(owner);
            if (popupHandle == IntPtr.Zero || popupHandle == owner || !IsWindowVisible(popupHandle)) continue;
            var popupInfo = ToWindowInfo(popupHandle);
            if (IsAuxiliaryWindow(popupInfo) || IsMeetingWindow(popupInfo)) continue;
            ShowWindow(popupHandle, SwRestore);
            SetWindowPos(popupHandle, HwndTopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpShowWindow);
            BringWindowToTop(popupHandle);
            SetForegroundWindow(popupHandle);
            return true;
        }
        var popup = FindWindows(IsUmeProcess, visibleOnly: true)
            .Select(ToWindowInfo)
            .Where(info => !IsMeetingWindow(info) && !IsMainWindowCandidate(info, bounds))
            .Where(info => !IsAuxiliaryWindow(info))
            .Where(info => !string.IsNullOrWhiteSpace(info.Title))
            .Where(info => !string.Equals(info.Title, "UME global", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(info => info.Bounds.Width * info.Bounds.Height)
            .FirstOrDefault();
        if (popup is null) return false;
        ShowWindow(popup.Handle, SwRestore);
        SetWindowPos(popup.Handle, HwndTopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpShowWindow);
        BringWindowToTop(popup.Handle);
        SetForegroundWindow(popup.Handle);
        return true;
    }

    private static bool IsAuxiliaryWindow(WindowInfo info)
    {
        return info.Title.Equals("Aqua Camera Monitor", StringComparison.OrdinalIgnoreCase)
                || info.Title.Contains("Camera Monitor", StringComparison.OrdinalIgnoreCase)
                || info.Title.Equals("WhiteBoardToolBar", StringComparison.OrdinalIgnoreCase)
                || info.Title.Equals("USBCOMUSBDetect", StringComparison.OrdinalIgnoreCase)
                || info.ClassName.Equals("Qt5158QWindowToolSaveBits", StringComparison.OrdinalIgnoreCase)
                || info.ClassName.Equals("CmWin32SocketNotification_59168765", StringComparison.OrdinalIgnoreCase);
    }

    private static void SendUmeAuxiliaryWindowsToBackground()
    {
        foreach (var info in FindWindows(IsUmeProcess, visibleOnly: true).Select(ToWindowInfo))
        {
            if (!IsAuxiliaryWindow(info)) continue;
            // 창은 살아 있게 두되 포커스·최상위만 제거한다.
            SetWindowPos(info.Handle, HwndBottom, 0, 0, 0, 0,
                SwpNoMove | SwpNoSize | SwpNoOwnerZOrder);
        }
    }

    private static void RestoreVisibleClientWindows(Rectangle monitorBounds)
    {
        foreach (var info in FindWindows(IsUmeProcess, visibleOnly: true).Select(ToWindowInfo))
            if (!IsMeetingWindow(info) && IsMainWindowCandidate(info, monitorBounds)) RestoreNormalClientWindow(info.Handle);
    }

    private static void MinimizeClientWindows(Rectangle monitorBounds)
    {
        foreach (var info in FindWindows(IsUmeProcess, visibleOnly: true).Select(ToWindowInfo))
        {
            if (IsMeetingWindow(info) || !IsMainWindowCandidate(info, monitorBounds)) continue;
            ShowWindow(info.Handle, SwMinimize);
            SetWindowPos(info.Handle, HwndBottom, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoOwnerZOrder);
        }
    }

    private static void RestoreNormalClientWindow(IntPtr window)
    {
        ShowWindow(window, SwRestore);
        var style = GetLong(window, GwlStyle) | WsCaption | WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSysMenu;
        var exStyle = GetLong(window, GwlExStyle) & ~(WsExDlgModalFrame | WsExClientEdge | WsExStaticEdge);
        SetLong(window, GwlStyle, style);
        SetLong(window, GwlExStyle, exStyle);
        SetWindowPos(window, HwndNoTopmost, 0, 0, 0, 0, SwpFrameChanged | SwpNoMove | SwpNoSize | SwpNoOwnerZOrder | SwpShowWindow);
    }

    private static void MakeBorderlessFullscreen(IntPtr window, Rectangle bounds)
    {
        ShowWindow(window, SwRestore);
        var style = GetLong(window, GwlStyle) & ~(WsCaption | WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSysMenu);
        var exStyle = GetLong(window, GwlExStyle) & ~(WsExDlgModalFrame | WsExClientEdge | WsExStaticEdge);
        SetLong(window, GwlStyle, style);
        SetLong(window, GwlExStyle, exStyle);
        // 회의 본창은 전체화면 최상위로 유지하되 Foreground를 강제로 빼앗지 않는다.
        // UME의 모달/더보기 팝업은 별도 창으로 감지해 watcher가 본창을 재승격하지 않는다.
        SetWindowPos(window, HwndTopmost, bounds.Left, bounds.Top, bounds.Width, bounds.Height,
            SwpFrameChanged | SwpNoOwnerZOrder | SwpShowWindow);
    }

    private static bool IsIvisionProcess(Process process) =>
        process.ProcessName.Contains("i-vision", StringComparison.OrdinalIgnoreCase) ||
        process.ProcessName.Contains("ivision", StringComparison.OrdinalIgnoreCase);

    private static long GetLong(IntPtr window, int index) => IntPtr.Size == 8
        ? GetWindowLongPtr64(window, index).ToInt64()
        : GetWindowLong32(window, index);

    private static void SetLong(IntPtr window, int index, long value)
    {
        if (IntPtr.Size == 8) SetWindowLongPtr64(window, index, new IntPtr(value));
        else SetWindowLong32(window, index, (int)value);
    }

    private static async Task<object> TryClickGreenAcceptButtonAsync(IntPtr window, Rectangle monitorBounds, CancellationToken cancellationToken)
    {
        var startedAt = DateTimeOffset.UtcNow;
        GreenButtonCandidate? candidate = null;
        var loginClicked = false;
        for (var attempt = 1; attempt <= 24; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var visibleUmeWindows = FindWindows(IsUmeProcess, visibleOnly: true);
            var activeTarget = visibleUmeWindows.Contains(window) ? window : visibleUmeWindows.FirstOrDefault();
            if (activeTarget != IntPtr.Zero)
            {
                BringWindowToTop(activeTarget);
                SetForegroundWindow(activeTarget);
            }
            await Task.Delay(150, cancellationToken);
            var target = FindBestGreenButtonTarget(monitorBounds);
            if (target is not null)
            {
                candidate = target.Candidate;
                BringWindowToTop(target.Window);
                SetForegroundWindow(target.Window);
                await Task.Delay(80, cancellationToken);
                ClickScreenPoint(candidate.CenterX, candidate.CenterY);
                await Task.Delay(250, cancellationToken);
                return new
                {
                    attempted = true,
                    clicked = true,
                    method = "green-color-detection",
                    elapsedMs = (int)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds,
                    loginRecoveryClicked = loginClicked,
                    candidate = new { candidate.CenterX, candidate.CenterY, candidate.Width, candidate.Height, candidate.Score, target.Title }
                };
            }
            if (!loginClicked)
            {
                var loginTarget = FindBestBlueLoginButtonTarget(monitorBounds);
                if (loginTarget is not null)
                {
                    loginClicked = true;
                    BringWindowToTop(loginTarget.Window);
                    SetForegroundWindow(loginTarget.Window);
                    await Task.Delay(120, cancellationToken);
                    ClickScreenPoint(loginTarget.Candidate.CenterX, loginTarget.Candidate.CenterY);
                    await Task.Delay(700, cancellationToken);
                }
            }
            await Task.Delay(100, cancellationToken);
        }
        return new
        {
            attempted = true,
            clicked = false,
            method = "green-color-detection",
            elapsedMs = (int)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds,
            loginRecoveryClicked = loginClicked,
            reason = "녹색 참가/수락 버튼 후보를 찾지 못했습니다."
        };
    }

    private static GreenButtonTarget? FindBestGreenButtonTarget(Rectangle monitorBounds)
    {
        GreenButtonTarget? best = null;
        foreach (var info in FindWindows(IsUmeProcess, visibleOnly: true).Select(ToWindowInfo))
        {
            var candidate = FindGreenButtonCandidate(info.Handle, monitorBounds);
            if (candidate is null) continue;
            var target = new GreenButtonTarget(info.Handle, info.Title, candidate);
            if (best is null || target.Candidate.Score > best.Candidate.Score) best = target;
        }
        return best;
    }

    private static GreenButtonTarget? FindBestBlueLoginButtonTarget(Rectangle monitorBounds)
    {
        GreenButtonTarget? best = null;
        foreach (var info in FindWindows(IsUmeProcess, visibleOnly: true).Select(ToWindowInfo))
        {
            if (!IsCompactLoginCandidate(info, monitorBounds)) continue;
            var candidate = FindButtonCandidate(info.Handle, monitorBounds, IsLoginBlue);
            if (candidate is null) continue;
            var target = new GreenButtonTarget(info.Handle, info.Title, candidate);
            if (best is null || target.Candidate.Score > best.Candidate.Score) best = target;
        }
        return best;
    }

    private static bool IsCompactLoginCandidate(WindowInfo info, Rectangle monitorBounds)
    {
        if (IsMeetingWindow(info)) return false;
        if (info.Bounds.Width <= 0 || info.Bounds.Height <= 0) return false;
        var monitorArea = monitorBounds.Width * monitorBounds.Height;
        var windowArea = info.Bounds.Width * info.Bounds.Height;
        return info.Bounds.Width <= 900
               && info.Bounds.Height <= 700
               && (monitorArea <= 0 || windowArea <= monitorArea * 0.12);
    }

    private static GreenButtonCandidate? FindGreenButtonCandidate(IntPtr window, Rectangle monitorBounds)
        => FindButtonCandidate(window, monitorBounds, IsAcceptGreen);

    private static GreenButtonCandidate? FindButtonCandidate(IntPtr window, Rectangle monitorBounds, Func<Color, bool> predicate)
    {
        var captureBounds = monitorBounds;
        if (GetWindowRect(window, out var rect))
        {
            var windowBounds = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
            captureBounds = Rectangle.Intersect(monitorBounds, windowBounds);
            if (captureBounds.Width <= 0 || captureBounds.Height <= 0) captureBounds = monitorBounds;
        }

        using var bitmap = new Bitmap(captureBounds.Width, captureBounds.Height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.CopyFromScreen(captureBounds.Left, captureBounds.Top, 0, 0, captureBounds.Size, CopyPixelOperation.SourceCopy);
        }

        const int step = 4;
        var gridWidth = Math.Max(1, bitmap.Width / step);
        var gridHeight = Math.Max(1, bitmap.Height / step);
        var mask = new bool[gridWidth, gridHeight];
        for (var gy = 0; gy < gridHeight; gy++)
        {
            for (var gx = 0; gx < gridWidth; gx++)
            {
                var color = bitmap.GetPixel(Math.Min(gx * step, bitmap.Width - 1), Math.Min(gy * step, bitmap.Height - 1));
                mask[gx, gy] = predicate(color);
            }
        }

        var visited = new bool[gridWidth, gridHeight];
        GreenButtonCandidate? best = null;
        var queue = new Queue<(int X, int Y)>();
        for (var y = 0; y < gridHeight; y++)
        {
            for (var x = 0; x < gridWidth; x++)
            {
                if (!mask[x, y] || visited[x, y]) continue;
                visited[x, y] = true;
                queue.Enqueue((x, y));
                var count = 0;
                var minX = x;
                var maxX = x;
                var minY = y;
                var maxY = y;
                while (queue.Count > 0)
                {
                    var point = queue.Dequeue();
                    count++;
                    minX = Math.Min(minX, point.X);
                    maxX = Math.Max(maxX, point.X);
                    minY = Math.Min(minY, point.Y);
                    maxY = Math.Max(maxY, point.Y);
                    foreach (var next in Neighbors(point.X, point.Y, gridWidth, gridHeight))
                    {
                        if (visited[next.X, next.Y] || !mask[next.X, next.Y]) continue;
                        visited[next.X, next.Y] = true;
                        queue.Enqueue(next);
                    }
                }

                var width = (maxX - minX + 1) * step;
                var height = (maxY - minY + 1) * step;
                var area = width * height;
                if (count < 40 || width < 32 || height < 24 || area < 1_200) continue;
                if (height > captureBounds.Height * 0.35 || width > captureBounds.Width * 0.45) continue;

                var score = count * step * step;
                var candidate = new GreenButtonCandidate(
                    captureBounds.Left + ((minX + maxX + 1) * step / 2),
                    captureBounds.Top + ((minY + maxY + 1) * step / 2),
                    width,
                    height,
                    score);
                if (best is null || candidate.Score > best.Score) best = candidate;
            }
        }
        return best;
    }

    private static bool IsAcceptGreen(Color color)
    {
        var r = color.R;
        var g = color.G;
        var b = color.B;
        return g >= 120
               && g >= r + 35
               && g >= b + 25
               && r <= 170
               && b <= 170;
    }

    private static bool IsLoginBlue(Color color)
    {
        var r = color.R;
        var g = color.G;
        var b = color.B;
        return b >= 170
               && g >= 85
               && b >= r + 45
               && b >= g + 25
               && r <= 130;
    }

    private static IEnumerable<(int X, int Y)> Neighbors(int x, int y, int width, int height)
    {
        if (x > 0) yield return (x - 1, y);
        if (x + 1 < width) yield return (x + 1, y);
        if (y > 0) yield return (x, y - 1);
        if (y + 1 < height) yield return (x, y + 1);
    }

    private static void ClickScreenPoint(int x, int y)
    {
        SetCursorPos(x, y);
        var inputs = new[]
        {
            new Input { Type = InputMouse, Mouse = new MouseInput { Flags = MouseEventFLeftDown } },
            new Input { Type = InputMouse, Mouse = new MouseInput { Flags = MouseEventFLeftUp } },
        };
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct Rect
    {
        public readonly int Left;
        public readonly int Top;
        public readonly int Right;
        public readonly int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public MouseInput Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int Dx;
        public int Dy;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    private sealed record GreenButtonCandidate(int CenterX, int CenterY, int Width, int Height, int Score);
    private sealed record GreenButtonTarget(IntPtr Window, string Title, GreenButtonCandidate Candidate);
    private sealed record WindowInfo(IntPtr Handle, string Title, string ClassName, Rectangle Bounds);
}
