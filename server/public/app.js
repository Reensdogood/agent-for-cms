const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const loginView = $("#loginView");
const appView = $("#appView");
let csrfToken = "";
let devices = [];
const selectedDeviceIds = new Set();
let schedules = [];
let scheduleDeviceIds = [];
let releases = [];
let releaseFilter = "all";
let selectedRegionId = "all";
let devicePageSize = 10;
let devicePage = 1;
let deviceSort = { key: "status", direction: "asc" };
let users = [];
let currentSession = null;
let regionInfo = { serverBaseUrl: "", regions: [] };
document.querySelector('[data-device-sort="agentVersion"]')?.replaceChildren(document.createTextNode("funnet-agent"));

const pageMeta = {
  dashboard: ["OVERVIEW", "장비 현황"], devices: ["DEVICES", "장비 관리"],
  schedules: ["SCHEDULE", "실행 스케줄"], system: ["SYSTEM", "시스템 상태"], releases: ["DISTRIBUTION", "UME 배포"],
  integrations: ["SERVICES", "운영 관리 페이지"], users: ["ACCESS", "사용자 관리"],
};

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `요청 실패 (${response.status})`);
  return body;
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function statusLabel(status) { return { online: "온라인", delayed: "응답 지연", offline: "오프라인" }[status] || status; }

function toast(message, kind = "success") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3200);
}

function textElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function renderDevices() {
  const query = $("#searchInput").value.trim().toLowerCase();
  const scoped = devices.filter((device) => selectedRegionId === "all" || device.regionId === selectedRegionId);
  const visible = scoped.filter((device) => `${device.displayName} ${device.id} ${device.machineName || ""}`.toLowerCase().includes(query));
  const rank = { online: 0, delayed: 1, offline: 2 };
  const value = (d, key) => key === "status" ? (rank[d.status] ?? 9) : key === "regionName" ? (d.regionName || "") : key === "ume" ? (d.ume?.version || "") : key === "ivisionRunning" ? (d.ivisionRunning ? 0 : 1) : (d[key] ?? "");
  visible.sort((a, b) => { const av = value(a, deviceSort.key), bv = value(b, deviceSort.key); const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "ko"); return cmp * deviceSort.direction; });
  const pageCount = Math.max(1, Math.ceil(visible.length / devicePageSize));
  devicePage = Math.min(devicePage, pageCount);
  const pageRows = visible.slice((devicePage - 1) * devicePageSize, devicePage * devicePageSize);
  $("#countTotal").textContent = scoped.length;
  $("#countApproved").textContent = `승인 ${scoped.filter((d) => d.approved).length} · 대기 ${scoped.filter((d) => !d.approved).length}`;
  $("#countOnline").textContent = scoped.filter((d) => d.status === "online").length;
  $("#countUmeRunning").textContent = scoped.filter((d) => d.ume?.running).length;
  $("#countIvisionRunning").textContent = scoped.filter((d) => d.ivisionRunning).length;
  const umeVersions = [...new Set(scoped.map((d) => d.ume?.version).filter(Boolean))];
  $("#countUmeVersion").textContent = umeVersions.length ? `버전 ${umeVersions.slice(0, 2).join(", ")}${umeVersions.length > 2 ? ` 외 ${umeVersions.length - 2}` : ""}` : "감지된 버전 없음";
  $("#deviceRows").replaceChildren(...pageRows.map(deviceRow));
  $$('[data-device-sort]').forEach((button) => button.setAttribute("aria-sort", button.dataset.deviceSort === deviceSort.key ? (deviceSort.direction === 1 ? "ascending" : "descending") : "none"));
  $("#emptyState").hidden = visible.length > 0;
  renderDevicePagination(pageCount);
  renderBreakdowns();

  const attention = devices.filter((device) => device.status !== "online" || !device.approved).slice(0, 6);
  const list = $("#attentionList");
  if (!attention.length) list.replaceChildren(textElement("p", "all-clear", "모든 장비가 정상입니다."));
  else list.replaceChildren(...attention.map((device) => {
    const row = document.createElement("button");
    row.className = "attention-row";
    row.append(textElement("span", `status-icon ${device.status}`, ""));
    const copy = document.createElement("span");
    copy.append(textElement("strong", "", device.displayName), textElement("small", "", device.approved ? `${statusLabel(device.status)} · ${formatTime(device.lastSeenAt)}` : "승인 대기"));
    row.append(copy, textElement("span", "chevron", "›"));
    row.addEventListener("click", () => { $("#searchInput").value = device.displayName; showPage("devices"); renderDevices(); });
    return row;
  }));
}

function renderBreakdowns() {
  renderMetricList("#agentBreakdown", [
    ["온라인", devices.filter((d) => d.status === "online").length, "online"],
    ["응답 지연", devices.filter((d) => d.status === "delayed").length, "delayed"],
    ["오프라인", devices.filter((d) => d.status === "offline").length, "offline"],
    ["승인 대기", devices.filter((d) => !d.approved).length, "pending"],
  ]);
  renderMetricList("#appBreakdown", [
    ["UME 실행", devices.filter((d) => d.ume?.running).length, "ume"],
    ["UME 미실행/미감지", devices.filter((d) => !d.ume?.running).length, "quiet"],
    ["i-vision 실행", devices.filter((d) => d.ivisionRunning).length, "ivision"],
    ["i-vision 미실행", devices.filter((d) => !d.ivisionRunning).length, "quiet"],
  ]);
  const regions = new Map();
  for (const device of devices) regions.set(device.regionName || "미지정", (regions.get(device.regionName || "미지정") || 0) + 1);
  renderMetricList("#regionBreakdown", [...regions.entries()].map(([name, count]) => [name, count, "region"]));
}

function renderMetricList(selector, rows) {
  const root = $(selector);
  if (!rows.length) {
    root.replaceChildren(textElement("p", "metric-empty", "표시할 장비가 없습니다."));
    return;
  }
  root.replaceChildren(...rows.map(([label, count, tone]) => {
    const item = document.createElement("div");
    item.className = "metric-row";
    item.append(textElement("span", `metric-dot ${tone}`, ""), textElement("strong", "", label), textElement("em", "", count));
    return item;
  }));
}

function tableCell(text, className = "") { const cell = textElement("td", className, text); return cell; }

function canManageSmartPlugs() { return ["admin", "operator", "system_manager"].includes(currentSession?.role); }

function smartPlugLabel(plug) {
  if (!plug) return "미등록";
  const power = plug.power === "on" ? "전원On" : "전원Off";
  const connection = plug.connection === "online" ? "Online" : "Offline";
  return `${power}/${connection}`;
}

