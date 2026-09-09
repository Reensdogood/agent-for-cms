using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Microsoft.Win32;
using System.IO.Ports;

namespace Funnet.Gwanak.Agent.Installer;

internal sealed class InstallerForm : Form
{
    private const string RunValueName = "funnet-gwanak-agent";
    private readonly TextBox _serverUrl = new() { Text = "https://agent.funnet.kr", PlaceholderText = "https://agent.funnet.kr" };
    private readonly TextBox _enrollmentKey = new() { UseSystemPasswordChar = true, PlaceholderText = "관리자 화면에서 발급한 장비 등록 키" };
    private readonly TextBox _deviceName = new() { Text = Environment.MachineName };
    private readonly ComboBox _displayPort = new() { DropDownStyle = ComboBoxStyle.DropDown };
    private readonly CheckBox _displayEnabled = new() { Text = "이 장비에서 TV 제어 사용", Checked = true, AutoSize = true };
    private readonly Button _install = new() { Text = "Agent 설치", Height = 48, Dock = DockStyle.Fill, Margin = new Padding(0) };
    private readonly Button _uninstall = new() { Text = "기존 Agent 제거", Height = 42, Dock = DockStyle.Fill, Margin = new Padding(0) };
    private readonly Label _status = new() { AutoSize = false, Height = 44, ForeColor = Color.FromArgb(99, 99, 102), TextAlign = ContentAlignment.MiddleLeft };
    private readonly string _installDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Funnet", "funnet-gwanak-agent");

