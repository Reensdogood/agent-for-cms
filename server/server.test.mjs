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

  const rejectedRegistration = await fetch(`${base}/api/agent/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Enrollment-Key": "wrong-enrollment-key" },
    body: JSON.stringify({ installationId: crypto.randomUUID(), localName: "거절 장비", machineName: "OLD-KEY", agentVersion: "0.4.0" }),
  });
  assert.equal(rejectedRegistration.status, 401);

  const acceptedRegistration = await fetch(`${base}/api/agent/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Enrollment-Key": createdRegion.enrollmentKey },
    body: JSON.stringify({ installationId: crypto.randomUUID(), localName: "동작 신규 장비", machineName: "NEW-KEY", agentVersion: "0.4.0" }),
  });
  assert.equal(acceptedRegistration.status, 201);

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
    body: JSON.stringify({ localName: "테스트 장비", machineName: "TEST-PC", agentVersion: "0.4.0" }),
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

  const commandHistory = await fetch(`${base}/api/commands?limit=5`, { headers: { Cookie: cookie } });
  assert.equal(commandHistory.status, 200);
  const commandHistoryBody = await commandHistory.json();
  assert.equal(commandHistoryBody.commands[0].type, "ume.package.download");
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