async function openSmartPlugDialog(device, setup = false) {
  const dialog = document.createElement("dialog");
  dialog.className = "smart-plug-dialog";
  dialog.innerHTML = `<form method="dialog"><div class="tv-dialog-header"><span class="eyebrow">SMART PLUG</span><h3></h3><p class="smart-plug-description">EnerCare에서 현재 연결과 전원 상태를 조회합니다.</p><div class="smart-plug-live-status">상태 조회 중…</div></div><div class="smart-plug-actions"></div><section class="smart-plug-setup" hidden><label>상위 그룹 ID<input id="plugLowGroup" maxlength="80" placeholder="예: GWANAK9"></label><label>하위 그룹 ID<input id="plugSubGroup" maxlength="80" placeholder="전체는 비워두세요"></label><button type="button" class="small secondary" id="plugLoadCatalog">EnerCare 장치 목록 불러오기</button><label>EnerCare 장치<select id="plugCatalog"><option value="">목록을 먼저 불러오거나 아래에 직접 입력하세요</option></select></label><label>EnerCare 장치 ID<input id="plugDeviceId" maxlength="200" required></label><label>표시 이름<input id="plugDisplayName" maxlength="120"></label><div class="dialog-actions"><button type="button" class="small secondary" id="plugSave">등록 저장</button><button type="button" class="small danger" id="plugRemove" hidden>등록 해제</button></div></section><div class="dialog-footer"><button value="cancel" class="small secondary">닫기</button></div></form>`;
  dialog.querySelector("h3").textContent = `${device.displayName} 스마트플러그`;
  const status = dialog.querySelector(".smart-plug-live-status");
  const actions = dialog.querySelector(".smart-plug-actions");
  const setupPanel = dialog.querySelector(".smart-plug-setup");
  const isManager = canManageSmartPlugs();
  let plug = device.smartPlug;
  const statusText = (value) => `${smartPlugLabel(value)} · ${value?.lastSyncedAt ? `최근 조회 ${formatTime(value.lastSyncedAt)}` : "현재 값 확인 필요"}${value?.lastError ? ` · ${value.lastError}` : ""}`;
  const loadStatus = async () => {
    if (!plug) { status.textContent = "스마트플러그가 등록되지 않았습니다."; return; }
    status.textContent = "EnerCare 상태를 조회하고 있습니다…";
    try { const result = await api(`/api/devices/${device.id}/smart-plug/status`); plug = result.smartPlug; status.textContent = statusText(plug); renderControl(); }
    catch (error) { status.textContent = `상태 조회 실패 · ${error.message}`; }
  };
  const renderControl = () => {
    actions.replaceChildren();
    if (plug && isManager) {
      const on = plug.power === "on";
      const control = textElement("button", "smart-plug-power", on ? "전원 OFF" : "전원 ON");
      control.type = "button"; control.disabled = plug.connection !== "online";
      control.title = control.disabled ? "스마트플러그가 Offline 상태입니다." : "현재 전원 상태를 반대로 전환합니다.";
      control.addEventListener("click", async () => {
        const wanted = !on;
        if (!await confirmAction(`${device.displayName} 스마트플러그 전원을 ${wanted ? "ON" : "OFF"}할까요?`, "Online 상태의 스마트플러그에만 적용됩니다.", wanted ? "전원 ON" : "전원 OFF")) return;
        control.disabled = true;
        try { const result = await api(`/api/devices/${device.id}/smart-plug/power`, { method: "POST", body: JSON.stringify({ on: wanted }) }); plug = result.smartPlug; status.textContent = statusText(plug); renderControl(); await loadDevices(); toast(`스마트플러그 전원을 ${wanted ? "ON" : "OFF"}했습니다.`); }
        catch (error) { toast(error.message, "error"); control.disabled = false; }
      });
      actions.append(control);
    }
    if (isManager) {
      const configure = textElement("button", "small secondary", plug ? "스마트플러그 설정" : "스마트플러그 등록");
      configure.type = "button"; configure.addEventListener("click", () => { setupPanel.hidden = !setupPanel.hidden; }); actions.append(configure);
    }
  };
  const low = dialog.querySelector("#plugLowGroup"); const sub = dialog.querySelector("#plugSubGroup"); const catalog = dialog.querySelector("#plugCatalog"); const deviceId = dialog.querySelector("#plugDeviceId"); const displayName = dialog.querySelector("#plugDisplayName");
  low.value = plug?.lowGroupId || "GWANAK9"; sub.value = plug?.subGroupId || ""; deviceId.value = plug?.enercareDeviceId || ""; displayName.value = plug?.displayName || device.displayName;
  setupPanel.hidden = !setup;
  dialog.querySelector("#plugLoadCatalog").addEventListener("click", async (event) => {
    const button = event.currentTarget; button.disabled = true; button.textContent = "불러오는 중…";
    try { const result = await api("/api/smart-plugs/catalog", { method: "POST", body: JSON.stringify({ lowGroupId: low.value, subGroupId: sub.value }) }); catalog.replaceChildren(new Option("EnerCare 장치 선택", ""), ...result.devices.map((item) => new Option(`${item.displayName} · ${smartPlugLabel(item)}`, item.deviceId))); catalog.dataset.devices = JSON.stringify(result.devices); }
    catch (error) { toast(error.message, "error"); } finally { button.disabled = false; button.textContent = "EnerCare 장치 목록 불러오기"; }
  });
  catalog.addEventListener("change", () => { const selected = JSON.parse(catalog.dataset.devices || "[]").find((item) => item.deviceId === catalog.value); if (selected) { deviceId.value = selected.deviceId; displayName.value = selected.displayName; low.value = selected.lowGroupId; sub.value = selected.subGroupId; } });
  dialog.querySelector("#plugSave").addEventListener("click", async (event) => { const button = event.currentTarget; button.disabled = true; try { const result = await api(`/api/devices/${device.id}/smart-plug`, { method: "PUT", body: JSON.stringify({ enercareDeviceId: deviceId.value, lowGroupId: low.value, subGroupId: sub.value, displayName: displayName.value }) }); plug = result.smartPlug; setupPanel.hidden = true; status.textContent = statusText(plug); renderControl(); await loadDevices(); toast("스마트플러그를 등록했습니다."); } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; } });
  const remove = dialog.querySelector("#plugRemove"); remove.hidden = !plug; remove.addEventListener("click", async () => { if (!await confirmAction("스마트플러그 등록을 해제할까요?", "EnerCare 장치 자체는 삭제되지 않고 이 서버의 연결만 해제됩니다.", "등록 해제")) return; await api(`/api/devices/${device.id}/smart-plug`, { method: "DELETE", body: "{}" }); plug = null; setupPanel.hidden = true; status.textContent = "스마트플러그 등록이 해제되었습니다."; renderControl(); await loadDevices(); });
  document.body.append(dialog); dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal(); renderControl(); await loadStatus();
}

