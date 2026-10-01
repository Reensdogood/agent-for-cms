using System.Diagnostics;
using Funnet.Gwanak.Agent.Infrastructure;

namespace Funnet.Gwanak.Agent.Services;

/// <summary>
/// Restarts the elevated Agent without racing its single-instance mutex.
/// The short-lived handoff process is the same signed Agent executable, so it
/// keeps the current elevated token, waits for the tray process to exit, then
/// asks the registered task to start the next primary instance and verifies it.
/// </summary>
internal static class AgentRestartHandoff
{
    private const int ExitWaitMilliseconds = 15_000;
    private const int StartWaitMilliseconds = 12_000;

    internal static bool Start(int previousProcessId, out string error)
    {
        error = string.Empty;
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
        {
            error = "현재 Agent 실행 파일 경로를 확인하지 못했습니다.";
            return false;
        }

        try
        {
            var start = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(executable),
            };
            start.ArgumentList.Add("--restart-handoff");
            start.ArgumentList.Add("--previous-pid");
            start.ArgumentList.Add(previousProcessId.ToString());
            if (Process.Start(start) is null)
            {
                error = "재시작 확인 프로세스를 시작하지 못했습니다.";
                return false;
            }
            return true;
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return false;
        }
    }

    internal static int Run(string[] args)
    {
        var previousProcessId = ReadPreviousProcessId(args);
        RuntimeTrace.Write("agent.restart.handoff.started", new { previousProcessId });
        try
        {
            if (previousProcessId is null)
                throw new InvalidOperationException("재시작 대상 Agent 프로세스 ID가 없습니다.");

            WaitForPreviousAgentExit(previousProcessId.Value);
            if (!PrivilegedTaskBroker.TaskExists(PrivilegedTaskBroker.AgentTask))
                throw new InvalidOperationException("Agent 관리자 권한 자동 실행 작업을 찾을 수 없습니다.");
            if (!PrivilegedTaskBroker.RunAgent())
                throw new InvalidOperationException("Agent 관리자 권한 자동 실행 작업을 시작하지 못했습니다.");

            var newProcessId = WaitForNewAgentProcess(previousProcessId.Value);
            RuntimeTrace.Write("agent.restart.handoff.succeeded", new { previousProcessId, newProcessId });
            return 0;
        }
        catch (Exception exception)
        {
            RuntimeTrace.Write("agent.restart.handoff.failed", new { previousProcessId }, exception);
            return 1;
        }
    }

    private static int? ReadPreviousProcessId(string[] args)
    {
        var option = Array.FindIndex(args, value => string.Equals(value, "--previous-pid", StringComparison.OrdinalIgnoreCase));
        return option >= 0 && option + 1 < args.Length && int.TryParse(args[option + 1], out var processId) && processId > 0
            ? processId
            : null;
    }

    private static void WaitForPreviousAgentExit(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            if (!process.HasExited && !process.WaitForExit(ExitWaitMilliseconds))
                throw new TimeoutException("기존 Agent가 종료 시간 안에 종료되지 않았습니다.");
        }
        catch (ArgumentException)
        {
            // The process had already exited before the handoff began.
        }
    }

    private static int WaitForNewAgentProcess(int previousProcessId)
    {
        var ownProcessId = Environment.ProcessId;
        var deadline = Environment.TickCount64 + StartWaitMilliseconds;
        while (Environment.TickCount64 < deadline)
        {
            foreach (var process in Process.GetProcessesByName("funnet-gwanak-agent"))
            {
                try
                {
                    if (process.Id != ownProcessId && process.Id != previousProcessId && !process.HasExited)
                        return process.Id;
                }
                finally { process.Dispose(); }
            }
            Thread.Sleep(250);
        }
        throw new TimeoutException("재시작된 Agent 프로세스를 확인하지 못했습니다.");
    }
}
