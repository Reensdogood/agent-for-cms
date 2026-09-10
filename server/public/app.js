const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const loginView = $("#loginView");
const appView = $("#appView");
let csrfToken = "";
let devices = [];
let schedules = [];
let releases = [];
let releaseFilter = "all";
let selectedRegionId = "all";
let users = [];
let currentSession = null;
let regionInfo = { serverBaseUrl: "", regions: [] };

const pageMeta = {
  dashboard: ["OVERVIEW", "장비 현황"], devices: ["DEVICES", "장비 관리"],
  schedules: ["SCHEDULE", "실행 스케줄"], system: ["SYSTEM", "시스템 상태"], releases: ["DISTRIBUTION", "UME 배포"],
  integrations: ["SERVICES", "외부 관리"], users: ["ACCESS", "사용자 관리"],
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
  $("#countTotal").textContent = scoped.length;
  $("#countApproved").textContent = `승인 ${scoped.filter((d) => d.approved).length} · 대기 ${scoped.filter((d) => !d.approved).length}`;
  $("#countOnline").textContent = scoped.filter((d) => d.status === "online").length;
  $("#countUmeRunning").textContent = scoped.filter((d) => d.ume?.running).length;
  $("#countIvisionRunning").textContent = scoped.filter((d) => d.ivisionRunning).length;
  const umeVersions = [...new Set(scoped.map((d) => d.ume?.version).filter(Boolean))];
  $("#countUmeVersion").textContent = umeVersions.length ? `버전 ${umeVersions.slice(0, 2).join(", ")}${umeVersions.length > 2 ? ` 외 ${umeVersions.length - 2}` : ""}` : "감지된 버전 없음";
  $("#deviceRows").replaceChildren(...visible.map(deviceRow));
  $("#emptyState").hidden = visible.length > 0;
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

function deviceRow(device) {
  const row = document.createElement("tr");
  const status = document.createElement("td");
  const badge = textElement("span", `status ${device.status}`, statusLabel(device.status));
  badge.prepend(textElement("i", "", ""));
  status.append(badge);
  if (!device.approved) status.append(textElement("small", "pending-label", "승인 대기"));
  row.append(status, tableCell(device.regionName || "-", "region-name"), tableCell(device.displayName, "device-name"), tableCell(device.id, "mono"),
    tableCell(device.agentVersion || "-"),
    tableCell(device.ume?.version ? `${device.ume.name || "UME"} ${device.ume.version}${device.ume.running ? " · 실행" : ""}` : "미감지"),
    tableCell(device.ivisionRunning ? "실행" : "미실행"), tableCell(device.displayConnection || "미확인", `display-connection ${device.displayConnection === "정상" ? "connected" : device.displayConnection === "연결 실패" ? "failed" : ""}`), tableCell(formatTime(device.lastSeenAt)));
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
  const tv = textElement("button", "small secondary", "TV 제어");
  tv.disabled = !device.approved || !device.displayEnabled;
  if (!device.displayEnabled) tv.title = "이 장비는 TV 제어가 비활성화되어 있습니다.";
  tv.addEventListener("click", async () => {
    let current = {};
    try { const s = await api(`/api/devices/${device.id}/display/status`); current = s.display || {}; } catch {}
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `<form method="dialog"><div class="tv-dialog-header"><span class="eyebrow">DISPLAY CONTROL</span><h3>${device.displayName} TV 제어</h3><p>현재 상태를 확인하고 원하는 동작을 선택하세요.</p><div class="tv-live-status">${current.power ? `전원 ${String(current.power).toUpperCase()} · ${current.input || "입력 미확인"} · 볼륨 ${current.volume ?? "미확인"}` : "현재 상태 미확인"}</div><button type="button" class="small secondary" id="readDisplayStatus">TV 현재 상태 조회</button></div><div class="dialog-actions"></div><div class="dialog-footer"><button value="cancel" class="small secondary">닫기</button></div></form>`;
    dialog.querySelector("#readDisplayStatus").addEventListener("click", async (event) => { const button = event.currentTarget; button.disabled = true; try { await api(`/api/devices/${device.id}/display/status`, { method: "POST", body: "{}" }); button.textContent = "조회 중…"; setTimeout(async () => { try { const latest = await api(`/api/devices/${device.id}/display/status`); const value = latest.display || {}; dialog.querySelector(".tv-live-status").textContent = value.connection === "connected" ? `전원 ${String(value.power || "-").toUpperCase()} · ${value.input || "입력 -"} · 볼륨 ${value.volume ?? "-"}` : "TV 연결 실패"; } catch {} finally { button.disabled = false; button.textContent = "TV 현재 상태 조회"; } }, 1800); } catch (error) { toast(error.message, "error"); button.disabled = false; } });
    const actions = dialog.querySelector(".dialog-actions");
    const commands = [["전원 ON", "power", { on: true }], ["전원 OFF", "power", { on: false }], ["HDMI1", "input", { input: "HDMI1" }], ["HDMI2", "input", { input: "HDMI2" }], ["현재 볼륨 +", "volume", { value: 55 }], ["현재 볼륨 −", "volume", { value: 45 }]];
    for (const [label, kind, payload] of commands) { const active = (label.includes("ON") && String(current.power).toLowerCase() === "on") || (label.includes("OFF") && String(current.power).toLowerCase() === "off") || (label.toUpperCase() === String(current.input || "").toUpperCase()); const tone = label.startsWith("전원") ? "power-command" : label.startsWith("HDMI") ? "input-command" : "volume-command"; const b = textElement("button", `small primary-soft tv-command ${tone}${active ? " active-display" : ""}`, active ? `✓ ${label}` : label); b.type = "button"; b.addEventListener("click", async () => { b.disabled = true; try { await api(`/api/devices/${device.id}/display/${kind}`, { method: "POST", body: JSON.stringify(payload) }); toast(`${device.displayName}에 ${label} 명령을 보냈습니다.`); dialog.close(); } catch (error) { toast(error.message, "error"); b.disabled = false; } }); actions.append(b); }
    document.body.append(dialog); dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal();
  });
  actions.append(tv);
  const ivisionStop = textElement("button", "small secondary", "i-vision 종료");
  const ivisionRestart = textElement("button", "small secondary", "i-vision 재실행");
  ivisionStop.disabled = ivisionRestart.disabled = !device.approved;
  for (const [button, action, label] of [[ivisionStop, "stop", "종료"], [ivisionRestart, "restart", "재실행"]]) button.addEventListener("click", async () => { if (!await confirmAction(`${device.displayName}의 i-vision을 ${label}할까요?`, "현재 실행 중인 i-Vision.Player 프로세스 기준으로 처리합니다.", label)) return; button.disabled = true; try { await api(`/api/devices/${device.id}/ivision/${action}`, { method: "POST", body: "{}" }); toast(`i-vision ${label} 명령을 보냈습니다.`); setTimeout(loadDevices, 1800); } catch (error) { toast(error.message, "error"); } finally { button.disabled = !device.approved; } });
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
  actions.append(probe, runUme, ivisionStop, ivisionRestart, edit, remove);
  row.append(actions);
  return row;
}

async function loadDevices() {
  const result = await api("/api/devices");
  devices = result.devices;
  $("#updatedAt").textContent = `최근 갱신 ${formatTime(result.serverTime)}`;
  renderDevices();
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
    row.append(copy, copyButton, rotate);
    return row;
  }));
}