function deviceRow(device) {
  const capabilities = device.capabilities || {};
  const isAndroidDevice = device.platform === "android" || String(device.agentVersion || "").startsWith("android-") || /^Android\b/i.test(String(device.osVersion || ""));
  const supportsUme = capabilities.ume !== false;
  const supportsIvision = capabilities.ivision !== false;
  const supportsWindowsShutdown = capabilities.windowsShutdown !== false;
  const row = document.createElement("tr");
  const selectCell = document.createElement("td");
  const select = document.createElement("input"); select.type = "checkbox"; select.className = "device-select"; select.dataset.deviceId = device.id; select.checked = selectedDeviceIds.has(device.id); select.disabled = !device.approved;
  select.addEventListener("change", () => select.checked ? selectedDeviceIds.add(device.id) : selectedDeviceIds.delete(device.id)); selectCell.append(select);
  const status = document.createElement("td");
  const badge = textElement("span", `status ${device.status}`, statusLabel(device.status));
  badge.prepend(textElement("i", "", ""));
  status.append(badge);
  if (!device.approved) status.append(textElement("small", "pending-label", "승인 대기"));
  const nameCell = tableCell(device.displayName, "device-name");
  nameCell.dataset.deviceId = device.id;
  nameCell.title = `Device ID: ${device.id}`;
  nameCell.setAttribute("aria-label", `${device.displayName} (Device ID ${device.id})`);
  row.append(selectCell, status, tableCell(device.regionName || "-", "region-name"), nameCell, tableCell(device.id, "mono"),
    tableCell(device.osVersion || "-", "os-version"), (() => { const cell = tableCell(device.agentVersion || "-", "agent-version"); if (device.agentElevationRequired) cell.append(textElement("small", "pending-label", "관리자 권한으로 다시 실행 필요")); return cell; })(),
    tableCell(supportsUme ? (device.ume?.version ? `${device.ume.name || "UME"} ${device.ume.version}${device.ume.running ? " · 실행" : ""} · funnet-agent ${device.agentVersion || "-"}` : `미감지 · funnet-agent ${device.agentVersion || "-"}`) : "해당 없음"),
    tableCell(supportsIvision ? (device.ivisionRunning ? "실행" : "미실행") : "해당 없음"), tableCell(device.displayConnection || "미확인", `display-connection ${device.displayConnection === "정상" ? "connected" : device.displayConnection === "연결 실패" ? "failed" : ""}`), tableCell(smartPlugLabel(device.smartPlug), `smart-plug-state ${device.smartPlug?.connection === "online" ? "online" : "offline"}`), tableCell(formatTime(device.lastSeenAt)));
  const actions = document.createElement("td");
  if (!device.approved) {
    const approve = textElement("button", "small primary-soft", "승인");
    approve.addEventListener("click", async () => {
      approve.disabled = true;
      try { await api(`/api/devices/${device.id}/approve`, { method: "POST" }); await loadDevices(); toast("장비를 승인했습니다."); }
      catch (error) { toast(error.message, "error"); }
      finally { approve.disabled = false; }
    });
    actions.append(approve);
  }
  const probe = textElement("button", "small secondary", "상태 확인");
  probe.addEventListener("click", async () => {
    probe.disabled = true;
    try { await api(`/api/devices/${device.id}/probe`, { method: "POST" }); setTimeout(loadDevices, 2200); }
    catch (error) { toast(error.message, "error"); }
    finally { probe.disabled = false; }
  });
  const runUme = textElement("button", "small secondary", "UME 실행");
  runUme.disabled = !device.approved;
  runUme.addEventListener("click", async () => {
    if (!await confirmAction(`${device.displayName}에서 UME를 다시 실행할까요?`, "선택한 장비 1대에만 UME 전체화면/화상창 우선 명령을 보냅니다.", "실행")) return;
    runUme.disabled = true;
    try { const result = await api(`/api/devices/${device.id}/run-ume`, { method: "POST", body: "{}" }); toast(`${device.displayName}에 실행 명령을 보냈습니다.`); setTimeout(loadDevices, 1800); }
    catch (error) { toast(error.message, "error"); }
    finally { runUme.disabled = !device.approved; }
  });
  const stopUme = textElement("button", "small secondary", "UME 종료");
  stopUme.disabled = !device.approved;
  stopUme.addEventListener("click", async () => { if (!await confirmAction(`${device.displayName}의 UME를 종료할까요?`, "트레이에 남아 있는 UME도 종료 상태로 전환합니다.", "UME 종료")) return; stopUme.disabled = true; try { await api(`/api/devices/${device.id}/ume/stop`, { method: "POST", body: "{}" }); toast(`${device.displayName}에 UME 종료 명령을 보냈습니다.`); setTimeout(loadDevices, 1800); } catch (error) { toast(error.message, "error"); } finally { stopUme.disabled = !device.approved; } });
  const tv = textElement("button", "small secondary", "TV 제어");
  tv.disabled = !device.approved || !device.displayEnabled;
  if (!device.displayEnabled) tv.title = "이 장비는 TV 제어가 비활성화되어 있습니다.";
  tv.addEventListener("click", async () => {
    let current = {};
    try { const s = await api(`/api/devices/${device.id}/display/status`); current = s.display || {}; } catch {}
    const dialog = document.createElement("dialog");
    const displayText = (value) => { const c = value?.connection; const connection = c === "standby" ? "절전/대기 중" : c === "timeout" ? "응답 시간 초과" : c === "connected" ? "연결 정상" : "확인 필요"; return `전원 ${String(value?.power || "미확인").toUpperCase()} · ${value?.input || "입력 미확인"} · 볼륨 ${value?.volume ?? "미확인"} · ${connection}`; };
    dialog.innerHTML = `<form method="dialog"><div class="tv-dialog-header"><span class="eyebrow">DISPLAY CONTROL</span><h3>${device.displayName} TV 제어</h3><p>현재 상태를 확인하고 원하는 동작을 선택하세요.</p><div class="tv-live-status">${displayText(current)}</div><button type="button" class="small secondary" id="readDisplayStatus">TV 현재 상태 조회</button></div><div class="dialog-actions"></div><div class="dialog-footer"><button value="cancel" class="small secondary">닫기</button></div></form>`;
    dialog.querySelector("#readDisplayStatus").addEventListener("click", async (event) => { const button = event.currentTarget; button.disabled = true; try { await api(`/api/devices/${device.id}/display/status`, { method: "POST", body: "{}" }); button.textContent = "조회 중…"; setTimeout(async () => { try { const latest = await api(`/api/devices/${device.id}/display/status`); dialog.querySelector(".tv-live-status").textContent = displayText(latest.display || {}); } catch {} finally { button.disabled = false; button.textContent = "TV 현재 상태 조회"; } }, 1800); } catch (error) { toast(error.message, "error"); button.disabled = false; } });
    const actions = dialog.querySelector(".dialog-actions");
    const displayInputs = Array.isArray(device.displayInputs) && device.displayInputs.length ? device.displayInputs : ["HDMI1", "HDMI2"];
    const commands = [["전원 ON", "power", { on: true }], ["전원 OFF", "power", { on: false }], ...displayInputs.map((input) => [input, "input", { input }]), ["현재 볼륨 +", "volume", { value: 55 }], ["현재 볼륨 −", "volume", { value: 45 }]];
    let statusTimer;
    const refreshDialogStatus = async () => { try { const latest = await api(`/api/devices/${device.id}/display/status`); dialog.querySelector(".tv-live-status").textContent = displayText(latest.display || {}); } catch {} };
    for (const [label, kind, payload] of commands) { const active = (label.includes("ON") && String(current.power).toLowerCase() === "on") || (label.includes("OFF") && String(current.power).toLowerCase() === "off") || (label.toUpperCase() === String(current.input || "").toUpperCase()); const tone = label.startsWith("전원") ? "power-command" : label.startsWith("HDMI") ? "input-command" : "volume-command"; const b = textElement("button", `small primary-soft tv-command ${tone}${active ? " active-display" : ""}`, active ? `✓ ${label}` : label); b.type = "button"; b.addEventListener("click", async () => { b.disabled = true; try { await api(`/api/devices/${device.id}/display/${kind}`, { method: "POST", body: JSON.stringify(payload) }); toast(`${device.displayName}에 ${label} 명령을 보냈습니다.`); setTimeout(refreshDialogStatus, 1200); } catch (error) { toast(error.message, "error"); } finally { b.disabled = false; } }); actions.append(b); }
    document.body.append(dialog); dialog.addEventListener("close", () => { clearInterval(statusTimer); dialog.remove(); }, { once: true }); dialog.showModal(); statusTimer = setInterval(refreshDialogStatus, 2500);
  });
  actions.append(tv);
  if (isAndroidDevice) {
    const diagnostics = textElement("button", "small secondary", "USB 진단");
    diagnostics.addEventListener("click", () => {
      const value = device.serialDiagnostics || { stage: "not_reported", message: "아직 Android 앱에서 USB 진단 정보가 보고되지 않았습니다." };
      const dialog = document.createElement("dialog");
      const form = document.createElement("form"); form.method = "dialog";
      form.append(textElement("p", "eyebrow", "ANDROID USB SERIAL"), textElement("h3", "", `${device.displayName} USB 진단`));
      const description = textElement("p", "", "USB 인식과 TV 응답은 별도 단계입니다. 아래 정보로 FTDI 인식, 권한, 드라이버, 송수신 상태를 확인합니다.");
      const output = textElement("pre", "mono usb-diagnostics", JSON.stringify(value, null, 2));
      const footer = document.createElement("div"); footer.className = "dialog-footer";
      const close = textElement("button", "small secondary", "닫기"); close.value = "cancel"; footer.append(close);
      form.append(description, output, footer); dialog.append(form);
      document.body.append(dialog); dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal();
    });
    actions.append(diagnostics);
  }
  if (device.smartPlug || canManageSmartPlugs()) {
    const smartPlug = textElement("button", "small secondary", device.smartPlug ? "스마트플러그 제어" : "스마트플러그 등록");
    smartPlug.addEventListener("click", () => openSmartPlugDialog(device, !device.smartPlug));
    actions.append(smartPlug);
  }
  const ivisionStop = textElement("button", "small secondary", "i-vision 종료");
  const ivisionRestart = textElement("button", "small secondary", "i-vision 재실행");
  const windowsShutdown = textElement("button", "small danger", "Windows 종료");
  ivisionStop.disabled = ivisionRestart.disabled = !device.approved;
  for (const [button, action, label] of [[ivisionStop, "stop", "종료"], [ivisionRestart, "restart", "재실행"]]) button.addEventListener("click", async () => { if (!await confirmAction(`${device.displayName}의 i-vision을 ${label}할까요?`, "현재 실행 중인 i-Vision.Player 프로세스 기준으로 처리합니다.", label)) return; button.disabled = true; try { await api(`/api/devices/${device.id}/ivision/${action}`, { method: "POST", body: "{}" }); toast(`i-vision ${label} 명령을 보냈습니다.`); setTimeout(loadDevices, 1800); } catch (error) { toast(error.message, "error"); } finally { button.disabled = !device.approved; } });
  windowsShutdown.disabled = !device.approved;
  windowsShutdown.addEventListener("click", async () => { if (!await confirmAction(`${device.displayName}의 Windows를 종료할까요?`, "저장하지 않은 작업이 있으면 손실될 수 있습니다.", "Windows 종료")) return; windowsShutdown.disabled = true; try { await api(`/api/devices/${device.id}/windows/shutdown`, { method: "POST", body: "{}" }); toast(`${device.displayName}에 Windows 종료 명령을 전송했습니다.`); } catch (error) { toast(error.message, "error"); windowsShutdown.disabled = !device.approved; } });
  const edit = textElement("button", "small secondary", "수정");
  edit.addEventListener("click", () => {
    $("#renameDeviceId").value = device.id;
    $("#renameDisplayName").value = device.displayName;
    $("#renameDialog").showModal();
  });
  const remove = textElement("button", "small danger", "삭제");
  remove.addEventListener("click", async () => {
    if (!await confirmAction("이 장비를 삭제할까요?", `${device.displayName} 등록 정보와 대기 명령이 서버에서 삭제됩니다.`, "삭제")) return;
    remove.disabled = true;
    try { await api(`/api/devices/${device.id}`, { method: "DELETE" }); await loadDevices(); toast("장비를 삭제했습니다."); }
    catch (error) { toast(error.message, "error"); }
    finally { remove.disabled = false; }
  });
  actions.append(probe);
  if (supportsUme) actions.append(runUme, stopUme);
  if (supportsIvision) actions.append(ivisionStop, ivisionRestart);
  if (supportsWindowsShutdown) actions.append(windowsShutdown);
  actions.append(edit, remove);
  row.append(actions);
  return row;
}

