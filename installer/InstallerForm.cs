using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Microsoft.Win32;
using System.IO.Ports;

namespace Funnet.Gwanak.Agent.Installer;

internal sealed class InstallerForm : Form
{
    private const string RunValueName = "funnet-gwanak-agent";
    private const string ScheduledTaskName = "Funnet Gwanak Agent";
    private const string IvisionLauncherTaskName = "Funnet i-Vision Launcher";
    private readonly TextBox _serverUrl = new() { Text = "https://agent.funnet.kr", PlaceholderText = "https://agent.funnet.kr" };
    private readonly TextBox _enrollmentKey = new() { UseSystemPasswordChar = true, PlaceholderText = "관리자 화면에서 발급한 등록 지역 키" };
    private readonly TextBox _deviceName = new() { Text = Environment.MachineName };
    private readonly ComboBox _displayModel = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly ComboBox _displayPort = new() { DropDownStyle = ComboBoxStyle.DropDown };
    private readonly CheckBox _displayEnabled = new() { Text = "이 장비에서 TV 제어 사용", Checked = true, AutoSize = true };
    private readonly Button _install = new() { Text = "Agent 설치", Height = 48, Dock = DockStyle.Fill, Margin = new Padding(0) };
    private readonly Button _cancelSettings = new() { Text = "취소", Height = 42, Dock = DockStyle.Fill, Margin = new Padding(0), Visible = false };
    private readonly Button _uninstall = new() { Text = "기존 Agent 제거", Height = 42, Dock = DockStyle.Fill, Margin = new Padding(0) };
    private readonly TextBox _status = new() { Multiline = true, ReadOnly = true, WordWrap = true, ScrollBars = ScrollBars.Vertical, Height = 64, ForeColor = Color.FromArgb(99, 99, 102), BorderStyle = BorderStyle.None, BackColor = Color.FromArgb(245, 245, 247), TabStop = false };
    private readonly string _installDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Funnet", "funnet-gwanak-agent");

