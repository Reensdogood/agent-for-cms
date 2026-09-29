import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "funnet-server-test-"));
process.env.NODE_ENV = "test";
process.env.FUNNET_DATA_DIR = testDir;
process.env.FUNNET_ADMIN_PASSWORD = "test-admin-password";
process.env.FUNNET_ENROLLMENT_KEY = "test-enrollment-key-123";
process.env.ENERCARE_BASE_URL = "https://enercare.test";
process.env.ENERCARE_DWD_SERVER_ID = "FUNNET";
process.env.ENERCARE_DWD_GROUP_ID = "FUNNET";
process.env.ENERCARE_DWD_SERVER_SECRET = "test-dwd-secret";
process.env.ENERCARE_CON_SERVER_SECRET = "test-callback-secret";

const nativeFetch = global.fetch;
global.fetch = async (input, options = {}) => {
  const url = String(input);
  if (!url.startsWith("https://enercare.test/")) return nativeFetch(input, options);
  if (url.endsWith("/conn/v1/publish/servertoken")) return Response.json({ dwd_access_token: "test-access-token", dwd_access_token_expiredate: "2099-12-31 23:59:59" });
  if (url.endsWith("/conn/v1/inquire/device/values")) return Response.json({ results: { conn_status: 1, switch_status: "ON", upload_time: "2026-09-18 10:00:00" } });
  if (url.endsWith("/conn/v1/control/device/onoff")) return Response.json({ result: "OFF" });
  if (url.endsWith("/conn/v1/profile/device/list")) return Response.json({ deviceList: [{ device_id: "DAWONDNS-B540_W-test", display_name: "테스트 플러그", conn_status: "1", power: "true" }] });
  return Response.json({ reason: "not found" }, { status: 404 });
};