async function loadDevices() {
  const result = await api("/api/devices");
  devices = result.devices;
  $("#updatedAt").textContent = `최근 갱신 ${formatTime(result.serverTime)}`;
  renderDevices();
}

function renderDevicePagination(pageCount) {
  const root = $("#devicePagination"); if (!root) return;
  root.replaceChildren();
  if (pageCount <= 1) return;
  for (let page = 1; page <= pageCount; page += 1) { const button = textElement("button", `page-button${page === devicePage ? " active" : ""}`, String(page)); button.type = "button"; button.addEventListener("click", () => { devicePage = page; renderDevices(); }); root.append(button); }
}

async function loadSystemStatus() {
  const result = await api("/api/commands?limit=20");
  const failed = result.commands.filter((command) => command.status === "failed" || (command.status !== "completed" && command.attempts >= 5));
  const pending = result.commands.filter((command) => command.status === "pending" || command.status === "delivered");
  $("#systemDeviceCount").textContent = devices.length;
  $("#systemOnlineCount").textContent = `온라인 ${devices.filter((device) => device.status === "online").length}`;
  $("#systemFailedCount").textContent = failed.length;
  $("#systemPendingCount").textContent = pending.length;
  const rows = failed.map((command) => { const row = document.createElement("tr"); const detail = command.result?.error || (command.status === "failed" ? "명령 실행 실패" : "응답 없음"); row.append(tableCell(command.deviceName, "device-name"), tableCell(command.status === "failed" ? "실패" : "응답 없음"), tableCell(command.type), tableCell(detail), tableCell(formatTime(command.completedAt || command.createdAt))); return row; });
  $("#systemErrorRows").replaceChildren(...rows); $("#systemErrorEmpty").hidden = rows.length > 0;
}

async function loadEnrollmentInfo() {
  regionInfo = await api("/api/regions");
  ["dashboardRegionFilter", "deviceRegionFilter", "scheduleRegionFilter"].forEach((id) => { const select = $(`#${id}`); if (!select) return; select.replaceChildren(new Option("전체 지역", "all"), ...regionInfo.regions.map((region) => new Option(region.name, region.id))); select.value = selectedRegionId; });
  $("#agentServerUrl").value = regionInfo.serverBaseUrl;
  const releaseRegion = $("#releaseRegion");
  if (releaseRegion) releaseRegion.replaceChildren(new Option("Agent 대상 지역 선택", ""), ...regionInfo.regions.map((region) => new Option(region.name, region.id)));
  renderRegionKeys();
}

function renderRegionKeys() {
  const root = $("#regionKeyList");
  root.replaceChildren(...regionInfo.regions.map((region) => {
    const row = document.createElement("article");
    row.className = "region-key-row";
    const copy = document.createElement("div");
    copy.append(textElement("strong", "", `${region.name}${region.isDefault ? " · 기본" : ""}`), textElement("code", "", region.enrollmentKey));
    const copyButton = textElement("button", "small secondary", "키 복사");
    copyButton.addEventListener("click", async () => { try { await copyText(region.enrollmentKey); toast("등록 지역 키를 복사했습니다."); } catch (error) { toast(`복사하지 못했습니다: ${error.message}`, "error"); } });
    const rotate = textElement("button", "small secondary", "키 재발급");
    rotate.addEventListener("click", async () => {
      if (!await confirmAction(`${region.name} 등록 키를 재발급할까요?`, "기존 등록 장비는 계속 동작하지만, 기존 키로는 새 장비 등록이 되지 않습니다.", "재발급")) return;
      try { await api(`/api/regions/${region.id}/rotate-key`, { method: "POST", body: "{}" }); await loadEnrollmentInfo(); toast("등록 키를 재발급했습니다."); }
      catch (error) { handleError(error); }
    });
    const download = textElement("button", "small secondary", "에이전트 파일 다운로드 (최신)");
    download.addEventListener("click", async () => {
      download.disabled = true;
      const original = download.textContent;
      download.textContent = "설치 파일 준비 중…";
      try {
        const result = await api(`/api/regions/${region.id}/agent-installer`, { method: "POST", body: "{}" });
        window.location.assign(result.downloadPath);
        toast(`${region.name} 최신 Agent 설치 파일 다운로드를 시작했습니다.`);
      } catch (error) { handleError(error); }
      finally { download.disabled = false; download.textContent = original; }
    });
    row.append(copy, copyButton, rotate, download);
    return row;
  }));
}

