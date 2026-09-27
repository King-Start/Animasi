#!/usr/bin/env node
/**
 * ISpooferMotion Web — server.
 *
 * Jalankan:  node ism-web/server.mjs        (butuh Node 20+)
 * Lalu buka: http://localhost:8787/spoof.html
 *
 * Yang dilakukan server ini:
 *   1. Menyajikan situs statis (ism-site) — jadi satu origin, tanpa drama CORS.
 *   2. Mengambil isi aset dari ID (tanpa kredensial apa pun).
 *   3. Meng-upload balik ke akun/grup tujuan lewat Open Cloud Assets API
 *      memakai Open Cloud API key milikmu ATAU access token OAuth 2.0.
 *
 * Yang TIDAK dilakukan server ini, dan tidak akan pernah:
 *   - tidak menerima, menyimpan, atau memakai cookie sesi Roblox (.ROBLOSECURITY)
 *   - tidak menulis kredensial ke disk
 *   - tidak mengirim data ke pihak ketiga mana pun
 */
import http from "node:http";
import { readFile, stat, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import {
  createRobloxClient, buildAuthorizeUrl, exchangeCodeForToken, fetchUserInfo, RobloxError
} from "./lib/roblox.mjs";
import { parseAssetList, formatForPlugin, formatPlain, formatPairs } from "./lib/parse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "1.0.0";

// Daftar fitur yang ada di build ini. UI menampilkannya supaya jelas server mana yang
// sedang dipakai — kalau fiturnya tidak muncul, berarti yang jalan adalah versi lama.
const FEATURES = ["pending-confirm", "recheck", "preflight-upload", "job-report"];

/* ------------------------------------------------------------------ config */
const cfg = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  staticRoot: process.env.STATIC_ROOT || path.resolve(__dirname, "..", "ism-site"),
  serverApiKey: process.env.ROBLOX_API_KEY || "",
  accessPassword: process.env.ACCESS_PASSWORD || "",
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  concurrency: Math.max(1, Math.min(6, Number(process.env.CONCURRENCY || 3))),
  jobRateLimit: Math.max(1, Number(process.env.JOB_RATE_LIMIT || 10)), // job per menit per IP
  maxItemsPerJob: Math.max(1, Math.min(500, Number(process.env.MAX_ITEMS || 120))),
  // Berapa lama menunggu jawaban akhir Roblox setelah upload. Kalau habis, item
  // TIDAK dianggap gagal — jadi "belum pasti" dan ID-nya dicari di inventaris.
  pollTimeoutMs: Math.max(1000, Number(process.env.POLL_TIMEOUT_MS || 90000)),
  // Folder laporan job. Bisa dipindah supaya pengujian tidak mengotori folder kerja.
  reportDir: process.env.REPORT_DIR || path.resolve(__dirname, "reports"),
  oauth: {
    clientId: process.env.ROBLOX_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.ROBLOX_OAUTH_CLIENT_SECRET || "",
    scopes: "asset:read asset:write"
  },
  roblox: {
    apisBase: process.env.ROBLOX_APIS_BASE || undefined,
    assetDeliveryBase: process.env.ROBLOX_ASSET_DELIVERY_BASE || undefined,
    oauthBase: process.env.ROBLOX_OAUTH_BASE || undefined,
    usersBase: process.env.ROBLOX_USERS_BASE || undefined,
    inventoryBase: process.env.ROBLOX_INVENTORY_BASE || undefined,
    // host CDN tambahan (mirror / server tiruan saat pengujian)
    allowedAssetHosts: (process.env.ALLOW_ASSET_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean)
  }
};

const oauthEnabled = Boolean(cfg.oauth.clientId && cfg.oauth.clientSecret);
const roblox = createRobloxClient(Object.fromEntries(Object.entries(cfg.roblox).filter(([, v]) => v)));

/* ------------------------------------------------------------ util kecil */
const now = () => Date.now();

function log(...args) { console.log(new Date().toISOString(), ...args); }

/** Jangan pernah menulis kredensial ke log. */
function redact(value) {
  if (value == null) return value;
  const s = String(value);
  return s.length <= 6 ? "***" : s.slice(0, 4) + "…" + s.slice(-2);
}

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(data);
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RobloxError("Payload terlalu besar.", { code: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new RobloxError("Body bukan JSON yang valid.", { code: 400 });
  }
}

/* --------------------------------------------------------- signed cookie */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", cfg.sessionSecret).update(body).digest("base64url");
  return body + "." + mac;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expect = createHmac("sha256", cfg.sessionSecret).update(body).digest("base64url");
  const a = Buffer.from(mac || "");
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.maxAge) bits.push("Max-Age=" + opts.maxAge);
  if (opts.secure) bits.push("Secure");
  res.setHeader("set-cookie", bits.join("; "));
}

/* --------------------------------------------------------------- gating */
function gateOk(req) {
  if (!cfg.accessPassword) return true;
  const c = parseCookies(req).ism_gate;
  const payload = verify(c);
  return Boolean(payload && payload.gate);
}

/* ------------------------------------------------------- penyimpanan job */
const jobs = new Map();
const JOB_TTL_MS = 45 * 60 * 1000;
const MAX_JOBS = 40;

function pruneJobs() {
  for (const [id, job] of jobs) if (now() - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
}

function newJob(meta) {
  pruneJobs();
  const id = randomBytes(9).toString("base64url");
  const job = {
    id,
    createdAt: now(),
    status: "queued",
    cancelled: false,
    items: meta.items,
    options: meta.options,
    auth: meta.auth,
    origin: meta.origin || null, // "userscript" = job dari serah-terima sesi browser
    concurrency: meta.concurrency,
    createdAtMs: Date.now(),
    summary: { total: meta.items.length, done: 0, error: 0, skipped: 0, uncertain: 0, pending: meta.items.length },
    clients: new Set(),
    logTail: []
  };
  jobs.set(id, job);
  return job;
}

function emit(job, event) {
  const payload = { ...event, at: now() };
  if (event.type === "item" || event.type === "log") {
    job.logTail.push(payload);
    if (job.logTail.length > 200) job.logTail.shift();
  }
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of job.clients) {
    try { client.write(line); } catch { job.clients.delete(client); }
  }
}

