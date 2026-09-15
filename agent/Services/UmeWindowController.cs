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
    private const int SwRestore = 9;
    private const int SwHide = 0;
    private const uint InputMouse = 0;
    private const uint MouseEventFLeftDown = 0x0002;
    private const uint MouseEventFLeftUp = 0x0004;
    private static readonly IntPtr HwndTop = new(0);
    private static readonly IntPtr HwndNoTopmost = new(-2);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
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
        Process.Start(new ProcessStartInfo(installation.Path) { UseShellExecute = true });

        List<WindowInfo> windows = [];
        for (var attempt = 0; attempt < 24 && windows.Count == 0; attempt++)
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
                SetWindowPos(window, HwndTop, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoOwnerZOrder | SwpShowWindow);
                SetWindowPos(window, HwndNoTopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoOwnerZOrder | SwpShowWindow);
                mainWindowsPrepared++;
            }
        }
        var promotedMeeting = PromoteMeetingWindow(bounds);
        var target = promotedMeeting
                     ?? windows.LastOrDefault(info => IsMainWindowCandidate(info, bounds))?.Handle
                     ?? windows[^1].Handle;
        BringWindowToTop(target);
        SetForegroundWindow(target);
        var acceptClick = await TryClickGreenAcceptButtonAsync(target, bounds, cancellationToken);
        promotedMeeting = PromoteMeetingWindow(bounds);
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
        var didWindows = FindWindows(IsIvisionProcess, visibleOnly: true);
        var restored = false;
        if (didWindows.Count > 0)
        {
            var target = didWindows[^1];
            BringWindowToTop(target);
            restored = SetForegroundWindow(target);
        }
        return new { umeWindowsHidden = umeWindows.Count, iVisionWindowFound = didWindows.Count > 0, iVisionForegroundRequested = restored };
    }

    public bool PrioritizeMeetingWindowIfVisible()
    {
        var bounds = Screen.PrimaryScreen?.Bounds ?? Rectangle.Empty;
        if (bounds.IsEmpty) return false;
        return PromoteMeetingWindow(bounds) is not null;
    }

    public async Task<bool> TryClickForegroundGreenAcceptButtonAsync(CancellationToken cancellationToken)
    {
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
        return new WindowInfo(window, text.ToString(), Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom));
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

    private static void MakeBorderlessFullscreen(IntPtr window, Rectangle bounds)
    {
        ShowWindow(window, SwRestore);
        var style = GetLong(window, GwlStyle) & ~(WsCaption | WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSysMenu);
        var exStyle = GetLong(window, GwlExStyle) & ~(WsExDlgModalFrame | WsExClientEdge | WsExStaticEdge);
        SetLong(window, GwlStyle, style);
        SetLong(window, GwlExStyle, exStyle);
        // 회의창은 전체화면으로만 배치한다. TopMost/반복적인 Foreground 강제는
        // 사용자의 마우스·키보드 입력을 가로채므로 사용하지 않는다.
        SetWindowPos(window, HwndNoTopmost, bounds.Left, bounds.Top, bounds.Width, bounds.Height,
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
    private sealed record WindowInfo(IntPtr Handle, string Title, Rectangle Bounds);
}
