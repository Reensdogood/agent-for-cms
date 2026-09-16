using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Diagnostics;

namespace Funnet.Gwanak.Agent.Services;

internal sealed class PackageDeploymentService(AgentApiClient apiClient)
{
    public async Task<object> DownloadAsync(string downloadPath, string fileName, string version,
        string expectedSha256, long expectedSize, CancellationToken cancellationToken)
        => await DownloadCoreAsync(downloadPath, fileName, version, expectedSha256, expectedSize, true, cancellationToken);

    public async Task<object> DownloadAgentAsync(string downloadPath, string fileName, string version,
        string expectedSha256, long expectedSize, CancellationToken cancellationToken)
    {
        var result = await DownloadCoreAsync(downloadPath, fileName, version, expectedSha256, expectedSize, false, cancellationToken);
        var path = result.GetType().GetProperty("path")?.GetValue(result)?.ToString() ?? throw new InvalidOperationException("에이전트 파일 경로가 없습니다.");
        return new AgentPackage(version, fileName, path, expectedSha256);
    }

    public static void StartAgentUpdate(AgentPackage package)
    {
        Process.Start(new ProcessStartInfo(package.Path, "--update") { UseShellExecute = true });
    }

    internal sealed record AgentPackage(string Version, string FileName, string Path, string Sha256);

    private async Task<object> DownloadCoreAsync(string downloadPath, string fileName, string version,
        string expectedSha256, long expectedSize, bool requireSignature, CancellationToken cancellationToken)
    {
        if (!fileName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
            (requireSignature && !fileName.StartsWith("UME-release-", StringComparison.OrdinalIgnoreCase)) ||
            (!requireSignature && !fileName.StartsWith("Funnet.Gwanak.Agent-", StringComparison.OrdinalIgnoreCase) && !fileName.StartsWith("funnet-agent-setup-", StringComparison.OrdinalIgnoreCase) && !fileName.StartsWith("funnet-gwanak-agent-setup-", StringComparison.OrdinalIgnoreCase)) ||
            fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new InvalidOperationException("허용되지 않은 배포 파일명입니다.");

        var baseDataDir = Environment.GetEnvironmentVariable("FUNNET_AGENT_DATA_DIR");
        if (string.IsNullOrWhiteSpace(baseDataDir))
        {
            baseDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Funnet", "funnet-gwanak-agent");
        }

        var directory = Path.Combine(baseDataDir, "packages", version);
        var destination = Path.Combine(directory, Path.GetFileName(fileName));
        await apiClient.DownloadPackageAsync(downloadPath, destination, cancellationToken);

        var info = new FileInfo(destination);
        if (expectedSize > 0 && info.Length != expectedSize)
        {
            File.Delete(destination);
            throw new InvalidOperationException("다운로드 파일 크기가 서버 정보와 일치하지 않습니다.");
        }

        await using var stream = File.OpenRead(destination);
        var actualSha256 = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken));
        if (!actualSha256.Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(destination);
            throw new InvalidOperationException("다운로드 파일의 SHA-256 검증에 실패했습니다.");
        }

        if (requireSignature && !AuthenticodeVerifier.IsTrusted(destination))
        {
            File.Delete(destination);
            throw new InvalidOperationException("UME 설치파일의 Windows 전자서명을 신뢰할 수 없습니다.");
        }

        var publisher = requireSignature ? new X509Certificate2(X509Certificate.CreateFromSignedFile(destination)).Subject : "SHA-256 verified";

        return new { version, fileName, path = destination, sizeBytes = info.Length, sha256 = actualSha256, publisher, installed = false };
    }

    private static class AuthenticodeVerifier
    {
        private static readonly Guid ActionGenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustFileInfo
        {
            public uint StructSize;
            public IntPtr FilePath;
            public IntPtr FileHandle;
            public IntPtr KnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustData
        {
            public uint StructSize;
            public IntPtr PolicyCallbackData;
            public IntPtr SipClientData;
            public uint UiChoice;
            public uint RevocationChecks;
            public uint UnionChoice;
            public IntPtr FileInfo;
            public uint StateAction;
            public IntPtr StateData;
            public string? UrlReference;
            public uint ProviderFlags;
            public uint UiContext;
        }

        [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int WinVerifyTrust(IntPtr window, [In] ref Guid actionId, [In] ref WinTrustData data);

        public static bool IsTrusted(string filePath)
        {
            var pathPointer = Marshal.StringToCoTaskMemUni(filePath);
            var fileInfo = new WinTrustFileInfo
            {
                StructSize = (uint)Marshal.SizeOf<WinTrustFileInfo>(),
                FilePath = pathPointer,
            };
            var fileInfoPointer = Marshal.AllocCoTaskMem(Marshal.SizeOf<WinTrustFileInfo>());
            try
            {
                Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);
                var data = new WinTrustData
                {
                    StructSize = (uint)Marshal.SizeOf<WinTrustData>(),
                    UiChoice = 2,
                    RevocationChecks = 0,
                    UnionChoice = 1,
                    FileInfo = fileInfoPointer,
                    ProviderFlags = 0x00001000,
                };
                var action = ActionGenericVerifyV2;
                return WinVerifyTrust(IntPtr.Zero, ref action, ref data) == 0;
            }
            finally
            {
                Marshal.FreeCoTaskMem(fileInfoPointer);
                Marshal.FreeCoTaskMem(pathPointer);
            }
        }
    }
}
