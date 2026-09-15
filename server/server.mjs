import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(currentDir, "public");
const packagePath = path.join(currentDir, "..", "package.json");
const appVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "0.0.0";
const dataDir = process.env.FUNNET_DATA_DIR || path.join(currentDir, "data");
const releaseDir = path.join(dataDir, "releases");
const databasePath = path.join(dataDir, "funnet.db");
const port = Number(process.env.PORT || 4170);
const adminUser = process.env.FUNNET_ADMIN_USER || "admin";
const adminPassword = process.env.FUNNET_ADMIN_PASSWORD;
const enrollmentKey = process.env.FUNNET_ENROLLMENT_KEY;
// 운영 여부와 무관하게 명시 설정을 우선한다. 내부망 HTTP(4171) 테스트에서는
// FUNNET_COOKIE_SECURE=false로 세션 쿠키를 저장할 수 있어야 한다.
const secureCookies = process.env.FUNNET_COOKIE_SECURE === "true";
const maxUploadBytes = Number(process.env.FUNNET_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);

if (!adminPassword || adminPassword.length < 10) {
  throw new Error("FUNNET_ADMIN_PASSWORD must contain at least 10 characters.");
}
if (!enrollmentKey || enrollmentKey.length < 16) {
  throw new Error("FUNNET_ENROLLMENT_KEY must contain at least 16 characters.");
}

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    region_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL,
    region_id TEXT,
    display_name TEXT NOT NULL,
    local_name TEXT NOT NULL,
    machine_name TEXT,
    approved INTEGER NOT NULL DEFAULT 0,
    agent_version TEXT,
    ume_name TEXT,
    ume_version TEXT,
    ume_path TEXT,
    ume_running INTEGER NOT NULL DEFAULT 0,
    ivision_running INTEGER NOT NULL DEFAULT 0,
    foreground_app TEXT,
    last_seen_at TEXT,
    last_health_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    completed_at TEXT,
    result_json TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    local_time TEXT NOT NULL,
    days_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedule_runs (
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    run_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (schedule_id, run_key)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS regions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    enrollment_key TEXT NOT NULL UNIQUE,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

ensureColumn("commands", "attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("devices", "region_id", "TEXT");
ensureColumn("users", "region_id", "TEXT");
ensureColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("schedules", "region_ids_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("users", "updated_at", "TEXT");
db.prepare("UPDATE users SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''").run();
seedDefaultRegion();

seedAdmin();

const sessions = new Map();
const loginAttempts = new Map();

function now() {
  return new Date().toISOString();
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, expectedHex] = String(encoded).split(":");
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicServerUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (secureCookies ? "https" : "http");
  return `${proto}://${req.headers.host || `127.0.0.1:${port}`}`.replace(/\/$/, "");
}

function seedDefaultRegion() {
  const timestamp = now();
  let defaultRegion = db.prepare("SELECT * FROM regions WHERE is_default = 1 ORDER BY created_at LIMIT 1").get();
  if (!defaultRegion) {
    const existingSetting = db.prepare("SELECT value FROM app_settings WHERE key = 'enrollment_key'").get()?.value;
    const key = existingSetting || enrollmentKey;
    db.prepare("INSERT INTO regions (id, name, enrollment_key, is_default, created_at, updated_at) VALUES (?, '관악', ?, 1, ?, ?)")
      .run(crypto.randomUUID(), key, timestamp, timestamp);
    defaultRegion = db.prepare("SELECT * FROM regions WHERE is_default = 1 ORDER BY created_at LIMIT 1").get();
  }
  db.prepare("UPDATE devices SET region_id = ? WHERE region_id IS NULL OR region_id = ''").run(defaultRegion.id);
}

function findRegionByEnrollmentKey(key) {
  return db.prepare("SELECT * FROM regions WHERE enrollment_key = ?").get(key);
}

function defaultRegion() {
  return db.prepare("SELECT * FROM regions WHERE is_default = 1 ORDER BY created_at LIMIT 1").get()
    || db.prepare("SELECT * FROM regions ORDER BY created_at LIMIT 1").get();
}

function regionDto(row) {
  return {
    id: row.id,
    name: row.name,
    enrollmentKey: row.enrollment_key,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const roles = {
  admin: { label: "전체 시스템", rank: 3 },
  operator: { label: "운영", rank: 2 },
  region_manager: { label: "지역 관리자", rank: 1 },
  system_manager: { label: "시스템 담당자", rank: 2 },
};

function normalizeRole(value) {
  return roles[value] ? value : "operator";
}

function canManageAll(session) {
  return session?.role === "admin";
}

function canOperate(session) {
  return ["admin", "operator", "region_manager", "system_manager"].includes(session?.role);
}

function sameRegionOnly(session) {
  return session?.role === "region_manager";
}

function assertRole(session, res, allowedRoles) {
  if (!allowedRoles.includes(session.role)) {
    json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    return false;
  }
  return true;
}

function userDto(row) {
  return {
    id: row.id,
    username: row.username,
    role: normalizeRole(row.role),
    roleLabel: roles[normalizeRole(row.role)].label,
    regionId: row.region_id,
    regionName: row.region_name || null,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function seedAdmin() {
  const existing = db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(adminUser);
  if (!existing) {
    const timestamp = now();
    db.prepare("INSERT INTO users (username, password_hash, role, active, created_at, updated_at) VALUES (?, ?, 'admin', 1, ?, ?)")
      .run(adminUser, hashPassword(adminPassword), timestamp, timestamp);
  }
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src https://cloud.myivision.com https://uc01.fun-net.co.kr:8443; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
    ...(secureCookies ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

async function saveUpload(req, destination) {
  const temporary = `${destination}.${crypto.randomUUID()}.upload`;
  const output = fs.createWriteStream(temporary, { flags: "wx" });
  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxUploadBytes) throw Object.assign(new Error("업로드 파일이 허용 크기를 초과했습니다."), { status: 413 });
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
    fs.renameSync(temporary, destination);
    return { size, sha256: hash.digest("hex").toUpperCase() };
  } catch (error) {
    output.destroy();
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const index = value.indexOf("=");
        return [decodeURIComponent(value.slice(0, index)), decodeURIComponent(value.slice(index + 1))];
      }),
  );
}

function safeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function currentSession(req) {
  const token = parseCookies(req).funnet_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return session;
}

function requireAdmin(req, res, requireCsrf = false) {
  const session = currentSession(req);
  if (!session) {
    json(res, 401, { error: "로그인이 필요합니다." });
    return null;
  }
  if (requireCsrf && req.headers["x-csrf-token"] !== session.csrfToken) {
    json(res, 403, { error: "요청 검증에 실패했습니다." });
    return null;
  }
  return session;
}

function requireDevice(req, res) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    json(res, 401, { error: "장비 인증이 필요합니다." });
    return null;
  }
  const tokenHash = hashToken(auth.slice(7));
  const device = db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(tokenHash);
  if (!device) {
    json(res, 401, { error: "유효하지 않은 장비 토큰입니다." });
    return null;
  }
  return device;
}

function audit(actor, action, target, detail = {}) {
  db.prepare("INSERT INTO audit_logs (actor, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(actor, action, target || null, JSON.stringify(detail), now());
}

function statusFor(lastSeenAt) {
  if (!lastSeenAt) return "offline";
  const age = Date.now() - Date.parse(lastSeenAt);
  if (age <= 90_000) return "online";
  if (age <= 180_000) return "delayed";
  return "offline";
}

function compareReleaseVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function humanizeOsVersion(value) {
  const raw = String(value || "");
  const match = raw.match(/10\.0\.(\d+)/i);
  if (!match) return raw || null;
  const build = Number(match[1]);
  if (build >= 26100) return `Windows 11 (24H2) · 빌드 ${build}`;
  if (build >= 22621) return `Windows 11 · 빌드 ${build}`;
  if (build >= 22000) return `Windows 11 · 빌드 ${build}`;
  if (build >= 19041) return `Windows 10 · 빌드 ${build}`;
  return `Windows · 빌드 ${build}`;
}

function clearPendingDisplayCommands(deviceId) {
  return Number(db.prepare("DELETE FROM commands WHERE device_id = ? AND type LIKE 'display.%' AND status IN ('pending','delivered')").run(deviceId).changes || 0);
}

function deviceDto(row) {
  let displayEnabled = false;
  let osVersion = null;
  try { const health = JSON.parse(row.last_health_json || "{}"); displayEnabled = Boolean(health.display?.enabled); osVersion = health.osVersion || null; } catch {}
  const displayCheck = db.prepare("SELECT status, completed_at, result_json FROM commands WHERE device_id = ? AND type = 'display.status' ORDER BY created_at DESC LIMIT 1").get(row.id);
  let displayConnection = displayEnabled ? "미확인" : "비활성화";
  if (displayCheck?.status === "completed") displayConnection = "정상";
  else if (displayCheck?.status === "failed") displayConnection = "연결 실패";
  return {
    id: row.id,
    osVersion: humanizeOsVersion(osVersion),
    installationId: row.installation_id,
    regionId: row.region_id,
    regionName: row.region_name || "미지정",
    displayName: row.display_name,
    localName: row.local_name,
    machineName: row.machine_name,
    approved: Boolean(row.approved),
    status: statusFor(row.last_seen_at),
    agentVersion: String(row.agent_version || "").split("+")[0] || null,
    ume: {
      name: row.ume_name,
      version: row.ume_version,
      path: row.ume_path,
      running: Boolean(row.ume_running),
    },
    ivisionRunning: Boolean(row.ivision_running),
    foregroundApp: row.foreground_app,
    lastSeenAt: row.last_seen_at,
    displayEnabled,
    displayConnection,
    displayCheckedAt: displayCheck?.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const address = req.socket.remoteAddress || "unknown";
    const attempt = loginAttempts.get(address) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) {
      return json(res, 429, { error: "잠시 후 다시 시도해 주세요." });
    }
    const body = await readJson(req);
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(String(body.username || ""));
    if (!user || !user.active || !verifyPassword(String(body.password || ""), user.password_hash)) {
      attempt.count += 1;
      if (attempt.count >= 5) {
        attempt.count = 0;
        attempt.blockedUntil = Date.now() + 60_000;
      }
      loginAttempts.set(address, attempt);
      audit(String(body.username || "unknown"), "login.failed", null, { address });
      return json(res, 401, { error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }
    loginAttempts.delete(address);
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    sessions.set(token, {
      username: user.username,
      role: normalizeRole(user.role),
      regionId: user.region_id,
      csrfToken,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    });
    audit(user.username, "login.success");
    return json(res, 200, { username: user.username, role: normalizeRole(user.role), regionId: user.region_id, csrfToken }, {
      "Set-Cookie": `funnet_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? "; Secure" : ""}`,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    const token = parseCookies(req).funnet_session;
    sessions.delete(token);
    audit(session.username, "logout");
    return json(res, 200, { ok: true }, {
      "Set-Cookie": `funnet_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? "; Secure" : ""}`,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const session = requireAdmin(req, res);
    if (!session) return;
    return json(res, 200, { username: session.username, role: session.role, roleLabel: roles[session.role]?.label || session.role, regionId: session.regionId, csrfToken: session.csrfToken });
  }

  if (req.method === "POST" && url.pathname === "/api/agent/register") {
    const region = findRegionByEnrollmentKey(String(req.headers["x-enrollment-key"] || ""));
    if (!region) {
      return json(res, 401, { error: "등록 키가 올바르지 않습니다." });
    }
    const body = await readJson(req);
    const installationId = String(body.installationId || "").trim();
    const localName = String(body.localName || body.machineName || "미지정 장비").trim().slice(0, 100);
    if (!/^[a-f0-9-]{36}$/i.test(installationId)) {
      return json(res, 400, { error: "installationId 형식이 올바르지 않습니다." });
    }
    const existing = db.prepare("SELECT * FROM devices WHERE installation_id = ?").get(installationId);
    if (existing) {
      return json(res, 409, { error: "이미 등록된 장비입니다. 저장된 장비 토큰을 사용해야 합니다." });
    }
    const deviceId = crypto.randomUUID();
    const deviceToken = crypto.randomBytes(32).toString("base64url");
    const timestamp = now();
    db.prepare(`
      INSERT INTO devices (
        id, installation_id, token_hash, region_id, display_name, local_name, machine_name,
        agent_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deviceId,
      installationId,
      hashToken(deviceToken),
      region.id,
      localName,
      localName,
      String(body.machineName || "").slice(0, 100),
      String(body.agentVersion || "").slice(0, 40),
      timestamp,
      timestamp,
    );
    audit(`agent:${deviceId}`, "device.register", deviceId, { localName, region: region.name });
    return json(res, 201, { deviceId, deviceToken, approved: false });
  }

  if (req.method === "POST" && url.pathname === "/api/agent/heartbeat") {
    const device = requireDevice(req, res);
    if (!device) return;
    const body = await readJson(req);
    const timestamp = now();
    const ume = body.ume || {};
    db.prepare(`
      UPDATE devices SET
        local_name = ?, machine_name = ?, agent_version = ?, ume_name = ?, ume_version = ?,
        ume_path = ?, ume_running = ?, ivision_running = ?, foreground_app = ?,
        last_seen_at = ?, last_health_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      String(body.localName || device.local_name).slice(0, 100),
      String(body.machineName || device.machine_name || "").slice(0, 100),
      String(body.agentVersion || "").slice(0, 40),
      String(ume.name || "").slice(0, 80),
      String(ume.version || "").slice(0, 40),
      String(ume.path || "").slice(0, 500),
      ume.running ? 1 : 0,
      body.ivisionRunning ? 1 : 0,
      String(body.foregroundApp || "").slice(0, 120),
      timestamp,
      JSON.stringify(body),
      timestamp,
      device.id,
    );
    return json(res, 200, { ok: true, serverTime: timestamp, approved: Boolean(device.approved) });
  }

  if (req.method === "GET" && url.pathname === "/api/agent/commands") {
    const device = requireDevice(req, res);
    if (!device) return;
    const retryBefore = new Date(Date.now() - 60_000).toISOString();
    const commands = db.prepare("SELECT id, type, payload_json, created_at FROM commands WHERE device_id = ? AND (status = 'pending' OR (status = 'delivered' AND delivered_at < ? AND attempts < 5)) ORDER BY created_at LIMIT 10").all(device.id, retryBefore);
    const timestamp = now();
    const markDelivered = db.prepare("UPDATE commands SET status = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE id = ?");
    for (const command of commands) markDelivered.run(timestamp, command.id);
    return json(res, 200, {
      commands: commands.map((command) => ({
        id: command.id,
        type: command.type,
        payload: JSON.parse(command.payload_json),
        createdAt: command.created_at,
      })),
    });
  }

  const commandResultMatch = url.pathname.match(/^\/api\/agent\/commands\/([a-f0-9-]+)\/result$/i);
  if (req.method === "POST" && commandResultMatch) {
    const device = requireDevice(req, res);
    if (!device) return;
    const command = db.prepare("SELECT * FROM commands WHERE id = ? AND device_id = ?").get(commandResultMatch[1], device.id);
    if (!command) return json(res, 404, { error: "명령을 찾을 수 없습니다." });
    const body = await readJson(req);
    db.prepare("UPDATE commands SET status = ?, completed_at = ?, result_json = ? WHERE id = ?")
      .run(body.success ? "completed" : "failed", now(), JSON.stringify(body), command.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/devices") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const where = sameRegionOnly(session) ? "WHERE devices.region_id = ?" : "";
    const rows = db.prepare(`
      SELECT devices.*, regions.name AS region_name
      FROM devices
      LEFT JOIN regions ON regions.id = devices.region_id
      ${where}
      ORDER BY regions.name COLLATE NOCASE, devices.display_name COLLATE NOCASE
    `).all(...(where ? [session.regionId] : []));
    return json(res, 200, { devices: rows.map(deviceDto), serverTime: now() });
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    const session = requireAdmin(req, res);
    if (!session) return;
    if (!assertRole(session, res, ["admin"])) return;
    const rows = db.prepare(`
      SELECT users.id, users.username, users.role, users.region_id, users.active, users.created_at, users.updated_at,
        regions.name AS region_name
      FROM users
      LEFT JOIN regions ON regions.id = users.region_id
      ORDER BY users.active DESC, users.username COLLATE NOCASE
    `).all();
    return json(res, 200, { users: rows.map(userDto), roles: Object.entries(roles).map(([id, role]) => ({ id, label: role.label })) });
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin"])) return;
    const body = await readJson(req);
    const username = String(body.username || "").trim().slice(0, 60);
    const password = String(body.password || "");
    const passwordConfirm = String(body.passwordConfirm || "");
    const role = normalizeRole(body.role);
    const regionId = role === "region_manager" ? String(body.regionId || "").trim() : null;
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) return json(res, 400, { error: "아이디는 영문, 숫자, ., _, @, - 조합 3자 이상이어야 합니다." });
    if (password.length < 10) return json(res, 400, { error: "비밀번호는 10자 이상이어야 합니다." });
    if (passwordConfirm && password !== passwordConfirm) return json(res, 400, { error: "비밀번호 확인이 일치하지 않습니다." });
    if (regionId && !db.prepare("SELECT id FROM regions WHERE id = ?").get(regionId)) return json(res, 400, { error: "담당 지역을 선택해 주세요." });
    if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) return json(res, 409, { error: "이미 사용 중인 아이디입니다." });
    const timestamp = now();
    db.prepare("INSERT INTO users (username, password_hash, role, region_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
      .run(username, hashPassword(password), role, regionId, timestamp, timestamp);
    audit(session.username, "user.create", username, { role, regionId });
    return json(res, 201, { user: userDto(db.prepare("SELECT users.*, regions.name AS region_name FROM users LEFT JOIN regions ON regions.id = users.region_id WHERE users.username = ?").get(username)) });
  }

  const userMatch = url.pathname.match(/^\/api\/users\/(\d+)$/);
  if ((req.method === "PUT" || req.method === "DELETE") && userMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin"])) return;
    const current = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(userMatch[1]));
    if (!current) return json(res, 404, { error: "사용자를 찾을 수 없습니다." });
    if (req.method === "DELETE") {
      if (current.username === session.username) return json(res, 400, { error: "현재 로그인한 계정은 삭제할 수 없습니다." });
      db.prepare("DELETE FROM users WHERE id = ?").run(current.id);
      audit(session.username, "user.delete", String(current.id), { username: current.username });
      return json(res, 200, { ok: true });
    }
    const body = await readJson(req);
    const username = String(body.username ?? current.username).trim().slice(0, 60);
    const role = normalizeRole(body.role ?? current.role);
    const regionId = role === "region_manager" ? String(body.regionId || "").trim() : null;
    const active = body.active === undefined ? current.active : body.active ? 1 : 0;
    const password = String(body.password || "");
    const passwordConfirm = String(body.passwordConfirm || "");
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) return json(res, 400, { error: "아이디는 영문, 숫자, ., _, @, - 조합 3자 이상이어야 합니다." });
    if (regionId && !db.prepare("SELECT id FROM regions WHERE id = ?").get(regionId)) return json(res, 400, { error: "담당 지역을 선택해 주세요." });
    const duplicate = db.prepare("SELECT id FROM users WHERE username = ? AND id <> ?").get(username, current.id);
    if (duplicate) return json(res, 409, { error: "이미 사용 중인 아이디입니다." });
    if (!active && current.username === session.username) return json(res, 400, { error: "현재 로그인한 계정은 비활성화할 수 없습니다." });
    if (password) {
      if (passwordConfirm && password !== passwordConfirm) return json(res, 400, { error: "비밀번호 확인이 일치하지 않습니다." });
      if (password.length < 10) return json(res, 400, { error: "비밀번호는 10자 이상이어야 합니다." });
      db.prepare("UPDATE users SET username = ?, password_hash = ?, role = ?, region_id = ?, active = ?, updated_at = ? WHERE id = ?")
        .run(username, hashPassword(password), role, regionId, active, now(), current.id);
    } else {
      db.prepare("UPDATE users SET username = ?, role = ?, region_id = ?, active = ?, updated_at = ? WHERE id = ?")
        .run(username, role, regionId, active, now(), current.id);
    }
    audit(session.username, "user.update", String(current.id), { username, role, regionId, active: Boolean(active), passwordChanged: Boolean(password) });
    return json(res, 200, { user: userDto(db.prepare("SELECT users.*, regions.name AS region_name FROM users LEFT JOIN regions ON regions.id = users.region_id WHERE users.id = ?").get(current.id)) });
  }

  if (req.method === "GET" && url.pathname === "/api/regions") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const rows = sameRegionOnly(session)
      ? db.prepare("SELECT * FROM regions WHERE id = ? ORDER BY is_default DESC, name COLLATE NOCASE").all(session.regionId)
      : db.prepare("SELECT * FROM regions ORDER BY is_default DESC, name COLLATE NOCASE").all();
    return json(res, 200, { regions: rows.map(regionDto), serverBaseUrl: publicServerUrl(req) });
  }

  if (req.method === "GET" && url.pathname === "/api/enrollment-key") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const region = defaultRegion();
    return json(res, 200, { enrollmentKey: region.enrollment_key, serverBaseUrl: publicServerUrl(req), region: regionDto(region) });
  }

  if (req.method === "POST" && url.pathname === "/api/regions") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin"])) return;
    const body = await readJson(req);
    const name = String(body.name || "").trim().slice(0, 50);
    if (!name) return json(res, 400, { error: "지역명을 입력해 주세요." });
    const timestamp = now();
    const id = crypto.randomUUID();
    const key = crypto.randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO regions (id, name, enrollment_key, is_default, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
      .run(id, name, key, timestamp, timestamp);
    audit(session.username, "region.create", id, { name });
    return json(res, 201, { region: regionDto(db.prepare("SELECT * FROM regions WHERE id = ?").get(id)), serverBaseUrl: publicServerUrl(req) });
  }

  const regionRotateMatch = url.pathname.match(/^\/api\/regions\/([a-f0-9-]+)\/rotate-key$/i);
  if (req.method === "POST" && regionRotateMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin"])) return;
    const region = db.prepare("SELECT * FROM regions WHERE id = ?").get(regionRotateMatch[1]);
    if (!region) return json(res, 404, { error: "지역을 찾을 수 없습니다." });
    const nextKey = crypto.randomBytes(24).toString("base64url");
    db.prepare("UPDATE regions SET enrollment_key = ?, updated_at = ? WHERE id = ?").run(nextKey, now(), region.id);
    audit(session.username, "region.rotate_key", region.id, { name: region.name });
    return json(res, 200, { region: regionDto(db.prepare("SELECT * FROM regions WHERE id = ?").get(region.id)), serverBaseUrl: publicServerUrl(req) });
  }

  if (req.method === "GET" && url.pathname === "/api/releases") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const releases = db.prepare("SELECT id, version, file_name, size_bytes, sha256, created_by, created_at FROM releases ORDER BY created_at DESC").all();
    return json(res, 200, { releases: releases.map((item) => ({
      id: item.id, version: item.version, fileName: item.file_name, sizeBytes: item.size_bytes,
      sha256: item.sha256, createdBy: item.created_by, createdAt: item.created_at,
    })) });
  }

  if (req.method === "GET" && url.pathname === "/api/commands") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
    const rows = db.prepare(`
      SELECT commands.id, commands.device_id, commands.type, commands.status, commands.attempts,
        commands.payload_json, commands.result_json, commands.created_at, commands.delivered_at, commands.completed_at,
        devices.display_name
      FROM commands
      LEFT JOIN devices ON devices.id = commands.device_id
      ORDER BY commands.created_at DESC
      LIMIT ?
    `).all(limit);
    return json(res, 200, { commands: rows.map((item) => ({
      id: item.id,
      deviceId: item.device_id,
      deviceName: item.display_name || item.device_id,
      type: item.type,
      status: item.status,
      attempts: item.attempts,
      payload: safeJson(item.payload_json),
      result: safeJson(item.result_json),
      createdAt: item.created_at,
      deliveredAt: item.delivered_at,
      completedAt: item.completed_at,
    })) });
  }

  if (req.method === "POST" && url.pathname === "/api/releases/upload") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const fileName = path.basename(decodeURIComponent(String(req.headers["x-file-name"] || "")));
    const match = /^(UME-release|Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-([0-9]+(?:\.[0-9]+){1,3})(?:\+[^\\/]+)?\.exe$/i.exec(fileName);
    if (!match) return json(res, 400, { error: "파일명은 UME-release-{버전}.exe 또는 funnet-agent-setup-{버전}.exe 형식이어야 합니다." });
    if (db.prepare("SELECT id FROM releases WHERE version = ?").get(match[2])) {
      return json(res, 409, { error: "이미 등록된 UME 버전입니다." });
    }
    const id = crypto.randomUUID();
    const storedName = `${id}.exe`;
    const destination = path.join(releaseDir, storedName);
    const saved = await saveUpload(req, destination);
    const timestamp = now();
    db.prepare("INSERT INTO releases (id, version, file_name, file_path, size_bytes, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, match[2], fileName, destination, saved.size, saved.sha256, session.username, timestamp);
    const isAgentRelease = /^(Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-/i.test(fileName);
    let removedOlderAgentReleases = 0;
    if (isAgentRelease) {
      const older = db.prepare("SELECT id, file_path, version FROM releases WHERE id <> ?").all(id)
        .filter((item) => compareReleaseVersions(item.version, match[2]) < 0)
        .filter((item) => /agent/i.test(String(db.prepare("SELECT file_name FROM releases WHERE id = ?").get(item.id)?.file_name || "")));
      for (const item of older) {
        db.prepare("DELETE FROM commands WHERE type = 'agent.package.download' AND status IN ('pending','delivered') AND payload_json LIKE ?").run(`%${item.id}%`);
        db.prepare("DELETE FROM releases WHERE id = ?").run(item.id);
        try { if (fs.existsSync(item.file_path)) fs.unlinkSync(item.file_path); } catch (error) { console.error(error); }
        removedOlderAgentReleases += 1;
      }
    }
    audit(session.username, "release.upload", id, { version: match[2], fileName, ...saved, removedOlderAgentReleases });
    return json(res, 201, { release: { id, version: match[2], fileName, sizeBytes: saved.size, sha256: saved.sha256, createdAt: timestamp }, removedOlderAgentReleases });
  }

  const releaseDownloadMatch = url.pathname.match(/^\/api\/agent\/releases\/([a-f0-9-]+)\/download$/i);
  if (req.method === "GET" && releaseDownloadMatch) {
    const device = requireDevice(req, res);
    if (!device) return;
    const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseDownloadMatch[1]);
    if (!release || !fs.existsSync(release.file_path)) return json(res, 404, { error: "배포 파일을 찾을 수 없습니다." });
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": release.size_bytes,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(release.file_name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    return fs.createReadStream(release.file_path).pipe(res);
  }

  const releaseDistributeMatch = url.pathname.match(/^\/api\/releases\/([a-f0-9-]+)\/distribute$/i);
  if (req.method === "POST" && releaseDistributeMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseDistributeMatch[1]);
    if (!release) return json(res, 404, { error: "배포 파일을 찾을 수 없습니다." });
    const body = await readJson(req);
    const requestedIds = Array.isArray(body.deviceIds) ? body.deviceIds.map(String) : [];
    const scope = sameRegionOnly(session) ? " AND region_id = ?" : "";
    const devices = requestedIds.length
      ? db.prepare(`SELECT id FROM devices WHERE approved = 1${scope} AND id IN (${requestedIds.map(() => "?").join(",")})`).all(...(sameRegionOnly(session) ? [session.regionId] : []), ...requestedIds)
      : db.prepare(`SELECT id FROM devices WHERE approved = 1${scope}`).all(...(sameRegionOnly(session) ? [session.regionId] : []));
    const commandType = /^(Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-/i.test(release.file_name) ? "agent.package.download" : "ume.package.download";
    const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)");
    const createdAt = now();
    for (const device of devices) insert.run(crypto.randomUUID(), device.id, commandType, JSON.stringify({
      releaseId: release.id, version: release.version, fileName: release.file_name,
      sizeBytes: release.size_bytes, sha256: release.sha256,
      downloadPath: `/api/agent/releases/${release.id}/download`,
    }), createdAt);
    audit(session.username, "release.distribute", release.id, { version: release.version, deviceCount: devices.length });
    return json(res, 202, { queued: devices.length });
  }

  if (req.method === "GET" && url.pathname === "/api/schedules") {
    const session = requireAdmin(req, res);
    if (!session) return;
    return json(res, 200, { schedules: listSchedules() });
  }

  if (req.method === "POST" && url.pathname === "/api/schedules") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const body = await readJson(req);
    const schedule = validateSchedule(body);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.prepare("INSERT INTO schedules (id, name, local_time, days_json, region_ids_json, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, schedule.name, schedule.localTime, JSON.stringify(schedule.days), JSON.stringify(schedule.regionIds), schedule.enabled ? 1 : 0, session.username, timestamp, timestamp);
    audit(session.username, "schedule.create", id, schedule);
    return json(res, 201, { schedule: listSchedules().find((item) => item.id === id) });
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([a-f0-9-]+)$/i);
  if (req.method === "PUT" && scheduleMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const current = db.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleMatch[1]);
    if (!current) return json(res, 404, { error: "스케줄을 찾을 수 없습니다." });
    const schedule = validateSchedule(await readJson(req));
    db.prepare("UPDATE schedules SET name = ?, local_time = ?, days_json = ?, region_ids_json = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(schedule.name, schedule.localTime, JSON.stringify(schedule.days), JSON.stringify(schedule.regionIds), schedule.enabled ? 1 : 0, now(), current.id);
    audit(session.username, "schedule.update", current.id, schedule);
    return json(res, 200, { schedule: listSchedules().find((item) => item.id === current.id) });
  }

  if (req.method === "DELETE" && scheduleMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const current = db.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleMatch[1]);
    if (!current) return json(res, 404, { error: "스케줄을 찾을 수 없습니다." });
    db.prepare("DELETE FROM schedules WHERE id = ?").run(current.id);
    audit(session.username, "schedule.delete", current.id, { name: current.name });
    return json(res, 200, { ok: true });
  }

  const scheduleRunMatch = url.pathname.match(/^\/api\/schedules\/([a-f0-9-]+)\/run$/i);
  if (req.method === "POST" && scheduleRunMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const schedule = db.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleRunMatch[1]);
    if (!schedule) return json(res, 404, { error: "스케줄을 찾을 수 없습니다." });
    const queued = enqueueUmeActivate(schedule.id, `manual:${crypto.randomUUID()}`, sameRegionOnly(session) ? [session.regionId] : JSON.parse(schedule.region_ids_json || "[]"));
    audit(session.username, "schedule.run", schedule.id, { queued });
    return json(res, 202, { queued });
  }

  const releaseDeleteMatch = url.pathname.match(/^\/api\/releases\/([a-f0-9-]+)$/i);
  if (req.method === "DELETE" && releaseDeleteMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseDeleteMatch[1]);
    if (!release) return json(res, 404, { error: "업데이트 파일을 찾을 수 없습니다." });
    const isAgentRelease = /^(Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-/i.test(release.file_name);
    const pending = db.prepare("SELECT COUNT(*) AS count FROM commands WHERE type IN ('agent.package.download','ume.package.download') AND status = 'pending' AND payload_json LIKE ?").get(`%${release.id}%`);
    if (Number(pending?.count || 0) > 0 && !isAgentRelease) return json(res, 409, { error: "UME 배포 대기 중인 업데이트는 삭제할 수 없습니다." });
    let removedCommands = 0;
    if (isAgentRelease) {
      const result = db.prepare("DELETE FROM commands WHERE type = 'agent.package.download' AND status IN ('pending','delivered') AND payload_json LIKE ?").run(`%${release.id}%`);
      removedCommands = Number(result.changes || 0);
    }
    db.prepare("DELETE FROM releases WHERE id = ?").run(release.id);
    try { if (fs.existsSync(release.file_path)) fs.unlinkSync(release.file_path); } catch (error) { console.error(error); }
    audit(session.username, "release.delete", release.id, { version: release.version, fileName: release.file_name, removedCommands });
    return json(res, 200, { deleted: true, removedCommands });
  }

  const displayCommandMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/display\/(power|input|volume|status)$/i);
  const windowsCommandMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/windows\/(shutdown)$/i);
  if (req.method === "POST" && windowsCommandMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const device = db.prepare("SELECT id, region_id, approved FROM devices WHERE id = ?").get(windowsCommandMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 제어할 수 있습니다." });
    if (!device.approved) return json(res, 400, { error: "승인된 장비만 제어할 수 있습니다." });
    const commandId = crypto.randomUUID();
    db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'windows.shutdown', '{}', ?)").run(commandId, device.id, now());
    audit(session.username, "windows.shutdown", device.id, { commandId });
    return json(res, 202, { commandId, status: "pending" });
  }
  if (req.method === "POST" && displayCommandMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const device = db.prepare("SELECT id, region_id, approved FROM devices WHERE id = ?").get(displayCommandMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 제어할 수 있습니다." });
    if (!device.approved) return json(res, 400, { error: "승인된 장비만 제어할 수 있습니다." });
    const healthRow = db.prepare("SELECT last_health_json FROM devices WHERE id = ?").get(device.id);
    try { if (!JSON.parse(healthRow?.last_health_json || "{}").display?.enabled) return json(res, 409, { error: "이 장비는 TV 제어가 비활성화되어 있습니다." }); } catch { return json(res, 409, { error: "장비의 TV 제어 설정을 확인할 수 없습니다." }); }
    const kind = displayCommandMatch[2].toLowerCase();
    if (kind === "status") {
      clearPendingDisplayCommands(device.id);
      const commandId = crypto.randomUUID();
      db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'display.status', '{}', ?)").run(commandId, device.id, now());
      audit(session.username, "display.status", device.id, { commandId });
      return json(res, 202, { commandId, status: "pending" });
    }
    const body = await readJson(req);
    let payload;
    if (kind === "power") {
      if (typeof body.on !== "boolean") return json(res, 400, { error: "on은 boolean이어야 합니다." });
      payload = { on: body.on };
    } else if (kind === "input") {
      const input = String(body.input || "").toUpperCase();
      if (!["HDMI1", "HDMI2"].includes(input)) return json(res, 400, { error: "input은 HDMI1 또는 HDMI2여야 합니다." });
      payload = { input };
    } else {
      const value = Number(body.value);
      if (!Number.isInteger(value) || value < 0 || value > 100) return json(res, 400, { error: "volume은 0~100 정수여야 합니다." });
      payload = { value };
    }
    const commandId = crypto.randomUUID();
    clearPendingDisplayCommands(device.id);
    db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(commandId, device.id, `display.${kind}`, JSON.stringify(payload), now());
    audit(session.username, `display.${kind}`, device.id, { commandId, payload });
    return json(res, 202, { commandId, status: "pending" });
  }

  const displayStatusMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/display\/status$/i);
  if (req.method === "GET" && displayStatusMatch) {
    const session = requireAdmin(req, res);
    if (!session) return;
    const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(displayStatusMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 조회할 수 있습니다." });
    let health = {};
    try { health = JSON.parse(device.last_health_json || "{}"); } catch {}
    let display = health.display || null;
    const latest = db.prepare("SELECT type, result_json, completed_at FROM commands WHERE device_id = ? AND type LIKE 'display.%' AND status = 'completed' ORDER BY completed_at DESC").all(device.id);
    let checkedAt = null;
    let statusApplied = false;
    if (!display) display = {};
    for (const item of latest) { try { const result = JSON.parse(item.result_json || "{}"); const value = result.result || {}; if (item.type === "display.status" && result.success && !statusApplied) { display = { ...display, ...value, connection: value.connection || "connected" }; checkedAt = item.completed_at; statusApplied = true; } if (!statusApplied && item.type === "display.power" && display.power === undefined) display.power = value.power; if (!statusApplied && item.type === "display.input" && display.input === undefined) display.input = value.input; if (!statusApplied && item.type === "display.volume" && display.volume === undefined) display.volume = value.volume; } catch {} }
    if (!Object.keys(display).length) display = null;
    return json(res, 200, { display, checkedAt, lastSeenAt: device.last_seen_at, online: Number.isFinite(Date.parse(device.last_seen_at || "")) && Date.now() - Date.parse(device.last_seen_at) < 120000 });
  }

  const selectedBulkMatch = url.pathname.match(/^\/api\/(health|ume)\/bulk$/i);
  if (req.method === "POST" && selectedBulkMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const body = await readJson(req); const ids = Array.isArray(body.deviceIds) ? body.deviceIds.filter((id) => /^[a-f0-9-]{20,80}$/i.test(String(id))) : [];
    const scope = sameRegionOnly(session) ? " AND region_id = ?" : ""; const args = sameRegionOnly(session) ? [session.regionId] : [];
    const rows = ids.length ? db.prepare(`SELECT id FROM devices WHERE approved=1 AND julianday(last_seen_at)>=julianday('now','-120 seconds')${scope} AND id IN (${ids.map(() => "?").join(",")})`).all(...args, ...ids) : db.prepare(`SELECT id FROM devices WHERE approved=1 AND julianday(last_seen_at)>=julianday('now','-120 seconds')${scope}`).all(...args);
    const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, '{}', ?)"); const type = selectedBulkMatch[1] === "health" ? "health.probe" : (body.action === "stop" ? "ume.hide" : "ume.activate");
    const commandIds = rows.map((row) => { const id = crypto.randomUUID(); insert.run(id, row.id, type, "{}", now()); if (type === "health.probe") { try { if (JSON.parse(db.prepare("SELECT last_health_json FROM devices WHERE id=?").get(row.id)?.last_health_json || "{}").display?.enabled) insert.run(crypto.randomUUID(), row.id, "display.status", "{}", now()); } catch {} } return id; });
    audit(session.username, type + ".bulk", "ALL", { queued: commandIds.length }); return json(res, 202, { queued: commandIds.length, commands: commandIds, status: "pending" });
  }

  const displayBulkMatch = url.pathname.match(/^\/api\/display\/bulk\/(power|input)$/i);
  if (req.method === "POST" && displayBulkMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const body = await readJson(req);
    const kind = displayBulkMatch[1].toLowerCase();
    const payload = kind === "power" ? { on: Boolean(body.on) } : { input: String(body.input || "").toUpperCase() };
    if (kind === "input" && !["HDMI1", "HDMI2"].includes(payload.input)) return json(res, 400, { error: "input은 HDMI1 또는 HDMI2여야 합니다." });
    const ids = Array.isArray(body.deviceIds) ? body.deviceIds.filter((id) => /^[a-f0-9-]{20,80}$/i.test(String(id))) : [];
    const scope = sameRegionOnly(session) ? " AND region_id = ?" : "";
    const args = sameRegionOnly(session) ? [session.regionId] : [];
    const rows = ids.length ? db.prepare(`SELECT id FROM devices WHERE approved = 1 AND julianday(last_seen_at) >= julianday('now', '-120 seconds')${scope} AND id IN (${ids.map(() => "?").join(",")})`).all(...args, ...ids) : db.prepare(`SELECT id FROM devices WHERE approved = 1 AND julianday(last_seen_at) >= julianday('now', '-120 seconds')${scope}`).all(...args);
    const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)");
    const enabledRows = rows.filter((row) => { try { return Boolean(JSON.parse(db.prepare("SELECT last_health_json FROM devices WHERE id = ?").get(row.id)?.last_health_json || "{}").display?.enabled); } catch { return false; } });
    const commandIds = enabledRows.map((row) => { clearPendingDisplayCommands(row.id); const id = crypto.randomUUID(); insert.run(id, row.id, `display.${kind}`, JSON.stringify(payload), now()); return { deviceId: row.id, commandId: id }; });
    audit(session.username, `display.bulk.${kind}`, "ALL", { payload, queued: commandIds.length });
    return json(res, 202, { queued: commandIds.length, commands: commandIds, status: "pending" });
  }

  const ivisionBulkMatch = url.pathname.match(/^\/api\/ivision\/bulk\/(stop|restart)$/i);
  if (req.method === "POST" && ivisionBulkMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const body = await readJson(req);
    const ids = Array.isArray(body.deviceIds) ? body.deviceIds.filter((id) => /^[a-f0-9-]{20,80}$/i.test(String(id))) : [];
    const scope = sameRegionOnly(session) ? " AND region_id = ?" : "";
    const args = sameRegionOnly(session) ? [session.regionId] : [];
    const rows = ids.length ? db.prepare(`SELECT id FROM devices WHERE approved = 1 AND julianday(last_seen_at) >= julianday('now', '-120 seconds')${scope} AND id IN (${ids.map(() => "?").join(",")})`).all(...args, ...ids) : db.prepare(`SELECT id FROM devices WHERE approved = 1 AND julianday(last_seen_at) >= julianday('now', '-120 seconds')${scope}`).all(...args);
    const type = `ivision.${ivisionBulkMatch[1].toLowerCase()}`;
    const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, '{}', ?)");
    const commandIds = rows.map((row) => { const id = crypto.randomUUID(); insert.run(id, row.id, type, now()); return { deviceId: row.id, commandId: id }; });
    audit(session.username, type, "ALL", { queued: commandIds.length });
    return json(res, 202, { queued: commandIds.length, commands: commandIds, status: "pending" });
  }

  const windowsBulkMatch = url.pathname.match(/^\/api\/windows\/bulk\/(shutdown)$/i);
  if (req.method === "POST" && windowsBulkMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const body = await readJson(req);
    const ids = Array.isArray(body.deviceIds) ? body.deviceIds.filter((id) => /^[a-f0-9-]{20,80}$/i.test(String(id))) : [];
    const scope = sameRegionOnly(session) ? " AND region_id = ?" : "";
    const args = sameRegionOnly(session) ? [session.regionId] : [];
    const rows = ids.length ? db.prepare(`SELECT id FROM devices WHERE approved = 1 AND julianday(last_seen_at) >= julianday('now', '-120 seconds')${scope} AND id IN (${ids.map(() => "?").join(",")})`).all(...args, ...ids) : db.prepare(`SELECT id FROM devices WHERE approved = 1 AND julianday(last_seen_at) >= julianday('now', '-120 seconds')${scope}`).all(...args);
    const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'windows.shutdown', '{}', ?)");
    const commandIds = rows.map((row) => { const id = crypto.randomUUID(); insert.run(id, row.id, now()); return { deviceId: row.id, commandId: id }; });
    audit(session.username, "windows.shutdown.bulk", "ALL", { queued: commandIds.length });
    return json(res, 202, { queued: commandIds.length, commands: commandIds, status: "pending" });
  }

  const deviceMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)$/i);
  if (req.method === "PUT" && deviceMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    const body = await readJson(req);
    const current = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceMatch[1]);
    if (!current) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && current.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 관리할 수 있습니다." });
    const displayName = String(body.displayName ?? current.display_name).trim().slice(0, 100);
    const approved = body.approved === undefined ? current.approved : body.approved ? 1 : 0;
    if (!displayName) return json(res, 400, { error: "장비명을 입력해 주세요." });
    db.prepare("UPDATE devices SET display_name = ?, approved = ?, updated_at = ? WHERE id = ?")
      .run(displayName, approved, now(), current.id);
    audit(session.username, "device.update", current.id, { displayName, approved: Boolean(approved) });
    return json(res, 200, { device: deviceDto(db.prepare("SELECT devices.*, regions.name AS region_name FROM devices LEFT JOIN regions ON regions.id = devices.region_id WHERE devices.id = ?").get(current.id)) });
  }

  if (req.method === "DELETE" && deviceMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const current = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceMatch[1]);
    if (!current) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    db.prepare("DELETE FROM commands WHERE device_id = ?").run(current.id);
    db.prepare("DELETE FROM devices WHERE id = ?").run(current.id);
    audit(session.username, "device.delete", current.id, { displayName: current.display_name });
    return json(res, 200, { ok: true });
  }

  const approveMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/approve$/i);
  if (req.method === "POST" && approveMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    const current = db.prepare("SELECT * FROM devices WHERE id = ?").get(approveMatch[1]);
    if (!current) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && current.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 승인할 수 있습니다." });
    db.prepare("UPDATE devices SET approved = 1, updated_at = ? WHERE id = ?").run(now(), current.id);
    audit(session.username, "device.approve", current.id, { displayName: current.display_name });
    return json(res, 200, { device: deviceDto(db.prepare("SELECT devices.*, regions.name AS region_name FROM devices LEFT JOIN regions ON regions.id = devices.region_id WHERE devices.id = ?").get(current.id)) });
  }

  const probeMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/probe$/i);
  if (req.method === "POST" && probeMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    const device = db.prepare("SELECT id, region_id FROM devices WHERE id = ?").get(probeMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 확인할 수 있습니다." });
    const commandId = crypto.randomUUID();
    db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'health.probe', '{}', ?)")
      .run(commandId, device.id, now());
    const health = db.prepare("SELECT last_health_json FROM devices WHERE id = ?").get(device.id);
    try { if (JSON.parse(health?.last_health_json || "{}").display?.enabled) db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'display.status', '{}', ?)").run(crypto.randomUUID(), device.id, now()); } catch {}
    audit(session.username, "health.probe", device.id, { commandId });
    return json(res, 202, { commandId, status: "pending" });
  }

  const deviceRunUmeMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/run-ume$/i);
  if (req.method === "POST" && deviceRunUmeMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const device = db.prepare("SELECT id, region_id, approved, display_name FROM devices WHERE id = ?").get(deviceRunUmeMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 실행할 수 있습니다." });
    if (!device.approved) return json(res, 400, { error: "승인된 장비만 실행할 수 있습니다." });
    const body = await readJson(req);
    const commandId = crypto.randomUUID();
    const scheduleId = body.scheduleId ? String(body.scheduleId).slice(0, 80) : null;
    const runKey = `manual-device:${crypto.randomUUID()}`;
    db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'ume.activate', ?, ?)")
      .run(commandId, device.id, JSON.stringify({ scheduleId, runKey, deviceOnly: true }), now());
    audit(session.username, "device.run_ume", device.id, { commandId, scheduleId, displayName: device.display_name });
    return json(res, 202, { commandId, queued: 1, status: "pending" });
  }

  const umeStopMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/ume\/stop$/i);
  if (req.method === "POST" && umeStopMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const device = db.prepare("SELECT id, region_id, approved FROM devices WHERE id = ?").get(umeStopMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 실행할 수 있습니다." });
    if (!device.approved) return json(res, 400, { error: "승인된 장비만 실행할 수 있습니다." });
    const commandId = crypto.randomUUID();
    db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'ume.hide', '{}', ?)").run(commandId, device.id, now());
    audit(session.username, "device.ume_stop", device.id, { commandId });
    return json(res, 202, { commandId, status: "pending" });
  }

  const ivisionMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/ivision\/(stop|restart)$/i);
  if (req.method === "POST" && ivisionMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const device = db.prepare("SELECT id, region_id, approved FROM devices WHERE id = ?").get(ivisionMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 실행할 수 있습니다." });
    if (!device.approved) return json(res, 400, { error: "승인된 장비만 실행할 수 있습니다." });
    const commandId = crypto.randomUUID(); const type = `ivision.${ivisionMatch[2].toLowerCase()}`;
    db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, '{}', ?)").run(commandId, device.id, type, now());
    audit(session.username, type, device.id, { commandId });
    return json(res, 202, { commandId, status: "pending" });
  }

  json(res, 404, { error: "요청한 API를 찾을 수 없습니다." });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalized);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, {
    "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    "Cache-Control": requested === "/index.html" ? "no-store" : "public, max-age=300",
    ...securityHeaders(),
  });
  fs.createReadStream(filePath).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, version: appVersion, serverTime: now() });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, error.status || 500, { error: error.status ? error.message : "서버 오류가 발생했습니다." });
  }
});