function roleLabel(role) {
  return { admin: "전체 시스템", operator: "운영", system_manager: "시스템 담당자", region_manager: "지역 관리자" }[role] || role;
}

function renderUserRegions(selectedId = "") {
  const select = $("#userRegion");
  select.replaceChildren(...regionInfo.regions.map((region) => {
    const option = document.createElement("option");
    option.value = region.id;
    option.textContent = region.name;
    option.selected = region.id === selectedId;
    return option;
  }));
  $("#userRegionLabel").hidden = $("#userRole").value !== "region_manager";
}

function renderUsers() {
  const rows = users.map((user) => {
    const row = document.createElement("tr");
    const state = document.createElement("td");
    state.append(textElement("span", `active-badge${user.active ? "" : " inactive"}`, user.active ? "사용 중" : "중지"));
    row.append(state, tableCell(user.username, "device-name"));
    const role = document.createElement("td");
    role.append(textElement("span", "role-badge", user.roleLabel || roleLabel(user.role)));
    row.append(role, tableCell(user.regionName || "전체", "region-name"), tableCell(formatTime(user.createdAt)));
    const actions = document.createElement("td");
    const edit = textElement("button", "small secondary", "수정");
    edit.addEventListener("click", () => openUser(user));
    const remove = textElement("button", "small danger", "삭제");
    remove.disabled = currentSession?.username === user.username;
    remove.addEventListener("click", async () => {
      if (!await confirmAction("이 사용자를 삭제할까요?", `${user.username} 계정으로는 더 이상 로그인할 수 없습니다.`, "삭제")) return;
      try { await api(`/api/users/${user.id}`, { method: "DELETE" }); await loadUsers(); toast("사용자를 삭제했습니다."); }
      catch (error) { handleError(error); }
    });
    actions.append(edit, remove);
    row.append(actions);
    return row;
  });
  $("#userRows").replaceChildren(...rows);
  $("#userEmptyState").hidden = rows.length > 0;
}

async function loadUsers() {
  const result = await api("/api/users");
  users = result.users;
  renderUsers();
}

function openUser(user = null) {
  if (!$("#userRole option[value=system_manager]")) $("#userRole").insertAdjacentHTML("beforeend", '<option value="system_manager">시스템 담당자</option>');
  if (!$("#userPasswordConfirm")) { const label = document.createElement("label"); label.innerHTML = '비밀번호 확인<input id="userPasswordConfirm" type="password" minlength="10" autocomplete="new-password" placeholder="비밀번호를 다시 입력하세요">'; $("#userPassword").closest("label").after(label); }
  $("#userDialogTitle").textContent = user ? "사용자 정보 수정" : "사용자 추가";
  $("#userId").value = user?.id || "";
  $("#userName").value = user?.username || "";
  $("#userPassword").value = "";
  $("#userPasswordConfirm").value = "";
  $("#userPassword").required = !user;
  $("#userRole").value = user?.role || "operator";
  $("#userActive").checked = user?.active ?? true;
  renderUserRegions(user?.regionId || regionInfo.regions[0]?.id || "");
  $("#userDialog").showModal();
}

const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
const scheduleActionLabels = {
  "ivision.stop": "I-Vision 종료", "ivision.restart": "I-Vision 실행", "ume.activate": "화상회의 (UME) 실행",
  "smart_plug.on": "스마트플러그 ON", "smart_plug.off": "스마트플러그 OFF", "windows.shutdown": "Windows 종료",
};
function renderSchedules() {
  const list = $("#scheduleList");
  if (!schedules.length) {
    const empty = textElement("section", "panel empty-card", "등록된 스케줄이 없습니다. ‘스케줄 추가’로 시작하세요.");
    list.replaceChildren(empty); return;
  }
  const visibleSchedules = schedules.filter((schedule) => selectedRegionId === "all" || schedule.regionIds?.includes(selectedRegionId));
  list.replaceChildren(...visibleSchedules.map((schedule) => {
    const card = document.createElement("article");
    card.className = `schedule-card${schedule.enabled ? "" : " disabled"}`;
    const top = document.createElement("div");
    top.className = "schedule-top";
    const copy = document.createElement("div");
    const target = schedule.deviceNames?.length ? schedule.deviceNames.join(" · ") : (schedule.regionNames?.length ? `${schedule.regionNames.join(" · ")} 전체` : "전체 지역");
    copy.append(textElement("span", "schedule-state", schedule.enabled ? "사용 중" : "중지됨"), textElement("h3", "", schedule.name), textElement("p", "schedule-regions", schedule.actionLabel || scheduleActionLabels[schedule.actionType] || "화상회의 (UME) 실행"), textElement("p", "schedule-target", target));
    const edit = textElement("button", "icon-button", "•••");
    edit.setAttribute("aria-label", `${schedule.name} 수정`);
    edit.addEventListener("click", () => openSchedule(schedule));
    top.append(copy, edit);
    const time = textElement("strong", "schedule-time", schedule.localTime);
    const days = textElement("p", "schedule-days", schedule.days.map((day) => dayNames[day]).join(" · "));
    const actions = document.createElement("div");
    actions.className = "schedule-actions";
    const run = textElement("button", "secondary", "지금 실행");
    run.addEventListener("click", async () => {
      const actionLabel = schedule.actionLabel || scheduleActionLabels[schedule.actionType] || "화상회의 (UME) 실행";
      if (!await confirmAction(`${actionLabel}을 지금 실행할까요?`, `${target}에 저장된 스케줄 작업을 실행합니다.`, "실행")) return;
      try {
        const result = await api(`/api/schedules/${schedule.id}/run`, { method: "POST" });
        toast(schedule.actionType?.startsWith("smart_plug.") ? `등록된 Online 스마트플러그 ${result.targeted}대 제어를 완료했습니다.` : `${result.queued}대에 실행 명령을 보냈습니다.`);
      }
      catch (error) { toast(error.message, "error"); }
    });
    const toggle = textElement("button", "secondary", schedule.enabled ? "사용 해제" : "사용");
    toggle.addEventListener("click", async () => {
      try {
        await api(`/api/schedules/${schedule.id}`, { method: "PUT", body: JSON.stringify({ ...schedule, enabled: !schedule.enabled }) });
        await loadSchedules();
        toast(schedule.enabled ? "스케줄을 사용 해제했습니다." : "스케줄을 사용 상태로 바꿨습니다.");
      } catch (error) { handleError(error); }
    });
    const remove = textElement("button", "danger", "삭제");
    remove.addEventListener("click", async () => {
      if (!await confirmAction("이 스케줄을 삭제할까요?", `${schedule.name} 스케줄이 삭제됩니다. 기존 명령 이력은 유지됩니다.`, "삭제")) return;
      try { await api(`/api/schedules/${schedule.id}`, { method: "DELETE" }); await loadSchedules(); toast("스케줄을 삭제했습니다."); }
      catch (error) { handleError(error); }
    });
    actions.append(run, toggle, remove);
    card.append(top, time, days, actions);
    return card;
  }));
}

async function loadSchedules() { schedules = (await api("/api/schedules")).schedules; renderSchedules(); }