/** IP keluar server ini (dipakai untuk menjelaskan kalau Roblox memblokir IP data center). */
let egressCache = { at: 0, ip: null };
// IP keluar yang terakhir diketahui (dipakai laporan job & UI supaya tidak selalu menembak ipify).
let egressIpLast = null;
setInterval(() => { serverEgressIp().then((ip) => { if (ip) egressIpLast = ip; }).catch(() => {}); }, 5 * 60_000).unref?.();

async function serverEgressIp() {
  if (Date.now() - egressCache.at < 10 * 60_000) return egressCache.ip;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("https://api.ipify.org?format=json", { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await res.json();
    egressCache = { at: Date.now(), ip: j && j.ip ? String(j.ip) : null };
  } catch (_) {
    egressCache = { at: Date.now(), ip: null };
  }
  return egressCache.ip;
}

/**
 * Cari ID aset yang mungkin sudah dibuat Roblox, lewat daftar aset publik kreator.
 * Tidak butuh kredensial, dan tidak mengubah apa pun di akun user.
 */
async function tryRecover(job, item) {
  const target = job.options.target || {};
  const displayName = item.displayName || (item.source === "file" ? item.fileName : (job.options.namePrefix || "ISM Spoof") + " " + item.id);
  try {
    const res = await roblox.recoverNewAsset({
      userId: target.userId,
      groupId: target.groupId,
      displayName,
      sinceMs: item.uploadStartedAt || job.createdAtMs || Date.now() - 900000
    });
    if (res.found) return { found: true, assetId: res.assetId, reason: null };
    return { found: false, reason: res.supported ? "Belum ada aset dengan nama itu di daftar asetmu — coba Periksa ulang beberapa saat lagi." : res.reason };
  } catch (err) {
    return { found: false, reason: "Gagal memeriksa inventaris: " + ((err && err.message) || String(err)) };
  }
}

/** Pekerjaan yang masih menunggu konfirmasi ID (untuk diperiksa ulang berkala). */
const reconcilers = new Map(); // jobId → { job, tries, timer }

function scheduleReconcile(job) {
  if (reconcilers.has(job.id)) return;
  const state = { job, tries: 0, timer: null };
  reconcilers.set(job.id, state);
  const tick = async () => {
    state.tries++;
    const pending = job.items.filter((i) => i.status === "pending-confirm");
    if (!pending.length || job.cancelled || state.tries > 20) {
      clearTimeout(state.timer);
      reconcilers.delete(job.id);
      emit(job, { type: "job", status: job.status, summary: job.summary });
      return;
    }
    for (const item of pending) {
      // 1) operasi yang sama
      if (item.operationId || item.operationPath) {
        try {
          const done = await roblox.pollOperation(
            { operationId: item.operationId, operationPath: item.operationPath },
            job.auth,
            { timeoutMs: 4000, intervalMs: 1200 }
          );
          item.status = "done";
          item.newId = done.assetId;
          item.recovered = true;
          delete item.error;
          job.summary.uncertain = Math.max(0, (job.summary.uncertain || 0) - 1);
          job.summary.done++;
          emit(job, { type: "item", id: item.id, status: "done", newId: item.newId, recovered: true });
          emit(job, { type: "log", level: "ok", message: `ID ${item.id} → ${item.newId} (operasi selesai)` });
          continue;
        } catch (_) { /* lanjut ke inventaris */ }
      }
      // 2) inventaris
      const rec = await tryRecover(job, item);
      if (rec.found) {
        item.status = "done";
        item.newId = rec.assetId;
        item.recovered = true;
        delete item.error;
        job.summary.uncertain = Math.max(0, (job.summary.uncertain || 0) - 1);
        job.summary.done++;
        emit(job, { type: "item", id: item.id, status: "done", newId: item.newId, recovered: true });
        emit(job, { type: "log", level: "ok", message: `ID ${item.id} → ${item.newId} (dipulihkan dari inventaris)` });
      }
    }
    // perbarui status job kalau semua sudah jelas
    if (!job.items.some((i) => i.status === "pending-confirm") && !job.summary.error) job.status = "finished";
    else if (job.summary.error && !job.summary.uncertain) job.status = "finished-with-errors";
    state.timer = setTimeout(tick, 20000);
  };
  state.timer = setTimeout(tick, 15000);
}

/** Sekali jalan: periksa ulang semua item yang belum pasti. */
async function reconcileNow(job) {
  const pending = job.items.filter((i) => i.status === "pending-confirm");
  let recovered = 0;
  for (const item of pending) {
    if (item.operationId || item.operationPath) {
      try {
        const done = await roblox.pollOperation(
          { operationId: item.operationId, operationPath: item.operationPath }, job.auth, { timeoutMs: 6000, intervalMs: 1500 }
        );
        item.status = "done"; item.newId = done.assetId; item.recovered = true;
        delete item.error; delete item.hint;
        job.summary.uncertain = Math.max(0, (job.summary.uncertain || 0) - 1); job.summary.done++; recovered++;
        continue;
      } catch (_) { /* lanjut */ }
    }
    const rec = await tryRecover(job, item);
    if (rec.found) {
      item.status = "done"; item.newId = rec.assetId; item.recovered = true;
      delete item.error; delete item.hint;
      job.summary.uncertain = Math.max(0, (job.summary.uncertain || 0) - 1); job.summary.done++; recovered++;
    } else if (rec.reason) {
      item.hint = rec.reason;
    }
  }
  if (!job.items.some((i) => i.status === "pending-confirm")) {
    job.status = job.summary.error ? "finished-with-errors" : "finished";
  }
  job.authKind = job.authKind || (job.auth && job.auth.kind) || null;
  writeJobReport(job).catch(() => {}); // laporan ikut diperbarui setelah pemulihan
  return recovered;
}

/**
 * Tulis laporan job ke berkas teks (tanpa kredensial apa pun) supaya kalau ada
 * kegagalan, penyebabnya bisa dibaca belakangan — termasuk kalau servernya sudah
 * mati/restart. Disimpan di <server>/reports/<jobId>.txt, maksimal 25 berkas terakhir.
 */
function jobReportText(job) {
  const lines = [];
    lines.push("# Laporan job ISpooferMotion Web");
    lines.push("jobId        : " + job.id);
    lines.push("waktu        : " + new Date(job.createdAtMs || Date.now()).toISOString());
    lines.push("status       : " + job.status);
    lines.push("target       : " + (job.options && job.options.target
      ? (job.options.target.groupId ? "grup " + job.options.target.groupId : "user " + job.options.target.userId)
      : "?"));
    lines.push("auth         : " + (job.authKind || (job.auth && job.auth.kind) || "?") + " (nilai kredensial tidak pernah disimpan)");
    lines.push("ringkasan    : " + JSON.stringify(job.summary));
    lines.push("egressIp     : " + (egressIpLast || "?"));
    lines.push("versi server : " + VERSION + " · fitur " + FEATURES.join(", "));
    lines.push("");
    for (const it of job.items) {
      lines.push("## item " + it.id + (it.name ? " (" + it.name + ")" : ""));
      lines.push("   status      : " + it.status + (it.stage ? " · tahap " + it.stage : ""));
      lines.push("   httpStatus  : " + (it.httpStatus == null ? "-" : it.httpStatus));
      lines.push("   error       : " + (it.error || "-"));
      lines.push("   hint        : " + (it.hint || "-"));
      lines.push("   newId       : " + (it.newId || "-") + (it.recovered ? "  (dipulihkan)" : ""));
      lines.push("   operationId : " + (it.operationId || "-"));
      lines.push("   sha256      : " + (it.sha256 || "-") + " · byte " + (it.bytesLength == null ? "-" : it.bytesLength));
      if (Array.isArray(it.tried) && it.tried.length) {
        lines.push("   percobaan   :");
        for (const tr of it.tried.slice(0, 12)) {
          lines.push("     - " + [tr.endpoint, tr.ua, tr.status].filter((x) => x != null).join(" · "));
        }
      }
      lines.push("");
    }
  return lines.join("\n");
}

async function writeJobReport(job) {
  try {
    const dir = cfg.reportDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, job.id + ".txt"), jobReportText(job), "utf8");
    const all = (await readdir(dir)).filter((f) => f.endsWith(".txt")).sort();
    for (const ol of all.slice(0, Math.max(0, all.length - 25))) {
      await unlink(path.join(dir, ol)).catch(() => {});
    }
  } catch (err) {
    log("laporan gagal ditulis:", err.message);
  }
}

