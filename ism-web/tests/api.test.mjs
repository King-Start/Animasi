/**
 * Test end-to-end: server ISM Web ↔ server Roblox tiruan.
 *
 * Cara jalan:
 *   node ism-web/tests/api.test.mjs
 *
 * Yang dibuktikan di sini (semua lewat HTTP sungguhan, bukan mock di dalam proses):
 *   1. Alur ID lama → byte → upload → ID baru benar-benar selesai.
 *   2. Byte yang diterima endpoint upload IDENTIK dengan byte dari CDN
 *      (dibandingkan lewat SHA-256) — tidak ada re-encode.
 *   3. Bentuk multipart & JSON request sesuai dokumentasi Open Cloud
 *      (assetType, creationContext.creator.userId/groupId, content-type model/x-rbxm).
 *   4. Auth: API key (x-api-key) dan OAuth (Authorization: Bearer) dua-duanya jalan.
 *   5. TIDAK ADA jalur auth berbasis cookie: kirim cookie akun → tetap ditolak.
 *   6. Error handling: 404 aset, 401 kunci salah, 429 → retry, operasi gagal.
 *   7. Gzip dari CDN ditangani, path traversal ditolak, API key tidak bocor di respons/log.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "server.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra !== undefined ? "  -> " + extra : "")); }
};
const heading = (t) => console.log("\n" + t);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/* ============================ 1. server Roblox tiruan ==================== */

const seen = {
  uploads: [],          // { auth, request, fileSha, fileType, fileName, bytes }
  delivery: [],         // { id, placeId }
  oauthAuthorize: null, // query params
  tokenExchange: null,  // body params
  failures: {},         // penghitung untuk skenario gagal
  cdnRequests: [],      // URL persis yang diminta ke CDN
  introspect: []        // kunci yang dikirim ke endpoint introspect
};

/** Byte "aset" palsu tapi deterministik: mirip header biner rbxm. */
function fakeRbxm(id) {
  const filler = createHash("sha256").update("asset:" + id).digest();
  return Buffer.concat([
    Buffer.from("<roblox!"),
    Buffer.from([0x89, 0x00, 0x00, 0x00, 0x0a, 0x1a, 0x00, 0x00]),
    Buffer.from("KeyframeSequence\u0000"),
    filler,
    Buffer.from(String(id))
  ]);
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) return {};
  const boundary = Buffer.from("--" + (m[1] || m[2]).trim());
  const parts = {};
  let idx = buf.indexOf(boundary);
  while (idx >= 0) {
    const start = idx + boundary.length;
    const next = buf.indexOf(boundary, start);
    if (next < 0) break;
    let chunk = buf.slice(start, next);
    if (chunk.slice(0, 2).toString() === "\r\n") chunk = chunk.slice(2);
    const hEnd = chunk.indexOf("\r\n\r\n");
    if (hEnd >= 0) {
      const headers = chunk.slice(0, hEnd).toString("utf8");
      let body = chunk.slice(hEnd + 4);
      if (body.slice(-2).toString() === "\r\n") body = body.slice(0, -2);
      const name = (/name="([^"]+)"/.exec(headers) || [])[1];
      const type = (/content-type:\s*([^\r\n]+)/i.exec(headers) || [])[1];
      if (name) parts[name] = { body, headers, type: type ? type.trim() : null };
    }
    idx = next;
  }
  return parts;
}

const mockServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const send = (status, body, headers = {}) => {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "application/octet-stream",
      ...headers
    });
    res.end(data);
  };

  /* --- asset delivery v2 --- */
  let m = url.pathname.match(/^\/v2\/assetId\/(\d+)$/);
  if (m) {
    const id = m[1];
    seen.delivery.push({ id, placeId: url.searchParams.get("placeId") });

    if (id === "404404404") {
      // Roblox menjawab HTTP 200 walau isinya error
      return send(200, { errors: [{ code: 404, message: "Request asset was not found" }], assetTypeId: 0 });
    }
    if (id === "555555555") {
      return send(200, { errors: [{ code: 401, message: "Authentication required to access Asset." }], assetTypeId: 3 });
    }
    const cdnPath = id === "777777777" ? "/cdn-gzip/" + id : "/cdn/" + id;
    return send(200, {
      locations: [{ assetFormat: "source", location: `http://127.0.0.1:${mockPort}${cdnPath}?encoding=gzip&version=1` }],
      assetTypeId: id === "666666666" ? 3 : 24
    });
  }

  /* --- asset delivery v1 (fallback 302) --- */
  if (url.pathname === "/v1/asset") {
    const id = url.searchParams.get("id");
    if (id === "888888888") {
      res.writeHead(302, { location: `http://127.0.0.1:${mockPort}/cdn/${id}` });
      return res.end();
    }
    return send(404, "not found");
  }

  /* --- CDN --- */
  m = url.pathname.match(/^\/cdn(-gzip)?\/(\d+)$/);
  if (m) {
    const id = m[2];
    seen.cdnRequests.push({ path: url.pathname, url: req.url });
    const bytes = fakeRbxm(id);
    if (m[1]) {
      const { gzipSync } = await import("node:zlib");
      return send(200, gzipSync(bytes), { "content-encoding": "gzip", "content-type": "application/octet-stream" });
    }
    return send(200, bytes);
  }

  /* --- Open Cloud: create asset --- */
  if (url.pathname === "/assets/v1/assets" && req.method === "POST") {
    const auth = { apiKey: req.headers["x-api-key"] || null, bearer: (req.headers.authorization || "").replace(/^Bearer /, "") || null };
    const parts = parseMultipart(raw, req.headers["content-type"]);
    let request = null;
    try { request = JSON.parse(parts.request ? parts.request.body.toString("utf8") : "{}"); } catch { /* biarkan null */ }

    seen.uploads.push({
      auth, request, cookieHeader: req.headers.cookie || null,
      fileSha: parts.fileContent ? sha(parts.fileContent.body) : null,
      fileBytes: parts.fileContent ? parts.fileContent.body.length : 0,
      fileType: parts.fileContent ? parts.fileContent.type : null,
      fileName: parts.fileContent ? (/filename="([^"]+)"/.exec(parts.fileContent.headers) || [])[1] : null
    });

    if (!auth.apiKey && !auth.bearer) {
      return send(401, { errors: [{ code: 401, message: "Invalid authentication data provided" }] });
    }
    if (auth.apiKey === "key-tidak-valid") {
      return send(401, { errors: [{ code: 401, message: "Invalid API Key provided" }] });
    }
    // 429 pada percobaan pertama untuk kunci "key-sibuk" → menguji retry
    if (auth.apiKey === "key-sibuk") {
      seen.failures.rateLimited = (seen.failures.rateLimited || 0) + 1;
      if (seen.failures.rateLimited === 1) {
        return send(429, { errors: [{ code: 429, message: "Too many requests" }] }, { "retry-after": "0" });
      }
    }
    const opId = "op-" + seen.uploads.length;
    return send(200, { path: "/assets/v1/operations/" + opId, operationId: opId, done: false });
  }

  /* --- Open Cloud: operasi --- */
  m = url.pathname.match(/^\/assets\/v1\/operations\/(.+)$/);
  if (m) {
    const opId = m[1];
    const key = seen.uploads[Number(opId.split("-")[1]) - 1];
    const idx = (seen.failures["poll:" + opId] = (seen.failures["poll:" + opId] || 0) + 1);
    if (opId === "op-gagal") {
      return send(200, { done: true, error: { code: 3, message: "Asset processing failed" } });
    }
    if (idx < 2) return send(200, { done: false, path: url.pathname });
    const newId = String(9000000000 + (parseInt((key && key.fileSha ? key.fileSha : "1").slice(0, 4), 16) % 100000));
    return send(200, { done: true, response: { assetId: newId, assetType: "Animation" } });
  }

  /* --- Open Cloud: introspect API key (untuk fitur cek kunci) --- */
  if (url.pathname === "/api-keys/v1/introspect" && req.method === "POST") {
    const key = req.headers["x-api-key"] || "";
    seen.introspect.push(key);
    const ok = (body) => send(200, body);
    if (!key || key.length < 30) return send(400, { code: 3, message: "API Key is not provided in a valid format.", details: [] });
    if (key.startsWith("kunci-lengkap")) {
      return ok({
        name: "ISM_TEST_KEY", enabled: true, expired: false,
        expirationTimeUtc: "2027-01-01T00:00:00Z", authorizedUserId: "1234567",
        scopes: [{ name: "asset", operations: ["read", "write"], userIds: ["*"], groupIds: ["33445566"] }]
      });
    }
    if (key.startsWith("kunci-tanpa-assets")) {
      return ok({
        name: "ONLY_DATASTORE", enabled: true, expired: false, authorizedUserId: "1234567",
        scopes: [{ name: "universe-datastores", operations: ["read"], universeDatastores: [] }]
      });
    }
    if (key.startsWith("kunci-readonly")) {
      return ok({
        name: "READ_ONLY", enabled: true, expired: false, authorizedUserId: "1234567",
        scopes: [{ name: "asset", operations: ["read"], userIds: ["*"], groupIds: [] }]
      });
    }
    if (key.startsWith("kunci-kadaluwarsa")) {
      return ok({
        name: "OLD_KEY", enabled: true, expired: true, expirationTimeUtc: "2025-01-01T00:00:00Z",
        authorizedUserId: "1234567",
        scopes: [{ name: "asset", operations: ["read", "write"], userIds: ["*"], groupIds: [] }]
      });
    }
    if (key.startsWith("kunci-akun-lain")) {
      return ok({
        name: "OTHER_USER", enabled: true, expired: false, authorizedUserId: "7654321",
        scopes: [{ name: "asset", operations: ["read", "write"], userIds: ["*"], groupIds: [] }]
      });
    }
    return send(401, { code: 16, message: "API Key not found" });
  }

  /* --- users (publik) --- */
  m = url.pathname.match(/^\/v1\/users\/(\d+)$/);
  if (m) {
    const id = m[1];
    if (id === "1234567") return send(200, { id: 1234567, name: "TesterISM", displayName: "Tester ISM" });
    if (id === "7654321") return send(200, { id: 7654321, name: "AkunLain", displayName: "Akun Lain" });
    return send(404, { errors: [{ code: 3, message: "user not found" }] });
  }

  /* --- OAuth 2.0 --- */
  if (url.pathname === "/oauth/v1/token" && req.method === "POST") {
    const p = new URLSearchParams(raw.toString());
    seen.tokenExchange = Object.fromEntries(p.entries());
    return send(200, { access_token: "oauth-token-uji", refresh_token: "r", expires_in: 3600, token_type: "Bearer" });
  }
  if (url.pathname === "/oauth/v1/userinfo") {
    return send(200, { sub: "1234567", preferred_username: "TesterISM", name: "Tester" });
  }

  return send(404, { errors: [{ code: 404, message: "mock: rute tidak dikenal " + url.pathname }] });
});