function openSchedule(schedule = null) {
  $("#scheduleId").value = schedule?.id || "";
  $("#scheduleName").value = schedule?.name || "";
  $("#scheduleTime").value = schedule?.localTime || "09:00";
  $("#scheduleActionType").value = schedule?.actionType || "ume.activate";
  $("#scheduleEnabled").checked = schedule?.enabled ?? true;
  scheduleDeviceIds = [...(schedule?.deviceIds || [])];
  const regionBox = $("#scheduleRegions");
  regionBox.replaceChildren(...regionInfo.regions.map((region) => { const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.name = "scheduleRegion"; input.value = region.id; input.checked = schedule?.regionIds?.length ? schedule.regionIds.includes(region.id) : true; input.addEventListener("change", renderScheduleDeviceSummary); label.append(input, region.name); return label; }));
  $$('input[name="day"]').forEach((input) => { input.checked = schedule ? schedule.days.includes(Number(input.value)) : [1, 2, 3, 4, 5].includes(Number(input.value)); });
  renderScheduleDeviceSummary();
  $("#scheduleDialog").showModal();
}

function scheduleSelectedRegions() { return $$('input[name="scheduleRegion"]:checked').map((input) => input.value); }
function scheduleEligibleDevices() {
  const regionIds = scheduleSelectedRegions();
  return devices.filter((device) => device.approved && (!regionIds.length || regionIds.includes(device.regionId)));
}
function renderScheduleDeviceSummary() {
  const eligible = scheduleEligibleDevices();
  scheduleDeviceIds = scheduleDeviceIds.filter((id) => eligible.some((device) => device.id === id));
  const names = eligible.filter((device) => scheduleDeviceIds.includes(device.id)).map((device) => device.displayName);
  $("#scheduleDeviceSummary").textContent = names.length ? `${names.length}곳 선택 · ${names.join(" · ")}` : "선택하지 않음 · 대상 지역 전체 적용";
}
function openScheduleDevicePicker() {
  const choices = $("#scheduleDeviceChoices");
  const eligible = scheduleEligibleDevices();
  scheduleDeviceIds = scheduleDeviceIds.filter((id) => eligible.some((device) => device.id === id));
  if (!eligible.length) choices.replaceChildren(textElement("p", "empty", "선택한 지역에 등록·승인된 경로당이 없습니다."));
  else choices.replaceChildren(...eligible.map((device) => {
    const label = document.createElement("label"); label.className = "schedule-device-choice";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = device.id; input.checked = scheduleDeviceIds.includes(device.id);
    label.append(input, textElement("span", "", device.displayName), textElement("small", "", device.regionName || "")); return label;
  }));
  $("#scheduleDeviceDialog").showModal();
}

function renderReleases() {
  const list = $("#releaseList");
  const visibleReleases = releases.filter((release) => releaseFilter === "all" || (releaseFilter === "agent" ? /^(Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-/i.test(release.fileName) : !/^(Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-/i.test(release.fileName)));
  if (!visibleReleases.length) { list.replaceChildren(textElement("section", "panel empty-card", "등록된 업데이트 파일이 없습니다.")); return; }
  list.replaceChildren(...visibleReleases.map((release) => {
    const card = document.createElement("article");
    card.className = "release-card panel";
    const isAgent = /^(Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-/i.test(release.fileName);
    const icon = textElement("div", `package-icon ${isAgent ? "agent-icon" : "ume-icon"}`, isAgent ? "Agent" : "UME");
    const info = document.createElement("div");
    info.className = "release-info";
    const regionLabel = isAgent ? (release.regionName || "기존 전역 파일") : "전체 지역";
    info.append(textElement("h3", "", `${isAgent ? "Agent" : "UME"} ${release.version}`), textElement("p", "", `${release.fileName} · ${formatBytes(release.sizeBytes)} · ${regionLabel}`), textElement("code", "hash", `SHA-256 ${release.sha256}`), textElement("small", "", `${release.createdBy} · ${formatTime(release.createdAt)}`));
    const distribute = textElement("button", "", release.regionName ? `${release.regionName} 장비에 배포` : "전체 장비에 배포");
    distribute.addEventListener("click", async () => {
      const target = release.regionName ? `${release.regionName} 지역의 승인 장비` : "승인된 모든 장비";
      if (!await confirmAction(`${isAgent ? "Agent" : "UME"} ${release.version}을 배포할까요?`, isAgent ? `${target}가 SHA-256 검증 후 자동으로 업데이트됩니다.` : `${target}가 설치파일을 다운로드하고 전자서명을 검증합니다.`, "배포")) return;
      distribute.disabled = true;
      try { const result = await api(`/api/releases/${release.id}/distribute`, { method: "POST", body: "{}" }); toast(`${result.queued}대에 다운로드 명령을 보냈습니다.`); }
      catch (error) { toast(error.message, "error"); }
      finally { distribute.disabled = false; }
    });
    const remove = textElement("button", "small danger", "삭제");
    remove.addEventListener("click", async () => { if (!await confirmAction(`${isAgent ? "Agent" : "UME"} ${release.version} 파일을 삭제할까요?`, isAgent ? "이 Agent 버전의 대기 중인 업데이트 명령과 파일을 함께 삭제합니다." : "배포 대기 중인 UME 파일은 삭제할 수 없습니다.", "삭제")) return; try { const result = await api(`/api/releases/${release.id}`, { method: "DELETE" }); await loadReleases(); toast(result.removedCommands ? `업데이트 파일과 대기 명령 ${result.removedCommands}건을 삭제했습니다.` : "업데이트 파일을 삭제했습니다."); } catch (error) { toast(error.message, "error"); } });
    const actions = textElement("div", "release-actions", "");
    if (isAgent) {
      const download = textElement("button", "secondary", "설치 파일 다운로드");
      download.addEventListener("click", () => { window.location.assign(`/api/releases/${release.id}/download`); });
      actions.append(download);
    }
    actions.append(distribute, remove);
    card.append(icon, info, actions); return card;
  }));
}

async function loadReleases() { releases = (await api("/api/releases")).releases; renderReleases(); }

function showPage(name) {
  if (name === "users" && currentSession?.role !== "admin") return;
  const nav = $(`.nav-item[data-view="${name}"]`);
  if (nav?.dataset.roles && !nav.dataset.roles.split(",").includes(currentSession?.role)) return;
  $$(".page").forEach((page) => { page.hidden = page.dataset.page !== name; page.classList.toggle("active", page.dataset.page === name); });
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  $("#pageEyebrow").textContent = pageMeta[name][0];
  $("#pageTitle").textContent = pageMeta[name][1];
  appView.classList.remove("menu-open");
  if (name === "schedules") loadSchedules().catch(handleError);
  if (name === "releases") loadReleases().catch(handleError);
  if (name === "users") loadUsers().catch(handleError);
  if (name === "system") Promise.all([loadDevices(), loadSystemStatus()]).catch(handleError);
}

function handleError(error) { toast(error.message || "요청을 처리하지 못했습니다.", "error"); }

function confirmAction(title, message, action) {
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmAccept").textContent = action;
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "default"), { once: true }));
}

async function showApp() {
  const session = await api("/api/session");
  currentSession = session;
  csrfToken = session.csrfToken;
  $("#sessionUser").textContent = `${session.username} · ${session.roleLabel || roleLabel(session.role)}`;
  $$(".admin-only").forEach((item) => { item.hidden = session.role !== "admin"; });
  $$(".nav-item[data-roles]").forEach((item) => { item.hidden = !item.dataset.roles.split(",").includes(session.role); });
  loginView.hidden = true;
  appView.hidden = false;
  await Promise.all([loadDevices(), loadEnrollmentInfo()]);
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#loginError");
  const button = $("#loginButton");
  error.textContent = ""; button.disabled = true; button.textContent = "확인 중…";
  try {
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: $("#username").value, password: $("#password").value }) });
    csrfToken = result.csrfToken; $("#password").value = ""; await showApp();
  } catch (reason) { error.textContent = reason.message; }
  finally { button.disabled = false; button.textContent = "로그인"; }
});

