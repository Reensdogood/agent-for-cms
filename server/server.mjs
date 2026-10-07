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
const bootstrapInstallerPath = path.join(dataDir, "funnet-agent-bootstrap.exe");
const databasePath = path.join(dataDir, "funnet.db");
const port = Number(process.env.PORT || 4170);
const adminUser = process.env.FUNNET_ADMIN_USER || "admin";
const adminPassword = process.env.FUNNET_ADMIN_PASSWORD;
const enrollmentKey = process.env.FUNNET_ENROLLMENT_KEY;
const enercareBaseUrl = String(process.env.ENERCARE_BASE_URL || "https://dwcon.enercare.co.kr:18443").replace(/\/$/, "");
const enercareServerId = String(process.env.ENERCARE_DWD_SERVER_ID || "FUNNET");
const enercareGroupId = String(process.env.ENERCARE_DWD_GROUP_ID || "FUNNET");
const enercareServerSecret = String(process.env.ENERCARE_DWD_SERVER_SECRET || "");
const enercareCallbackSecret = String(process.env.ENERCARE_CON_SERVER_SECRET || "");
let enercareToken = null;
let enercareTokenRequest = null;
// 운영 여부와 무관하게 명시 설정을 우선한다. 내부망 HTTP(4171) 테스트에서는
// FUNNET_COOKIE_SECURE=false로 세션 쿠키를 저장할 수 있어야 한다.
const secureCookies = process.env.FUNNET_COOKIE_SECURE === "true";
const maxUploadBytes = Number(process.env.FUNNET_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);
const buildRunnerKey = String(process.env.FUNNET_BUILD_RUNNER_KEY || "");

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
    version TEXT NOT NULL,
    region_id TEXT,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (version, region_id, file_name)
  );

  CREATE TABLE IF NOT EXISTS build_jobs (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL REFERENCES regions(id),
    product_type TEXT NOT NULL,
    version TEXT NOT NULL,
    tv_model TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    requested_by TEXT NOT NULL,
    runner_name TEXT,
    error_text TEXT,
    release_id TEXT REFERENCES releases(id),
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT,
    UNIQUE(region_id, product_type, version)
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

  CREATE TABLE IF NOT EXISTS smart_plugs (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
    enercare_device_id TEXT NOT NULL UNIQUE,
    low_group_id TEXT NOT NULL DEFAULT '',
    sub_group_id TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    connection_status TEXT,
    power_status TEXT,
    last_synced_at TEXT,
    last_error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS enercare_group_options (
    low_group_id TEXT NOT NULL,
    low_group_name TEXT NOT NULL,
    sub_group_id TEXT NOT NULL DEFAULT '',
    sub_group_name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (low_group_id, sub_group_id)
  );

  CREATE TABLE IF NOT EXISTS enercare_callback_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS installer_bootstrap_tokens (
    token_hash TEXT PRIMARY KEY,
    region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

ensureColumn("commands", "attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("devices", "region_id", "TEXT");
ensureColumn("users", "region_id", "TEXT");
ensureColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("schedules", "region_ids_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("schedules", "action_type", "TEXT NOT NULL DEFAULT 'ume.activate'");
ensureColumn("schedules", "device_ids_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("users", "updated_at", "TEXT");
db.prepare("UPDATE users SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''").run();
migrateReleasesSchema();
seedDefaultRegion();
seedEnercareGroupOptions();

seedAdmin();

const sessions = new Map();
const loginAttempts = new Map();
const registrationRejectionAuditAt = new Map();

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

function canManageSmartPlugs(session) {
  return ["admin", "operator", "system_manager"].includes(session?.role);
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

function seedEnercareGroupOptions() {
  const rows = [
    ["GM", "광명", "A-GM", "A그룹-광명(광명,철산,학온)"],
    ["GM", "광명", "B-GM", "B그룹-광명(소하,일직,하안)"],
    ["GM", "광명", "", "ALL 전체"],
    ["GWANAK9", "관악구", "", "ALL 전체"],
    ["SSCH", "스마트경로당", "DALSEO", "달서구스마트경로당"],
    ["SSCH", "스마트경로당", "GANGJIN", "강진 스마트경로당"],
    ["YUSEONG", "유성구 스마트 돌봄 체계 구축 사업", "YS-I", "유성아이돌봄센터"],
    ["YUSEONG", "유성구 스마트 돌봄 체계 구축 사업", "YS-ST", "유성구 스튜디오"],
    ["YUSEONG", "유성구 스마트 돌봄 체계 구축 사업", "YS-T", "유성구 지역아동센터"],
    ["YUSEONG", "유성구 스마트 돌봄 체계 구축 사업", "YS-YOUTH", "유성구 청소년 시설"],
    ["YUSEONG", "유성구 스마트 돌봄 체계 구축 사업", "", "ALL 전체"],
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO enercare_group_options (low_group_id, low_group_name, sub_group_id, sub_group_name) VALUES (?, ?, ?, ?)");
  for (const row of rows) insert.run(...row);
}

// 1.5.0 installers are built with one enrollment key per region.  Older
// databases made `version` globally unique, which cannot store two regional
// packages of the same Agent version.  Rebuild this isolated table in-place;
// commands refer to release ids only inside JSON, so no foreign key is lost.
function migrateReleasesSchema() {
  const columns = db.prepare("PRAGMA table_info(releases)").all();
  const hasRegion = columns.some((column) => column.name === "region_id");
  const hasVersionOnlyUnique = db.prepare("PRAGMA index_list(releases)").all().some((index) => {
    if (!index.unique) return false;
    const indexed = db.prepare(`PRAGMA index_info(${index.name})`).all();
    return indexed.length === 1 && indexed[0].name === "version";
  });
  if (hasRegion && !hasVersionOnlyUnique) return;
  db.exec(`
    BEGIN;
    CREATE TABLE releases_next (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      region_id TEXT,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (version, region_id, file_name)
    );
    INSERT INTO releases_next (id, version, region_id, file_name, file_path, size_bytes, sha256, created_by, created_at)
      SELECT id, version, ${hasRegion ? "region_id" : "NULL"}, file_name, file_path, size_bytes, sha256, created_by, created_at FROM releases;
    DROP TABLE releases;
    ALTER TABLE releases_next RENAME TO releases;
    COMMIT;
  `);
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

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleEnercareCallback(req, res, url) {
  if (req.method === "POST" && url.pathname === "/conn/v1/publish/servertoken") {
    if (!enercareCallbackSecret) return json(res, 503, { reason: "EnerCare callback secret is not configured" });
    const header = String(req.headers.authorization || "");
    const encoded = header.startsWith("Basic ") ? header.slice(6) : "";
    const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
    const [serverId, suppliedSecret] = decoded.split(/:(.*)/s);
    if (serverId !== enercareServerId || !equalSecret(suppliedSecret, enercareCallbackSecret)) return json(res, 401, { reason: "Unauthorized" });
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT OR REPLACE INTO enercare_callback_tokens (token_hash, expires_at, created_at) VALUES (?, ?, ?)")
      .run(hashToken(token), "9999-12-31T23:59:59.000Z", now());
    return json(res, 200, { con_access_token: token, con_access_token_expiredate: "9999-12-31 23:59:59" });
  }
  if (req.method === "POST" && url.pathname === "/conn/v1/transfer/device/realtimedata") {
    const body = await readJson(req);
    const token = String(body.con_server_access_token || "");
    const known = token && db.prepare("SELECT expires_at FROM enercare_callback_tokens WHERE token_hash = ?").get(hashToken(token));
    if (body.con_server_id !== enercareServerId || !known || Date.parse(known.expires_at) < Date.now()) return json(res, 401, { reason: "Unauthorized" });
    const plug = db.prepare("SELECT * FROM smart_plugs WHERE enercare_device_id = ?").get(String(body.device_id || ""));
    if (plug) {
      const state = plugState(body);
      db.prepare("UPDATE smart_plugs SET connection_status=?, power_status=?, last_synced_at=?, last_error=NULL, updated_at=? WHERE id=?")
        .run(state.connection, state.power, now(), now(), plug.id);
    }
    return json(res, 200, { result: "OK" });
  }
  return json(res, 404, { reason: "Not Found" });
}

function enercareIsConfigured() {
  return Boolean(enercareServerSecret && enercareCallbackSecret);
}

function enercareError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

async function enercareAccessToken(forceRefresh = false) {
  if (!enercareIsConfigured()) throw enercareError("EnerCare 연동 정보가 아직 설정되지 않았습니다.", 503);
  if (!forceRefresh && enercareToken && enercareToken.expiresAt > Date.now() + 60_000) return enercareToken.value;
  if (enercareTokenRequest) return enercareTokenRequest;
  enercareTokenRequest = (async () => {
    const authorization = Buffer.from(`${enercareServerId}:${enercareServerSecret}`, "utf8").toString("base64");
    const response = await fetch(`${enercareBaseUrl}/conn/v1/publish/servertoken`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-HIT-Version": "1.0", Authorization: `Basic ${authorization}` },
      body: JSON.stringify({ dwd_group_id: enercareGroupId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.dwd_access_token) throw enercareError(`EnerCare 인증에 실패했습니다.${body.reason ? ` ${body.reason}` : ""}`, response.status || 502);
    const expiresAt = Date.parse(String(body.dwd_access_token_expiredate || ""));
    enercareToken = { value: String(body.dwd_access_token), expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 23 * 60 * 60 * 1000 };
    return enercareToken.value;
  })();
  try { return await enercareTokenRequest; }
  finally { enercareTokenRequest = null; }
}

async function enercareRequest(endpoint, payload, retryOnInvalidToken = true) {
  const token = await enercareAccessToken(!retryOnInvalidToken);
  const response = await fetch(`${enercareBaseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-HIT-Version": "1.0" },
    body: JSON.stringify({ dwd_server_id: enercareServerId, dwd_access_token: token, group_id: enercareGroupId, ...payload }),
  });
  const body = await response.json().catch(() => ({}));
  const invalidToken = response.status === 498 || /token\s+incorrect|invalid\s+token/i.test(String(body.reason || ""));
  // 다원 서버가 토큰 만료 시각보다 먼저 토큰을 무효화하는 경우가 있어, 한 번만
  // 새 토큰으로 재시도한다. 반복 재시도는 API 분당 요청 제한을 건드릴 수 있다.
  if (!response.ok && invalidToken && retryOnInvalidToken) {
    enercareToken = null;
    return enercareRequest(endpoint, payload, false);
  }
  if (!response.ok) throw enercareError(`EnerCare 요청에 실패했습니다.${body.reason ? ` ${body.reason}` : ""}`, response.status || 502);
  return body;
}

function plugState(value) {
  const results = value?.results || value || {};
  return {
    connection: String(results.conn_status) === "1" ? "online" : "offline",
    power: String(results.switch_status || "").toUpperCase() === "ON" ? "on" : "off",
    uploadTime: results.upload_time || null,
  };
}

async function refreshSmartPlug(plug) {
  try {
    const response = await enercareRequest("/conn/v1/inquire/device/values", {
      device_id: plug.enercare_device_id,
      inquire_values: ["switch_status", "conn_status", "upload_time"],
    });
    const state = plugState(response);
    db.prepare("UPDATE smart_plugs SET connection_status = ?, power_status = ?, last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(state.connection, state.power, now(), now(), plug.id);
    return { ...plug, ...state, lastSyncedAt: now(), lastError: null };
  } catch (error) {
    const message = String(error.message || "EnerCare 상태 조회 실패").slice(0, 500);
    db.prepare("UPDATE smart_plugs SET last_error = ?, updated_at = ? WHERE id = ?").run(message, now(), plug.id);
    throw error;
  }
}

function smartPlugDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    enercareDeviceId: row.enercare_device_id,
    lowGroupId: row.low_group_id,
    subGroupId: row.sub_group_id,
    displayName: row.display_name,
    connection: row.connection_status || "offline",
    power: row.power_status || "off",
    lastSyncedAt: row.last_synced_at || null,
    lastError: row.last_error || null,
  };
}

async function controlSmartPlugs(rows, control) {
  const succeeded = [];
  const failed = [];
  // EnerCare는 분당 요청 수를 제한하므로 작은 동시성으로 제어한다.
  for (let offset = 0; offset < rows.length; offset += 4) {
    const batch = rows.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async (plug) => {
      try {
        const response = await enercareRequest("/conn/v1/control/device/onoff", {
          device_id: plug.enercare_device_id, control, control_time: now().replace("T", " ").slice(0, 19),
        });
        db.prepare("UPDATE smart_plugs SET power_status=?, connection_status='online', last_synced_at=?, last_error=NULL, updated_at=? WHERE id=?")
          .run(control.toLowerCase(), now(), now(), plug.id);
        return { ok: true, id: plug.id, deviceId: plug.device_id, result: response.result || control };
      } catch (error) {
        const message = String(error.message || "EnerCare 제어 실패").slice(0, 500);
        db.prepare("UPDATE smart_plugs SET last_error=?, updated_at=? WHERE id=?").run(message, now(), plug.id);
        return { ok: false, id: plug.id, deviceId: plug.device_id, error: message };
      }
    }));
    for (const item of results) (item.ok ? succeeded : failed).push(item);
  }
  return { succeeded, failed };
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

function isAgentReleaseName(fileName) {
  return /^(Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-/i.test(fileName);
}

function releaseProduct(fileName) {
  if (/^funnet-meetingbar-a10-controller-/i.test(fileName)) return "meetingbar_a10";
  if (isAgentReleaseName(fileName)) return "windows_agent";
  return "ume";
}

function runnerAuthorized(req) {
  const supplied = String(req.headers["x-build-runner-key"] || "");
  if (!buildRunnerKey || supplied.length !== buildRunnerKey.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(buildRunnerKey));
}

function releaseDto(row) {
  return {
    id: row.id,
    version: row.version,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    regionId: row.region_id || null,
    regionName: row.region_name || null,
    productType: releaseProduct(row.file_name),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function buildJobDto(row) {
  return {
    id: row.id, regionId: row.region_id, regionName: row.region_name || null,
    productType: row.product_type, version: row.version, tvModel: row.tv_model || null,
    status: row.status, requestedBy: row.requested_by, runnerName: row.runner_name || null,
    error: row.error_text || null, releaseId: row.release_id || null,
    createdAt: row.created_at, claimedAt: row.claimed_at || null, completedAt: row.completed_at || null,
  };
}

function streamRelease(res, release) {
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": release.size_bytes,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(release.file_name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
  return fs.createReadStream(release.file_path).pipe(res);
}

function auditRegistrationRejection(reason, enrollment, installationId, localName) {
  // 등록 실패 Agent는 5초마다 재시도한다. 같은 원인을 모두 기록하면
  // 감사 로그가 급증하므로 장비·원인별로 5분마다 한 번만 남긴다.
  const keyFingerprint = crypto.createHash("sha256").update(String(enrollment || "")).digest("hex").slice(0, 12);
  const key = `${reason}:${keyFingerprint}:${installationId}`;
  const previous = registrationRejectionAuditAt.get(key) || 0;
  if (Date.now() - previous < 5 * 60 * 1000) return;
  if (registrationRejectionAuditAt.size > 500) registrationRejectionAuditAt.clear();
  registrationRejectionAuditAt.set(key, Date.now());
  audit("agent:registration", "device.register.rejected", null, { reason, keyFingerprint, installationId, localName });
}

function bootstrapTokenHash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function createBootstrapToken(regionId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO installer_bootstrap_tokens (token_hash, region_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(bootstrapTokenHash(token), regionId, expiresAt, now());
  return token;
}

function streamBootstrapInstaller(res, token) {
  const stat = fs.statSync(bootstrapInstallerPath);
  // Windows single-file exe는 실행에 사용되지 않는 overlay 바이트를 허용한다.
  // 파일명은 브라우저가 중복 다운로드 시 바꿀 수 있으므로, 같은 토큰을 파일
  // 끝에도 넣어 설치기가 이름과 무관하게 지역 등록 정보를 찾을 수 있게 한다.
  const trailer = Buffer.from(`\nFUNNET_BOOTSTRAP_TOKEN:${token}\n`, "utf8");
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": stat.size + trailer.length,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`funnet-agent-bootstrap-${token}.exe`)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
  const stream = fs.createReadStream(bootstrapInstallerPath);
  stream.once("error", () => res.destroy());
  stream.once("end", () => res.end(trailer));
  return stream.pipe(res, { end: false });
}

function humanizeOsVersion(value, edition, displayVersion, buildValue, revisionValue) {
  // 서버 화면에는 빌드 번호로 추정한 OS 계열을 표시하지 않는다.
  // Agent가 보고한 사람이 읽을 수 있는 에디션과 릴리즈 버전만 사용한다.
  const labels = [edition, displayVersion].filter((value) => value && String(value).trim());
  return labels.length ? labels.join(" · ") : (String(value || "") || null);
}

function clearPendingDisplayCommands(deviceId) {
  return Number(db.prepare("DELETE FROM commands WHERE device_id = ? AND type LIKE 'display.%' AND status IN ('pending','delivered')").run(deviceId).changes || 0);
}

const knownDisplayInputs = new Set(["HDMI1", "HDMI2", "HDMI3"]);

function displayInputsForHealth(health) {
  const declared = Array.isArray(health?.display?.inputSources)
    ? health.display.inputSources.map((value) => String(value || "").toUpperCase()).filter((value) => knownDisplayInputs.has(value))
    : [];
  if (declared.length) return [...new Set(declared)];
  // 이전 Agent는 HDMI3 MDC 값을 이해하지 못하므로, 새 Health 계약을 보고하기 전에는
  // 기존 HDMI1/HDMI2 범위만 허용한다. 업데이트 직후 첫 heartbeat부터 HDMI3이 열린다.
  return ["HDMI1", "HDMI2"];
}

function deviceSupportsDisplayInput(health, input) {
  return displayInputsForHealth(health).includes(String(input || "").toUpperCase());
}

function capabilityFromHealth(health, name, fallback = true) {
  return typeof health?.capabilities?.[name] === "boolean" ? health.capabilities[name] : fallback;
}

function deviceHasCapability(deviceId, name, fallback = true) {
  try {
    const row = db.prepare("SELECT last_health_json FROM devices WHERE id = ?").get(deviceId);
    return capabilityFromHealth(JSON.parse(row?.last_health_json || "{}"), name, fallback);
  } catch {
    return fallback;
  }
}

function deviceDto(row) {
  let displayEnabled = false;
  let displayInputs = ["HDMI1", "HDMI2"];
  let serialDiagnostics = null;
  let platform = "windows";
  let capabilities = { displayControl: false, ume: true, ivision: true, windowsShutdown: true, agentUpdate: true, supportedInputs: displayInputs };
  let osVersion = null; let osEdition = null; let osDisplayVersion = null; let osBuild = null; let osRevision = null; let agentElevated = null; let deviceProfile = null; let conferenceIdentity = null; let localIpAddress = null;
  try { const health = JSON.parse(row.last_health_json || "{}"); displayEnabled = Boolean(health.display?.enabled); displayInputs = displayInputsForHealth(health); serialDiagnostics = health.display?.serialDiagnostics || null; deviceProfile = health.deviceProfile || null; conferenceIdentity = health.conferenceIdentity || null; localIpAddress = health.localIpAddress || null; const androidEvidence = health.platform === "android" || String(row.agent_version || "").startsWith("android-") || /^Android\b/i.test(String(health.osVersion || "")) || health.deviceProfile === "yealink-meetingbar-a10"; platform = androidEvidence ? "android" : "windows"; capabilities = { ...capabilities, ...(health.capabilities || {}), supportedInputs: displayInputs }; osVersion = health.osVersion || null; osEdition = health.osEdition; osDisplayVersion = health.osDisplayVersion; osBuild = health.osBuild; osRevision = health.osRevision; agentElevated = typeof health.agentElevated === "boolean" ? health.agentElevated : null; } catch {}
  const displayCheck = db.prepare("SELECT status, completed_at, result_json FROM commands WHERE device_id = ? AND type = 'display.status' ORDER BY created_at DESC LIMIT 1").get(row.id);
  let displayConnection = displayEnabled ? "미확인" : "비활성화";
  if (displayCheck?.status === "completed") {
    try {
      const result = JSON.parse(displayCheck.result_json || "{}");
      displayConnection = result?.result?.connection === "timeout" || result?.success === false ? "연결 실패" : "정상";
    } catch { displayConnection = "정상"; }
  }
  else if (displayCheck?.status === "failed") displayConnection = "연결 실패";
  const smartPlug = smartPlugDto(db.prepare("SELECT * FROM smart_plugs WHERE device_id = ?").get(row.id));
  return {
    id: row.id,
    platform,
    deviceProfile,
    conferenceIdentity,
    localIpAddress,
    capabilities,
    osVersion: humanizeOsVersion(osVersion, osEdition, osDisplayVersion, osBuild, osRevision),
    installationId: row.installation_id,
    regionId: row.region_id,
    regionName: row.region_name || "미지정",
    displayName: row.display_name,
    localName: row.local_name,
    machineName: row.machine_name,
    approved: Boolean(row.approved),
    status: statusFor(row.last_seen_at),
    agentVersion: String(row.agent_version || "").split("+")[0] || null,
    agentElevationRequired: agentElevated === false,
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
    displayInputs,
    serialDiagnostics,
    smartPlug,
    displayConnection,
    displayCheckedAt: displayCheck?.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleApi(req, res, url) {
  if (url.pathname.startsWith("/api/build-runner/")) {
    if (!runnerAuthorized(req)) return json(res, 401, { error: "빌드 러너 인증에 실패했습니다." });
    if (req.method === "GET" && url.pathname === "/api/build-runner/jobs/next") {
      const runnerName = String(req.headers["x-build-runner-name"] || "windows-runner").slice(0, 100);
      const job = db.prepare(`SELECT build_jobs.*, regions.name AS region_name, regions.enrollment_key
        FROM build_jobs JOIN regions ON regions.id = build_jobs.region_id
        WHERE build_jobs.status = 'queued' ORDER BY build_jobs.created_at LIMIT 1`).get();
      if (!job) return json(res, 200, { job: null });
      const claimedAt = now();
      const changed = db.prepare("UPDATE build_jobs SET status='building', runner_name=?, claimed_at=? WHERE id=? AND status='queued'").run(runnerName, claimedAt, job.id);
      if (!changed.changes) return json(res, 200, { job: null });
      return json(res, 200, { job: { ...buildJobDto({ ...job, status: "building", runner_name: runnerName, claimed_at: claimedAt }), serverBaseUrl: publicServerUrl(req), enrollmentKey: job.enrollment_key } });
    }
    const runnerResultMatch = url.pathname.match(/^\/api\/build-runner\/jobs\/([a-f0-9-]+)\/result$/i);
    if (req.method === "POST" && runnerResultMatch) {
      const job = db.prepare("SELECT build_jobs.*, regions.name AS region_name FROM build_jobs JOIN regions ON regions.id=build_jobs.region_id WHERE build_jobs.id=?").get(runnerResultMatch[1]);
      if (!job || job.status !== "building") return json(res, 409, { error: "업로드할 빌드 작업을 찾을 수 없습니다." });
      const fileName = path.basename(decodeURIComponent(String(req.headers["x-file-name"] || "")));
      const expected = job.product_type === "meetingbar_a10" ? `funnet-meetingbar-a10-controller-${job.version}.apk` : `funnet-agent-setup-${job.version}.exe`;
      if (fileName !== expected) return json(res, 400, { error: `결과 파일명은 ${expected}이어야 합니다.` });
      const id = crypto.randomUUID();
      const extension = job.product_type === "meetingbar_a10" ? ".apk" : ".exe";
      const destination = path.join(releaseDir, `${id}${extension}`);
      const saved = await saveUpload(req, destination);
      const timestamp = now();
      db.prepare("INSERT INTO releases (id, version, region_id, file_name, file_path, size_bytes, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, job.version, job.region_id, fileName, destination, saved.size, saved.sha256, `runner:${job.runner_name || "windows"}`, timestamp);
      db.prepare("UPDATE build_jobs SET status='completed', release_id=?, completed_at=?, error_text=NULL WHERE id=?").run(id, timestamp, job.id);
      audit(`runner:${job.runner_name || "windows"}`, "build.complete", job.id, { productType: job.product_type, version: job.version, regionId: job.region_id, ...saved });
      return json(res, 201, { releaseId: id, sha256: saved.sha256, size: saved.size });
    }
    const runnerFailureMatch = url.pathname.match(/^\/api\/build-runner\/jobs\/([a-f0-9-]+)\/failure$/i);
    if (req.method === "POST" && runnerFailureMatch) {
      const body = await readJson(req);
      const error = String(body.error || "빌드 실패").slice(0, 2000);
      db.prepare("UPDATE build_jobs SET status='failed', error_text=?, completed_at=? WHERE id=? AND status='building'").run(error, now(), runnerFailureMatch[1]);
      audit("build-runner", "build.failed", runnerFailureMatch[1], { error });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "빌드 러너 API를 찾을 수 없습니다." });
  }

  const provisioningMatch = url.pathname.match(/^\/api\/installer-provisioning\/([A-Za-z0-9_-]{24,128})$/);
  if (req.method === "GET" && provisioningMatch) {
    const token = provisioningMatch[1];
    const record = db.prepare("SELECT region_id, expires_at FROM installer_bootstrap_tokens WHERE token_hash = ?").get(bootstrapTokenHash(token));
    if (!record || Date.parse(record.expires_at) <= Date.now()) return json(res, 404, { error: "설치 파일의 지역 등록 정보가 만료되었습니다. 관리자 화면에서 다시 내려받아 주세요." });
    const region = db.prepare("SELECT * FROM regions WHERE id = ?").get(record.region_id);
    if (!region) return json(res, 404, { error: "지역 등록 정보를 찾을 수 없습니다." });
    return json(res, 200, { serverBaseUrl: publicServerUrl(req), enrollmentKey: region.enrollment_key, regionName: region.name });
  }

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
    const body = await readJson(req);
    const enrollment = String(req.headers["x-enrollment-key"] || "");
    const installationId = String(body.installationId || "").trim();
    const localName = String(body.localName || body.machineName || "미지정 장비").trim().slice(0, 100);
    const region = findRegionByEnrollmentKey(enrollment);
    if (!region) {
      auditRegistrationRejection("invalid_enrollment_key", enrollment, installationId, localName);
      return json(res, 401, { error: "등록 키가 올바르지 않습니다." });
    }
    if (!/^[a-f0-9-]{36}$/i.test(installationId)) {
      auditRegistrationRejection("invalid_installation_id", enrollment, installationId, localName);
      return json(res, 400, { error: "installationId 형식이 올바르지 않습니다." });
    }
    const existing = db.prepare("SELECT * FROM devices WHERE installation_id = ?").get(installationId);
    if (existing) {
      auditRegistrationRejection("duplicate_installation_id", enrollment, installationId, localName);
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
    db.prepare("DELETE FROM installer_bootstrap_tokens WHERE region_id = ?").run(region.id);
    audit(session.username, "region.rotate_key", region.id, { name: region.name });
    return json(res, 200, { region: regionDto(db.prepare("SELECT * FROM regions WHERE id = ?").get(region.id)), serverBaseUrl: publicServerUrl(req) });
  }

  const regionInstallerMatch = url.pathname.match(/^\/api\/regions\/([a-f0-9-]+)\/agent-installer$/i);
  if (req.method === "POST" && regionInstallerMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    const region = db.prepare("SELECT * FROM regions WHERE id = ?").get(regionInstallerMatch[1]);
    if (!region) return json(res, 404, { error: "지역을 찾을 수 없습니다." });
    if (sameRegionOnly(session) && region.id !== session.regionId) return json(res, 403, { error: "담당 지역 설치 파일만 내려받을 수 있습니다." });
    if (!fs.existsSync(bootstrapInstallerPath)) return json(res, 503, { error: "최신 Agent 설치 파일 템플릿이 아직 준비되지 않았습니다." });
    const token = createBootstrapToken(region.id);
    audit(session.username, "region.agent_installer.download", region.id, { name: region.name });
    return json(res, 200, { downloadPath: `/api/regions/${region.id}/agent-installer/download?token=${encodeURIComponent(token)}` });
  }

  const regionInstallerDownloadMatch = url.pathname.match(/^\/api\/regions\/([a-f0-9-]+)\/agent-installer\/download$/i);
  if (req.method === "GET" && regionInstallerDownloadMatch) {
    const session = requireAdmin(req, res);
    if (!session) return;
    const regionId = regionInstallerDownloadMatch[1];
    if (sameRegionOnly(session) && regionId !== session.regionId) return json(res, 403, { error: "담당 지역 설치 파일만 내려받을 수 있습니다." });
    const token = String(url.searchParams.get("token") || "");
    const record = db.prepare("SELECT region_id, expires_at FROM installer_bootstrap_tokens WHERE token_hash = ?").get(bootstrapTokenHash(token));
    if (!record || record.region_id !== regionId || Date.parse(record.expires_at) <= Date.now()) return json(res, 404, { error: "다운로드 정보가 만료되었습니다. 다시 시도해 주세요." });
    if (!fs.existsSync(bootstrapInstallerPath)) return json(res, 503, { error: "최신 Agent 설치 파일 템플릿이 아직 준비되지 않았습니다." });
    return streamBootstrapInstaller(res, token);
  }

  if (req.method === "GET" && url.pathname === "/api/build-jobs") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const scope = sameRegionOnly(session) ? "WHERE build_jobs.region_id = ?" : "";
    const rows = db.prepare(`SELECT build_jobs.*, regions.name AS region_name FROM build_jobs JOIN regions ON regions.id=build_jobs.region_id ${scope} ORDER BY build_jobs.created_at DESC LIMIT 50`)
      .all(...(sameRegionOnly(session) ? [session.regionId] : []));
    return json(res, 200, { jobs: rows.map(buildJobDto), runnerConfigured: buildRunnerKey.length >= 24 });
  }

  if (req.method === "POST" && url.pathname === "/api/build-jobs") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    if (buildRunnerKey.length < 24) return json(res, 503, { error: "서버에 전용 빌드 러너 키가 설정되지 않았습니다." });
    const body = await readJson(req);
    const regionId = String(body.regionId || "");
    const productType = String(body.productType || "");
    const version = String(body.version || "").trim();
    const tvModel = productType === "meetingbar_a10" ? String(body.tvModel || "LH65QET").toUpperCase() : null;
    if (!/^(windows_agent|meetingbar_a10)$/.test(productType)) return json(res, 400, { error: "빌드 제품을 선택해 주세요." });
    if (!/^[0-9]+(?:\.[0-9]+){2,3}$/.test(version)) return json(res, 400, { error: "버전은 1.0.0 형식으로 입력해 주세요." });
    if (tvModel && !/^LH(65|75|85)(QET|QBC)$/.test(tvModel)) return json(res, 400, { error: "지원하는 TV 모델을 선택해 주세요." });
    const region = db.prepare("SELECT id, name FROM regions WHERE id=?").get(regionId);
    if (!region) return json(res, 400, { error: "대상 지역을 찾을 수 없습니다." });
    if (sameRegionOnly(session) && region.id !== session.regionId) return json(res, 403, { error: "담당 지역만 빌드할 수 있습니다." });
    const id = crypto.randomUUID(); const timestamp = now();
    try {
      db.prepare("INSERT INTO build_jobs (id, region_id, product_type, version, tv_model, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, region.id, productType, version, tvModel, session.username, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "같은 지역·제품·버전의 빌드가 이미 존재합니다." });
      throw error;
    }
    audit(session.username, "build.queue", id, { regionId, productType, version, tvModel });
    return json(res, 201, { job: buildJobDto({ id, region_id: region.id, region_name: region.name, product_type: productType, version, tv_model: tvModel, status: "queued", requested_by: session.username, created_at: timestamp }) });
  }

  if (req.method === "GET" && url.pathname === "/api/releases") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const scope = sameRegionOnly(session) ? "WHERE releases.region_id = ?" : "";
    const releases = db.prepare(`
      SELECT releases.*, regions.name AS region_name
      FROM releases LEFT JOIN regions ON regions.id = releases.region_id
      ${scope} ORDER BY releases.created_at DESC
    `).all(...(sameRegionOnly(session) ? [session.regionId] : []));
    return json(res, 200, { releases: releases.map(releaseDto) });
  }

  if (req.method === "GET" && url.pathname === "/api/commands") {
    const session = requireAdmin(req, res);
    if (!session) return;
    // 시스템 상태는 전체 장비의 명령 실패/미응답 내역을 포함한다. 지역 관리자는
    // 다른 지역 장비의 운영 정보를 볼 수 없도록 조회 자체를 막고, 운영 및
    // 시스템 담당자에게만 읽기 권한을 준다.
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
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

  if (req.method === "GET" && url.pathname === "/api/smart-plugs/groups") {
    const session = requireAdmin(req, res);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const groups = db.prepare("SELECT low_group_id, low_group_name, sub_group_id, sub_group_name FROM enercare_group_options ORDER BY low_group_name, sub_group_name").all();
    return json(res, 200, { groups, configured: Boolean(enercareServerSecret) });
  }

  if (req.method === "POST" && url.pathname === "/api/smart-plugs/catalog") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canManageSmartPlugs(session)) return json(res, 403, { error: "스마트플러그 등록은 시스템 또는 운영 관리자만 할 수 있습니다." });
    const body = await readJson(req);
    const lowGroupId = String(body.lowGroupId || "").trim().slice(0, 80);
    const subGroupId = String(body.subGroupId || "").trim().slice(0, 80);
    const result = await enercareRequest("/conn/v1/profile/device/list", { low_group_id: lowGroupId, sub_group_id: subGroupId, inquire_time: now().replace("T", " ").slice(0, 19) });
    return json(res, 200, { devices: Array.isArray(result.deviceList) ? result.deviceList.map((item) => ({
      deviceId: item.device_id, displayName: item.display_name || item.device_id, lowGroupId: item.low_group_id || lowGroupId,
      subGroupId: item.sub_group_id || subGroupId, connection: String(item.conn_status) === "1" ? "online" : "offline",
      power: String(item.power).toLowerCase() === "true" ? "on" : "off",
    })) : [] });
  }

  const smartPlugMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/smart-plug$/i);
  const smartPlugStatusMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/smart-plug\/status$/i);
  const smartPlugPowerMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/smart-plug\/power$/i);
  if (smartPlugMatch || smartPlugStatusMatch || smartPlugPowerMatch) {
    const session = requireAdmin(req, res, req.method !== "GET");
    if (!session) return;
    const deviceId = (smartPlugMatch || smartPlugStatusMatch || smartPlugPowerMatch)[1];
    const device = db.prepare("SELECT id, region_id, display_name FROM devices WHERE id = ?").get(deviceId);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 조회할 수 있습니다." });
    const plug = db.prepare("SELECT * FROM smart_plugs WHERE device_id = ?").get(device.id);
    if (req.method === "GET" && smartPlugStatusMatch) {
      if (!plug) return json(res, 404, { error: "이 장비에 등록된 스마트플러그가 없습니다." });
      const current = await refreshSmartPlug(plug);
      return json(res, 200, { smartPlug: smartPlugDto({ ...plug, connection_status: current.connection, power_status: current.power, last_synced_at: current.lastSyncedAt, last_error: null }) });
    }
    if (req.method === "POST" && smartPlugPowerMatch) {
      if (!canManageSmartPlugs(session)) return json(res, 403, { error: "스마트플러그 제어는 시스템 또는 운영 관리자만 할 수 있습니다." });
      if (!plug) return json(res, 404, { error: "이 장비에 등록된 스마트플러그가 없습니다." });
      const body = await readJson(req);
      if (typeof body.on !== "boolean") return json(res, 400, { error: "on 값은 true 또는 false여야 합니다." });
      const current = await refreshSmartPlug(plug);
      if (current.connection !== "online") return json(res, 409, { error: "스마트플러그가 오프라인입니다. 온라인 상태에서만 전원을 제어할 수 있습니다." });
      const wanted = body.on ? "ON" : "OFF";
      const response = await enercareRequest("/conn/v1/control/device/onoff", { device_id: plug.enercare_device_id, control: wanted, control_time: now().replace("T", " ").slice(0, 19) });
      db.prepare("UPDATE smart_plugs SET power_status = ?, connection_status = 'online', last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .run(wanted.toLowerCase(), now(), now(), plug.id);
      audit(session.username, "smart_plug.power", plug.id, { deviceId: device.id, enercareDeviceId: plug.enercare_device_id, control: wanted, result: response.result || null });
      return json(res, 200, { smartPlug: smartPlugDto(db.prepare("SELECT * FROM smart_plugs WHERE id = ?").get(plug.id)), result: response.result || wanted });
    }
    if (req.method === "PUT" && smartPlugMatch) {
      if (!canManageSmartPlugs(session)) return json(res, 403, { error: "스마트플러그 등록은 시스템 또는 운영 관리자만 할 수 있습니다." });
      const body = await readJson(req);
      const enercareDeviceId = String(body.enercareDeviceId || "").trim().slice(0, 200);
      const lowGroupId = String(body.lowGroupId || "").trim().slice(0, 80);
      const subGroupId = String(body.subGroupId || "").trim().slice(0, 80);
      const displayName = String(body.displayName || device.display_name).trim().slice(0, 120);
      if (!enercareDeviceId) return json(res, 400, { error: "EnerCare 장치 ID를 선택하거나 입력해 주세요." });
      const timestamp = now();
      if (plug) db.prepare("UPDATE smart_plugs SET enercare_device_id=?, low_group_id=?, sub_group_id=?, display_name=?, connection_status=NULL, power_status=NULL, last_synced_at=NULL, last_error=NULL, updated_at=? WHERE id=?")
        .run(enercareDeviceId, lowGroupId, subGroupId, displayName, timestamp, plug.id);
      else db.prepare("INSERT INTO smart_plugs (id, device_id, enercare_device_id, low_group_id, sub_group_id, display_name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), device.id, enercareDeviceId, lowGroupId, subGroupId, displayName, session.username, timestamp, timestamp);
      const saved = db.prepare("SELECT * FROM smart_plugs WHERE device_id = ?").get(device.id);
      audit(session.username, "smart_plug.save", saved.id, { deviceId: device.id, enercareDeviceId, lowGroupId, subGroupId });
      return json(res, 200, { smartPlug: smartPlugDto(saved) });
    }
    if (req.method === "DELETE" && smartPlugMatch) {
      if (!canManageSmartPlugs(session)) return json(res, 403, { error: "스마트플러그 삭제는 시스템 또는 운영 관리자만 할 수 있습니다." });
      if (!plug) return json(res, 404, { error: "이 장비에 등록된 스마트플러그가 없습니다." });
      db.prepare("DELETE FROM smart_plugs WHERE id = ?").run(plug.id);
      audit(session.username, "smart_plug.delete", plug.id, { deviceId: device.id });
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/releases/upload") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const fileName = path.basename(decodeURIComponent(String(req.headers["x-file-name"] || "")));
    const match = /^(UME-release|Funnet\.Gwanak\.Agent|funnet-agent-setup|funnet-gwanak-agent-setup)-([0-9]+(?:\.[0-9]+){1,3})(?:\+[^\\/]+)?\.exe$/i.exec(fileName);
    if (!match) return json(res, 400, { error: "파일명은 UME-release-{버전}.exe 또는 funnet-agent-setup-{버전}.exe 형식이어야 합니다." });
    const isAgentRelease = isAgentReleaseName(fileName);
    const requestedRegionId = String(req.headers["x-region-id"] || "").trim();
    if (isAgentRelease && !requestedRegionId) return json(res, 400, { error: "Agent 설치 파일은 대상 지역을 선택해야 합니다." });
    const regionId = isAgentRelease ? requestedRegionId : null;
    const region = regionId ? db.prepare("SELECT id, name FROM regions WHERE id = ?").get(regionId) : null;
    if (regionId && !region) return json(res, 400, { error: "대상 지역을 찾을 수 없습니다." });
    if (sameRegionOnly(session) && regionId !== session.regionId) return json(res, 403, { error: "담당 지역 설치 파일만 등록할 수 있습니다." });
    if (db.prepare("SELECT id FROM releases WHERE version = ? AND file_name = ? AND ((region_id = ?) OR (region_id IS NULL AND ? IS NULL))").get(match[2], fileName, regionId, regionId)) {
      return json(res, 409, { error: "해당 지역에 같은 버전의 파일이 이미 등록되어 있습니다." });
    }
    const id = crypto.randomUUID();
    const storedName = `${id}.exe`;
    const destination = path.join(releaseDir, storedName);
    const saved = await saveUpload(req, destination);
    const timestamp = now();
    db.prepare("INSERT INTO releases (id, version, region_id, file_name, file_path, size_bytes, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, match[2], regionId, fileName, destination, saved.size, saved.sha256, session.username, timestamp);
    let removedOlderAgentReleases = 0;
    if (isAgentRelease) {
      const older = db.prepare("SELECT id, file_path, version FROM releases WHERE id <> ? AND region_id = ?").all(id, regionId)
        .filter((item) => compareReleaseVersions(item.version, match[2]) < 0)
        .filter((item) => isAgentReleaseName(String(db.prepare("SELECT file_name FROM releases WHERE id = ?").get(item.id)?.file_name || "")));
      for (const item of older) {
        db.prepare("DELETE FROM commands WHERE type = 'agent.package.download' AND status IN ('pending','delivered') AND payload_json LIKE ?").run(`%${item.id}%`);
        db.prepare("DELETE FROM releases WHERE id = ?").run(item.id);
        try { if (fs.existsSync(item.file_path)) fs.unlinkSync(item.file_path); } catch (error) { console.error(error); }
        removedOlderAgentReleases += 1;
      }
    }
    audit(session.username, "release.upload", id, { version: match[2], fileName, regionId, ...saved, removedOlderAgentReleases });
    return json(res, 201, { release: releaseDto({ id, version: match[2], file_name: fileName, size_bytes: saved.size, sha256: saved.sha256, region_id: regionId, region_name: region?.name, created_by: session.username, created_at: timestamp }), removedOlderAgentReleases });
  }

  const releaseInstallerDownloadMatch = url.pathname.match(/^\/api\/releases\/([a-f0-9-]+)\/download$/i);
  if (req.method === "GET" && releaseInstallerDownloadMatch) {
    const session = requireAdmin(req, res);
    if (!session) return;
    const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseInstallerDownloadMatch[1]);
    if (!release || !fs.existsSync(release.file_path)) return json(res, 404, { error: "배포 파일을 찾을 수 없습니다." });
    if (!["windows_agent", "meetingbar_a10"].includes(releaseProduct(release.file_name))) return json(res, 400, { error: "Agent 또는 MeetingBar A10 설치 파일만 내려받을 수 있습니다." });
    if (sameRegionOnly(session) && release.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 설치 파일만 내려받을 수 있습니다." });
    audit(session.username, "release.download", release.id, { version: release.version, regionId: release.region_id });
    return streamRelease(res, release);
  }

  const releaseDownloadMatch = url.pathname.match(/^\/api\/agent\/releases\/([a-f0-9-]+)\/download$/i);
  if (req.method === "GET" && releaseDownloadMatch) {
    const device = requireDevice(req, res);
    if (!device) return;
    const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseDownloadMatch[1]);
    if (!release || !fs.existsSync(release.file_path)) return json(res, 404, { error: "배포 파일을 찾을 수 없습니다." });
    if (release.region_id && release.region_id !== device.region_id) return json(res, 403, { error: "다른 지역의 Agent 설치 파일은 내려받을 수 없습니다." });
    return streamRelease(res, release);
  }

  const releaseDistributeMatch = url.pathname.match(/^\/api\/releases\/([a-f0-9-]+)\/distribute$/i);
  if (req.method === "POST" && releaseDistributeMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "operator", "system_manager"])) return;
    const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseDistributeMatch[1]);
    if (!release) return json(res, 404, { error: "배포 파일을 찾을 수 없습니다." });
    if (releaseProduct(release.file_name) === "meetingbar_a10") return json(res, 409, { error: "MeetingBar A10 APK는 장비에서 직접 업데이트 설치해 주세요." });
    const body = await readJson(req);
    const requestedIds = Array.isArray(body.deviceIds) ? body.deviceIds.map(String) : [];
    if (sameRegionOnly(session) && release.region_id && release.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 설치 파일만 배포할 수 있습니다." });
    const releaseScope = release.region_id ? " AND region_id = ?" : "";
    const roleScope = sameRegionOnly(session) ? " AND region_id = ?" : "";
    const scopeArgs = [...(release.region_id ? [release.region_id] : []), ...(sameRegionOnly(session) ? [session.regionId] : [])];
    const candidateDevices = requestedIds.length
      ? db.prepare(`SELECT id FROM devices WHERE approved = 1${releaseScope}${roleScope} AND id IN (${requestedIds.map(() => "?").join(",")})`).all(...scopeArgs, ...requestedIds)
      : db.prepare(`SELECT id FROM devices WHERE approved = 1${releaseScope}${roleScope}`).all(...scopeArgs);
    const isAgentRelease = isAgentReleaseName(release.file_name);
    const commandType = isAgentRelease ? "agent.package.download" : "ume.package.download";
    const devices = candidateDevices.filter((device) => deviceHasCapability(device.id, isAgentRelease ? "agentUpdate" : "ume"));
    // 구버전 Agent(1.3.x 포함)는 표준화된 funnet-agent-setup 이름을
    // 허용하지 않고 Funnet.Gwanak.Agent 접두사만 인식한다. 실제 다운로드는
    // releaseId로 처리되므로, 명령에 전달하는 이름만 하위 호환 이름으로
    // 고정해 구버전 장비도 업데이트할 수 있게 한다.
    const distributionFileName = isAgentRelease
      ? `Funnet.Gwanak.Agent-${release.version}.exe`
      : release.file_name;
    const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)");
    const createdAt = now();
    for (const device of devices) insert.run(crypto.randomUUID(), device.id, commandType, JSON.stringify({
      releaseId: release.id, version: release.version, fileName: distributionFileName,
      sizeBytes: release.size_bytes, sha256: release.sha256,
      downloadPath: `/api/agent/releases/${release.id}/download`,
    }), createdAt);
    audit(session.username, "release.distribute", release.id, { version: release.version, regionId: release.region_id, deviceCount: devices.length });
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
    db.prepare("INSERT INTO schedules (id, name, local_time, days_json, region_ids_json, action_type, device_ids_json, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, schedule.name, schedule.localTime, JSON.stringify(schedule.days), JSON.stringify(schedule.regionIds), schedule.actionType, JSON.stringify(schedule.deviceIds), schedule.enabled ? 1 : 0, session.username, timestamp, timestamp);
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
    db.prepare("UPDATE schedules SET name = ?, local_time = ?, days_json = ?, region_ids_json = ?, action_type = ?, device_ids_json = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(schedule.name, schedule.localTime, JSON.stringify(schedule.days), JSON.stringify(schedule.regionIds), schedule.actionType, JSON.stringify(schedule.deviceIds), schedule.enabled ? 1 : 0, now(), current.id);
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
    const result = await executeScheduleAction(schedule, `manual:${crypto.randomUUID()}`, {
      regionIdsOverride: sameRegionOnly(session) ? [session.regionId] : null,
    });
    audit(session.username, "schedule.run", schedule.id, { actionType: scheduleAction(schedule.action_type).type, ...result });
    return json(res, 202, result);
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
    if (!deviceHasCapability(device.id, "windowsShutdown")) return json(res, 409, { error: "이 장비는 Windows 종료를 지원하지 않습니다." });
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
    let deviceHealth;
    try { deviceHealth = JSON.parse(healthRow?.last_health_json || "{}"); if (!deviceHealth.display?.enabled) return json(res, 409, { error: "이 장비는 TV 제어가 비활성화되어 있습니다." }); } catch { return json(res, 409, { error: "장비의 TV 제어 설정을 확인할 수 없습니다." }); }
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
      if (!knownDisplayInputs.has(input)) return json(res, 400, { error: "input은 HDMI1, HDMI2 또는 HDMI3여야 합니다." });
      if (!deviceSupportsDisplayInput(deviceHealth, input)) return json(res, 409, { error: `${input}은 이 장비 모델에서 사용할 수 없습니다.` });
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

  const remoteCommandMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/remote\/(screen|key|click)$/i);
  if (req.method === "POST" && remoteCommandMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!assertRole(session, res, ["admin", "system_manager"])) return;
    const device = db.prepare("SELECT id, region_id, approved FROM devices WHERE id = ?").get(remoteCommandMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 원격 제어할 수 있습니다." });
    if (!device.approved) return json(res, 400, { error: "승인된 장비만 원격 제어할 수 있습니다." });
    const kind = remoteCommandMatch[2].toLowerCase();
    let type = "remote.screen.capture"; let payload = {};
    if (kind === "key") {
      const body = await readJson(req); const key = String(body.key || "").toUpperCase();
      if (!["LEFT", "RIGHT", "UP", "DOWN", "ENTER", "ESC", "TAB", "SPACE"].includes(key)) return json(res, 400, { error: "허용되지 않은 키입니다." });
      type = "remote.input.key"; payload = { key };
    } else if (kind === "click") {
      const body = await readJson(req); const x = Number(body.x); const y = Number(body.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 10000 || y > 10000) return json(res, 400, { error: "화면 좌표가 올바르지 않습니다." });
      type = "remote.input.click"; payload = { x, y };
    }
    const commandId = crypto.randomUUID();
    db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(commandId, device.id, type, JSON.stringify(payload), now());
    audit(session.username, type, device.id, { commandId, payload });
    return json(res, 202, { commandId, status: "pending", warning: "UAC 보안 데스크톱은 원격 입력 대상이 아닙니다." });
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

  if (req.method === "POST" && url.pathname === "/api/smart-plugs/bulk/power") {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canManageSmartPlugs(session)) return json(res, 403, { error: "스마트플러그 제어는 시스템 또는 운영 관리자만 할 수 있습니다." });
    const body = await readJson(req);
    if (typeof body.on !== "boolean") return json(res, 400, { error: "on 값은 true 또는 false여야 합니다." });
    const requestedRegionId = String(body.regionId || "all").trim() || "all";
    if (requestedRegionId !== "all" && !db.prepare("SELECT id FROM regions WHERE id = ?").get(requestedRegionId)) return json(res, 400, { error: "선택한 지역을 찾을 수 없습니다." });
    const hasDeviceIds = Array.isArray(body.deviceIds);
    const ids = hasDeviceIds ? body.deviceIds.filter((id) => /^[a-f0-9-]{20,80}$/i.test(String(id))) : [];
    const filters = ["devices.approved = 1", "smart_plugs.connection_status = 'online'"];
    const args = [];
    if (requestedRegionId !== "all") { filters.push("devices.region_id = ?"); args.push(requestedRegionId); }
    if (hasDeviceIds) {
      if (!ids.length) return json(res, 200, { targeted: 0, succeeded: 0, failed: 0, failures: [] });
      filters.push(`devices.id IN (${ids.map(() => "?").join(",")})`); args.push(...ids);
    }
    const plugs = db.prepare(`SELECT smart_plugs.*, devices.region_id FROM smart_plugs JOIN devices ON devices.id = smart_plugs.device_id WHERE ${filters.join(" AND ")}`).all(...args);
    const control = body.on ? "ON" : "OFF";
    const result = await controlSmartPlugs(plugs, control);
    audit(session.username, "smart_plug.bulk.power", "ALL", {
      control,
      regionId: requestedRegionId,
      targeted: plugs.length,
      succeeded: result.succeeded.length,
      failed: result.failed.length,
    });
    return json(res, 200, {
      targeted: plugs.length,
      succeeded: result.succeeded.length,
      failed: result.failed.length,
      failures: result.failed.map((item) => ({ deviceId: item.deviceId, error: item.error })),
    });
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
    const supportedRows = type === "health.probe" ? rows : rows.filter((row) => deviceHasCapability(row.id, "ume"));
    const commandIds = supportedRows.map((row) => { const id = crypto.randomUUID(); insert.run(id, row.id, type, now()); if (type === "health.probe") { try { if (JSON.parse(db.prepare("SELECT last_health_json FROM devices WHERE id=?").get(row.id)?.last_health_json || "{}").display?.enabled) insert.run(crypto.randomUUID(), row.id, "display.status", "{}", now()); } catch {} } return id; });
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
    if (kind === "input" && !knownDisplayInputs.has(payload.input)) return json(res, 400, { error: "input은 HDMI1, HDMI2 또는 HDMI3여야 합니다." });
    const ids = Array.isArray(body.deviceIds) ? body.deviceIds.filter((id) => /^[a-f0-9-]{20,80}$/i.test(String(id))) : [];
    const scope = sameRegionOnly(session) ? " AND region_id = ?" : "";
    const args = sameRegionOnly(session) ? [session.regionId] : [];
    const rows = ids.length ? db.prepare(`SELECT id FROM devices WHERE approved = 1 AND julianday(last_seen_at) >= julianday('now', '-120 seconds')${scope} AND id IN (${ids.map(() => "?").join(",")})`).all(...args, ...ids) : db.prepare(`SELECT id FROM devices WHERE approved = 1 AND julianday(last_seen_at) >= julianday('now', '-120 seconds')${scope}`).all(...args);
    const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)");
    const enabledRows = rows.filter((row) => { try { const health = JSON.parse(db.prepare("SELECT last_health_json FROM devices WHERE id = ?").get(row.id)?.last_health_json || "{}"); return Boolean(health.display?.enabled) && (kind !== "input" || deviceSupportsDisplayInput(health, payload.input)); } catch { return false; } });
    const commandIds = enabledRows.map((row) => { clearPendingDisplayCommands(row.id); const id = crypto.randomUUID(); insert.run(id, row.id, `display.${kind}`, JSON.stringify(payload), now()); return { deviceId: row.id, commandId: id }; });
    audit(session.username, `display.bulk.${kind}`, "ALL", { payload, queued: commandIds.length });
    return json(res, 202, { queued: commandIds.length, skippedUnsupported: kind === "input" ? rows.length - enabledRows.length : 0, commands: commandIds, status: "pending" });
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
    const commandIds = rows.filter((row) => deviceHasCapability(row.id, "ivision")).map((row) => { const id = crypto.randomUUID(); insert.run(id, row.id, type, now()); return { deviceId: row.id, commandId: id }; });
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
    const commandIds = rows.filter((row) => deviceHasCapability(row.id, "windowsShutdown")).map((row) => { const id = crypto.randomUUID(); insert.run(id, row.id, now()); return { deviceId: row.id, commandId: id }; });
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

  const adminPageProbeMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/admin-page\/probe$/i);
  if (req.method === "POST" && adminPageProbeMatch) {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    if (!canOperate(session)) return json(res, 403, { error: "이 작업을 수행할 권한이 없습니다." });
    const device = db.prepare("SELECT id, region_id, approved FROM devices WHERE id = ?").get(adminPageProbeMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 확인할 수 있습니다." });
    if (!device.approved) return json(res, 400, { error: "승인된 장비만 확인할 수 있습니다." });
    if (!deviceHasCapability(device.id, "a10AdminRelayProbe")) return json(res, 409, { error: "A10 관리페이지 점검을 지원하는 앱 1.0.1 이상이 필요합니다." });
    db.prepare("DELETE FROM commands WHERE device_id = ? AND type = 'a10.admin.probe' AND status IN ('pending','delivered')").run(device.id);
    const commandId = crypto.randomUUID();
    db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, 'a10.admin.probe', '{}', ?)")
      .run(commandId, device.id, now());
    audit(session.username, "a10.admin.probe", device.id, { commandId });
    return json(res, 202, { commandId, status: "pending" });
  }

  const adminPageProbeResultMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/admin-page\/probe\/([a-f0-9-]+)$/i);
  if (req.method === "GET" && adminPageProbeResultMatch) {
    const session = requireAdmin(req, res);
    if (!session) return;
    const device = db.prepare("SELECT id, region_id FROM devices WHERE id = ?").get(adminPageProbeResultMatch[1]);
    if (!device) return json(res, 404, { error: "장비를 찾을 수 없습니다." });
    if (sameRegionOnly(session) && device.region_id !== session.regionId) return json(res, 403, { error: "담당 지역 장비만 확인할 수 있습니다." });
    const command = db.prepare("SELECT status, result_json, created_at, completed_at FROM commands WHERE id = ? AND device_id = ? AND type = 'a10.admin.probe'")
      .get(adminPageProbeResultMatch[2], device.id);
    if (!command) return json(res, 404, { error: "관리페이지 점검 요청을 찾을 수 없습니다." });
    return json(res, 200, {
      status: command.status,
      result: safeJson(command.result_json),
      createdAt: command.created_at,
      completedAt: command.completed_at,
    });
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
    if (!deviceHasCapability(device.id, "ume")) return json(res, 409, { error: "이 장비는 UME 제어를 지원하지 않습니다." });
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
    if (!deviceHasCapability(device.id, "ume")) return json(res, 409, { error: "이 장비는 UME 제어를 지원하지 않습니다." });
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
    if (!deviceHasCapability(device.id, "ivision")) return json(res, 409, { error: "이 장비는 i-vision 제어를 지원하지 않습니다." });
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
    if (url.pathname.startsWith("/conn/")) return await handleEnercareCallback(req, res, url);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, error.status || 500, { error: error.status ? error.message : "서버 오류가 발생했습니다." });
  }
});

const scheduleActions = Object.freeze({
  "ivision.stop": { type: "ivision.stop", label: "I-Vision 종료" },
  "ivision.restart": { type: "ivision.restart", label: "I-Vision 실행" },
  "ume.activate": { type: "ume.activate", label: "화상회의 (UME) 실행" },
  "smart_plug.on": { type: "smart_plug.on", label: "스마트플러그 ON", smartPlugControl: "ON" },
  "smart_plug.off": { type: "smart_plug.off", label: "스마트플러그 OFF", smartPlugControl: "OFF" },
  "windows.shutdown": { type: "windows.shutdown", label: "Windows 종료" },
});

function scheduleAction(value) {
  return scheduleActions[value] || scheduleActions["ume.activate"];
}

function jsonIdList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).filter(Boolean))];
  try { return jsonIdList(JSON.parse(value || "[]")); } catch { return []; }
}

function validateSchedule(value) {
  const name = String(value.name || "").trim().slice(0, 100);
  const localTime = String(value.localTime || "");
  const days = [...new Set((Array.isArray(value.days) ? value.days : []).map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
  if (!name) throw Object.assign(new Error("스케줄명을 입력해 주세요."), { status: 400 });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw Object.assign(new Error("실행 시간을 확인해 주세요."), { status: 400 });
  if (!days.length) throw Object.assign(new Error("실행 요일을 하나 이상 선택해 주세요."), { status: 400 });
  const regionIds = [...new Set((Array.isArray(value.regionIds) ? value.regionIds : []).map(String).filter(Boolean))];
  const validRegions = db.prepare(`SELECT id FROM regions WHERE id IN (${regionIds.length ? regionIds.map(() => "?").join(",") : "NULL"})`).all(...regionIds).map((row) => row.id);
  const action = scheduleAction(value.actionType);
  if (value.actionType && action.type !== value.actionType) throw Object.assign(new Error("실행 기능을 확인해 주세요."), { status: 400 });
  const requestedDeviceIds = jsonIdList(value.deviceIds).filter((id) => /^[a-f0-9-]{20,80}$/i.test(id));
  const deviceIds = requestedDeviceIds.length
    ? db.prepare(`SELECT id FROM devices WHERE approved = 1${validRegions.length ? ` AND region_id IN (${validRegions.map(() => "?").join(",")})` : ""} AND id IN (${requestedDeviceIds.map(() => "?").join(",")})`).all(...validRegions, ...requestedDeviceIds).map((row) => row.id)
    : [];
  return { name, localTime, days, regionIds: validRegions, actionType: action.type, deviceIds, enabled: value.enabled !== false };
}

function listSchedules() {
  return db.prepare("SELECT * FROM schedules ORDER BY local_time, name COLLATE NOCASE").all().map((item) => ({
    id: item.id, name: item.name, localTime: item.local_time, days: JSON.parse(item.days_json), regionIds: jsonIdList(item.region_ids_json),
    regionNames: jsonIdList(item.region_ids_json).map((id) => db.prepare("SELECT name FROM regions WHERE id = ?").get(id)?.name).filter(Boolean),
    actionType: scheduleAction(item.action_type).type, actionLabel: scheduleAction(item.action_type).label,
    deviceIds: jsonIdList(item.device_ids_json),
    deviceNames: jsonIdList(item.device_ids_json).map((id) => db.prepare("SELECT display_name FROM devices WHERE approved = 1 AND id = ?").get(id)?.display_name).filter(Boolean),
    enabled: Boolean(item.enabled), createdBy: item.created_by, createdAt: item.created_at, updatedAt: item.updated_at,
  }));
}

function scheduleTargetDevices(schedule, regionIdsOverride = null) {
  const regionIds = regionIdsOverride || jsonIdList(schedule.regionIds ?? schedule.region_ids_json);
  const deviceIds = jsonIdList(schedule.deviceIds ?? schedule.device_ids_json);
  const filters = ["approved = 1"];
  const args = [];
  if (regionIds.length) { filters.push(`region_id IN (${regionIds.map(() => "?").join(",")})`); args.push(...regionIds); }
  if (deviceIds.length) { filters.push(`id IN (${deviceIds.map(() => "?").join(",")})`); args.push(...deviceIds); }
  return db.prepare(`SELECT id FROM devices WHERE ${filters.join(" AND ")}`).all(...args);
}

function queueScheduleAgentCommand(actionType, scheduleId, runKey, devices) {
  const insert = db.prepare("INSERT INTO commands (id, device_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)");
  const timestamp = now();
  for (const device of devices) insert.run(crypto.randomUUID(), device.id, actionType, JSON.stringify({ scheduleId, runKey }), timestamp);
  return { queued: devices.length, targeted: devices.length, succeeded: 0, failed: 0 };
}

async function executeScheduleAction(schedule, runKey, { regionIdsOverride = null } = {}) {
  const action = scheduleAction(schedule.actionType ?? schedule.action_type);
  const devices = scheduleTargetDevices(schedule, regionIdsOverride);
  if (!action.smartPlugControl) return queueScheduleAgentCommand(action.type, schedule.id, runKey, devices);
  if (!devices.length) return { queued: 0, targeted: 0, succeeded: 0, failed: 0 };
  const rows = db.prepare(`SELECT smart_plugs.*, devices.id AS device_id FROM smart_plugs JOIN devices ON devices.id = smart_plugs.device_id WHERE smart_plugs.connection_status = 'online' AND devices.id IN (${devices.map(() => "?").join(",")})`).all(...devices.map((device) => device.id));
  const result = await controlSmartPlugs(rows, action.smartPlugControl);
  return { queued: 0, targeted: rows.length, succeeded: result.succeeded.length, failed: result.failed.length };
}

function koreaClock() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday };
}

let runningDueSchedules = false;
async function runDueSchedules() {
  if (runningDueSchedules) return;
  runningDueSchedules = true;
  const clock = koreaClock();
  try {
    for (const schedule of listSchedules().filter((item) => item.enabled && item.localTime === clock.time && item.days.includes(clock.weekday))) {
      const runKey = `${clock.date}:${clock.time}`;
      try {
        db.prepare("INSERT INTO schedule_runs (schedule_id, run_key, created_at) VALUES (?, ?, ?)").run(schedule.id, runKey, now());
        const result = await executeScheduleAction(schedule, runKey);
        audit("scheduler", "schedule.run", schedule.id, { actionType: schedule.actionType, ...result });
      } catch (error) {
        if (!String(error.message).includes("UNIQUE constraint failed")) console.error(error);
      }
    }
  } finally {
    runningDueSchedules = false;
  }
}

const scheduler = setInterval(() => { void runDueSchedules(); }, 15_000);
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