function validateSchedule(value) {
  const name = String(value.name || "").trim().slice(0, 100);
  const localTime = String(value.localTime || "");
  const days = [...new Set((Array.isArray(value.days) ? value.days : []).map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
  if (!name) throw Object.assign(new Error("스케줄명을 입력해 주세요."), { status: 400 });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw Object.assign(new Error("실행 시간을 확인해 주세요."), { status: 400 });
  if (!days.length) throw Object.assign(new Error("실행 요일을 하나 이상 선택해 주세요."), { status: 400 });
  const regionIds = [...new Set((Array.isArray(value.regionIds) ? value.regionIds : []).map(String).filter(Boolean))];
  const validRegions = db.prepare(`SELECT id FROM regions WHERE id IN (${regionIds.length ? regionIds.map(() => "?").join(",") : "NULL"})`).all(...regionIds).map((row) => row.id);
  return { name, localTime, days, regionIds: validRegions, enabled: value.enabled !== false };
}

function listSchedules() {
  return db.prepare("SELECT * FROM schedules ORDER BY local_time, name COLLATE NOCASE").all().map((item) => ({
    id: item.id, name: item.name, localTime: item.local_time, days: JSON.parse(item.days_json), regionIds: JSON.parse(item.region_ids_json || "[]"),
    regionNames: JSON.parse(item.region_ids_json || "[]").map((id) => db.prepare("SELECT name FROM regions WHERE id = ?").get(id)?.name).filter(Boolean),
    enabled: Boolean(item.enabled), createdBy: item.created_by, createdAt: item.created_at, updatedAt: item.updated_at,
  }));
}

function enqueueUmeActivate(scheduleId, runKey, regionIds = []) {
  const devices = regionIds?.length
    ? db.prepare(`SELECT id FROM devices WHERE approved = 1 AND region_id IN (${regionIds.map(() => "?").join(",")})`).all(...regionIds)
    : db.prepare("SELECT id FROM devices WHERE approved = 1").all();
  const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'ume.activate', ?, ?)");
  const timestamp = now();
  for (const device of devices) insert.run(crypto.randomUUID(), device.id, JSON.stringify({ scheduleId, runKey }), timestamp);
  return devices.length;
}

function koreaClock() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday };
}

function runDueSchedules() {
  const clock = koreaClock();
  for (const schedule of listSchedules().filter((item) => item.enabled && item.localTime === clock.time && item.days.includes(clock.weekday))) {
    const runKey = `${clock.date}:${clock.time}`;
    try {
      db.prepare("INSERT INTO schedule_runs (schedule_id, run_key, created_at) VALUES (?, ?, ?)").run(schedule.id, runKey, now());
      enqueueUmeActivate(schedule.id, runKey, schedule.regionIds);
    } catch (error) {
      if (!String(error.message).includes("UNIQUE constraint failed")) console.error(error);
    }
  }
}

const scheduler = setInterval(runDueSchedules, 15_000);
scheduler.unref();

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`funnet-gwanak-control ${appVersion} listening on port ${port}`);
  });
  const shutdown = () => server.close(() => { clearInterval(scheduler); db.close(); process.exit(0); });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function closeDatabase() {
  clearInterval(scheduler);
  db.close();
}