$("#togglePassword").addEventListener("click", () => {
  const input = $("#password"); const visible = input.type === "text";
  input.type = visible ? "password" : "text"; $("#togglePassword").textContent = visible ? "보기" : "숨기기";
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }); csrfToken = ""; appView.hidden = true; loginView.hidden = false; $("#username").focus();
});
$("#refreshButton").addEventListener("click", () => loadDevices().then(() => toast("최신 상태로 갱신했습니다.")).catch(handleError));
$("#dashboardRegionFilter")?.addEventListener("change", (event) => { selectedRegionId = event.target.value; renderDevices(); });
$("#deviceRegionFilter")?.addEventListener("change", (event) => { selectedRegionId = event.target.value; devicePage = 1; renderDevices(); });
$("#devicePageSize")?.addEventListener("change", (event) => { devicePageSize = Number(event.target.value) || 10; devicePage = 1; renderDevices(); });
$$('[data-device-sort]').forEach((button) => button.addEventListener("click", () => { const key = button.dataset.deviceSort; deviceSort = deviceSort.key === key ? { key, direction: deviceSort.direction * -1 } : { key, direction: 1 }; devicePage = 1; renderDevices(); }));
$("#scheduleRegionFilter")?.addEventListener("change", (event) => { selectedRegionId = event.target.value; renderSchedules(); });
$("#systemRefreshButton").addEventListener("click", () => Promise.all([loadDevices(), loadSystemStatus()]).then(() => toast("시스템 상태를 갱신했습니다.")).catch(handleError));
$("#searchInput").addEventListener("input", renderDevices);
$("#menuButton").addEventListener("click", () => appView.classList.toggle("menu-open"));
$$(".nav-item").forEach((item) => item.addEventListener("click", () => showPage(item.dataset.view)));
$$(".jump-button").forEach((item) => item.addEventListener("click", () => showPage(item.dataset.jump)));
$$("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  const input = $(`#${button.dataset.copy}`);
  await copyText(input.value);
  toast("복사했습니다.");
}));
$("#addRegionButton").addEventListener("click", () => { $("#regionName").value = ""; $("#regionDialog").showModal(); });
$("#addUserButton").addEventListener("click", () => openUser());
$("#userRole").addEventListener("change", () => renderUserRegions($("#userRegion").value));

$("#renameForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  try {
    await api(`/api/devices/${$("#renameDeviceId").value}`, { method: "PUT", body: JSON.stringify({ displayName: $("#renameDisplayName").value }) });
    $("#renameDialog").close(); await loadDevices(); toast("장비 정보를 저장했습니다.");
  } catch (error) { handleError(error); }
});

$("#regionForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  try {
    await api("/api/regions", { method: "POST", body: JSON.stringify({ name: $("#regionName").value }) });
    $("#regionDialog").close(); await loadEnrollmentInfo(); toast("지역 등록 키를 생성했습니다.");
  } catch (error) { handleError(error); }
});

$("#userForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const id = $("#userId").value;
  const password = $("#userPassword").value;
  const passwordConfirm = $("#userPasswordConfirm")?.value || "";
  if (password && password !== passwordConfirm) { toast("비밀번호가 일치하지 않습니다.", "error"); return; }
  const body = {
    username: $("#userName").value,
    password,
    passwordConfirm,
    role: $("#userRole").value,
    regionId: $("#userRole").value === "region_manager" ? $("#userRegion").value : null,
    active: $("#userActive").checked,
  };
  try {
    await api(id ? `/api/users/${id}` : "/api/users", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#userDialog").close(); await loadUsers(); toast("사용자 정보를 저장했습니다.");
  } catch (error) { handleError(error); }
});