    private readonly bool _configureOnly;
    private readonly bool _updateOnly;
    private string _existingEnrollmentKey = "";
    public InstallerForm(bool configureOnly = false, bool updateOnly = false)
    {
        _configureOnly = configureOnly;
        _updateOnly = updateOnly;
        Text = "Funnet 관악 Agent 설치";
        Width = 560; Height = 850; MinimumSize = new Size(540, 720);
        StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.None;
        AutoScroll = false; Font = new Font("Segoe UI", 10F);
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
            RowCount = 13,
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 70));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        panel.Controls.Add(logo);
        panel.Controls.Add(title);
        panel.Controls.Add(subtitle);
        panel.Controls.Add(Field("서버 주소", _serverUrl));
        panel.Controls.Add(Field("등록 지역 키", _enrollmentKey));
        panel.Controls.Add(Field("장비명", _deviceName));
        _displayModel.Items.AddRange(new object[] { "LH75QET", "LH65QET", "LH85QET", "LH65QBC", "LH75QBC", "LH85QBC" });
        _displayModel.SelectedIndex = 0;
        panel.Controls.Add(Field("Samsung 모델", _displayModel));
        panel.Controls.Add(Field("디스플레이 COM 포트", _displayPort));
        panel.Controls.Add(Field("TV 제어", _displayEnabled));
        panel.Controls.Add(_install);
        panel.Controls.Add(_cancelSettings);
        panel.Controls.Add(_uninstall);
        panel.Controls.Add(_status);
        Controls.Add(panel);
        _status.Dock = DockStyle.Fill;
        StyleTextBox(_serverUrl);
        StyleTextBox(_enrollmentKey);
        StyleTextBox(_deviceName);
        _displayPort.Dock = DockStyle.Fill;
        _displayPort.Items.AddRange(SerialPort.GetPortNames().OrderBy(x => x).Cast<object>().ToArray());
        LoadExistingSettings();
        StylePrimaryButton(_install);
        StyleSecondaryButton(_uninstall);
        StyleSecondaryButton(_cancelSettings);
        _install.Click += async (_, _) => await InstallAsync();
        _cancelSettings.Click += (_, _) => Close();
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
                if (display.TryGetProperty("model", out var model) && model.ValueKind == JsonValueKind.String)
                {
                    var configuredModel = model.GetString();
                    var index = _displayModel.Items.IndexOf(configuredModel);
                    if (index >= 0) _displayModel.SelectedIndex = index;
                }
                if (display.TryGetProperty("port", out var port) && port.ValueKind == JsonValueKind.String) _displayPort.Text = port.GetString() ?? "";
            }
            _install.Text = "설정 저장";
            _cancelSettings.Visible = true;
            _uninstall.Text = "Agent 제거";
            _enrollmentKey.Enabled = false;
            _enrollmentKey.BackColor = Color.FromArgb(235, 235, 235);
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
        if (_configureOnly && !_updateOnly)
        {
            await SaveSettingsOnlyAsync();
            return;
        }
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
            var settings = new { serverBaseUrl = server.ToString().TrimEnd('/'), enrollmentKey = key, localName = _deviceName.Text.Trim(), heartbeatSeconds = 30, commandPollSeconds = 5, display = new { enabled = _displayEnabled.Checked, vendor = "samsung", model = _displayModel.SelectedItem?.ToString() ?? "LH75QET", port = string.IsNullOrWhiteSpace(port) ? null : port } };
            await File.WriteAllTextAsync(Path.Combine(_installDirectory, "agent-settings.json"), JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
            var setupCopy = Path.Combine(_installDirectory, "funnet-agent-setup.exe");
            if (!_configureOnly && !string.Equals(Process.GetCurrentProcess().MainModule?.FileName, setupCopy, StringComparison.OrdinalIgnoreCase)) File.Copy(Process.GetCurrentProcess().MainModule?.FileName ?? "", setupCopy, true);
            RegisterElevatedStartup(executable);
            // i-Vision 재실행은 이 예약 작업을 통해서만 관리자 권한으로 수행한다.
            // 등록 실패를 설치 성공으로 처리하면 이후 서버 명령이 원인 없이
            // 실패하므로, 설치 단계에서 즉시 사용자에게 알린다.
            if (!RegisterIvisionLauncher())
                throw new InvalidOperationException("i-Vision 관리자 권한 실행 작업 등록에 실패했습니다. 관리자 권한으로 설치기를 다시 실행해 주세요.");
            StartScheduledAgent();
            _enrollmentKey.Clear();
            ShowStatus("설치 완료 · Agent가 트레이에서 실행 중입니다.");
            BeginInvoke(Close);
        }
        catch (Exception exception) { ShowStatus(exception.Message, true); }
        finally { _install.Enabled = true; }
    }

    public Task RunUpdateAsync() => InstallAsync();

    private async Task SaveSettingsOnlyAsync()
    {
        if (!Uri.TryCreate(_serverUrl.Text.Trim(), UriKind.Absolute, out var server) || (server.Scheme != "https" && server.Scheme != "http"))
        { ShowStatus("서버 주소를 확인해 주세요.", true); return; }
        if (string.IsNullOrWhiteSpace(_deviceName.Text)) { ShowStatus("장비명을 입력해 주세요.", true); return; }
        try
        {
            var port = _displayPort.Text.Trim();
            var settings = new { serverBaseUrl = server.ToString().TrimEnd('/'), enrollmentKey = _existingEnrollmentKey, localName = _deviceName.Text.Trim(), heartbeatSeconds = 30, commandPollSeconds = 5, display = new { enabled = _displayEnabled.Checked, vendor = "samsung", model = _displayModel.SelectedItem?.ToString() ?? "LH75QET", port = string.IsNullOrWhiteSpace(port) ? null : port } };
            await File.WriteAllTextAsync(Path.Combine(_installDirectory, "agent-settings.json"), JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
            ShowStatus("설정을 저장했습니다. Agent를 재시작합니다.");
            StopAgent();
            var executable = Path.Combine(_installDirectory, "funnet-gwanak-agent.exe");
            if (File.Exists(executable)) StartScheduledAgent();
            BeginInvoke((Action)(() => Application.Exit()));
        }
        catch (Exception exception) { ShowStatus(exception.Message, true); }
    }

    private void Uninstall()
    {
        if (MessageBox.Show("Agent 실행파일과 자동실행 등록을 제거할까요? 장비 식별 정보는 재설치를 위해 보존됩니다.", "Agent 제거", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        try
        {
            using (var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) run.DeleteValue(RunValueName, false);
            DeleteScheduledStartup();
            DeleteIvisionLauncher();
            StopAgent();
            var executable = Path.Combine(_installDirectory, "funnet-gwanak-agent.exe");
            var settings = Path.Combine(_installDirectory, "agent-settings.json");
            ScheduleDelete(executable, settings);
            ShowStatus("Agent 종료 및 자동실행 등록을 해제했습니다. 파일은 잠금 해제 후 삭제됩니다.");
            BeginInvoke(Close);
        }
        catch (Exception exception) { ShowStatus(exception.Message, true); }
    }

    private static void StopAgent()
    {
        KillAgentProcesses();
        // Kill(true)가 권한/자식 트리 상태로 실패하는 경우를 대비해 Windows
        // 기본 종료 경로도 사용한다. setup 자신은 이름이 달라 대상에 포함되지 않는다.
        try
        {
            using var taskkill = Process.Start(new ProcessStartInfo("taskkill", "/F /IM funnet-gwanak-agent.exe")
            { CreateNoWindow = true, UseShellExecute = false });
            taskkill?.WaitForExit(5000);
        }
        catch { }
        for (var attempt = 0; attempt < 10; attempt++)
        {
            KillAgentProcesses();
            if (Process.GetProcessesByName("funnet-gwanak-agent").Length == 0) return;
            Thread.Sleep(300);
        }
    }

    private static void KillAgentProcesses()
    {
        foreach (var process in Process.GetProcessesByName("funnet-gwanak-agent"))
        {
            // 설정창/제거창이 Agent의 자식으로 실행될 수 있으므로 Kill(true)로
            // 자식 트리까지 종료하지 않는다. setup 자신이 살아 있어 후속 재시작/삭제를 수행해야 한다.
            try { if (!process.HasExited) { process.Kill(); process.WaitForExit(1500); } }
            catch { }
            finally { process.Dispose(); }
        }
    }

    private static void ScheduleDelete(string executable, string settings)
    {
        var script = $"timeout /t 2 /nobreak >nul & del /f /q \"{executable}\" \"{settings}\"";
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c {script}") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
    }

    private static void RegisterElevatedStartup(string executable)
    {
        // 기존 작업이 LIMITED로 남아 있거나 이전 exe 경로를 가리킬 수 있다.
        // 설치·업데이트 시에는 현재 경로와 HIGHEST 권한을 함께 재등록한다.
        // 설정 저장 경로에서는 이 메서드를 호출하지 않아 불필요한 UAC를 피한다.
        DeleteScheduledStartup();
        using var task = Process.Start(new ProcessStartInfo("schtasks.exe",
            $"/Create /TN \"{ScheduledTaskName}\" /TR \"\\\"{executable}\\\"\" /SC ONLOGON /RL HIGHEST /F")
        {
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
        });
        task?.WaitForExit(15000);
        if (task is null || task.ExitCode != 0) throw new InvalidOperationException("Agent 관리자 권한 자동 실행 등록에 실패했습니다.");
    }

    private static bool RegisterIvisionLauncher()
    {
        const string updater = @"C:\i-Vision Player\iVisionUpdater.exe";
        if (!File.Exists(updater)) return false;
        DeleteIvisionLauncher();
        using var task = Process.Start(new ProcessStartInfo("schtasks.exe",
            $"/Create /TN \"{IvisionLauncherTaskName}\" /TR \"\\\"{updater}\\\"\" /SC ONDEMAND /RL HIGHEST /F")
        {
            // 설치기 자체가 app.manifest의 requireAdministrator로 상승되어
            // 있으므로 runas를 중첩 호출하지 않는다. 중첩 UAC는 Windows 10
            // IoT에서 schtasks 등록 실패로 처리되는 경우가 있다.
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        });
        task?.WaitForExit(15000);
        return task is not null && task.ExitCode == 0;
    }

    private static bool ScheduledTaskExists()
    {
        try
        {
            using var query = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Query /TN \"{ScheduledTaskName}\"")
            { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true });
            query?.WaitForExit(5000);
            return query?.ExitCode == 0;
        }
        catch { return false; }
    }

    private static void StartScheduledAgent()
    {
        if (!ScheduledTaskExists()) throw new InvalidOperationException("Agent 관리자 권한 자동 실행 작업을 찾을 수 없습니다.");
        using var start = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Run /TN \"{ScheduledTaskName}\"")
        { CreateNoWindow = true, UseShellExecute = false });
        start?.WaitForExit(5000);
        if (start is null || start.ExitCode != 0) throw new InvalidOperationException("Agent 관리자 권한 실행을 시작하지 못했습니다.");
    }

    private static void DeleteScheduledStartup()
    {
        try
        {
            using var task = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Delete /TN \"{ScheduledTaskName}\" /F")
            { CreateNoWindow = true, UseShellExecute = false });
            task?.WaitForExit(5000);
        }
        catch { }
    }

    private static void DeleteIvisionLauncher()
    {
        try
        {
            using var task = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Delete /TN \"{IvisionLauncherTaskName}\" /F")
            { CreateNoWindow = true, UseShellExecute = false });
            task?.WaitForExit(5000);
        }
        catch { }
    }

    private void ShowStatus(string message, bool error = false) { _status.Text = message; _status.ForeColor = error ? Color.Firebrick : Color.DimGray; }
}
