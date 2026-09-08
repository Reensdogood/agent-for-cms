using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Funnet.Gwanak.Agent.Infrastructure;

internal sealed class DeviceIdentityStore
{
    private readonly string _directory;

    public DeviceIdentityStore()
    {
        var overrideDirectory = Environment.GetEnvironmentVariable("FUNNET_AGENT_DATA_DIR");
        _directory = string.IsNullOrWhiteSpace(overrideDirectory)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Funnet", "funnet-gwanak-agent")
            : Path.GetFullPath(overrideDirectory);
    }

    private string IdentityPath => Path.Combine(_directory, "identity.json");

    public DeviceIdentity LoadOrCreate()
    {
        Directory.CreateDirectory(_directory);
        if (File.Exists(IdentityPath))
        {
            var value = JsonSerializer.Deserialize<DeviceIdentity>(File.ReadAllText(IdentityPath), JsonDefaults.Standard);
            if (value is not null && Guid.TryParse(value.InstallationId, out _)) return value;
        }

        var identity = new DeviceIdentity();
        Save(identity);
        return identity;
    }

    public void Save(DeviceIdentity identity)
    {
        Directory.CreateDirectory(_directory);
        var temporary = IdentityPath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(identity, JsonDefaults.Indented));
        File.Move(temporary, IdentityPath, true);
    }

    public void SetDeviceCredentials(DeviceIdentity identity, string deviceId, string deviceToken)
    {
        identity.DeviceId = deviceId;
        identity.ProtectedDeviceToken = Convert.ToBase64String(Dpapi.Protect(Encoding.UTF8.GetBytes(deviceToken)));
        Save(identity);
    }

    public string? GetDeviceToken(DeviceIdentity identity)
    {
        if (string.IsNullOrWhiteSpace(identity.ProtectedDeviceToken)) return null;
        try
        {
            return Encoding.UTF8.GetString(Dpapi.Unprotect(Convert.FromBase64String(identity.ProtectedDeviceToken)));
        }
        catch
        {
            return null;
        }
    }

    private static class Dpapi
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct DataBlob
        {
            public int Size;
            public IntPtr Data;
        }

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptProtectData(ref DataBlob input, string? description, IntPtr entropy,
            IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

        [DllImport("crypt32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, IntPtr entropy,
            IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        public static byte[] Protect(byte[] input) => Transform(input, true);
        public static byte[] Unprotect(byte[] input) => Transform(input, false);

        private static byte[] Transform(byte[] input, bool protect)
        {
            var inputPointer = Marshal.AllocHGlobal(input.Length);
            try
            {
                Marshal.Copy(input, 0, inputPointer, input.Length);
                var inputBlob = new DataBlob { Size = input.Length, Data = inputPointer };
                DataBlob outputBlob;
                var success = protect
                    ? CryptProtectData(ref inputBlob, "funnet-gwanak-agent", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out outputBlob)
                    : CryptUnprotectData(ref inputBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out outputBlob);
                if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                try
                {
                    var output = new byte[outputBlob.Size];
                    Marshal.Copy(outputBlob.Data, output, 0, outputBlob.Size);
                    return output;
                }
                finally
                {
                    LocalFree(outputBlob.Data);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(inputPointer);
            }
        }
    }
}
