namespace Funnet.Gwanak.Agent.Installer;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new InstallerForm(args.Contains("--configure", StringComparer.OrdinalIgnoreCase)));
    }
}