function roleLabel(role) {
  return { admin: "전체 시스템", operator: "운영", region_manager: "지역 관리자" }[role] || role;
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
    copy.append(textElement("span", "schedule-state", schedule.enabled ? "사용 중" : "중지됨"), textElement("h3", "", schedule.name), textElement("p", "schedule-regions", schedule.regionNames?.length ? schedule.regionNames.join(" · ") : "전체 지역"));
    const edit = textElement("button", "icon-button", "•••");
    edit.setAttribute("aria-label", `${schedule.name} 수정`);
    edit.addEventListener("click", () => openSchedule(schedule));
    top.append(copy, edit);
    const time = textElement("strong", "schedule-time", schedule.localTime);
    const days = textElement("p", "schedule-days", schedule.days.map((day) => dayNames[day]).join(" · "));
    const actions = document.createElement("div");
    actions.className = "schedule-actions";
    const run = textElement("button", "secondary", "전체 실행");
    run.addEventListener("click", async () => {
      if (!await confirmAction("UME를 지금 실행할까요?", "승인된 모든 온라인 장비에 전체화면 실행 명령을 전송합니다.", "실행")) return;
      try { const result = await api(`/api/schedules/${schedule.id}/run`, { method: "POST" }); toast(`${result.queued}대에 실행 명령을 보냈습니다.`); }
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
  $("#scheduleEnabled").checked = schedule?.enabled ?? true;
  let regionBox = $("#scheduleRegions");
  if (!regionBox) { regionBox = document.createElement("div"); regionBox.id = "scheduleRegions"; regionBox.className = "day-picker region-picker"; $("#scheduleForm").prepend(regionBox); }
  regionBox.replaceChildren(...regionInfo.regions.map((region) => { const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.name = "scheduleRegion"; input.value = region.id; input.checked = schedule?.regionIds?.includes(region.id) ?? true; label.append(input, region.name); return label; }));
  $$('input[name="day"]').forEach((input) => { input.checked = schedule ? schedule.days.includes(Number(input.value)) : [1, 2, 3, 4, 5].includes(Number(input.value)); });
  $("#scheduleDialog").showModal();
}

function renderReleases() {
  const list = $("#releaseList");
  const visibleReleases = releases.filter((release) => releaseFilter === "all" || (releaseFilter === "agent" ? /^(Funnet\.Gwanak\.Agent|funnet-gwanak-agent-setup)-/i.test(release.fileName) : !/^(Funnet\.Gwanak\.Agent|funnet-gwanak-agent-setup)-/i.test(release.fileName)));
  if (!visibleReleases.length) { list.replaceChildren(textElement("section", "panel empty-card", "등록된 업데이트 파일이 없습니다.")); return; }
  list.replaceChildren(...visibleReleases.map((release) => {
    const card = document.createElement("article");
    card.className = "release-card panel";
    const isAgent = /^(Funnet\.Gwanak\.Agent|funnet-gwanak-agent-setup)-/i.test(release.fileName);
    const icon = textElement("div", `package-icon ${isAgent ? "agent-icon" : "ume-icon"}`, isAgent ? "Agent" : "UME");
    const info = document.createElement("div");
    info.className = "release-info";
    info.append(textElement("h3", "", `${isAgent ? "Agent" : "UME"} ${release.version}`), textElement("p", "", `${release.fileName} · ${formatBytes(release.sizeBytes)}`), textElement("code", "hash", `SHA-256 ${release.sha256}`), textElement("small", "", `${release.createdBy} · ${formatTime(release.createdAt)}`));
    const distribute = textElement("button", "", "전체 장비에 배포");
    distribute.addEventListener("click", async () => {
      if (!await confirmAction(`${isAgent ? "Agent" : "UME"} ${release.version}을 배포할까요?`, isAgent ? "승인된 모든 에이전트가 SHA-256 검증 후 자동으로 업데이트됩니다." : "승인된 모든 PC가 설치파일을 다운로드하고 전자서명을 검증합니다.", "배포")) return;
      distribute.disabled = true;
      try { const result = await api(`/api/releases/${release.id}/distribute`, { method: "POST", body: "{}" }); toast(`${result.queued}대에 다운로드 명령을 보냈습니다.`); }
      catch (error) { toast(error.message, "error"); }
      finally { distribute.disabled = false; }
    });
    const remove = textElement("button", "small danger", "삭제");
    remove.addEventListener("click", async () => { if (!await confirmAction(`${isAgent ? "Agent" : "UME"} ${release.version} 파일을 삭제할까요?`, "배포 대기 중인 파일은 삭제할 수 없습니다.", "삭제")) return; try { await api(`/api/releases/${release.id}`, { method: "DELETE" }); await loadReleases(); toast("업데이트 파일을 삭제했습니다."); } catch (error) { toast(error.message, "error"); } });
    const actions = textElement("div", "release-actions", ""); actions.append(distribute, remove);
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
$("#deviceRegionFilter")?.addEventListener("change", (event) => { selectedRegionId = event.target.value; renderDevices(); });
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
  try { const result = await api(`/api/ivision/bulk/${action}`, { method: "POST", body: "{}" }); toast(`${result.queued}대의 온라인 장비에 i-Vision ${label} 명령을 전송했습니다.`); }
  catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}));
$("#scheduleForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const id = $("#scheduleId").value;
  const body = JSON.stringify({ name: $("#scheduleName").value, localTime: $("#scheduleTime").value, regionIds: $$('input[name="scheduleRegion"]:checked').map((input) => input.value), days: $$('input[name="day"]:checked').map((input) => Number(input.value)), enabled: $("#scheduleEnabled").checked });
  try { await api(id ? `/api/schedules/${id}` : "/api/schedules", { method: id ? "PUT" : "POST", body }); $("#scheduleDialog").close(); await loadSchedules(); toast("스케줄을 저장했습니다."); }
  catch (error) { handleError(error); }
});

$("#releaseFile").addEventListener("change", () => { const file = $("#releaseFile").files[0]; $("#uploadReleaseButton").disabled = !file; $("#selectedReleaseFile").textContent = file ? `선택 파일: ${file.name}` : "선택된 파일 없음"; });
$("#uploadReleaseButton").addEventListener("click", async () => {
  const file = $("#releaseFile").files[0]; if (!file) return;
  const button = $("#uploadReleaseButton"); const progress = $("#uploadProgress");
  button.disabled = true; button.textContent = "업로드 중…"; progress.hidden = false; progress.removeAttribute("value");
  try {
    await api("/api/releases/upload", { method: "POST", headers: { "X-File-Name": encodeURIComponent(file.name) }, body: file });
    $("#releaseFile").value = ""; $("#selectedReleaseFile").textContent = "선택된 파일 없음"; await loadReleases(); toast("업데이트 파일을 등록했습니다.");
  } catch (error) { handleError(error); }
  finally { button.disabled = false; button.textContent = "업로드"; progress.hidden = true; progress.value = 0; }
});

const integrations = {
  ivision: { title: "i-vision Cloud", label: "cloud.myivision.com", url: "https://cloud.myivision.com/" },
  "ume-manager": { title: "UME 관리자", label: "uc01.fun-net.co.kr:8443", url: "https://uc01.fun-net.co.kr:8443/manager/login" },
};
$$('[data-tool]').forEach((button) => button.addEventListener("click", () => {
  $$('[data-tool]').forEach((item) => item.classList.toggle("active", item === button));
  const tool = integrations[button.dataset.tool]; $("#integrationTitle").textContent = tool.title; $("#integrationUrl").textContent = tool.label; $("#integrationFrame").src = tool.url; $("#integrationFallback").href = tool.url;
}));
$$('[data-release-filter]').forEach((button) => button.addEventListener("click", () => {
  releaseFilter = button.dataset.releaseFilter;
  $$('[data-release-filter]').forEach((item) => item.classList.toggle("active", item === button));
  renderReleases();
}));

showApp().catch(() => { loginView.hidden = false; appView.hidden = true; });
