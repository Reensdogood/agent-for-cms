using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;

namespace Funnet.Gwanak.Agent.Installer;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // A legacy elevated Agent must be able to start an update installer
        // without ShellExecute creating an unreachable second UAC prompt.
        // The asInvoker executable inherits that elevated token.  A direct
        // operator launch is immediately relaunched with one explicit UAC
        // confirmation before it can modify files or scheduled tasks.
        if (!IsElevated())
        {
            try
            {
                var executable = Environment.ProcessPath ?? throw new InvalidOperationException("설치기 경로를 확인할 수 없습니다.");
                Process.Start(new ProcessStartInfo(executable, string.Join(" ", args.Select(QuoteArgument)))
                {
                    UseShellExecute = true,
                    Verb = "runas",
                });
            }
            catch (Win32Exception error) when (error.NativeErrorCode == 1223)
            {
                MessageBox.Show("Agent 설치에는 관리자 권한이 필요합니다.", "Funnet Agent 설치", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (Exception error)
            {
                MessageBox.Show($"관리자 권한 설치기를 시작하지 못했습니다.\n\n{error.Message}", "Funnet Agent 설치", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return;
        }

        ApplicationConfiguration.Initialize();
        using var mutex = new Mutex(true, @"Local\funnet-gwanak-agent-setup", out var firstInstance);
        if (!firstInstance)
        {
            MessageBox.Show("Agent 설정창이 이미 열려 있습니다.", "Funnet 관악 Agent", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        try
        {
            var update = args.Contains("--update", StringComparer.OrdinalIgnoreCase);
            var form = new InstallerForm(args.Contains("--configure", StringComparer.OrdinalIgnoreCase) || update, update);
            if (update) form.Shown += async (_, _) => await form.RunUpdateAsync();
            Application.Run(form);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Funnet Agent 설치", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static bool IsElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static string QuoteArgument(string value)
        => value.IndexOfAny([' ', '\t', '"']) >= 0 ? $"\"{value.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"" : value;
}