/** Susun output siap-tempel dari item yang sudah punya ID baru. */
function buildOutput(snap) {
  const pairs = snap.items.filter((i) => i.newId).map((i) => ({ oldId: i.id, newId: i.newId }));
  return {
    plugin: formatForPlugin(pairs),
    plain: formatPlain(pairs),
    pairs: formatPairs(pairs),
    count: pairs.length
  };
}

function snapshot(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    summary: job.summary,
    dashboardUrl: job.options.target && job.options.target.groupId
      ? "https://create.roblox.com/dashboard/group-creations?activeTab=Animation"
      : "https://create.roblox.com/dashboard/creations?activeTab=Animation",
    items: job.items.map((it) => ({
      id: it.id, status: it.status, stage: it.stage || null, newId: it.newId || null,
      error: it.error || null, hint: it.hint || null, httpStatus: it.httpStatus || null,
      bytesLength: it.bytesLength || null, sha256: it.sha256 || null,
      assetType: it.assetType || null, ms: it.ms || null, name: it.name || null,
      recovered: Boolean(it.recovered), operationId: it.operationId || null,
      creatorId: it.creatorId || null, creatorType: it.creatorType || null
    })),
    options: {
      placeId: job.options.placeId || null,
      namePrefix: job.options.namePrefix,
      target: job.options.target,
      assetType: job.options.assetType
    }
  };
}

/**
 * Ambil aset di Roblox: POST hanya sekali per item (kecuali POST-nya sendiri gagal).
 * Polling dilakukan pada operasi yang sama — tidak pernah meng-upload ulang.
 */
async function uploadOnce(job, item, payload) {
  if (item.uploadOp) return item.uploadOp; // sudah pernah di-POST: jangan ulangi!
  const up = await roblox.uploadAsset(payload);
  item.uploadOp = up;
  item.operationId = up.operationId || null;
  item.operationPath = up.operationPath || null;
  item.uploadStartedAt = item.uploadStartedAt || Date.now();
  return up;
}

