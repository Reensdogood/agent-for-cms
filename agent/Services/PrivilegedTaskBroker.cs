using System.Diagnostics;
using System.Security.Principal;

namespace Funnet.Gwanak.Agent.Services;

/// <summary>
/// 중앙 서버 명령이 관리자 권한을 필요로 할 때 사용하는 로컬 브로커입니다.
/// 임의의 명령 문자열을 실행하지 않고, 설치 시 등록된 allow-list 작업만 실행합니다.
/// </summary>
internal static class PrivilegedTaskBroker
{
    internal const string AgentTask = "Funnet Gwanak Agent";
    internal const string IvisionLauncherTask = "Funnet i-Vision Launcher";

    internal static bool IsElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    internal static bool RunIvisionLauncher()
    {
        return RunTask(IvisionLauncherTask);
    }

    internal static bool RunAgent()
    {
        return RunTask(AgentTask);
    }

    internal static bool RunTask(string taskName)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Run /TN \"{taskName}\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (process is null) return false;
            process.WaitForExit(5000);
            return process.ExitCode == 0;
        }
        catch { return false; }
    }

    internal static bool TaskExists(string taskName)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Query /TN \"{taskName}\"")
            { CreateNoWindow = true, UseShellExecute = false });
            process?.WaitForExit(3000);
            return process?.ExitCode == 0;
        }
        catch { return false; }
    }
}
