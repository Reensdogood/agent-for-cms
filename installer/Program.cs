namespace Funnet.Gwanak.Agent.Installer;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var update = args.Contains("--update", StringComparer.OrdinalIgnoreCase);
        var form = new InstallerForm(args.Contains("--configure", StringComparer.OrdinalIgnoreCase) || update, update);
        if (update) form.Shown += async (_, _) => await form.RunUpdateAsync();
        Application.Run(form);
    }
}