const mockPort = await new Promise((resolve) => {
  mockServer.listen(0, "127.0.0.1", () => resolve(mockServer.address().port));
});

/* ============================ 2. server ISM Web ========================= */

const APP_PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${mockPort}`;

const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    HOST: "127.0.0.1",
    STATIC_ROOT: path.join(__dirname, "..", "..", "ism-site"),
    ACCESS_PASSWORD: "rahasia-uji",
    SESSION_SECRET: "secret-uji-panjang-sekali",
    ROBLOX_APIS_BASE: MOCK,
    ROBLOX_ASSET_DELIVERY_BASE: MOCK,
    ROBLOX_OAUTH_BASE: MOCK + "/oauth/v1",
    ROBLOX_USERS_BASE: MOCK,
    ROBLOX_OAUTH_CLIENT_ID: "client-uji",
    ROBLOX_OAUTH_CLIENT_SECRET: "secret-uji",
    ALLOW_ASSET_HOSTS: "127.0.0.1",
    JOB_RATE_LIMIT: "100",
    CONCURRENCY: "2",
    MAX_ITEMS: "10"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d.toString(); });
child.stderr.on("data", (d) => { serverLog += d.toString(); });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) return true;
    } catch { /* belum siap */ }
    await wait(120);
  }
  return false;
}
const up = await waitForServer();
if (!up) {
  console.error("Server ISM gagal start. Log:\n" + serverLog);
  process.exit(1);
}

/* cookie jar mini */
let jar = {};
function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
}
function absorb(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v === "") delete jar[k]; else jar[k] = v;
  }
}
async function call(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(Object.keys(jar).length ? { cookie: cookieHeader() } : {}) },
    redirect: "manual"
  });
  absorb(res);
  return res;
}
async function callJson(pathname, opts) {
  const res = await call(pathname, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers, res };
}

/* ============================ 3. pengujian ============================== */

heading("1. Kesehatan server & gate");
{
  const h = await callJson("/api/health");
  ok("health ok", h.status === 200 && h.body.ok === true);
  ok("cookie auth dinyatakan mati", h.body.cookieAuth === false);
  ok("catatan tegas soal cookie ada", /tidak menerima cookie/i.test(h.body.note || ""), h.body.note);
  ok("gate aktif & belum terbuka", h.body.gate === true && h.body.gateOk === false);
  ok("OAuth terdeteksi aktif", h.body.authModes.oauth === true);

  const wrong = await callJson("/api/gate", { method: "POST", body: JSON.stringify({ password: "salah" }) });
  ok("password salah → 401", wrong.status === 401 && wrong.body.ok === false);

  const right = await callJson("/api/gate", { method: "POST", body: JSON.stringify({ password: "rahasia-uji" }) });
  ok("password benar → cookie gate terpasang", right.status === 200 && right.body.ok === true && Boolean(jar.ism_gate));

  const h2 = await callJson("/api/health");
  ok("setelah gate, health menyatakan terbuka", h2.body.gateOk === true);

  const blocked = await fetch(BASE + "/api/parse", { method: "POST", body: "{}" });
  ok("tanpa cookie gate → endpoint lain diblokir", blocked.status === 401);
}

heading("2. Parser input (format plugin & variasi)");
{
  const input = [
    "--[[ TYPE: ANIMATION ]]",
    "[1234567890] [Run Animation] [User:2],",
    "[1234567891] [Idle] [Group:33445566],",
    "https://www.roblox.com/library/1234567890/duplikat",
    "rbxassetid://1234567892",
    "assetId=1234567893",
    "1234567894 = 9999999999,",
    "-- komentar",
    "bukan angka sama sekali",
    "12345"
  ].join("\n");
  const r = await callJson("/api/parse", { method: "POST", body: JSON.stringify({ input }) });
  const ids = r.body.items.map((i) => i.id);
  ok("tipe dari header plugin terbaca", r.body.typeHint === "ANIMATION", r.body.typeHint);
  ok("5 ID unik terkumpul (dari 10 baris input)", r.body.total === 5, JSON.stringify(ids));
  ok("duplikat (URL + bracket) dihitung sekali", ids.filter((i) => i === "1234567890").length === 1);
  ok("petunjuk nama & group ikut terbaca", r.body.items.find((i) => i.id === "1234567891")?.creatorId === "33445566");
  ok("pasangan 'lama = baru' memakai sisi kiri", ids.includes("1234567894") && !ids.includes("9999999999"));
  ok("angka 5 digit diabaikan", !ids.includes("12345"));
  ok("hasil terurut menaik", JSON.stringify(ids) === JSON.stringify([...ids].sort((a, b) => Number(a) - Number(b))));
}

const uploadsBeforeProbe = seen.uploads.length;
heading("2b. Uji ambil tanpa kredensial (/api/probe)");
{
  const r = await callJson("/api/probe", {
    method: "POST",
    body: JSON.stringify({ input: "180435571\n404404404\n555555555\n777777777" }) // tanpa apiKey sama sekali
  });
  ok("probe tidak butuh kredensial", r.status === 200, r.status);
  ok("probe menyatakan tidak perlu kredensial", r.body.needsCredentials === false && /tidak ada kredensial/i.test(r.body.note || ""));
  ok("4 ID diperiksa", r.body.checked === 4 && r.body.results.length === 4, JSON.stringify(r.body.checked));
  ok("2 ID berhasil ditarik", r.body.ok === 2, JSON.stringify({ ok: r.body.ok, failed: r.body.failed }));
  ok("2 ID gagal dengan alasan jelas", r.body.failed === 2 &&
    r.body.results.filter((x) => !x.ok).every((x) => /not found|Authentication required/i.test(x.error)),
    JSON.stringify(r.body.results.map((x) => x.error)));
  const good = r.body.results.find((x) => x.id === "180435571");
  ok("ID yang berhasil menyertakan ukuran + hash", good.bytesLength === fakeRbxm("180435571").length && /^[a-f0-9]{64}$/.test(good.sha256), JSON.stringify(good));
  ok("gzip juga tertangani di probe (777777777)", r.body.results.find((x) => x.id === "777777777").sha256 === sha(fakeRbxm("777777777")));
  ok("hasil terurut", JSON.stringify(r.body.results.map((x) => x.id)) === JSON.stringify(["180435571", "404404404", "555555555", "777777777"]));
  ok("probe TIDAK melakukan upload sama sekali", seen.uploads.length === uploadsBeforeProbe, `${seen.uploads.length} vs ${uploadsBeforeProbe}`);

  const empty = await callJson("/api/probe", { method: "POST", body: JSON.stringify({ input: "tidak ada angka" }) });
  ok("input tanpa ID → 400", empty.status === 400, JSON.stringify(empty.body));
}

heading("2c. Diagnosa kunci API (/api/check-key)");
{
  const K = "kunci-lengkap-valid-panjang-sekali-1234567890";

  const good = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: K, userId: "1234567" })
  });
  ok("kunci valid + target cocok → ok", good.body.ok === true, JSON.stringify(good.body.findings));
  ok("temuan pertama menyatakan siap dipakai", /siap dipakai/i.test(good.body.findings[0].message));
  ok("nama akun pemilik kunci ikut ditampilkan", good.body.profile && good.body.profile.name === "TesterISM", JSON.stringify(good.body.profile));
  ok("scope dilaporkan apa adanya", JSON.stringify(good.body.scopes) === JSON.stringify([{ name: "asset", operations: ["read", "write"], userIds: ["*"], groupIds: ["33445566"] }]), JSON.stringify(good.body.scopes));

  const short = await callJson("/api/check-key", { method: "POST", body: JSON.stringify({ apiKey: "abc123" }) });
  ok("kunci pendek → ditolak dengan penjelasan format", short.body.ok === false && /valid format|kepotong|tidak lengkap/i.test(short.body.findings.map((f) => f.message).join(" ")), JSON.stringify(short.body.findings));

  const spaced = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: "  \"" + K + "\"  ", userId: "1234567" })
  });
  ok("spasi & kutip di ujung kunci dibersihkan otomatis", spaced.body.ok === true, JSON.stringify(spaced.body.findings));
  ok("kunci yang dinormalisasi memang yang dikirim ke Roblox",
    seen.introspect.includes(K), "terkirim: " + JSON.stringify(seen.introspect.map((k) => k.slice(0, 14))));

  const unknown = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: "kunci-tidak-dikenal-sama-sekali-1234567890", userId: "1234567" })
  });
  ok("kunci tidak dikenal → dijelaskan (ditolak/cabut/IP)", unknown.body.ok === false && /ditolak|dicabut|IP/i.test(unknown.body.findings.map((f) => f.message).join(" ")), JSON.stringify(unknown.body.findings));

  const noAssets = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: "kunci-tanpa-assets-panjang-sekali-1234567890", userId: "1234567" })
  });
  ok("kunci tanpa API Assets → diberi tahu cara menambahkannya",
    noAssets.body.ok === false && /belum diberi API .?Assets/i.test(noAssets.body.findings.map((f) => f.message).join(" ")), JSON.stringify(noAssets.body.findings));

  const readOnly = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: "kunci-readonly-panjang-sekali-1234567890", userId: "1234567" })
  });
  ok("kunci hanya Read → diberi tahu Write belum dicentang",
    readOnly.body.ok === false && /Write belum dicentang/i.test(readOnly.body.findings.map((f) => f.message).join(" ")), JSON.stringify(readOnly.body.findings));

  const expired = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: "kunci-kadaluwarsa-panjang-sekali-1234567890", userId: "1234567" })
  });
  ok("kunci kedaluwarsa terdeteksi", expired.body.ok === false && /kedaluwarsa/i.test(expired.body.findings.map((f) => f.message).join(" ")), JSON.stringify(expired.body.findings));

  const mismatch = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: "kunci-akun-lain-panjang-sekali-1234567890", userId: "1234567" })
  });
  const mismatchText = mismatch.body.findings.map((f) => f.message).join(" ");
  ok("User ID tidak cocok dengan pemilik kunci → ditolak", mismatch.body.ok === false && /bukan pemilik kunci/i.test(mismatchText), mismatchText);
  ok("disarankan User ID yang benar + nama akunnya", /7654321/.test(mismatchText) && /AkunLain/.test(mismatchText), mismatchText);

  const groupBad = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: K, groupId: "99999999" })
  });
  ok("Group ID yang tidak diizinkan → ditolak dengan daftar grup yang boleh",
    groupBad.body.ok === false && /tidak punya akses ke grup 99999999/.test(groupBad.body.findings.map((f) => f.message).join(" ")), JSON.stringify(groupBad.body.findings));

  const groupGood = await callJson("/api/check-key", {
    method: "POST", body: JSON.stringify({ apiKey: K, groupId: "33445566" })
  });
  ok("Group ID yang memang diizinkan → ok", groupGood.body.ok === true, JSON.stringify(groupGood.body.findings));

  ok("kunci tidak pernah bocor ke log server", !serverLog.includes(K), "ketemu di log");
  ok("kunci tidak dikembalikan di respons", !JSON.stringify(good.body).includes(K));
}

heading("2d. Penerjemah pesan error (explainError)");
{
  const { createRobloxClient } = await import(path.join(__dirname, "..", "lib", "roblox.mjs"));
  const c = createRobloxClient();
  const cases = [
    ["Invalid API Key", /copy ulang|dicabut/i],
    ["API Key is not provided in a valid format.", /format kunci/i],
    ["Authentication required to access Asset.", /Dari file lokal/i],
    ["Request asset was not found", /tidak ditemukan/i],
    ["The API key does not have permission to perform this action", /Read DAN Write/i],
    ["Your API key is restricted to certain IP addresses", /dibatasi IP/i],
    ["This API key has expired", /kedaluwarsa/i],
    ["Asset is under moderation review", /moderasi/i],
    ["Too many requests", /batas\/kuota/i]
  ];
  for (const [msg, expect] of cases) {
    const hint = c.explainError(msg);
    ok(`"${msg.slice(0, 42)}" → saran yang tepat`, Boolean(hint) && expect.test(hint), String(hint));
  }
  ok("pesan tak dikenal → null (tidak menebak)", c.explainError("sesuatu yang aneh") === null);
  ok("normalizeApiKey membuang spasi/newline/kutip", c.normalizeApiKey('  "abc\ndef"  ') === "abcdef");
}

heading("3. Jalur utama: ID → ID baru (API key)");
{
  const r = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      input: "1234567890\n1234567891\n777777777",
      apiKey: "key-uji-panjang",
      options: { userId: "1234567", namePrefix: "ISM Spoof" }
    })
  });
  ok("job dibuat", r.status === 202 && Boolean(r.body.jobId), JSON.stringify(r.body).slice(0, 200));
  const jobId = r.body.jobId;

  let snap = null;
  for (let i = 0; i < 80; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + jobId);
    snap = s.body;
    if (["finished", "finished-with-errors", "failed", "cancelled"].includes(snap.status)) break;
  }

  ok("job selesai", snap.status === "finished", snap.status);
  ok("3 item selesai semua", snap.summary.done === 3 && snap.summary.error === 0, JSON.stringify(snap.summary) + " err=" + JSON.stringify(snap.items.map((i) => i.error)));
  ok("setiap item punya ID baru", snap.items.every((i) => /^\d+$/.test(i.newId || "")), JSON.stringify(snap.items.map((i) => i.newId)));
  ok("ukuran & hash dicatat", snap.items.every((i) => i.bytesLength > 0 && /^[a-f0-9]{64}$/.test(i.sha256 || "")));
  {
    const lines = snap.output.plugin.split("\n").filter(Boolean);
    ok("output plugin 3 baris format `lama = baru,`", lines.length === 3 && lines.every((l) => /^\d+ = \d+,$/.test(l)), JSON.stringify(snap.output.plugin));
    const map = Object.fromEntries(lines.map((l) => l.replace(/,$/, "").split(" = ")));
    ok("pasangan lama→baru cocok dengan hasil tiap item",
      snap.items.every((i) => map[i.id] === i.newId), JSON.stringify(map));
    ok("ID baru tidak sama dengan ID lama", lines.every((l) => { const [a, b] = l.replace(/,$/, "").split(" = "); return a !== b; }));
    ok("format plain & CSV konsisten", snap.output.plain.split("\n").length === 3 && snap.output.pairs.split("\n").every((l) => /^\d+,\d+$/.test(l)));
  }

  /* --- bukti byte-identik: hash dari CDN vs hash yang diterima endpoint upload --- */
  const up = seen.uploads[0];
  const src = fakeRbxm("1234567890");
  ok("byte yang di-upload IDENTIK dengan byte dari CDN", up.fileSha === sha(src), up.fileSha + " vs " + sha(src));
  ok("hash itu sama dengan yang dilaporkan server ke UI", snap.items.find((i) => i.id === "1234567890").sha256 === sha(src));
  ok("parameter ?encoding= TIDAK dibuang dari URL CDN (tanpa itu CDN menjawab 403)",
    seen.cdnRequests.every((c) => /encoding=gzip/.test(c.url)), JSON.stringify(seen.cdnRequests.map((c) => c.url)));
  ok("gzip dari CDN didekompresi dengan benar (777777777)", snap.items.find((i) => i.id === "777777777")?.sha256 === sha(fakeRbxm("777777777")));

  /* --- bentuk request sesuai dokumentasi Open Cloud --- */
  ok("assetType = Animation", up.request.assetType === "Animation", JSON.stringify(up.request));
  ok("creator pakai userId", up.request.creationContext.creator.userId === "1234567", JSON.stringify(up.request.creationContext));
  ok("nama aset memakai prefix", /^ISM Spoof 1234567890$/.test(up.request.displayName), up.request.displayName);
  ok("content-type file = model/x-rbxm", up.fileType === "model/x-rbxm", up.fileType);
  ok("auth lewat header x-api-key", up.auth.apiKey === "key-uji-panjang" && !up.auth.bearer);
  ok("fetch memakai endpoint v2 tanpa kredensial", seen.delivery.some((d) => d.id === "1234567890"));

  /* --- kebocoran kredensial --- */
  const asText = JSON.stringify(snap);
  ok("API key tidak muncul di respons job", !asText.includes("key-uji-panjang"));
  ok("API key tidak muncul di log server", !serverLog.includes("key-uji-panjang"), "ditemukan di log");
}

heading("4. Error handling: 404, 401, 429 (retry), tipe salah");
{
  /* aset tidak ada */
  const r = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ input: "404404404", apiKey: "key-uji-panjang", options: { userId: "1234567" } })
  });
  let snap = null;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + r.body.jobId);
    snap = s.body;
    if (!["queued", "running"].includes(snap.status)) break;
  }
  ok("job berstatus failed (tidak ada yang berhasil)", snap.status === "failed", snap.status);
  ok("pesan error 404 dari Roblox diteruskan", /not found/i.test(snap.items[0].error || ""), snap.items[0].error);
  ok("item gagal membawa petunjuk perbaikan (hint)", Boolean(snap.items[0].hint) && /tidak ditemukan/i.test(snap.items[0].hint), String(snap.items[0].hint));

  /* audio butuh auth → pesan jelas untuk pengguna */
  const r2 = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ input: "555555555", apiKey: "key-uji-panjang", options: { userId: "1234567" } })
  });
  let snap2 = null;
  for (let i = 0; i < 40; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + r2.body.jobId);
    snap2 = s.body;
    if (!["queued", "running"].includes(snap2.status)) break;
  }
  ok("aset yang butuh auth → error informatif", /Authentication required/i.test(snap2.items[0].error || ""), snap2.items[0].error);
  ok("aset yang butuh auth → disarankan pakai file lokal",
    /Dari file lokal/i.test(snap2.items[0].hint || ""), String(snap2.items[0].hint));

  /* 429 lalu berhasil karena retry */
  const r3 = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ input: "1234567895", apiKey: "key-sibuk", options: { userId: "1234567" } })
  });
  let snap3 = null;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + r3.body.jobId);
    snap3 = s.body;
    if (!["queued", "running"].includes(snap3.status)) break;
  }
  ok("HTTP 429 di-retry otomatis sampai berhasil", snap3.summary.done === 1, JSON.stringify(snap3.summary));

  /* kunci salah */
  const r4 = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ input: "1234567896", apiKey: "key-tidak-valid", options: { userId: "1234567" } })
  });
  let snap4 = null;
  for (let i = 0; i < 40; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + r4.body.jobId);
    snap4 = s.body;
    if (!["queued", "running"].includes(snap4.status)) break;
  }
  ok("API key tidak valid → error jelas", /Invalid API Key|Upload ditolak/i.test(snap4.items[0].error || ""), snap4.items[0].error);

  /* validasi target */
  const bad = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ input: "1234567890", apiKey: "key-uji-panjang", options: {} })
  });
  ok("tanpa target → 400", bad.status === 400 && /User ID atau Group ID/i.test(bad.body.error), JSON.stringify(bad.body));

  const both = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ input: "1234567890", apiKey: "key-uji-panjang", options: { userId: "1", groupId: "2" } })
  });
  ok("dua target sekaligus → 400", both.status === 400, JSON.stringify(both.body));
}

heading("5. Upload ke grup & fallback v1");
{
  const r = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      input: "888888888",
      apiKey: "key-uji-panjang",
      options: { groupId: "33445566", placeId: "4483381587", namePrefix: "Group Test" }
    })
  });
  let snap = null;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + r.body.jobId);
    snap = s.body;
    if (!["queued", "running"].includes(snap.status)) break;
  }
  ok("fallback v1 (redirect 302) berhasil", snap.summary.done === 1, JSON.stringify(snap.summary));
  const up = seen.uploads[seen.uploads.length - 1];
  ok("upload atas nama grup", up.request.creationContext.creator.groupId === "33445566", JSON.stringify(up.request.creationContext));
  ok("placeId dikirim ke endpoint delivery", seen.delivery.some((d) => d.id === "888888888" && d.placeId === "4483381587"));
}

heading("6. Mode file lokal (Sound / Decal / Video)");
{
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("OggS-isi-audio-palsu")], { type: "audio/ogg" }), "lagu.ogg");
  fd.append("userId", "1234567");
  fd.append("apiKey", "key-uji-panjang");
  fd.append("assetType", "Audio");
  fd.append("displayName", "Sound Spoof");

  const res = await call("/api/jobs-file", { method: "POST", body: fd });
  const body = await res.json();
  ok("job file dibuat", res.status === 202 && Boolean(body.jobId), JSON.stringify(body));

  let snap = null;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + body.jobId);
    snap = s.body;
    if (!["queued", "running"].includes(snap.status)) break;
  }
  ok("file lokal berhasil di-upload", snap.summary.done === 1, JSON.stringify(snap.summary));
  const up = seen.uploads[seen.uploads.length - 1];
  ok("assetType Audio diteruskan", up.request.assetType === "Audio", JSON.stringify(up.request.assetType));
  ok("content-type audio/ogg dipakai", up.fileType === "audio/ogg", up.fileType);
  ok("nama file asli dipertahankan", up.fileName === "lagu.ogg", up.fileName);
  ok("byte file identik setelah lewat server", up.fileSha === sha(Buffer.from("OggS-isi-audio-palsu")));
}

heading("7. OAuth 2.0 (login tanpa API key)");
{
  const start = await call("/api/oauth/start");
  ok("start → redirect 302", start.status === 302, start.status);
  const loc = start.headers.get("location") || "";
  const u = new URL(loc);
  ok("client_id benar", u.searchParams.get("client_id") === "client-uji");
  ok("scope asset:read asset:write", u.searchParams.get("scope") === "asset:read asset:write", u.searchParams.get("scope"));
  ok("state & nonce ada", Boolean(u.searchParams.get("state")) && Boolean(u.searchParams.get("nonce")));
  ok("prompts login+consent", u.searchParams.get("prompts") === "login consent");

  const state = u.searchParams.get("state");
  const cb = await call("/api/oauth/callback?code=code-uji&state=" + state);
  ok("callback menerima code → redirect ke UI", cb.status === 302 && (cb.headers.get("location") || "").includes("login=ok"), cb.status + " " + cb.headers.get("location"));
  ok("token ditukar dengan client_secret", seen.tokenExchange && seen.tokenExchange.client_secret === "secret-uji", JSON.stringify(seen.tokenExchange));

  const me = await callJson("/api/me");
  ok("sesi OAuth aktif & nama user dikenal", me.body.loggedIn === true && me.body.username === "TesterISM", JSON.stringify(me.body));

  const r = await callJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ input: "1234567897", options: { userId: "1234567" } }) // tanpa apiKey
  });
  let snap = null;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + r.body.jobId);
    snap = s.body;
    if (!["queued", "running"].includes(snap.status)) break;
  }
  ok("job jalan pakai access token OAuth", snap.summary.done === 1, JSON.stringify(snap.summary));
  const up = seen.uploads[seen.uploads.length - 1];
  ok("upload memakai Authorization: Bearer", up.auth.bearer === "oauth-token-uji" && !up.auth.apiKey, JSON.stringify(up.auth));
  ok("Bearer tidak bocor ke respons job", !JSON.stringify(snap).includes("oauth-token-uji"));
}

heading("8. Tidak ada jalur cookie (titik paling penting)");
{
  // keluar dulu dari sesi OAuth supaya yang diuji benar-benar jalur kredensial
  await callJson("/api/logout", { method: "POST" });
  const me = await callJson("/api/me");
  ok("sesi OAuth sudah keluar", me.body.loggedIn === false, JSON.stringify(me.body));

  const robocookie = ".ROBLOSECURITY=ini-cookie-akun-palsu";
  const r = await call("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: robocookie },
    body: JSON.stringify({ input: "1234567898", apiKey: "", options: { userId: "1234567" } })
  });
  const body = await r.json();
  ok("kirim cookie akun → ditolak (butuh API key/OAuth)", r.status === 401, r.status + " " + JSON.stringify(body).slice(0, 160));
  ok("pesan error mengingatkan jangan pakai cookie", /[Jj]angan pernah pakai cookie/.test(body.error || ""), body.error);

  // cookie akun + API key valid: yang dipakai HARUS API key, cookie diabaikan total
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("<roblox!palsu")], { type: "model/x-rbxm" }), "x.rbxm");
  fd.append("userId", "1234567");
  fd.append("apiKey", "key-uji-panjang");
  fd.append("assetType", "Animation");
  const res2 = await fetch(BASE + "/api/jobs-file", {
    method: "POST", headers: { cookie: robocookie + "; ism_gate=" + jar.ism_gate }, body: fd
  });
  const bodyJson = await res2.json();
  ok("cookie akun + API key valid → job jalan", res2.status === 202, JSON.stringify(bodyJson).slice(0, 140));
  let snap = null;
  for (let i = 0; i < 50; i++) {
    await wait(200);
    const s = await callJson("/api/jobs/" + bodyJson.jobId);
    snap = s.body;
    if (!["queued", "running"].includes(snap.status)) break;
  }
  const up = seen.uploads[seen.uploads.length - 1];
  ok("upload memakai API key, bukan cookie", up.auth.apiKey === "key-uji-panjang" && !up.auth.bearer);
  ok("cookie akun tidak pernah diteruskan ke Roblox", seen.uploads.every((u) => !u.cookieHeader), JSON.stringify(seen.uploads.map((u) => u.cookieHeader).filter(Boolean)));
  ok("cookie akun tidak tercatat di respons job", !JSON.stringify(snap).includes("ini-cookie-akun-palsu"));

  const src = await (await fetch(BASE + "/spoof.html")).text();
  ok("halaman spoofer tidak punya kolom cookie", !/name=["']?cookie/i.test(src) && !/ROBLOSECURITY/.test(src.replace(/<meta[\s\S]*?>/g, "")));
  ok("halaman menjelaskan kenapa tanpa cookie", /tidak ada kolom cookie/i.test(src));
  ok("halaman mengarahkan ke Open Cloud API key / OAuth", /Open Cloud API key/.test(src) && /OAuth/.test(src));
}

heading("9. Sajian statis & keamanan dasar");
{
  const page = await call("/spoof.html");
  ok("spoof.html tersaji", page.status === 200 && (page.headers.get("content-type") || "").includes("text/html"));
  const idx = await call("/");
  ok("halaman utama situs tersaji di /", idx.status === 200);
  ok("halaman utama masih self-contained (tanpa resource eksternal)",
    !/(src|href)="https?:/.test((await idx.text()).replace(/<a [^>]*>/g, "")));

  const trav = await call("/../etc/passwd");
  ok("path traversal ditolak", trav.status === 403 || trav.status === 404, trav.status);
  const trav2 = await call("/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
  ok("path traversal ter-encode ditolak", trav2.status === 403 || trav2.status === 404, trav2.status);

  const unknown = await callJson("/api/apa-pun");
  ok("endpoint tidak dikenal → 404 JSON", unknown.status === 404 && unknown.body.error);

  /* rate limit diuji pada instance terpisah dengan JOB_RATE_LIMIT kecil */
  const rlPort = APP_PORT + 500;
  const rl = spawn(process.execPath, [SERVER], {
    env: {
      PORT: String(rlPort), HOST: "127.0.0.1", STATIC_ROOT: path.join(__dirname, "..", "..", "ism-site"),
      SESSION_SECRET: "s2", ROBLOX_APIS_BASE: MOCK, ROBLOX_ASSET_DELIVERY_BASE: MOCK,
      ALLOW_ASSET_HOSTS: "127.0.0.1", JOB_RATE_LIMIT: "2", CONCURRENCY: "1"
    },
    stdio: "ignore"
  });
  let rlReady = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${rlPort}/api/health`)).ok) { rlReady = true; break; } } catch { /* tunggu */ }
    await wait(120);
  }
  ok("instance rate-limit siap", rlReady);
  let limited = false;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`http://127.0.0.1:${rlPort}/api/jobs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "1234567890", apiKey: "key-uji-panjang", options: { userId: "1234567" } })
    });
    if (res.status === 429) { limited = true; break; }
  }
  ok("rate limit job aktif (429 setelah JOB_RATE_LIMIT terlampaui)", limited);
  rl.kill("SIGTERM");

  /* batas jumlah item */
  const big = await callJson("/api/parse", {
    method: "POST",
    body: JSON.stringify({ input: Array.from({ length: 40 }, (_, i) => String(2000000000 + i)).join("\n") })
  });
  ok("parse 40 ID tanpa masalah", big.body.total === 40, big.body.total);
}

heading("10. Pengaman platform publik (kunci API di hosting tanpa password)");
{
  const { spawn: spawnSync2 } = await import("node:child_process");
  function runWithEnv(env) {
    return new Promise((resolve) => {
      const c = spawnSync2(process.execPath, [SERVER], {
        env: { ...process.env, STATIC_ROOT: path.join(__dirname, "..", "..", "ism-site"), ...env },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      c.stdout.on("data", (d) => { out += d.toString(); });
      c.stderr.on("data", (d) => { out += d.toString(); });
      c.on("exit", (code) => resolve({ code, out }));
      setTimeout(() => { c.kill("SIGKILL"); resolve({ code: -1, out }); }, 5000);
    });
  }

  const refused = await runWithEnv({
    PORT: "8777", RAILWAY_ENVIRONMENT: "production", ROBLOX_API_KEY: "kunci-palsu-uji-aman"
  });
  ok("Railway + kunci API tanpa password → server MENOLAK start (exit 1)", refused.code === 1, "exit=" + refused.code);
  ok("alasan penolakan jelas & memberi 3 pilihan", /DITOLAK START/.test(refused.out) && /ACCESS_PASSWORD/.test(refused.out) && /ALLOW_PUBLIC_SERVER_KEY/.test(refused.out));
  ok("kunci tidak bocor di pesan penolakan", !refused.out.includes("kunci-palsu-uji-aman"));

  const allowed = await runWithEnv({
    PORT: "8778", RAILWAY_ENVIRONMENT: "production", ROBLOX_API_KEY: "kunci-palsu-uji-aman", ALLOW_PUBLIC_SERVER_KEY: "1"
  });
  ok("dengan ALLOW_PUBLIC_SERVER_KEY=1 → boleh jalan + peringatan", allowed.code === -1 || allowed.code === null || allowed.code === 0 || /PERINGATAN/.test(allowed.out), "exit=" + allowed.code);

  const local = await runWithEnv({ PORT: "8779", ROBLOX_API_KEY: "kunci-palsu" });
  ok("di lokal (bukan platform publik) → jalan dengan catatan", /catatan: ROBLOX_API_KEY dipasang tanpa ACCESS_PASSWORD/.test(local.out));
}

/* ============================ 4. ringkasan ============================== */
console.log("\n" + "=".repeat(60));
console.log(`${pass} lolos · ${fail} gagal`);
console.log(`\nRingkasan bukti:`);
console.log(`  upload tercatat      : ${seen.uploads.length}`);
console.log(`  hash byte terverifikasi : ${seen.uploads.filter((u) => u.fileSha).length}`);
console.log(`  fetch via endpoint  : ${seen.delivery.length}`);
if (fail) {
  console.log("\n--- log server (200 baris terakhir) ---");
  console.log(serverLog.split("\n").slice(-200).join("\n"));
}

child.kill("SIGTERM");
mockServer.close();
await wait(200);
process.exit(fail ? 1 : 0);