$("#addScheduleButton").addEventListener("click", () => openSchedule());
$$('[data-bulk-display]').forEach((button) => button.addEventListener("click", async () => {
  const kind = button.dataset.bulkDisplay;
  const value = button.dataset.value;
  if (!await confirmAction(`${value} 명령을 보낼까요?`, "현재 온라인인 승인 장비에만 전송됩니다.", "전송")) return;
  button.disabled = true;
  try {
    const payload = kind === "power" ? { on: value === "on" } : { input: value };
    payload.deviceIds = devices.filter((device) => device.approved && device.status === "online" && (selectedRegionId === "all" || device.regionId === selectedRegionId)).map((device) => device.id);
    const result = await api(`/api/display/bulk/${kind}`, { method: "POST", body: JSON.stringify(payload) });
    toast(`${result.queued}대의 온라인 장비에 ${value} 명령을 전송했습니다.`);
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}));
async function copyText(value) {
  if (navigator.clipboard?.writeText && window.isSecureContext) { await navigator.clipboard.writeText(value); return; }
  const area = document.createElement("textarea");
  area.value = value; area.readOnly = true; area.style.position = "fixed"; area.style.opacity = "0";
  document.body.append(area); area.focus(); area.select();
  const copied = document.execCommand("copy"); area.remove();
  if (!copied) throw new Error("브라우저가 클립보드 접근을 허용하지 않았습니다.");
}
$$('[data-bulk-ivision]').forEach((button) => button.addEventListener("click", async () => {
  const action = button.dataset.bulkIvision;
  const label = action === "stop" ? "종료" : "재실행";
  if (!await confirmAction(`온라인 장비 전체의 i-Vision을 ${label}할까요?`, "현재 온라인인 승인 장비에만 전송됩니다.", label)) return;
  button.disabled = true;
  try { const deviceIds = devices.filter((device) => device.approved && device.status === "online" && (selectedRegionId === "all" || device.regionId === selectedRegionId)).map((device) => device.id); const result = await api(`/api/ivision/bulk/${action}`, { method: "POST", body: JSON.stringify({ deviceIds }) }); toast(`${result.queued}대의 온라인 장비에 i-Vision ${label} 명령을 전송했습니다.`); }
  catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}));
$$('[data-bulk-smart-plug]').forEach((button) => button.addEventListener("click", async () => {
  const on = button.dataset.bulkSmartPlug === "on";
  const targetDevices = devices.filter((device) => device.approved && device.smartPlug && device.smartPlug.connection === "online" && (selectedRegionId === "all" || device.regionId === selectedRegionId));
  if (!await confirmAction(`현재 지역의 등록된 Online 스마트플러그 ${targetDevices.length}대를 ${on ? "ON" : "OFF"}할까요?`, "Offline 또는 미등록 스마트플러그는 제외됩니다.", `스마트플러그 ${on ? "ON" : "OFF"}`)) return;
  button.disabled = true;
  try {
    const result = await api("/api/smart-plugs/bulk/power", { method: "POST", body: JSON.stringify({ on, regionId: selectedRegionId, deviceIds: targetDevices.map((device) => device.id) }) });
    toast(`등록된 Online 스마트플러그 ${result.targeted}대 중 ${result.succeeded}대 전원 ${on ? "ON" : "OFF"} 완료${result.failed ? ` · ${result.failed}대 실패` : ""}.`, result.failed ? "error" : "success");
    await loadDevices();
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}));
$$('[data-bulk-windows]').forEach((button) => button.addEventListener("click", async () => {
  if (!await confirmAction("온라인 장비 전체의 Windows를 종료할까요?", "저장하지 않은 작업이 손실될 수 있습니다. 현재 지역 필터의 온라인 승인 장비에만 전송됩니다.", "Windows 종료")) return;
  button.disabled = true;
  try { const deviceIds = devices.filter((device) => device.approved && device.status === "online" && (selectedRegionId === "all" || device.regionId === selectedRegionId)).map((device) => device.id); const result = await api("/api/windows/bulk/shutdown", { method: "POST", body: JSON.stringify({ deviceIds }) }); toast(`${result.queued}대의 장비에 Windows 종료 명령을 전송했습니다.`); }
  catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}));
$("#selectAllDevices")?.addEventListener("change", (event) => { $$(".device-select").forEach((box) => { if (!box.disabled) { box.checked = event.currentTarget.checked; box.checked ? selectedDeviceIds.add(box.dataset.deviceId) : selectedDeviceIds.delete(box.dataset.deviceId); } }); });
$$('[data-device-bulk]').forEach((button) => button.addEventListener("click", async () => {
  const action = button.dataset.deviceBulk; const ids = [...selectedDeviceIds]; if (!ids.length) { toast("먼저 장비를 선택해 주세요.", "error"); return; }
  const labels = { "display-status": "TV 상태 확인", "display-on": "TV 전원 ON", "display-off": "TV 전원 OFF", hdmi1: "HDMI1", hdmi2: "HDMI2", hdmi3: "HDMI3", ume: "UME 실행", "ume-stop": "UME 종료", "ivision-stop": "I-Vision 종료", "ivision-restart": "I-Vision 재실행", "smart-plug-on": "스마트플러그 ON", "smart-plug-off": "스마트플러그 OFF", "windows-shutdown": "Windows 종료" };
  const smartPlugAction = action === "smart-plug-on" || action === "smart-plug-off";
  if (!await confirmAction(`선택한 ${ids.length}대에 ${labels[action]} 명령을 보낼까요?`, smartPlugAction ? "등록되고 Online 상태인 스마트플러그만 제어합니다." : "온라인 승인 장비에만 전송됩니다.", "전송")) return;
  button.disabled = true;
  try {
    let path, payload = { deviceIds: ids };
    if (action === "display-status") path = "/api/health/bulk";
    else if (action === "display-on" || action === "display-off") { path = "/api/display/bulk/power"; payload.on = action === "display-on"; }
    else if (action === "hdmi1" || action === "hdmi2" || action === "hdmi3") { path = "/api/display/bulk/input"; payload.input = action.toUpperCase(); }
    else if (action === "ume" || action === "ume-stop") { path = "/api/ume/bulk"; if (action === "ume-stop") payload.action = "stop"; }
    else if (action.startsWith("ivision-")) path = `/api/ivision/bulk/${action.slice(8)}`;
    else if (smartPlugAction) { path = "/api/smart-plugs/bulk/power"; payload.on = action === "smart-plug-on"; payload.regionId = selectedRegionId; }
    else path = "/api/windows/bulk/shutdown";
    const result = await api(path, { method: "POST", body: JSON.stringify(payload) });
    const skippedUnsupported = !smartPlugAction && result.skippedUnsupported ? ` · HDMI 입력 미지원 ${result.skippedUnsupported}대 제외` : "";
    toast(smartPlugAction ? `등록된 Online 스마트플러그 ${result.targeted}대 중 ${result.succeeded}대 전원 ${payload.on ? "ON" : "OFF"} 완료${result.failed ? ` · ${result.failed}대 실패` : ""}.` : `${result.queued}대에 ${labels[action]} 명령을 전송했습니다.${skippedUnsupported}`, smartPlugAction && result.failed ? "error" : "success");
    if (action === "display-status") setTimeout(loadDevices, 2200); else if (smartPlugAction) await loadDevices();
  } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; }
}));
$("#scheduleForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const id = $("#scheduleId").value;
  const regionIds = $$('input[name="scheduleRegion"]:checked').map((input) => input.value);
  if (!regionIds.length) { event.preventDefault(); toast("대상 지역을 하나 이상 선택해 주세요.", "error"); return; }
  const body = JSON.stringify({ name: $("#scheduleName").value, actionType: $("#scheduleActionType").value, localTime: $("#scheduleTime").value, regionIds, deviceIds: scheduleDeviceIds, days: $$('input[name="day"]:checked').map((input) => Number(input.value)), enabled: $("#scheduleEnabled").checked });
  try { await api(id ? `/api/schedules/${id}` : "/api/schedules", { method: id ? "PUT" : "POST", body }); $("#scheduleDialog").close(); await loadSchedules(); toast("스케줄을 저장했습니다."); }
  catch (error) { handleError(error); }
});

$("#scheduleDevicePickerButton").addEventListener("click", openScheduleDevicePicker);
$("#scheduleDeviceDialog").addEventListener("close", () => {
  const dialog = $("#scheduleDeviceDialog");
  if (dialog.returnValue === "cancel") return;
  scheduleDeviceIds = $$("input[type=checkbox]:checked", $("#scheduleDeviceChoices")).map((input) => input.value);
  renderScheduleDeviceSummary();
});

$("#releaseFile").addEventListener("change", () => { const file = $("#releaseFile").files[0]; $("#uploadReleaseButton").disabled = !file; $("#selectedReleaseFile").textContent = file ? `선택 파일: ${file.name}` : "선택된 파일 없음"; });
$("#uploadReleaseButton").addEventListener("click", async () => {
  const file = $("#releaseFile").files[0]; if (!file) return;
  const isAgent = /^(Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-/i.test(file.name);
  const regionId = $("#releaseRegion").value;
  if (isAgent && !regionId) { toast("Agent 설치 파일의 대상 지역을 선택해 주세요.", "error"); return; }
  const button = $("#uploadReleaseButton"); const progress = $("#uploadProgress");
  button.disabled = true; button.textContent = "업로드 중…"; progress.hidden = false; progress.removeAttribute("value");
  try {
    await api("/api/releases/upload", { method: "POST", headers: { "X-File-Name": encodeURIComponent(file.name), ...(isAgent ? { "X-Region-Id": regionId } : {}) }, body: file });
    $("#releaseFile").value = ""; $("#selectedReleaseFile").textContent = "선택된 파일 없음"; await loadReleases(); toast("업데이트 파일을 등록했습니다.");
  } catch (error) { handleError(error); }
  finally { button.disabled = false; button.textContent = "업로드"; progress.hidden = true; progress.value = 0; }
});

const integrations = {
  ivision: { title: "i-vision Cloud", label: "cloud.myivision.com", url: "https://cloud.myivision.com/" },
  "ume-manager": { title: "UME 관리자", label: "uc01.fun-net.co.kr:8443", url: "https://uc01.fun-net.co.kr:8443/manager/login" },
  "agent-install": { title: "Agent 설치 정보", label: "현장 PC 등록을 위한 서버 주소와 지역별 등록 키", url: null },
};
$$('[data-tool]').forEach((button) => button.addEventListener("click", () => {
  $$('[data-tool]').forEach((item) => { const selected = item === button; item.classList.toggle("active", selected); item.setAttribute("aria-selected", String(selected)); });
  const tool = integrations[button.dataset.tool];
  const agentInstall = button.dataset.tool === "agent-install";
  $("#integrationPanel").hidden = agentInstall;
  $("#agentInstallPanel").hidden = !agentInstall;
  if (!agentInstall) { $("#integrationTitle").textContent = tool.title; $("#integrationUrl").textContent = tool.label; $("#integrationFrame").src = tool.url; $("#integrationFallback").href = tool.url; }
}));
$$('[data-release-filter]').forEach((button) => button.addEventListener("click", () => {
  releaseFilter = button.dataset.releaseFilter;
  $$('[data-release-filter]').forEach((item) => item.classList.toggle("active", item === button));
  renderReleases();
}));

showApp().catch(() => { loginView.hidden = false; appView.hidden = true; });
