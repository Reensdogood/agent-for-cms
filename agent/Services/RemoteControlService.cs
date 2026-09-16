using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Funnet.Gwanak.Agent.Services;

/// <summary>
/// 제한된 원격 지원 기능. 임의 셸/윈도우 메시지는 허용하지 않고 주 화면 스냅샷과
/// 명시된 키·클릭만 처리합니다. UAC 보안 데스크톱은 대상에 포함하지 않습니다.
/// </summary>
internal static class RemoteControlService
{
    private static readonly HashSet<string> AllowedKeys = new(StringComparer.OrdinalIgnoreCase)
        { "LEFT", "RIGHT", "UP", "DOWN", "ENTER", "ESC", "TAB", "SPACE" };
    private const uint KeyUp = 0x0002;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;

    internal static object CapturePrimaryScreen()
    {
        var bounds = Screen.PrimaryScreen?.Bounds ?? throw new InvalidOperationException("주 화면을 찾을 수 없습니다.");
        using var source = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(source))
            graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, source.Size, CopyPixelOperation.SourceCopy);
        const int maxWidth = 1280;
        using var image = source.Width > maxWidth
            ? new Bitmap(source, new Size(maxWidth, Math.Max(1, source.Height * maxWidth / source.Width)))
            : new Bitmap(source);
        using var stream = new MemoryStream();
        image.Save(stream, ImageFormat.Jpeg);
        return new { format = "jpeg", width = image.Width, height = image.Height, imageBase64 = Convert.ToBase64String(stream.ToArray()) };
    }

    internal static object SendKey(string key)
    {
        if (!AllowedKeys.Contains(key)) throw new InvalidOperationException("허용되지 않은 키입니다.");
        var virtualKey = key.ToUpperInvariant() switch
        {
            "LEFT" => 0x25, "UP" => 0x26, "RIGHT" => 0x27, "DOWN" => 0x28,
            "ENTER" => 0x0D, "ESC" => 0x1B, "TAB" => 0x09, "SPACE" => 0x20, _ => 0
        };
        keybd_event((byte)virtualKey, 0, 0, UIntPtr.Zero);
        keybd_event((byte)virtualKey, 0, KeyUp, UIntPtr.Zero);
        return new { key = key.ToUpperInvariant(), accepted = true };
    }

    internal static bool IsAllowedKey(string key) => AllowedKeys.Contains(key);

    internal static object Click(int x, int y)
    {
        var bounds = Screen.PrimaryScreen?.Bounds ?? throw new InvalidOperationException("주 화면을 찾을 수 없습니다.");
        if (x < 0 || y < 0 || x >= bounds.Width || y >= bounds.Height) throw new InvalidOperationException("화면 범위를 벗어난 좌표입니다.");
        SetCursorPos(bounds.Left + x, bounds.Top + y);
        mouse_event(MouseLeftDown | MouseLeftUp, 0, 0, 0, UIntPtr.Zero);
        return new { x, y, accepted = true };
    }

    [DllImport("user32.dll")] private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
