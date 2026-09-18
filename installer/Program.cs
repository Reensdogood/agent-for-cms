namespace Funnet.Gwanak.Agent.Installer;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
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
}
