using System.Diagnostics;
using System.Runtime.InteropServices;

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
    private const uint SwpNoOwnerZOrder = 0x0200;
    private const uint SwpShowWindow = 0x0040;
    private const int SwRestore = 9;
    private const int SwHide = 0;
    private static readonly IntPtr HwndTopmost = new(-1);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
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

        List<IntPtr> windows = [];
        for (var attempt = 0; attempt < 24 && windows.Count == 0; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(250, cancellationToken);
            windows = FindWindows(IsUmeProcess, visibleOnly: true);
        }
        if (windows.Count == 0) throw new InvalidOperationException("UME 창이 제한 시간 안에 나타나지 않았습니다.");

        var bounds = Screen.PrimaryScreen?.Bounds ?? throw new InvalidOperationException("주 디스플레이를 찾을 수 없습니다.");
        var positioned = 0;
        foreach (var window in windows)
        {
            ShowWindow(window, SwRestore);
            var style = GetLong(window, GwlStyle) & ~(WsCaption | WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSysMenu);
            var exStyle = GetLong(window, GwlExStyle) & ~(WsExDlgModalFrame | WsExClientEdge | WsExStaticEdge);
            SetLong(window, GwlStyle, style);
            SetLong(window, GwlExStyle, exStyle);
            if (SetWindowPos(window, HwndTopmost, bounds.Left, bounds.Top, bounds.Width, bounds.Height,
                    SwpFrameChanged | SwpNoOwnerZOrder | SwpShowWindow)) positioned++;
        }
        var target = windows[^1];
        BringWindowToTop(target);
        SetForegroundWindow(target);
        return new { installation.Name, installation.Version, windowCount = windows.Count, positioned, monitor = new { bounds.X, bounds.Y, bounds.Width, bounds.Height } };
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

    private static bool IsUmeProcess(Process process) =>
        process.ProcessName.Equals("UME", StringComparison.OrdinalIgnoreCase) ||
        process.ProcessName.Equals("UME global", StringComparison.OrdinalIgnoreCase);

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
}
