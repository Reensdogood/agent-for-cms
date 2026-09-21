using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using System.IO.Ports;

namespace Funnet.Gwanak.Agent.Installer;

internal sealed class InstallerForm : Form
{
    private const string RunValueName = "funnet-gwanak-agent";
    private const string ScheduledTaskName = "Funnet Gwanak Agent";
    private const string IvisionLauncherTaskName = "Funnet i-Vision Launcher";
    private readonly TextBox _serverUrl = new() { PlaceholderText = "https://agent.funnet.kr" };
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
    // 설치 파일에는 서버 주소와 지역 등록 키가 함께 포함된다. 새 설치와
    // 자동 업데이트에서는 이를 표시하거나 수정할 이유가 없고, 트레이의
    // [설정]으로 열었을 때만 운영자가 서버 주소를 변경할 수 있다.
    private readonly bool _showServerAddress;
    private string _existingEnrollmentKey = "";
    private string _existingEnrollmentKeyFingerprint = "";
    private readonly InstallerProvisioning _provisioning;
    private static string _lastTaskError = "";
    public InstallerForm(bool configureOnly = false, bool updateOnly = false)
    {
        _configureOnly = configureOnly;
        _updateOnly = updateOnly;
        _showServerAddress = configureOnly && !updateOnly;
        _provisioning = LoadProvisioning();
        _serverUrl.Text = _provisioning.ServerBaseUrl;
        Text = "Funnet 관악 Agent 설치";
        // 상태 결과(파일 설치/예약 작업/Agent 시작)를 반드시 볼 수 있어야
        // 설치 실패가 무음으로 보이지 않는다.
        Width = 560; Height = _showServerAddress ? 980 : 900; MinimumSize = _showServerAddress ? new Size(540, 900) : new Size(540, 820);
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
            RowCount = _showServerAddress ? 12 : 11,
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        if (_showServerAddress) panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 70));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 100));
        panel.Controls.Add(logo);
        panel.Controls.Add(title);
        panel.Controls.Add(subtitle);
        if (_showServerAddress) panel.Controls.Add(Field("서버 주소", _serverUrl));
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
            if (root.TryGetProperty("enrollmentKeyFingerprint", out var keyFingerprint)) _existingEnrollmentKeyFingerprint = keyFingerprint.GetString() ?? "";
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

    private static InstallerProvisioning LoadProvisioning()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ProvisioningPayload")
            ?? throw new InvalidOperationException("이 설치 파일의 지역 등록 정보가 없습니다. 관리자 화면에서 다시 내려받아 주세요.");
        var provisioning = JsonSerializer.Deserialize<InstallerProvisioning>(stream, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        })
            ?? throw new InvalidOperationException("이 설치 파일의 지역 등록 정보를 읽을 수 없습니다. 관리자 화면에서 다시 내려받아 주세요.");
        var hasBootstrapToken = TryGetBootstrapToken(out var token);
        if (hasBootstrapToken)
        {
            try
            {
                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
                var remote = client.GetStringAsync($"{provisioning.ServerBaseUrl.TrimEnd('/')}/api/installer-provisioning/{token}").GetAwaiter().GetResult();
                provisioning = JsonSerializer.Deserialize<InstallerProvisioning>(remote, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                    ?? throw new InvalidOperationException("지역 등록 정보를 읽지 못했습니다.");
            }
            catch (Exception error)
            {
                throw new InvalidOperationException($"지역 등록 정보를 서버에서 가져오지 못했습니다. 인터넷 연결을 확인한 뒤 관리자 화면에서 설치 파일을 다시 내려받아 주세요.\n\n{error.Message}");
            }
        }
        else if (string.Equals(provisioning.EnrollmentKey, "bootstrap-provisioning-placeholder", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("이 설치 파일의 지역 등록 정보를 찾지 못했습니다. 다운로드가 완료된 파일을 사용해 다시 내려받아 주세요.");
        }
        if (!Uri.TryCreate(provisioning.ServerBaseUrl, UriKind.Absolute, out var server) ||
            (server.Scheme != "https" && server.Scheme != "http"))
            throw new InvalidOperationException("이 설치 파일의 서버 정보가 올바르지 않습니다. 관리자 화면에서 다시 내려받아 주세요.");
        return provisioning with { ServerBaseUrl = server.ToString().TrimEnd('/') };
    }

    private static bool TryGetBootstrapToken(out string token)
    {
        token = "";
        var name = Path.GetFileNameWithoutExtension(Environment.ProcessPath ?? "");
        const string prefix = "funnet-agent-bootstrap-";
        if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && TryValidateBootstrapToken(name[prefix.Length..], out token)) return true;

        // 브라우저가 같은 다운로드 파일에 " (1)"을 붙이거나 사용자가 파일명을
        // 바꿔도 지역 키 조회가 깨지지 않도록 서버가 exe 끝에 붙인 토큰을 읽는다.
        // 단일 파일 실행 파일은 PE overlay를 허용하므로 실행 코드에는 영향을 주지 않는다.
        try
        {
            var executable = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable)) return false;
            const string marker = "FUNNET_BOOTSTRAP_TOKEN:";
            using var stream = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read);
            var count = (int)Math.Min(stream.Length, 512);
            stream.Seek(-count, SeekOrigin.End);
            var bytes = new byte[count];
            if (stream.Read(bytes, 0, bytes.Length) != bytes.Length) return false;
            var tail = Encoding.UTF8.GetString(bytes);
            var position = tail.LastIndexOf(marker, StringComparison.Ordinal);
            if (position < 0) return false;
            var value = tail[(position + marker.Length)..].Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
            return TryValidateBootstrapToken(value, out token);
        }
        catch { return false; }
    }

    private static bool TryValidateBootstrapToken(string value, out string token)
    {
        token = "";
        // 브라우저가 붙인 " (1)" 접미사는 토큰의 일부가 아니므로 첫 번째
        // 비허용 문자에서 분리한다. 토큰 생성 값에는 공백이 포함되지 않는다.
        var candidate = new string(value.TakeWhile(character => char.IsLetterOrDigit(character) || character is '-' or '_').ToArray());
        if (candidate.Length is < 24 or > 128) return false;
        token = candidate;
        return true;
    }

    private bool ShouldResetIdentityForNewEnrollment(string nextFingerprint)
    {
        if (string.IsNullOrWhiteSpace(nextFingerprint)) return false;
        var settingsPath = Path.Combine(_installDirectory, "agent-settings.json");
        if (!File.Exists(settingsPath)) return true;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(settingsPath));
            var existing = document.RootElement.TryGetProperty("enrollmentKeyFingerprint", out var value) ? value.GetString() ?? "" : "";
            return !string.Equals(existing, nextFingerprint, StringComparison.Ordinal);
        }
        catch { return true; }
    }

    private static string EnrollmentKeyFingerprint(string key)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(key));
        return Convert.ToHexString(bytes);
    }

    private void ResetDeviceIdentity()
    {
        var identityPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Funnet", "funnet-gwanak-agent", "identity.json");
        if (!File.Exists(identityPath)) return;
        var backup = identityPath + $".before-enrollment-{DateTimeOffset.Now:yyyyMMddHHmmssfff}";
        File.Move(identityPath, backup, false);
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
        if (!_configureOnly && _provisioning.EnrollmentKey.Trim().Length < 16)
        { ShowStatus("이 설치 파일의 지역 등록 정보가 올바르지 않습니다. 관리자 화면에서 다시 내려받아 주세요.", true); return; }
        if (string.IsNullOrWhiteSpace(_deviceName.Text)) { ShowStatus("장비명을 입력해 주세요.", true); return; }
        _install.Enabled = false; ShowStatus("설치 중입니다…");
        try
        {
            StopAgent(); Directory.CreateDirectory(_installDirectory);
            var executable = Path.Combine(_installDirectory, "funnet-gwanak-agent.exe");
            await using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("AgentPayload") ?? throw new InvalidOperationException("Agent 파일이 설치기에 포함되지 않았습니다."))
            await using (var output = new FileStream(executable, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true)) await source.CopyToAsync(output);
            var port = _displayPort.Text.Trim();
            // 신규 설치만 설치 파일에 포함된 지역 키로 등록한다. 업데이트와
            // 설정 변경은 기존 등록 토큰을 유지하므로 다른 지역으로 재등록하지 않는다.
            var key = _configureOnly ? _existingEnrollmentKey : _provisioning.EnrollmentKey.Trim();
            var keyFingerprint = _configureOnly ? _existingEnrollmentKeyFingerprint : EnrollmentKeyFingerprint(key);
            // 새 지역 설치 파일은 이전 Agent의 장비 토큰을 재사용하면 안 된다.
            // 자동 업데이트와 트레이 설정 변경은 같은 장비의 토큰을 유지한다.
            if (!_configureOnly && !_updateOnly && ShouldResetIdentityForNewEnrollment(keyFingerprint)) ResetDeviceIdentity();
            var settings = new { serverBaseUrl = server.ToString().TrimEnd('/'), enrollmentKey = key, enrollmentKeyFingerprint = keyFingerprint, localName = _deviceName.Text.Trim(), heartbeatSeconds = 30, commandPollSeconds = 5, display = new { enabled = _displayEnabled.Checked, vendor = "samsung", model = _displayModel.SelectedItem?.ToString() ?? "LH75QET", port = string.IsNullOrWhiteSpace(port) ? null : port } };
            await File.WriteAllTextAsync(Path.Combine(_installDirectory, "agent-settings.json"), JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
            var setupCopy = Path.Combine(_installDirectory, "funnet-agent-setup.exe");
            if (!_configureOnly && !string.Equals(Process.GetCurrentProcess().MainModule?.FileName, setupCopy, StringComparison.OrdinalIgnoreCase)) File.Copy(Process.GetCurrentProcess().MainModule?.FileName ?? "", setupCopy, true);
            RegisterElevatedStartup(executable);
            // i-Vision이 설치된 PC에서만 재실행용 관리자 작업을 등록한다.
            // 미설치 PC는 Agent 설치와 무관하므로 오래된 작업만 정리하고
            // Agent 설치를 실패로 처리하지 않는다.
            if (File.Exists(IvisionUpdaterPath))
            {
                if (!RegisterIvisionLauncher())
                    throw new InvalidOperationException($"i-Vision 관리자 권한 실행 작업 등록에 실패했습니다. {(_lastTaskError.Length > 0 ? _lastTaskError : "관리자 권한으로 설치기를 다시 실행해 주세요.")} ");
            }
            else DeleteIvisionLauncher();
            StartScheduledAgent(executable);
            // StartScheduledAgent는 실제 Agent 프로세스가 같은 경로에서 5초
            // 유지되는 것까지 확인한다. 확인에 성공한 운영 설치/업데이트는
            // 사용자 입력을 기다리지 않고 닫고, 실패 때만 창과 오류를 남긴다.
            ShowStatus("설치 완료 · Agent가 관리자 권한으로 실행되었습니다.\r\n잠시 후 설치 창을 자동으로 닫습니다.");
            await Task.Delay(1200);
            Close();
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
            var settings = new { serverBaseUrl = server.ToString().TrimEnd('/'), enrollmentKey = _existingEnrollmentKey, enrollmentKeyFingerprint = _existingEnrollmentKeyFingerprint, localName = _deviceName.Text.Trim(), heartbeatSeconds = 30, commandPollSeconds = 5, display = new { enabled = _displayEnabled.Checked, vendor = "samsung", model = _displayModel.SelectedItem?.ToString() ?? "LH75QET", port = string.IsNullOrWhiteSpace(port) ? null : port } };
            await File.WriteAllTextAsync(Path.Combine(_installDirectory, "agent-settings.json"), JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
            ShowStatus("설정을 저장했습니다. Agent를 재시작합니다.");
            StopAgent();
            var executable = Path.Combine(_installDirectory, "funnet-gwanak-agent.exe");
            if (File.Exists(executable)) StartScheduledAgent(executable);
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
            // Program has already elevated the installer. Avoid a second UAC
            // shell launch here; Windows 10 IoT can otherwise lose task setup.
            UseShellExecute = false,
            CreateNoWindow = true,
        });
        task?.WaitForExit(15000);
        if (task is null || task.ExitCode != 0) throw new InvalidOperationException("Agent 관리자 권한 자동 실행 등록에 실패했습니다.");
    }

    private const string IvisionUpdaterPath = @"C:\i-Vision Player\iVisionUpdater.exe";

    private static bool RegisterIvisionLauncher()
    {
        if (!File.Exists(IvisionUpdaterPath)) return true;
        DeleteIvisionLauncher();
        using var task = Process.Start(new ProcessStartInfo("schtasks.exe",
            // ONDEMAND는 schtasks /Create에서 유효한 스케줄 형식이 아니다.
            // 먼 미래의 ONCE 작업으로 등록하면 자동 실행은 발생하지 않고
            // schtasks /Run으로만 호출할 수 있다.
            $"/Create /TN \"{IvisionLauncherTaskName}\" /TR \"\\\"{IvisionUpdaterPath}\\\"\" /SC ONCE /ST 23:59 /RL HIGHEST /F")
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
        if (task is null || task.ExitCode != 0)
        {
            var detail = task is null ? "schtasks 프로세스를 시작하지 못했습니다." : task.StandardError.ReadToEnd().Trim();
            if (string.IsNullOrWhiteSpace(detail) && task is not null) detail = task.StandardOutput.ReadToEnd().Trim();
            _lastTaskError = detail;
            return false;
        }
        return true;
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

    private static void StartScheduledAgent(string executable)
    {
        if (!ScheduledTaskExists()) throw new InvalidOperationException("Agent 관리자 권한 자동 실행 작업을 찾을 수 없습니다.");
        if (!ScheduledTaskTargets(executable))
            throw new InvalidOperationException("관리자 권한 자동 실행 작업이 현재 Agent 파일을 가리키지 않습니다. 설치를 다시 진행해 주세요.");
        using var start = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Run /TN \"{ScheduledTaskName}\"")
        { CreateNoWindow = true, UseShellExecute = false });
        start?.WaitForExit(5000);
        if (start is null || start.ExitCode != 0) throw new InvalidOperationException("Agent 관리자 권한 실행을 시작하지 못했습니다.");

        // schtasks /Run 성공은 실행 요청이 접수됐다는 뜻일 뿐이다. 실제
        // Agent 프로세스가 생성됐는지 확인하지 않으면 설치창만 닫히고
        // 트레이 아이콘이 없는 상태를 성공으로 오인하게 된다.
        for (var attempt = 0; attempt < 20; attempt++)
        {
            foreach (var process in Process.GetProcessesByName("funnet-gwanak-agent"))
            {
                try
                {
                    if (string.Equals(Path.GetFullPath(process.MainModule?.FileName ?? ""), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase))
                    {
                        // 생성 직후 예외로 종료되는 경우를 성공으로 오인하지
                        // 않도록 최소 5초 동안 동일 프로세스가 유지되는지 확인한다.
                        for (var stableAttempt = 0; stableAttempt < 10; stableAttempt++)
                        {
                            Thread.Sleep(500);
                            if (process.HasExited)
                                throw new InvalidOperationException("Agent가 시작 직후 종료되었습니다. Agent 로그를 확인해 주세요.");
                        }
                        return;
                    }
                }
                catch (InvalidOperationException) { throw; }
                catch { /* 프로세스가 시작/종료 중이면 다음 시도에서 확인한다. */ }
                finally { process.Dispose(); }
            }
            Thread.Sleep(500);
        }
        throw new InvalidOperationException("관리자 권한 Agent가 시작되지 않았습니다. 작업 스케줄러와 Agent 로그를 확인해 주세요.");
    }

    private static bool ScheduledTaskTargets(string executable)
    {
        try
        {
            using var query = Process.Start(new ProcessStartInfo("schtasks.exe", $"/Query /TN \"{ScheduledTaskName}\" /FO LIST /V")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (query is null) return false;
            var output = query.StandardOutput.ReadToEnd();
            query.WaitForExit(5000);
            return query.ExitCode == 0 && output.Contains(Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
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

    private sealed record InstallerProvisioning(string ServerBaseUrl, string EnrollmentKey, string? RegionName);
}
