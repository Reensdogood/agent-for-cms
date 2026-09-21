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
    internal const string IvisionUpdaterPath = @"C:\i-Vision Player\iVisionUpdater.exe";

    internal static bool IsElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    internal static bool RunIvisionLauncher()
    {
        return RunTask(IvisionLauncherTask);
    }

    /// <summary>
    /// i-Vision이 설치된 뒤에도 재실행 작업이 빠지지 않게 보장한다.
    /// 설치되지 않은 장비에서는 성공으로 취급한다. i-Vision 설치 여부는
    /// Agent 설치의 선행조건이 아니며, 설치되는 즉시 이 메서드가 작업을 만든다.
    /// </summary>
    internal static bool EnsureIvisionLauncherTask(out string error)
    {
        error = string.Empty;
        if (!File.Exists(IvisionUpdaterPath)) return true;
        if (TaskExists(IvisionLauncherTask)) return true;
        if (!IsElevated())
        {
            error = "Agent가 관리자 권한으로 실행 중이 아닙니다.";
            return false;
        }

        try
        {
            using (var delete = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Delete /TN \"{IvisionLauncherTask}\" /F")
            { CreateNoWindow = true, UseShellExecute = false }))
                delete?.WaitForExit(3000);

            using var create = Process.Start(new ProcessStartInfo("schtasks.exe",
                $"/Create /TN \"{IvisionLauncherTask}\" /TR \"\\\"{IvisionUpdaterPath}\\\"\" /SC ONCE /ST 23:59 /RL HIGHEST /F")
            { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true });
            if (create is null)
            {
                error = "schtasks 프로세스를 시작하지 못했습니다.";
                return false;
            }
            create.WaitForExit(5000);
            if (create.ExitCode == 0) return true;
            error = create.StandardError.ReadToEnd().Trim();
            if (string.IsNullOrWhiteSpace(error)) error = $"schtasks 종료 코드: {create.ExitCode}";
            return false;
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return false;
        }
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