async function processItem(job, item) {
  const t0 = now();
  const opts = job.options;
  const attempts = 2;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (job.cancelled) { item.status = "skipped"; item.error = "dibatalkan"; return; }

      if (item.source === "file") {
        item.stage = "upload";
        item.status = "uploading";
        emit(job, { type: "item", id: item.id, status: item.status, attempt });
        const up = await uploadOnce(job, item, {
          bytes: item.bytes, fileName: item.fileName, assetType: item.assetType,
          displayName: item.displayName, description: opts.description || "Uploaded via ISpooferMotion Web",
          creator: opts.target, auth: job.auth
        });
        item.status = "processing";
        emit(job, { type: "item", id: item.id, status: item.status });
        const done = await roblox.pollOperation(up, job.auth, { timeoutMs: cfg.pollTimeoutMs });
        item.newId = done.assetId;
        item.assetType = item.assetType || "Animation";
      } else {
        // Tahap dilacak supaya jelas di mana gagalnya: "fetch" (ambil isi dari Roblox,
        // TIDAK memakai kunci API) atau "upload" (baru di sini kunci dipakai).
        item.stage = "fetch";
        item.status = "fetching";
        emit(job, { type: "item", id: item.id, status: item.status, attempt });

        const dl = await roblox.downloadAsset(item.id, { placeId: opts.placeId });
        item.bytesLength = dl.bytesLength;
        item.sha256 = dl.sha256;
        item.assetType = dl.assetType || "Animation";

        if (job.cancelled) { item.status = "skipped"; item.error = "dibatalkan"; return; }

        item.stage = "upload";
        item.status = "uploading";
        emit(job, {
          type: "item", id: item.id, status: item.status,
          bytesLength: dl.bytesLength, sha256: dl.sha256, assetType: item.assetType
        });

        item.displayName = (opts.namePrefix || "ISM Spoof") + " " + item.id;
        const up = await uploadOnce(job, item, {
          bytes: dl.bytes,
          fileName: `ism-${item.id}.rbxm`,
          assetType: opts.assetType || "Animation",
          displayName: item.displayName,
          description: opts.description || `Re-upload dari asset ${item.id} via ISpooferMotion Web`,
          creator: opts.target,
          auth: job.auth
        });

        item.status = "processing";
        emit(job, { type: "item", id: item.id, status: item.status });

        const done = await roblox.pollOperation(up, job.auth, { timeoutMs: cfg.pollTimeoutMs });
        item.newId = done.assetId;
      }

      item.status = "done";
      item.ms = now() - t0;
      job.summary.done++;
      job.summary.pending--;
      emit(job, { type: "item", id: item.id, status: "done", newId: item.newId, ms: item.ms, sha256: item.sha256 });
      return;
    } catch (err) {
      const re = err instanceof RobloxError ? err : new RobloxError(err.message || String(err));
      if (item.httpStatus == null && (re.status || re.code) && Number(re.status || re.code) >= 400) {
        item.httpStatus = Number(re.status || re.code);
      }

      // Timeout / jawaban belum turun: upload-nya biasanya SUDAH jadi. Jangan ulangi
      // upload (itu bikin aset ganda), tapi tandai "belum pasti" lalu cari ID-nya.
      if (re.uncertain) {
        item.status = "pending-confirm";
        item.stage = item.stage || "upload";
        item.error = re.message;
        item.hint = roblox.explainError(re.message) || "Upload sudah diterima Roblox; ID-nya menyusul. Cek Creator Dashboard kalau mau langsung memakainya.";
        item.ms = now() - t0;
        emit(job, { type: "item", id: item.id, status: item.status, stage: item.stage, error: item.error, hint: item.hint, ms: item.ms });
        emit(job, { type: "log", level: "warn", message: `ID ${item.id}: Roblox belum mengirim ID akhir. Upload kemungkinan tetap jadi — aku cari ID-nya di inventaris.` });

        const rec = await tryRecover(job, item);
        if (rec.found) {
          item.status = "done";
          item.newId = rec.assetId;
          item.recovered = true;
          delete item.error;
          delete item.hint;
          job.summary.uncertain = Math.max(0, (job.summary.uncertain || 0) - 1);
          job.summary.done++;
          emit(job, { type: "item", id: item.id, status: "done", newId: item.newId, recovered: true, ms: item.ms });
          emit(job, { type: "log", level: "ok", message: `ID ${item.id} → ${item.newId} (dipulihkan dari inventaris)` });
          return;
        }
        if (rec.reason) emit(job, { type: "log", level: "warn", message: `ID ${item.id}: ${rec.reason}` });
        job.summary.uncertain = (job.summary.uncertain || 0) + 1;
        scheduleReconcile(job);
        return;
      }

      if (attempt < attempts && re.retryable && !job.cancelled && !item.uploadOp) {
        emit(job, { type: "log", level: "warn", message: `ID ${item.id} gagal (${re.message}) — coba ulang…` });
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      item.status = "error";
      item.stage = item.stage || "unknown";
      item.error = re.message;
      item.hint = roblox.explainError(re.message) || null;
      // kode HTTP dari Roblox (401/403/429/…) supaya bisa dibedakan: butuh login,
      // diblokir IP, atau kena batas permintaan.
      const hs = Number(re.status) || Number(re.code) || 0;
      item.httpStatus = hs >= 400 ? hs : null;
      item.ms = now() - t0;
      job.summary.error++;
      job.summary.pending--;
      emit(job, { type: "item", id: item.id, status: "error", error: item.error, hint: item.hint, stage: item.stage, httpStatus: item.httpStatus, ms: item.ms });
      return;
    }
  }
}

async function runJob(job) {
  job.status = "running";
  emit(job, { type: "job", status: "running", summary: job.summary });

  const queue = job.items.filter((i) => i.status === "pending");
  await new Promise((resolve) => {
    let active = 0;
    const next = () => {
      if (job.cancelled) { queue.length = 0; }
      if ((!queue.length && active === 0)) return resolve();
      while (active < job.concurrency && queue.length) {
        const item = queue.shift();
        active++;
        processItem(job, item).finally(() => { active--; next(); });
      }
    };
    next();
  });

  if (job.cancelled) {
    for (const it of job.items) {
      if (it.status === "pending") { it.status = "skipped"; it.error = "dibatalkan"; job.summary.pending--; job.summary.skipped++; }
    }
    job.status = "cancelled";
  } else {
    // "belum pasti" bukan gagal: asetnya biasanya sudah ada di Roblox.
    job.status = job.summary.error
      ? (job.summary.done || job.summary.uncertain ? "finished-with-errors" : "failed")
      : job.summary.uncertain
        ? "finished-with-uncertain"
        : "finished";
  }

  emit(job, { type: "job", status: job.status, summary: job.summary });

  // Simpan laporan teks (tanpa kredensial) supaya kalau ada kegagalan, sebabnya
  // bisa dibaca lagi kapan pun — termasuk setelah server restart.
  job.authKind = (job.auth && job.auth.kind) || job.authKind || null;
  writeJobReport(job).catch(() => {});

  // kredensial per-job dibuang begitu selesai, kecuali diminta disimpan
  if (!job.options.rememberKey) job.auth = null;
  job.items.forEach((it) => { delete it.bytes; });
}

/** Jalankan tugas async dengan batas paralel. */
async function pool(items, limit, worker) {
  const queue = items.slice();
  await new Promise((resolve) => {
    let active = 0;
    const next = () => {
      if (!queue.length && active === 0) return resolve();
      while (active < limit && queue.length) {
        const item = queue.shift();
        active++;
        Promise.resolve(worker(item)).catch(() => {}).finally(() => { active--; next(); });
      }
    };
    next();
  });
}

/* --------------------------------------------------------- rate limiting */
const buckets = new Map();
function rateLimit(req, key, max, windowMs) {
  const ip = req.socket.remoteAddress || "?";
  const id = key + ":" + ip;
  const nowTs = now();
  const b = buckets.get(id) || { count: 0, reset: nowTs + windowMs };
  if (nowTs > b.reset) { b.count = 0; b.reset = nowTs + windowMs; }
  b.count++;
  buckets.set(id, b);
  return b.count <= max;
}

