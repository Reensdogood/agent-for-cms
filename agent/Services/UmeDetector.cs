using System.Diagnostics;
using Microsoft.Win32;
using Funnet.Gwanak.Agent.Models;

namespace Funnet.Gwanak.Agent.Services;

internal sealed class UmeDetector
{
    private static readonly string[] AllowedExecutables = ["UME.exe", "UME global.exe"];

    public IReadOnlyList<UmeInstallation> DetectAll()
    {
        var executablePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CollectFromRegistry(executablePaths);
        CollectFromKnownFolders(executablePaths);

        var runningPaths = RunningUmePaths();
        var results = executablePaths
            .Select(path => ToInstallation(path, runningPaths))
            .Where(value => value is not null)
            .Cast<UmeInstallation>()
            .OrderByDescending(value => ParseVersion(value.Version))
            .ThenBy(value => value.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return results;
    }

    public UmeInstallation? DetectPreferred() => DetectAll().FirstOrDefault();

    private static void CollectFromRegistry(HashSet<string> executablePaths)
    {
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(hive, view);
                using var uninstall = baseKey.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall");
                if (uninstall is null) continue;
                foreach (var subKeyName in uninstall.GetSubKeyNames())
                {
                    using var subKey = uninstall.OpenSubKey(subKeyName);
                    var displayName = subKey?.GetValue("DisplayName") as string;
                    if (string.IsNullOrWhiteSpace(displayName) ||
                        !(displayName.Equals("UME", StringComparison.OrdinalIgnoreCase) ||
                          displayName.Equals("UME global", StringComparison.OrdinalIgnoreCase))) continue;

                    var installLocation = subKey?.GetValue("InstallLocation") as string;
                    var uninstallString = subKey?.GetValue("UninstallString") as string;
                    if (!string.IsNullOrWhiteSpace(installLocation)) CollectExecutables(installLocation, executablePaths);
                    var uninstallPath = ExtractQuotedPath(uninstallString);
                    if (!string.IsNullOrWhiteSpace(uninstallPath))
                        CollectExecutables(Path.GetDirectoryName(uninstallPath), executablePaths);
                }
            }
            catch (UnauthorizedAccessException) { }
            catch (System.Security.SecurityException) { }
        }
    }

    private static void CollectFromKnownFolders(HashSet<string> executablePaths)
    {
        var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (!string.IsNullOrWhiteSpace(local))
        {
            folders.Add(Path.Combine(local, "UME"));
            folders.Add(Path.Combine(local, "UME global"));
        }

        var profile = Environment.GetEnvironmentVariable("USERPROFILE");
        if (!string.IsNullOrWhiteSpace(profile))
        {
            var realLocal = Path.Combine(profile, "AppData", "Local");
            folders.Add(Path.Combine(realLocal, "UME"));
            folders.Add(Path.Combine(realLocal, "UME global"));
        }

        foreach (var folder in folders)
            CollectExecutables(folder, executablePaths);
    }

    private static void CollectExecutables(string? root, HashSet<string> executablePaths)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return;
        try
        {
            foreach (var executableName in AllowedExecutables)
            foreach (var path in Directory.EnumerateFiles(root, executableName, SearchOption.AllDirectories))
            {
                var fullPath = Path.GetFullPath(path);
                if (!IsPackagedLocalCachePath(fullPath)) executablePaths.Add(fullPath);
            }
        }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }
    }

    private static bool IsPackagedLocalCachePath(string path) =>
        path.Contains(@"\AppData\Local\Packages\", StringComparison.OrdinalIgnoreCase)
        && path.Contains(@"\LocalCache\Local\UME", StringComparison.OrdinalIgnoreCase);

    private static HashSet<string> RunningUmePaths()
    {
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (!(process.ProcessName.Equals("UME", StringComparison.OrdinalIgnoreCase) ||
                      process.ProcessName.Equals("UME global", StringComparison.OrdinalIgnoreCase))) continue;
                var path = process.MainModule?.FileName;
                if (!string.IsNullOrWhiteSpace(path)) paths.Add(Path.GetFullPath(path));
            }
            catch { }
            finally { process.Dispose(); }
        }
        return paths;
    }

    private static UmeInstallation? ToInstallation(string path, HashSet<string> runningPaths)
    {
        try
        {
            var info = FileVersionInfo.GetVersionInfo(path);
            var productName = string.IsNullOrWhiteSpace(info.ProductName)
                ? Path.GetFileNameWithoutExtension(path)
                : info.ProductName;
            if (!productName.StartsWith("UME", StringComparison.OrdinalIgnoreCase)) return null;
            var version = NormalizeVersion(info.ProductVersion) ?? NormalizeVersion(info.FileVersion) ?? VersionFromPath(path) ?? "unknown";
            return new UmeInstallation(productName, version, path, runningPaths.Contains(Path.GetFullPath(path)));
        }
        catch
        {
            return null;
        }
    }

    private static string? ExtractQuotedPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (value[0] == '"')
        {
            var end = value.IndexOf('"', 1);
            return end > 1 ? value[1..end] : null;
        }
        var split = value.IndexOf(' ');
        return split > 0 ? value[..split] : value;
    }

    private static string? NormalizeVersion(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var numeric = new string(value.TakeWhile(character => char.IsDigit(character) || character == '.').ToArray());
        return string.IsNullOrWhiteSpace(numeric) ? null : numeric.TrimEnd('.');
    }

    private static string? VersionFromPath(string path) => path
        .Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
        .Select(NormalizeVersion)
        .FirstOrDefault(value => value is not null && value.Count(character => character == '.') >= 2);

    private static Version ParseVersion(string value) => Version.TryParse(value, out var parsed) ? parsed : new Version(0, 0);
}