    private readonly bool _configureOnly;
    private string _existingEnrollmentKey = "";
    public InstallerForm(bool configureOnly = false)
    {
        _configureOnly = configureOnly;
        Text = "Funnet 관악 Agent 설치";
        Width = 560; Height = 850; MinimumSize = new Size(540, 810);
        StartPosition = FormStartPosition.CenterScreen; Font = new Font("Segoe UI", 10F);
        BackColor = Color.FromArgb(245, 245, 247); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;

        var logo = new PictureBox
        {
            Image = LoadLogo(),
            SizeMode = PictureBoxSizeMode.Zoom,
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 0, 0, 2),
        };
        var title = new Label
        {
            Text = "관악 Agent",
            Font = new Font("Segoe UI", 12.5F, FontStyle.Bold),
            ForeColor = Color.FromArgb(58, 58, 60),
            AutoSize = false,
            Height = 28,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.TopCenter,
            Margin = new Padding(0),
        };
        var subtitle = new Label
        {
            Text = "장비를 서버에 연결하고 로그인 시 자동으로 실행합니다.",
            ForeColor = Color.FromArgb(99, 99, 102),
            AutoSize = false,
            Height = 28,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.TopCenter,
            Margin = new Padding(0, 0, 0, 8),
        };
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(44, 34, 44, 42),
            ColumnCount = 1,
            RowCount = 12,
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        panel.Controls.Add(logo);
        panel.Controls.Add(title);
        panel.Controls.Add(subtitle);
        panel.Controls.Add(Field("서버 주소", _serverUrl));
        panel.Controls.Add(Field("장비 등록 키", _enrollmentKey));
        panel.Controls.Add(Field("장비명", _deviceName));
        panel.Controls.Add(Field("Samsung 모델", new Label { Text = "LH75QET (고정)", AutoSize = true, TextAlign = ContentAlignment.MiddleLeft }));
        panel.Controls.Add(Field("디스플레이 COM 포트", _displayPort));
        panel.Controls.Add(Field("TV 제어", _displayEnabled));
        panel.Controls.Add(_install);
        panel.Controls.Add(_uninstall);
        panel.Controls.Add(_status);
        Controls.Add(panel);
        StyleTextBox(_serverUrl);
        StyleTextBox(_enrollmentKey);
        StyleTextBox(_deviceName);
        _displayPort.Dock = DockStyle.Fill;
        _displayPort.Items.AddRange(SerialPort.GetPortNames().OrderBy(x => x).Cast<object>().ToArray());
        LoadExistingSettings();
        StylePrimaryButton(_install);
        StyleSecondaryButton(_uninstall);
        _install.Click += async (_, _) => await InstallAsync();
        _uninstall.Click += (_, _) => Uninstall();
        AcceptButton = _install;
    }

    private void LoadExistingSettings()
    {
        if (!_configureOnly) return;
        var path = Path.Combine(_installDirectory, "agent-settings.json");
        if (!File.Exists(path)) return;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            if (root.TryGetProperty("serverBaseUrl", out var server)) _serverUrl.Text = server.GetString() ?? _serverUrl.Text;
            if (root.TryGetProperty("enrollmentKey", out var key)) _existingEnrollmentKey = key.GetString() ?? "";
            if (root.TryGetProperty("localName", out var name)) _deviceName.Text = name.GetString() ?? _deviceName.Text;
            if (root.TryGetProperty("display", out var display))
            {
                if (display.TryGetProperty("enabled", out var enabled)) _displayEnabled.Checked = enabled.GetBoolean();
                if (display.TryGetProperty("port", out var port) && port.ValueKind == JsonValueKind.String) _displayPort.Text = port.GetString() ?? "";
            }
            _install.Text = "설정 저장";
            _uninstall.Text = "Agent 제거";
            Text = "Funnet 관악 Agent 설정";
        }
        catch { }
    }

    private static Image LoadLogo()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("FunnetLogo")
            ?? throw new InvalidOperationException("Funnet 로고가 설치기에 포함되지 않았습니다.");
        return Image.FromStream(stream);
    }

    private static Control Field(string label, Control input)
    {
        input.Dock = DockStyle.Fill;
        var group = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, Margin = new Padding(0, 6, 0, 0) };
        group.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
        group.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        group.Controls.Add(new Label
        {
            Text = label,
            AutoSize = false,
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
            TextAlign = ContentAlignment.BottomLeft,
            Margin = new Padding(0),
        });
        group.Controls.Add(input);
        return group;
    }

    private Control InstallPath()
    {
        var group = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, Margin = new Padding(0, 4, 0, 10) };
        group.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        group.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        group.Controls.Add(new Label
        {
            Text = "설치 위치",
            ForeColor = Color.FromArgb(99, 99, 102),
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.BottomLeft,
            Margin = new Padding(0),
        });
        group.Controls.Add(new Label
        {
            Text = _installDirectory,
            AutoEllipsis = true,
            Dock = DockStyle.Fill,
            ForeColor = Color.FromArgb(28, 28, 30),
            TextAlign = ContentAlignment.MiddleLeft,
            Margin = new Padding(0),
        });
        return group;
    }

    private static void StyleTextBox(TextBox input)
    {
        input.Height = 38;
        input.Margin = new Padding(0);
        input.BorderStyle = BorderStyle.FixedSingle;
    }

    private static void StylePrimaryButton(Button button)
    {
        button.BackColor = Color.FromArgb(0, 113, 227);
        button.ForeColor = Color.White;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
    }

    private static void StyleSecondaryButton(Button button)
    {
        button.BackColor = Color.White;
        button.ForeColor = Color.FromArgb(28, 28, 30);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = Color.FromArgb(209, 209, 214);
    }

    private async Task InstallAsync()
    {
        if (!Uri.TryCreate(_serverUrl.Text.Trim(), UriKind.Absolute, out var server) || (server.Scheme != "https" && server.Scheme != "http"))
        { ShowStatus("서버 주소를 확인해 주세요.", true); return; }
        if (!_configureOnly && _enrollmentKey.Text.Trim().Length < 16) { ShowStatus("장비 등록 키는 16자 이상이어야 합니다.", true); return; }
        if (string.IsNullOrWhiteSpace(_deviceName.Text)) { ShowStatus("장비명을 입력해 주세요.", true); return; }
        _install.Enabled = false; ShowStatus("설치 중입니다…");
        try
        {
            StopAgent(); Directory.CreateDirectory(_installDirectory);
            var executable = Path.Combine(_installDirectory, "funnet-gwanak-agent.exe");
            await using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("AgentPayload") ?? throw new InvalidOperationException("Agent 파일이 설치기에 포함되지 않았습니다."))
            await using (var output = new FileStream(executable, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true)) await source.CopyToAsync(output);
            var port = _displayPort.Text.Trim();
            var key = string.IsNullOrWhiteSpace(_enrollmentKey.Text) ? _existingEnrollmentKey : _enrollmentKey.Text.Trim();
            var settings = new { serverBaseUrl = server.ToString().TrimEnd('/'), enrollmentKey = key, localName = _deviceName.Text.Trim(), heartbeatSeconds = 30, commandPollSeconds = 5, display = new { enabled = _displayEnabled.Checked, vendor = "samsung", model = "LH75QET", port = string.IsNullOrWhiteSpace(port) ? null : port } };
            await File.WriteAllTextAsync(Path.Combine(_installDirectory, "agent-settings.json"), JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
            var setupCopy = Path.Combine(_installDirectory, "funnet-gwanak-agent-setup.exe");
            if (!_configureOnly && !string.Equals(Process.GetCurrentProcess().MainModule?.FileName, setupCopy, StringComparison.OrdinalIgnoreCase)) File.Copy(Process.GetCurrentProcess().MainModule?.FileName ?? "", setupCopy, true);
            using (var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) run.SetValue(RunValueName, $"\"{executable}\"");
            Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true, WorkingDirectory = _installDirectory });
            _enrollmentKey.Clear();
            ShowStatus("설치 완료 · Agent가 트레이에서 실행 중입니다.");
            BeginInvoke(Close);
        }
        catch (Exception exception) { ShowStatus(exception.Message, true); }
        finally { _install.Enabled = true; }
    }

    public Task RunUpdateAsync() => InstallAsync();

    private void Uninstall()
    {
        if (MessageBox.Show("Agent 실행파일과 자동실행 등록을 제거할까요? 장비 식별 정보는 재설치를 위해 보존됩니다.", "Agent 제거", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        try
        {
            StopAgent(); using (var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) run.DeleteValue(RunValueName, false);
            var executable = Path.Combine(_installDirectory, "funnet-gwanak-agent.exe");
            var settings = Path.Combine(_installDirectory, "agent-settings.json");
            if (File.Exists(executable)) File.Delete(executable); if (File.Exists(settings)) File.Delete(settings);
            ShowStatus("Agent 실행파일과 자동실행 등록을 제거했습니다.");
        }
        catch (Exception exception) { ShowStatus(exception.Message, true); }
    }

    private static void StopAgent()
    {
        foreach (var process in Process.GetProcessesByName("funnet-gwanak-agent"))
        {
            try { process.Kill(); process.WaitForExit(4000); } catch { }
            finally { process.Dispose(); }
        }
    }

    private void ShowStatus(string message, bool error = false) { _status.Text = message; _status.ForeColor = error ? Color.Firebrick : Color.DimGray; }
}