const { server, closeDatabase } = await import("./server.mjs");
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test("login, registration, heartbeat, approval and health probe flow", async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-admin-password" }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const installationId = crypto.randomUUID();
  const registration = await fetch(`${base}/api/agent/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Enrollment-Key": "test-enrollment-key-123" },
    body: JSON.stringify({ installationId, localName: "테스트 장비", machineName: "TEST-PC", agentVersion: "0.1.0" }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json();

  const heartbeat = await fetch(`${base}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registered.deviceToken}` },
    body: JSON.stringify({
      localName: "테스트 장비",
      machineName: "TEST-PC",
      agentVersion: "0.1.0",
      ume: { name: "UME", version: "49.1.6", path: "C:/UME.exe", running: true },
      ivisionRunning: true,
      foregroundApp: "i-Vision.Player.exe",
    }),
  });
  assert.equal(heartbeat.status, 200);

  const list = await fetch(`${base}/api/devices`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0].status, "online");
  assert.equal(listed.devices[0].ume.version, "49.1.6");
  assert.equal(listed.devices[0].regionName, "관악");

  const update = await fetch(`${base}/api/devices/${registered.deviceId}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ displayName: "관악-001" }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).device.displayName, "관악-001");

  const approve = await fetch(`${base}/api/devices/${registered.deviceId}/approve`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
  });
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).device.approved, true);

  const enrollment = await fetch(`${base}/api/enrollment-key`, { headers: { Cookie: cookie } });
  assert.equal(enrollment.status, 200);
  assert.equal((await enrollment.json()).enrollmentKey, "test-enrollment-key-123");

  const regions = await fetch(`${base}/api/regions`, { headers: { Cookie: cookie } });
  assert.equal(regions.status, 200);
  const regionsBody = await regions.json();
  assert.equal(regionsBody.regions[0].name, "관악");

  const regionCreate = await fetch(`${base}/api/regions`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ name: "동작" }),
  });
  assert.equal(regionCreate.status, 201);
  const createdRegion = (await regionCreate.json()).region;
  assert.equal(createdRegion.name, "동작");

  const userCreate = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ username: "dongjak-manager", password: "region-password-123", role: "region_manager", regionId: createdRegion.id }),
  });
  assert.equal(userCreate.status, 201);
  const createdUser = (await userCreate.json()).user;
  assert.equal(createdUser.role, "region_manager");
  assert.equal(createdUser.regionName, "동작");

  const userUpdate = await fetch(`${base}/api/users/${createdUser.id}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ username: "dongjak-operator", role: "operator", active: true }),
  });
  assert.equal(userUpdate.status, 200);
  assert.equal((await userUpdate.json()).user.role, "operator");

  const userList = await fetch(`${base}/api/users`, { headers: { Cookie: cookie } });
  assert.equal(userList.status, 200);
  assert.ok((await userList.json()).users.some((user) => user.username === "dongjak-operator"));

  const operatorLogin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dongjak-operator", password: "region-password-123" }),
  });
  assert.equal(operatorLogin.status, 200);
  const operatorLoginBody = await operatorLogin.json();
  const operatorCookie = operatorLogin.headers.get("set-cookie").split(";")[0];
  const operatorSystemStatus = await fetch(`${base}/api/commands?limit=20`, { headers: { Cookie: operatorCookie } });
  assert.equal(operatorSystemStatus.status, 200);
  const smartPlugSave = await fetch(`${base}/api/devices/${registered.deviceId}/smart-plug`, {
    method: "PUT",
    headers: { Cookie: operatorCookie, "Content-Type": "application/json", "X-CSRF-Token": operatorLoginBody.csrfToken },
    body: JSON.stringify({ enercareDeviceId: "DAWONDNS-B540_W-test", lowGroupId: "GWANAK9", subGroupId: "", displayName: "테스트 플러그" }),
  });
  assert.equal(smartPlugSave.status, 200);
  assert.equal((await smartPlugSave.json()).smartPlug.lowGroupId, "GWANAK9");
  const smartPlugStatus = await fetch(`${base}/api/devices/${registered.deviceId}/smart-plug/status`, { headers: { Cookie: operatorCookie } });
  assert.equal(smartPlugStatus.status, 200);
  assert.deepEqual((await smartPlugStatus.json()).smartPlug.connection, "online");
  const smartPlugPower = await fetch(`${base}/api/devices/${registered.deviceId}/smart-plug/power`, {
    method: "POST",
    headers: { Cookie: operatorCookie, "Content-Type": "application/json", "X-CSRF-Token": operatorLoginBody.csrfToken },
    body: JSON.stringify({ on: false }),
  });
  assert.equal(smartPlugPower.status, 200);
  assert.equal((await smartPlugPower.json()).smartPlug.power, "off");
  const smartPlugBulkPower = await fetch(`${base}/api/smart-plugs/bulk/power`, {
    method: "POST",
    headers: { Cookie: operatorCookie, "Content-Type": "application/json", "X-CSRF-Token": operatorLoginBody.csrfToken },
    body: JSON.stringify({ on: true, regionId: regionsBody.regions[0].id, deviceIds: [registered.deviceId] }),
  });
  assert.equal(smartPlugBulkPower.status, 200);
  assert.deepEqual(await smartPlugBulkPower.json(), { targeted: 1, succeeded: 1, failed: 0, failures: [] });

  const regionalUser = await fetch(`${base}/api/users/${createdUser.id}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ username: "dongjak-manager", role: "region_manager", regionId: createdRegion.id, active: true }),
  });
  assert.equal(regionalUser.status, 200);
  const regionalLogin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dongjak-manager", password: "region-password-123" }),
  });
  assert.equal(regionalLogin.status, 200);
  const regionalCookie = regionalLogin.headers.get("set-cookie").split(";")[0];
  const regionalSystemStatus = await fetch(`${base}/api/commands?limit=20`, { headers: { Cookie: regionalCookie } });
  assert.equal(regionalSystemStatus.status, 403);
  const regionalSmartPlugSave = await fetch(`${base}/api/devices/${registered.deviceId}/smart-plug`, {
    method: "PUT",
    headers: { Cookie: regionalCookie, "Content-Type": "application/json", "X-CSRF-Token": (await regionalLogin.clone().json()).csrfToken },
    body: JSON.stringify({ enercareDeviceId: "DAWONDNS-B540_W-other" }),
  });
  assert.equal(regionalSmartPlugSave.status, 403);
  const regionalSmartPlugBulk = await fetch(`${base}/api/smart-plugs/bulk/power`, {
    method: "POST",
    headers: { Cookie: regionalCookie, "Content-Type": "application/json", "X-CSRF-Token": (await regionalLogin.clone().json()).csrfToken },
    body: JSON.stringify({ on: true, deviceIds: [registered.deviceId] }),
  });
  assert.equal(regionalSmartPlugBulk.status, 403);

  const rejectedRegistration = await fetch(`${base}/api/agent/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Enrollment-Key": "wrong-enrollment-key" },
    body: JSON.stringify({ installationId: crypto.randomUUID(), localName: "거절 장비", machineName: "OLD-KEY", agentVersion: "1.0.0" }),
  });
  assert.equal(rejectedRegistration.status, 401);

  const acceptedRegistration = await fetch(`${base}/api/agent/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Enrollment-Key": createdRegion.enrollmentKey },
    body: JSON.stringify({ installationId: crypto.randomUUID(), localName: "동작 신규 장비", machineName: "NEW-KEY", agentVersion: "1.0.0" }),
  });
  assert.equal(acceptedRegistration.status, 201);
  const acceptedRegionDevice = await acceptedRegistration.json();

  const rotateDefault = await fetch(`${base}/api/regions/${regionsBody.regions[0].id}/rotate-key`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
  });
  assert.equal(rotateDefault.status, 200);
  const rotatedDefault = await rotateDefault.json();
  assert.notEqual(rotatedDefault.region.enrollmentKey, "test-enrollment-key-123");

  const heartbeatAfterRotate = await fetch(`${base}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registered.deviceToken}` },
    body: JSON.stringify({ localName: "테스트 장비", machineName: "TEST-PC", agentVersion: "1.0.0" }),
  });
  assert.equal(heartbeatAfterRotate.status, 200);

  const probe = await fetch(`${base}/api/devices/${registered.deviceId}/probe`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
  });
  assert.equal(probe.status, 202);

  const commands = await fetch(`${base}/api/agent/commands`, {
    headers: { Authorization: `Bearer ${registered.deviceToken}` },
  });
  const commandBody = await commands.json();
  assert.equal(commandBody.commands.length, 1);
  assert.equal(commandBody.commands[0].type, "health.probe");

  const releaseBytes = Buffer.from("signed-installer-placeholder");
  const upload = await fetch(`${base}/api/releases/upload`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken, "X-File-Name": encodeURIComponent("UME-release-50.0.0+default.exe") },
    body: releaseBytes,
  });
  assert.equal(upload.status, 201);
  const uploaded = (await upload.json()).release;
  assert.equal(uploaded.version, "50.0.0");

  const releaseDownload = await fetch(`${base}/api/agent/releases/${uploaded.id}/download`, {
    headers: { Authorization: `Bearer ${registered.deviceToken}` },
  });
  assert.equal(releaseDownload.status, 200);
  assert.deepEqual(Buffer.from(await releaseDownload.arrayBuffer()), releaseBytes);

  const distribute = await fetch(`${base}/api/releases/${uploaded.id}/distribute`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken }, body: "{}",
  });
  assert.equal(distribute.status, 202);
  assert.equal((await distribute.json()).queued, 1);
  const packageCommands = await fetch(`${base}/api/agent/commands`, { headers: { Authorization: `Bearer ${registered.deviceToken}` } });
  assert.equal((await packageCommands.json()).commands[0].type, "ume.package.download");

  const agentPackage = Buffer.from("regional-agent-installer");
  const agentUpload = await fetch(`${base}/api/releases/upload`, {
    method: "POST",
    headers: {
      Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken,
      "X-File-Name": encodeURIComponent("funnet-agent-setup-51.0.0.exe"),
      "X-Region-Id": regionsBody.regions[0].id,
    },
    body: agentPackage,
  });
  assert.equal(agentUpload.status, 201);
  const defaultAgentRelease = (await agentUpload.json()).release;
  assert.equal(defaultAgentRelease.regionId, regionsBody.regions[0].id);

  const secondRegionAgentUpload = await fetch(`${base}/api/releases/upload`, {
    method: "POST",
    headers: {
      Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken,
      "X-File-Name": encodeURIComponent("funnet-agent-setup-51.0.0.exe"),
      "X-Region-Id": createdRegion.id,
    },
    body: agentPackage,
  });
  assert.equal(secondRegionAgentUpload.status, 201);

  const adminAgentDownload = await fetch(`${base}/api/releases/${defaultAgentRelease.id}/download`, { headers: { Cookie: cookie } });
  assert.equal(adminAgentDownload.status, 200);
  assert.deepEqual(Buffer.from(await adminAgentDownload.arrayBuffer()), agentPackage);

  const wrongRegionDownload = await fetch(`${base}/api/agent/releases/${defaultAgentRelease.id}/download`, {
    headers: { Authorization: `Bearer ${acceptedRegionDevice.deviceToken}` },
  });
  assert.equal(wrongRegionDownload.status, 403);

  const regionalDistribute = await fetch(`${base}/api/releases/${defaultAgentRelease.id}/distribute`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken }, body: "{}",
  });
  assert.equal(regionalDistribute.status, 202);
  assert.equal((await regionalDistribute.json()).queued, 1);

  const deliveredAgentPackage = await fetch(`${base}/api/agent/commands`, { headers: { Authorization: `Bearer ${registered.deviceToken}` } });
  const deliveredAgentCommand = (await deliveredAgentPackage.json()).commands[0];
  assert.equal(deliveredAgentCommand.type, "agent.package.download");
  const completedAgentPackage = await fetch(`${base}/api/agent/commands/${deliveredAgentCommand.id}/result`, {
    method: "POST", headers: { Authorization: `Bearer ${registered.deviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ success: true }),
  });
  assert.equal(completedAgentPackage.status, 200);

  const commandHistory = await fetch(`${base}/api/commands?limit=5`, { headers: { Cookie: cookie } });
  assert.equal(commandHistory.status, 200);
  const commandHistoryBody = await commandHistory.json();
  assert.equal(commandHistoryBody.commands[0].type, "agent.package.download");
  assert.equal(commandHistoryBody.commands[0].deviceName, "관악-001");

  const scheduleCreate = await fetch(`${base}/api/schedules`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ name: "평일 오전 회의", localTime: "09:00", days: [1, 2, 3, 4, 5], enabled: true }),
  });
  assert.equal(scheduleCreate.status, 201);
  const schedule = (await scheduleCreate.json()).schedule;
  const scheduleRun = await fetch(`${base}/api/schedules/${schedule.id}/run`, {
    method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
  });
  assert.equal(scheduleRun.status, 202);
  assert.equal((await scheduleRun.json()).queued, 1);
  const activateCommands = await fetch(`${base}/api/agent/commands`, { headers: { Authorization: `Bearer ${registered.deviceToken}` } });
  assert.equal((await activateCommands.json()).commands[0].type, "ume.activate");

  const deviceRun = await fetch(`${base}/api/devices/${registered.deviceId}/run-ume`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: "{}",
  });
  assert.equal(deviceRun.status, 202);
  assert.equal((await deviceRun.json()).queued, 1);
  const deviceRunCommands = await fetch(`${base}/api/agent/commands`, { headers: { Authorization: `Bearer ${registered.deviceToken}` } });
  const deviceRunBody = await deviceRunCommands.json();
  assert.equal(deviceRunBody.commands[0].type, "ume.activate");
  assert.equal(deviceRunBody.commands[0].payload.deviceOnly, true);

  const scheduleDisable = await fetch(`${base}/api/schedules/${schedule.id}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ ...schedule, enabled: false }),
  });
  assert.equal(scheduleDisable.status, 200);
  assert.equal((await scheduleDisable.json()).schedule.enabled, false);

  const scheduleDelete = await fetch(`${base}/api/schedules/${schedule.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
  });
  assert.equal(scheduleDelete.status, 200);
  const schedulesAfterDelete = await fetch(`${base}/api/schedules`, { headers: { Cookie: cookie } });
  assert.equal((await schedulesAfterDelete.json()).schedules.some((item) => item.id === schedule.id), false);

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /통합관리/);
  assert.match(page.headers.get("content-security-policy"), /frame-src/);
  assert.equal((await (await fetch(`${base}/healthz`)).json()).ok, true);

  const remove = await fetch(`${base}/api/devices/${registered.deviceId}`, {
    method: "DELETE",
    headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
  });
  assert.equal(remove.status, 200);
  const heartbeatAfterDelete = await fetch(`${base}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registered.deviceToken}` },
    body: JSON.stringify({ localName: "삭제된 장비" }),
  });
  assert.equal(heartbeatAfterDelete.status, 401);
});

test("Android TV controller capabilities keep Windows-only commands off the device", async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-admin-password" }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const regions = await (await fetch(`${base}/api/regions`, { headers: { Cookie: cookie } })).json();
  const region = regions.regions.find((item) => item.isDefault) || regions.regions[0];

  const registration = await fetch(`${base}/api/agent/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Enrollment-Key": region.enrollmentKey },
    body: JSON.stringify({ installationId: crypto.randomUUID(), localName: "Android TV PoC", machineName: "TV-STICK", agentVersion: "android-0.5.0-poc" }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json();

  const heartbeat = await fetch(`${base}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registered.deviceToken}` },
    body: JSON.stringify({
      localName: "Android TV PoC",
      machineName: "TV-STICK",
      agentVersion: "android-0.5.0-poc",
      osVersion: "Android 14 (API 34)",
      platform: "android",
      display: { enabled: true, vendor: "samsung", model: "LH75QBC", port: "FTDI", inputSources: ["HDMI1", "HDMI2", "HDMI3"] },
      capabilities: { displayControl: true, ume: false, ivision: false, windowsShutdown: false, agentUpdate: false, supportedInputs: ["HDMI1", "HDMI2", "HDMI3"] },
    }),
  });
  assert.equal(heartbeat.status, 200);

  const approve = await fetch(`${base}/api/devices/${registered.deviceId}/approve`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
  });
  assert.equal(approve.status, 200);

  const listed = await (await fetch(`${base}/api/devices`, { headers: { Cookie: cookie } })).json();
  const android = listed.devices.find((item) => item.id === registered.deviceId);
  assert.equal(android.platform, "android");
  assert.equal(android.capabilities.windowsShutdown, false);
  assert.deepEqual(android.capabilities.supportedInputs, ["HDMI1", "HDMI2", "HDMI3"]);

  for (const path of ["windows/shutdown", "run-ume", "ivision/stop"]) {
    const response = await fetch(`${base}/api/devices/${registered.deviceId}/${path}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
      body: "{}",
    });
    assert.equal(response.status, 409, `${path} must be blocked for Android`);
  }

  const display = await fetch(`${base}/api/devices/${registered.deviceId}/display/power`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(display.status, 202);

  const hdmi3 = await fetch(`${base}/api/devices/${registered.deviceId}/display/input`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ input: "HDMI3" }),
  });
  assert.equal(hdmi3.status, 202);

  const qetHeartbeat = await fetch(`${base}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registered.deviceToken}` },
    body: JSON.stringify({
      localName: "Android TV PoC",
      machineName: "TV-STICK",
      agentVersion: "android-0.5.0-poc",
      platform: "android",
      display: { enabled: true, vendor: "samsung", model: "LH75QET", port: "FTDI", inputSources: ["HDMI1", "HDMI2"] },
      capabilities: { displayControl: true, supportedInputs: ["HDMI1", "HDMI2"] },
    }),
  });
  assert.equal(qetHeartbeat.status, 200);
  const unsupportedHdmi3 = await fetch(`${base}/api/devices/${registered.deviceId}/display/input`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken },
    body: JSON.stringify({ input: "HDMI3" }),
  });
  assert.equal(unsupportedHdmi3.status, 409);
});