/* -------------------------------------------------------------- OAuth 2.0 */
function oauthRedirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}/api/oauth/callback`;
}

/* ------------------------------------------------------------ static file */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  // userscript & contoh file: dikirim apa adanya, tidak dieksekusi server
  ".user.js": "text/javascript; charset=utf-8", ".rbxm": "application/octet-stream",
  ".rbxmx": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".xml": "application/xml"
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const target = path.resolve(cfg.staticRoot, "." + rel);
  if (!target.startsWith(path.resolve(cfg.staticRoot))) {
    return json(res, 403, { error: "Path di luar root." });
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) return serveStatic(req, res, path.posix.join(rel, "index.html"));
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 — tidak ditemukan: " + rel);
  }
}

/* ----------------------------------------------------------------- routing */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const isApi = p.startsWith("/api/");

  /* CORS opsional (kalau UI di-host di domain lain, mis. GitHub Pages) */
  const origin = req.headers.origin;
  if (isApi && origin && (cfg.allowedOrigins.includes(origin) || cfg.allowedOrigins.includes("*"))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("vary", "origin");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (!isApi) return serveStatic(req, res, p);

  try {
    /* ---------- health & gate ---------- */
    if (p === "/api/health" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        gate: Boolean(cfg.accessPassword),
        gateOk: gateOk(req),
        authModes: {
          serverKey: Boolean(cfg.serverApiKey),
          oauth: oauthEnabled,
          apiKey: true
        },
        limits: { maxItems: cfg.maxItemsPerJob, concurrency: cfg.concurrency, maxBytes: roblox.config.maxAssetBytes },
        features: FEATURES,
        egressIp: await (async () => { const ip = await serverEgressIp(); if (ip) egressIpLast = ip; return ip; })(),
        userAgents: (roblox.config.userAgents || []).map((u) => String(u).split("/")[0]).slice(0, 5),
        cookieAuth: false,
        note: "Server ini tidak menerima cookie sesi Roblox. Auth hanya Open Cloud API key atau OAuth 2.0."
      });
    }

    if (p === "/api/gate" && req.method === "POST") {
      if (!cfg.accessPassword) return json(res, 200, { ok: true });
      const body = await readJson(req);
      const ok = String(body.password || "") === cfg.accessPassword;
      if (ok) setCookie(res, "ism_gate", sign({ gate: true, exp: now() + 12 * 3600 * 1000 }), { maxAge: 43200 });
      return json(res, ok ? 200 : 401, { ok });
    }

    /* ---------- OAuth ---------- */
    if (p === "/api/oauth/start" && req.method === "GET") {
      if (!oauthEnabled) return json(res, 400, { error: "OAuth belum dikonfigurasi di server ini." });
      const state = randomBytes(8).toString("base64url");
      const nonce = randomBytes(8).toString("base64url");
      setCookie(res, "ism_oauth", sign({ state, nonce, exp: now() + 600000 }), { maxAge: 600 });
      res.writeHead(302, { location: buildAuthorizeUrl({ ...cfg.oauth, oauthBase: roblox.config.oauthBase }, { state, nonce, redirectUri: oauthRedirectUri(req) }) });
      return res.end();
    }

    if (p === "/api/oauth/callback" && req.method === "GET") {
      if (!oauthEnabled) return json(res, 400, { error: "OAuth belum dikonfigurasi." });
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const saved = verify(parseCookies(req).ism_oauth);
      if (!code || !saved || saved.state !== state) {
        res.writeHead(400, { "content-type": "text/plain" });
        return res.end("State OAuth tidak cocok — proses dibatalkan.");
      }
      const token = await exchangeCodeForToken({ ...cfg.oauth, oauthBase: roblox.config.oauthBase }, { code, redirectUri: oauthRedirectUri(req) });
      const user = await fetchUserInfo({ ...cfg.oauth, oauthBase: roblox.config.oauthBase }, token.access_token).catch(() => null);
      setCookie(res, "ism_session", sign({
        accessToken: token.access_token,
        exp: now() + Math.min(Number(token.expires_in || 3600) * 1000, 11 * 3600 * 1000),
        userId: user?.sub || null, username: user?.preferred_username || null
      }), { maxAge: 3600 * 11 });
      res.writeHead(302, { location: "/spoof.html?login=ok" });
      return res.end();
    }

    if (p === "/api/me" && req.method === "GET") {
      const s = verify(parseCookies(req).ism_session);
      return json(res, 200, {
        loggedIn: Boolean(s && s.accessToken),
        userId: s?.userId || null,
        username: s?.username || null,
        serverKey: Boolean(cfg.serverApiKey)
      });
    }

    if (p === "/api/logout" && req.method === "POST") {
      setCookie(res, "ism_session", "", { maxAge: 0 });
      return json(res, 200, { ok: true });
    }

    /* ---------- API di balik gate ---------- */
    if (!gateOk(req)) {
      return json(res, 401, { error: "gate-required", message: "Server ini butuh password akses (ACCESS_PASSWORD)." });
    }

    /* ---------- buat job dari daftar ID ---------- */
    if (p === "/api/jobs" && req.method === "POST") {
      if (!rateLimit(req, "jobs", cfg.jobRateLimit, 60_000)) {
        return json(res, 429, { error: "rate-limited", message: "Terlalu banyak job. Tunggu sebentar." });
      }
      const body = await readJson(req);
      const parsed = parseAssetList(body.input || "");
      let items = parsed.items;
      if (!items.length) return json(res, 400, { error: "Tidak ada asset ID yang terbaca dari input." });
      if (items.length > cfg.maxItemsPerJob) {
        items = items.slice(0, cfg.maxItemsPerJob);
      }

      const target = {
        userId: String(body.options?.userId || "").trim() || undefined,
        groupId: String(body.options?.groupId || "").trim() || undefined
      };
      job_validateTarget(target);

      const auth = resolveAuth(req, body.apiKey);
      const job = newJob({
        items: items.map((it) => ({
          id: it.id, name: it.name || null, creatorId: it.creatorId || null,
          creatorType: it.creatorType || null, status: "pending", source: "id"
        })),
        options: {
          placeId: String(body.options?.placeId || "").trim() || null,
          namePrefix: String(body.options?.namePrefix || "ISM Spoof").trim().slice(0, 40),
          description: body.options?.description || null,
          assetType: body.options?.assetType || "Animation",
          target,
          rememberKey: Boolean(body.options?.rememberKey) && auth.kind === "apikey"
        },
        auth,
        concurrency: cfg.concurrency
      });

      log(`job ${job.id}: ${items.length} ID → ${target.groupId ? "group " + target.groupId : "user " + target.userId} (auth: ${auth.kind}${auth.kind === "apikey" ? " " + redact(auth.apiKey) : ""})`);
      runJob(job).catch((err) => {
        job.status = "failed";
        emit(job, { type: "job", status: "failed", error: err.message });
      });
      return json(res, 202, { jobId: job.id, total: items.length, typeHint: parsed.typeHint, target });
    }

    /* ---------- job dari file lokal ---------- */
    if (p === "/api/jobs-file" && req.method === "POST") {
      if (!rateLimit(req, "jobs", cfg.jobRateLimit, 60_000)) {
        return json(res, 429, { error: "rate-limited", message: "Terlalu banyak job. Tunggu sebentar." });
      }
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) {
        return json(res, 400, { error: "Harus multipart/form-data." });
      }
      const form = await new Response(Readable.toWeb(req), { headers: { "content-type": contentType } }).formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return json(res, 400, { error: "File tidak ada di form." });
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > roblox.config.maxAssetBytes) {
        return json(res, 413, { error: `File ${(bytes.length / 1048576).toFixed(1)} MB melebihi batas 20 MB.` });
      }

      const assetType = String(form.get("assetType") || roblox.guessAssetTypeFromFile(file.name));
      const target = {
        userId: String(form.get("userId") || "").trim() || undefined,
        groupId: String(form.get("groupId") || "").trim() || undefined
      };
      job_validateTarget(target);
      const auth = resolveAuth(req, form.get("apiKey"));
      const viaUserscript = String(form.get("via") || "").trim() === "userscript";

      const id = randomBytes(6).toString("base64url");
      const job = newJob({
        items: [{
          id: id, status: "pending", source: "file", bytes,
          // ID asal (kalau upload ini bagian dari alur spoofer: lama → baru)
          oldId: /^\d{6,}$/.test(String(form.get("oldId") || "").trim())
            ? String(form.get("oldId")).trim()
            : (/^Spoof\s+(\d{6,})$/i.exec(String(form.get("displayName") || "")) || [])[1] || null,
          fileName: file.name || "uploads.rbxm", assetType,
          displayName: String(form.get("displayName") || file.name || "ISM Upload").slice(0, 50),
          name: file.name || null
        }],
        options: {
          namePrefix: "ISM Upload", description: null, assetType,
          target, rememberKey: false, placeId: null
        },
        auth,
        origin: viaUserscript ? "userscript" : null,
        concurrency: 1
      });
      log(`job ${job.id}: file ${file.name} (${bytes.length} B) → ${target.groupId ? "group " + target.groupId : "user " + target.userId}`);
      runJob(job).catch(() => {});
      return json(res, 202, { jobId: job.id, total: 1 });
    }

    /* ---------- status & stream ---------- */
    const jobMatch = p.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)(\/events|\/cancel|\/recheck)?$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { error: "Job tidak ditemukan atau sudah kedaluwarsa." });

      if (jobMatch[2] === "/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        res.write(`retry: 3000\n\n`);
        res.write(`data: ${JSON.stringify({ type: "snapshot", ...snapshot(job) })}\n\n`);
        job.clients.add(res);
        const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch { /* noop */ } }, 15000);
        req.on("close", () => { clearInterval(hb); job.clients.delete(res); });
        return;
      }

      if (jobMatch[2] === "/recheck" && req.method === "POST") {
        if (!rateLimit(req, "recheck", 20, 60_000)) {
          return json(res, 429, { error: "rate-limited", message: "Terlalu banyak periksa ulang. Tunggu sebentar." });
        }
        const found = await reconcileNow(job);
        const snap = snapshot(job);
        snap.output = buildOutput(snap);
        snap.rechecked = { recovered: found, uncertainLeft: job.summary.uncertain || 0 };
        log(`job ${job.id}: periksa ulang → ${found} ID dipulihkan, sisa belum pasti ${job.summary.uncertain || 0}`);
        return json(res, 200, snap);
      }

      if (jobMatch[2] === "/cancel" && req.method === "POST") {
        job.cancelled = true;
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET") {
        const snap = snapshot(job);
        snap.output = buildOutput(snap);
        return json(res, 200, snap);
      }
    }

    /* ---------- uji ambil: cek ID bisa ditarik atau tidak, TANPA upload ---------- */
    if (p === "/api/probe" && req.method === "POST") {
      if (!rateLimit(req, "probe", 30, 60_000)) {
        return json(res, 429, { error: "rate-limited", message: "Terlalu banyak permintaan uji. Tunggu sebentar." });
      }
      const body = await readJson(req);
      const parsed = parseAssetList(body.input || "");
      const ids = parsed.items.slice(0, 20);
      if (!ids.length) return json(res, 400, { error: "Tidak ada asset ID yang terbaca dari input." });

      const placeId = String(body.placeId || "").trim() || null;
      const results = [];
      await pool(ids, 3, async (it) => {
        const t0 = now();
        try {
          const dl = await roblox.downloadAsset(it.id, { placeId });
          results.push({
            id: it.id, ok: true, bytesLength: dl.bytesLength, sha256: dl.sha256,
            assetType: dl.assetType, assetTypeId: dl.assetTypeId, ms: now() - t0
          });
        } catch (err) {
          const attempts = (err && err.detail && err.detail.attempts) || [];
          results.push({
            id: it.id, ok: false,
            status: Number((err && err.code) || 0) || null,
            error: (err && err.message) || String(err),
            tried: attempts.slice(0, 6).map((a) => `${a.endpoint || "cdn"} ${a.ua ? String(a.ua).split("/")[0] : "?"}=${a.status}`),
            hint: roblox.explainError((err && err.message) || String(err)) || null,
            ms: now() - t0
          });
        }
      });
      results.sort((a, b) => Number(a.id) - Number(b.id));
      const okCount = results.filter((r) => r.ok).length;
      const blocked = results.filter((r) => !r.ok && [401, 403].includes(Number(r.status))).length;
      const limited = results.filter((r) => !r.ok && Number(r.status) === 429).length;
      // "dinding" = Roblox menolak permintaan itu sendiri (bukan sekadar asetnya dibatasi)
      const gatewayBlocked = results.filter(
        (r) => !r.ok && /invalid authentication data|invalid api key|unauthorized/i.test(String(r.error || ""))
      ).length;
      return json(res, 200, {
        probe: true,
        checked: results.length,
        ok: okCount,
        failed: results.length - okCount,
        needsCredentials: false,
        note: "Uji ini hanya mengambil isi aset — tidak ada upload, tidak ada kredensial yang dipakai.",
        diagnosis: limited
          ? "Server ini kena batas permintaan Roblox (HTTP 429). Roblox membatasi per-IP, dan IP data center (Railway dll) sering dipakai bersama. Tunggu 1-2 menit lalu ulangi; untuk hasil paling lancar jalankan server ini di komputermu sendiri atau pakai userscript (ambil dari IP-mu)."
          : gatewayBlocked && okCount === 0
            ? "Roblox menolak permintaan dari server ini di pintu masuk (bukan soal asetnya). Biasanya karena IP data center diblokir/dibatasi Roblox. Jalankan server ini di komputermu sendiri, atau pakai userscript ism-fetch.user.js yang mengambil dari IP-mu."
            : gatewayBlocked
              ? "Sebagian permintaan ditolak di pintu masuk (HTTP 401/403) — server ini kadang dibatasi Roblox. Yang gagal bisa dicoba ulang, atau ambil lewat userscript (dari IP-mu)."
              : blocked
                ? "Aset yang gagal memang dibatasi: hanya sesi Roblox yang login boleh mengambil isinya. Kunci API tidak bisa menembusnya. Pakai userscript ism-fetch.user.js (mengambil di browsermu, lalu kirim ke halaman ini), atau tab 'Dari file lokal'."
                : null,
        results
      });
    }

    /* ---------- diagnosa kunci API: tanpa upload, tanpa efek samping ---------- */
    if (p === "/api/check-key" && req.method === "POST") {
      if (!rateLimit(req, "checkkey", 20, 60_000)) {
        return json(res, 429, { error: "rate-limited", message: "Terlalu banyak percobaan cek kunci. Tunggu sebentar." });
      }
      const body = await readJson(req);
      const key = body.apiKey || cfg.serverApiKey || "";
      const result = await roblox.checkKey({
        apiKey: key,
        userId: String(body.userId || "").trim() || null,
        groupId: String(body.groupId || "").trim() || null
      });
      // jangan pernah menuliskan kunci ke log, bahkan yang teredaksi sekalipun.
      // Yang boleh masuk log cuma bentuknya (panjang & karakter aneh) — bukan isinya.
      const ks = result.keyShape || {};
      const probeRingkas = (result.probes || []).map((p) => `${p.id}=${p.status}`).join(" ");
      const credKind = result.credential ? result.credential.kind : "?";
      if (credKind === "cookie") {
        log("check-key: PERINGATAN nilai yang ditempel berbentuk cookie sesi — ditolak, tidak diteruskan ke Roblox.");
      }
      log(
        `check-key: target=${body.groupId ? "group " + body.groupId : body.userId ? "user " + body.userId : "belum diisi"} ` +
          `jenis-kredensial=${credKind} ` +
          `→ ${result.verdict || (result.ok ? "ok" : "gagal")} ` +
          `(panjang kunci ${ks.length || 0}, tak-terlihat ${ks.hiddenChars || 0}, aneh ${(ks.odd || []).length}${probeRingkas ? ", uji " + probeRingkas : ""})`
      );
      return json(res, 200, { ...result, usingServerKey: !body.apiKey && Boolean(cfg.serverApiKey) });
    }

    /* ---------- uji izin upload (TIDAK membuat aset apa pun) ---------- */
    if (p === "/api/check-upload" && req.method === "POST") {
      if (!rateLimit(req, "checkupload", 20, 60_000)) {
        return json(res, 429, { error: "rate-limited", message: "Terlalu banyak percobaan. Tunggu sebentar." });
      }
      const body = await readJson(req);
      const target = {
        userId: String(body.userId || "").trim() || null,
        groupId: String(body.groupId || "").trim() || null
      };
      job_validateTarget(target); // melempar kalau ID tujuan kosong/dua-duanya
      let auth;
      try {
        auth = resolveAuth(req, body.apiKey);
      } catch (err) {
        return json(res, 200, {
          ok: false, verdict: "no-credential", status: 0,
          message: err.message,
          hint: "Isi Open Cloud API key dulu (atau login OAuth).",
          target
        });
      }
      const out = await roblox.probeUploadPermission({ auth, creator: target });
      log(`check-upload: target=${target.groupId ? "group " + target.groupId : "user " + target.userId} → ${out.verdict} (HTTP ${out.status})`);
      return json(res, 200, { ...out, egressIp: egressIpLast || (await serverEgressIp()) });
    }

    /* ---------- laporan job dalam bentuk teks (untuk disalin/diirim) ---------- */
    if (/^\/api\/jobs\/[^/]+\/report$/.test(p) && req.method === "GET") {
      const jobId = p.split("/")[3];
      const job = jobs.get(jobId);
      if (!job) {
        const file = path.join(cfg.reportDir, jobId + ".txt");
        if (existsSync(file)) {
          const txt = await readFile(file, "utf8").catch(() => null);
          if (txt) {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
            return res.end(txt);
          }
        }
        return json(res, 404, { error: "Job tidak ditemukan atau sudah kedaluwarsa." });
      }
      return json(res, 200, { ok: true, text: jobReportText(job) });
    }

    /* ---------- hasil yang datang dari sesi browser (userscript) ---------- */
    if (p === "/api/handoff" && req.method === "GET") {
      const list = [];
      for (const job of jobs.values()) {
        if (job.origin !== "userscript") continue;
        const pairs = job.items
          .filter((i) => i.newId && (i.oldId || /^\d{6,}$/.test(String(i.id))))
          .map((i) => ({ oldId: i.oldId || i.id, newId: i.newId, recovered: Boolean(i.recovered) }));
        list.push({
          jobId: job.id,
          at: new Date(job.createdAtMs || Date.now()).toISOString(),
          status: job.status,
          target: job.options && job.options.target
            ? (job.options.target.groupId ? "grup " + job.options.target.groupId : "user " + job.options.target.userId)
            : null,
          pairs
        });
      }
      list.sort((a, b) => (a.at < b.at ? 1 : -1)); // terbaru dulu
      const recent = list.slice(0, 20);
      const pairs = recent.flatMap((j) => j.pairs);
      const lines = pairs.map((x) => x.oldId + " = " + x.newId + ",").join("\n");
      return json(res, 200, { ok: true, jobs: recent, pairs, lines, count: pairs.length });
    }

    /* ---------- util: parse input saja (dipakai UI untuk pratinjau) ---------- */
    if (p === "/api/parse" && req.method === "POST") {
      const body = await readJson(req);
      const parsed = parseAssetList(body.input || "");
      return json(res, 200, {
        total: parsed.total,
        typeHint: parsed.typeHint,
        items: parsed.items.slice(0, 500),
        truncated: parsed.total > 500
      });
    }

    return json(res, 404, { error: "Endpoint tidak dikenal: " + p });
  } catch (err) {
    const status = err instanceof RobloxError && err.code ? Number(err.code) || 500 : 500;
    const msg = err?.message || "Kesalahan server";
    if (status >= 500) log("ERROR", msg);
    return json(res, status >= 400 && status < 600 ? status : 500, { error: msg });
  }
});

function resolveAuth(req, apiKeyFromClient) {
  const session = verify(parseCookies(req).ism_session);
  const key = String(apiKeyFromClient || "").trim();
  if (cfg.serverApiKey) return { kind: "apikey", apiKey: cfg.serverApiKey, source: "env" };
  if (session?.accessToken) return { kind: "oauth", accessToken: session.accessToken, source: "oauth" };
  if (key) return { kind: "apikey", apiKey: key, source: "request" };
  throw new RobloxError(
    "Butuh kredensial: pakai Open Cloud API key, atau login OAuth kalau server ini mendukungnya. " +
    "(Jangan pernah pakai cookie akun di sini.)",
    { code: 401 }
  );
}

function job_validateTarget(target) {
  const id = target.groupId || target.userId;
  if (!/^\d+$/.test(String(id || ""))) {
    throw new RobloxError("Isi User ID atau Group ID tujuan upload (angka).", { code: 400 });
  }
  if (target.groupId && target.userId) {
    throw new RobloxError("Pilih salah satu: User ID atau Group ID, jangan dua-duanya.", { code: 400 });
  }
}

/* ------------------------------------------------- pengaman platform publik */
/**
 * Kalau server ini jalan di platform hosting publik (Railway/Render/Fly/Heroku)
 * DENGAN kunci API milik operator tetapi TANPA ACCESS_PASSWORD, maka siapa pun
 * yang menemukan URL-nya bisa memakai kunci itu untuk upload ke akunmu.
 * Default-nya: tolak start. Set ALLOW_PUBLIC_SERVER_KEY=1 kalau kamu benar-benar
 * paham risikonya (mis. URL-nya memang privat dan tidak diindeks).
 */
function checkPublicSafety() {
  const hosted = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.DYNO ||
    process.env.K_SERVICE
  );
  if (!cfg.serverApiKey || cfg.accessPassword) return null;
  if (!hosted) {
    log("catatan: ROBLOX_API_KEY dipasang tanpa ACCESS_PASSWORD — aman hanya kalau server ini tidak bisa diakses orang lain.");
    return null;
  }
  if (process.env.ALLOW_PUBLIC_SERVER_KEY === "1") {
    log("PERINGATAN: kunci API dipasang di hosting publik tanpa password akses (diizinkan lewat ALLOW_PUBLIC_SERVER_KEY=1).");
    return null;
  }
  return [
    "DITOLAK START demi keamanan.",
    "",
    "Server ini terdeteksi berjalan di platform publik dan ROBLOX_API_KEY dipasang,",
    "tetapi ACCESS_PASSWORD belum diisi. Artinya siapa pun yang tahu URL-nya bisa",
    "meng-upload aset ke akunmu memakai kuncimu.",
    "",
    "Pilih salah satu:",
    "  1. (Disarankan) Hapus ROBLOX_API_KEY dari Variables. Setiap user memakai",
    "     Open Cloud API key miliknya sendiri di halaman spoofer.",
    "  2. Set ACCESS_PASSWORD supaya hanya orang yang tahu password bisa memakainya.",
    "  3. Kalau kamu benar-benar paham risikonya, set ALLOW_PUBLIC_SERVER_KEY=1."
  ].join("\n");
}

/* ------------------------------------------------------------------- start */
if (!existsSync(cfg.staticRoot)) {
  log(`PERINGATAN: folder situs tidak ditemukan di ${cfg.staticRoot} — set STATIC_ROOT.`);
}

const safetyIssue = checkPublicSafety();
if (safetyIssue) {
  log(safetyIssue);
  process.exit(1);
}

server.listen(cfg.port, cfg.host, () => {
  log(`ISpooferMotion Web v${VERSION} siap di http://localhost:${cfg.port}`);
  log(`  halaman spoofer : http://localhost:${cfg.port}/spoof.html`);
  log(`  situs statis    : ${cfg.staticRoot}`);
  log(`  auth tersedia   : API key (${cfg.serverApiKey ? "dari env" : "dari UI"})${oauthEnabled ? " · OAuth 2.0" : ""}`);
  if (cfg.accessPassword) log("  gate            : aktif (ACCESS_PASSWORD)");
  if (!process.env.SESSION_SECRET) log("  catatan         : SESSION_SECRET acak — sesi hilang saat server restart");
  log("  cookie akun Roblox TIDAK dipakai oleh server ini.");
  log(cfg.serverApiKey
    ? "  kunci API  : dipasang di server (user tidak perlu mengisi) — jaga URL ini tetap privat"
    : "  kunci API  : tidak dipasang di server — tiap user memakai kuncinya sendiri di UI");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { log("berhenti…"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}

export { server, cfg, parseAssetList };
