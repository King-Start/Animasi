// ==UserScript==
// @name         ISpooferMotion — Ambil aset di sesimu sendiri
// @namespace    https://github.com/ISpooferMotion
// @version      1.1.0
// @description  Mengunduh isi aset Roblox (termasuk animasi yang dikunci) memakai sesi login di browser-mu, lalu bisa langsung dikirim ke halaman ISpooferMotion untuk di-upload pakai kunci API-mu. Cookie sesimu TIDAK PERNAH dibaca atau dikirim oleh script ini.
// @author       ISpooferMotion
// @license      GPL-3.0-or-later
// @match        *://*.roblox.com/*
// @match        *://create.roblox.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      assetdelivery.roblox.com
// @connect      www.roblox.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/*
 * KENAPA SCRIPT INI ADA
 * ---------------------
 * Sebagian aset (mis. "Beautiful strangers" 80301288746676) hanya boleh diambil
 * oleh sesi Roblox yang login. Server ISpooferMotion TIDAK memakai cookie — jadi
 * server memang tidak bisa mengambil aset itu, dan itu disengaja.
 *
 * Yang bisa: permintaan yang dibuat DARI BROWSER-MU SENDIRI. Di sini browser
 * melampirkan sesi yang sudah ada, sama seperti halaman Roblox mana pun.
 *
 * Yang TIDAK dilakukan script ini:
 *   - tidak membaca document.cookie
 *   - tidak menyalin cookie ke variabel apa pun
 *   - tidak mengirim cookie ke server ISpooferMotion (ke situs hanya dikirim
 *     byte file yang sudah jadi)
 * Jadi: cookie-nya tidak pernah berpindah tangan. Browser yang memakainya,
 * di komputermu, untuk permintaan ke Roblox.
 *
 * File yang kamu ambil tetap tanggung jawabmu — pakai hanya untuk aset yang
 * kamu berhak memakainya.
 */

(function () {
  "use strict";

  /* ===== ISM-FETCH-PURE-START ===== */
  // Blok ini fungsi murni (tanpa DOM, tanpa GM_*), supaya bisa diuji di Node.

  const GZIP_MAGIC_0 = 0x1f;
  const GZIP_MAGIC_1 = 0x8b;

  /** Ambil asset ID dari berbagai bentuk URL Roblox. */
  function assetIdFromUrl(url) {
    const s = String(url == null ? "" : url);
    const m =
      s.match(/\/(?:library|catalog|store\/asset|asset|marketplace)\/(\d{3,})/i) ||
      s.match(/[?&](?:id|assetId|assetid)=(\d{3,})/i);
    return m ? m[1] : null;
  }

  /** Byte ini gzip? (CDN kadang mengirim gzip mentah) */
  function isGzipBytes(bytes) {
    return !!(bytes && bytes.length > 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1);
  }

  /**
   * Roblox sering menjawab HTTP 200 tapi isinya error.
   * Kembalikan {code, message} kalau body-nya JSON error, atau null.
   */
  function errorFromBody(text) {
    if (!text) return null;
    const t = String(text).trim();
    if (t.slice(0, 1) !== "{") return null;
    if (t.length > 4000) return null; // jelas bukan pesan error
    try {
      const j = JSON.parse(t);
      const e = Array.isArray(j.errors) ? j.errors[0] : null;
      if (!e) return null;
      return { code: e.code, message: String(e.message || "") };
    } catch (_) {
      return null;
    }
  }

  /** Nama file yang aman untuk diunduh / dikirim. */
  function safeFileName(id, ext) {
    const digits = String(id == null ? "" : id).replace(/[^0-9]/g, "");
    return "ism-" + (digits || "aset") + (ext || ".rbxm");
  }

  /** Token CSRF dari header balasan Roblox (kalau Roblox memintanya). */
  function csrfFromHeaders(headerText) {
    const m = String(headerText || "").match(/x-csrf-token:\s*([^\s\r\n]+)/i);
    return m ? m[1] : null;
  }

  /** URL endpoint situs ISM, tanpa garis miring ganda di ujung. */
  function apiUrl(site, path) {
    const base = String(site || "").trim().replace(/\/+$/, "");
    if (!base) return "";
    return base + (path.startsWith("/") ? path : "/" + path);
  }

  /** Kunci API Open Cloud bentuknya ~48 karakter alfanumerik + + / = - _ */
  function looksLikeApiKey(v) {
    const s = String(v || "").trim();
    return s.length >= 30 && s.length <= 96 && /^[A-Za-z0-9+/=_-]+$/.test(s);
  }

  /** Pesan manusiawi untuk kegagalan yang berkaitan dengan sesi/aset. */
  function explainSessionFailure(status, message) {
    const m = String(message || "");
    if (/not authorized to access asset|authentication required/i.test(m)) {
      return "Akunmu sendiri pun tidak diberi akses ke aset ini oleh pemiliknya.";
    }
    if (status === 401 || status === 403) {
      return "Sesi Roblox tidak diterima. Buka roblox.com, pastikan masih login, lalu coba lagi.";
    }
    if (status === 404) return "Aset tidak ditemukan (ID salah atau sudah dihapus).";
    if (status === 429) return "Kena batas permintaan Roblox. Tunggu sekitar satu menit.";
    if (!status) return "Permintaan gagal — cek koneksi internetmu.";
    return m || ("HTTP " + status);
  }

  /** UUID acak (dipakai sebagai requestId batch dan gameId). */
  function uuidish() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /** URL CDN yang ditanam Roblox di halaman library (jalur 1 milik V2). */
  function libraryPageCdnUrl(html) {
    const text = String(html || "");
    const idx = text.indexOf('data-mediathumb-url="');
    if (idx < 0) return null;
    const start = idx + 'data-mediathumb-url="'.length;
    const end = text.indexOf('"', start);
    if (end < 0) return null;
    const url = text.slice(start, end).trim();
    return /^https?:\/\//.test(url) ? url : null;
  }

  /** Ambil Location (redirect) dari teks header, dan hanya terima host Roblox CDN. */
  function locationFromHeaders(headerText) {
    const m = String(headerText || "").match(/^\s*location:\s*(\S+)\s*$/im);
    if (!m) return null;
    const url = m[1].trim();
    return /rbxcdn\.com/i.test(url) ? url : null;
  }

  /** Header konteks game yang dipakai V2 saat aset dibatasi sebuah place. */
  function gameContextHeaders(placeId, gameId) {
    const pid = String(placeId == null ? "" : placeId).trim();
    if (!/^\d+$/.test(pid) || pid === "0") return {};
    const gid = String(gameId || "").trim() || "00000000-0000-4000-8000-000000000000";
    return {
      "Roblox-Place-Id": pid,
      "Roblox-Game-Id": gid,
      "Roblox-Session-Id": JSON.stringify({ SessionId: gid, GameId: gid, PlaceId: Number(pid) })
    };
  }

  /** Body batch /v2/assets/batch — bentuknya sama dengan struct BatchAssetRequest di V2. */
  function buildBatchBody(id, opts) {
    const o = opts || {};
    const body = [{
      assetName: String(o.assetName || "asset-" + id),
      assetType: String(o.assetType || "Animation"),
      assetId: Number(id),
      requestId: String(o.requestId || ""),
      clientInsert: true
    }];
    const pid = String(o.placeId == null ? "" : o.placeId).trim();
    if (/^\d+$/.test(pid) && pid !== "0") {
      body[0].placeId = Number(pid);
      body[0].serverPlaceId = Number(pid);
    }
    return body;
  }

  /** Baca jawaban batch: cari location untuk requestId kita, atau pesan errornya. */
  function parseBatchResponse(json, requestId) {
    const arr = Array.isArray(json) ? json : (json && Array.isArray(json.assets) ? json.assets : []);
    for (const item of arr) {
      if (!item) continue;
      const rid = item.requestId || item.RequestId;
      if (requestId && rid && String(rid) !== String(requestId)) continue;
      const loc = item.location || item.Location;
      if (typeof loc === "string" && loc) return { url: loc };
      const errs = item.errors || item.Errors;
      if (Array.isArray(errs) && errs.length) {
        const msg = String(errs[0].message || errs[0].Message || "");
        return { error: msg, accessDenied: /not authorized|access denied|do not have permission/i.test(msg) };
      }
    }
    return { error: "jawaban batch tidak memuat lokasi aset", accessDenied: false };
  }

  /** Retry-After (detik atau tanggal) → milidetik. */
  function retryAfterMs(headerText) {
    const m = String(headerText || "").match(/^\s*retry-after:\s*(\S+)\s*$/im);
    if (!m) return null;
    const v = m[1].trim();
    if (/^\d+$/.test(v)) return Math.min(Number(v) * 1000, 15000);
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return Math.max(0, Math.min(t - Date.now(), 15000));
    return null;
  }

  /* ===== ISM-FETCH-PURE-END ===== */

  /* ------------------------------------------------------------------ *
   * Bagian yang menyentuh browser
   * ------------------------------------------------------------------ */

  const ASSET_DELIVERY = "https://assetdelivery.roblox.com/v1/asset/?id=";
  const SETTINGS_KEY = "ism_fetch_settings_v1";

  const DEFAULTS = { site: "", apiKey: "", userId: "", groupId: "", placeId: "", gameId: "" };

  function loadSettings() {
    try {
      const raw = typeof GM_getValue === "function" ? GM_getValue(SETTINGS_KEY, "") : "";
      if (!raw) return { ...DEFAULTS };
      const j = typeof raw === "string" ? JSON.parse(raw) : raw;
      return { ...DEFAULTS, ...(j || {}) };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(s) {
    const clean = { ...DEFAULTS, ...(s || {}) };
    if (typeof GM_setValue === "function") GM_setValue(SETTINGS_KEY, JSON.stringify(clean));
    return clean;
  }

  /** GM_xmlhttpRequest dibungkus jadi Promise. */
  function request(opts) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        timeout: 60000,
        ...opts,
        onload: (r) => resolve(r),
        onerror: (e) => resolve({ status: 0, error: e && (e.error || e.message) }),
        ontimeout: () => resolve({ status: 0, error: "timeout" })
      });
    });
  }

  /** Penundaan kecil. */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Satu permintaan; kalau kena 429, tunggu Retry-After lalu coba sekali lagi. */
  async function requestWithRetry(opts, log) {
    let r = await request(opts);
    if (r.status === 429) {
      const wait = retryAfterMs(r.responseHeaders) || 3000;
      if (log) log("Kena batas Roblox (429), tunggu " + Math.round(wait / 1000) + " detik lalu coba lagi…");
      await sleep(wait);
      r = await request(opts);
    }
    return r;
  }

  /**
   * Ambil byte dari URL CDN memakai sesi browser.
   * withCredentials:true -> BROWSER yang melampirkan cookie; script ini tidak pernah membacanya.
   */
  async function fetchCdnBytes(url, log) {
    const r = await requestWithRetry({ method: "GET", url, withCredentials: true, responseType: "arraybuffer" }, log);
    if (!r.status) throw new Error(explainSessionFailure(0, r.error));

    const buf = r.response ? new Uint8Array(r.response) : new Uint8Array(0);
    const asText = buf.length && buf[0] === 0x7b ? new TextDecoder().decode(buf.slice(0, 2000)) : "";
    const err = errorFromBody(asText) || errorFromBody(r.responseText);
    if (err) throw new Error(explainSessionFailure(r.status, err.message));
    if (r.status !== 200) throw new Error(explainSessionFailure(r.status, r.statusText));
    if (!buf.length) throw new Error("Roblox mengirim balasan kosong untuk aset ini.");

    let bytes = buf;
    if (isGzipBytes(buf) && typeof DecompressionStream === "function") {
      try {
        const ds = new DecompressionStream("gzip");
        const stream = new Blob([buf]).stream().pipeThrough(ds);
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        log("Isi aset di-dekompresi (gzip) — " + (bytes.length / 1024).toFixed(1) + " KB.");
      } catch (_) {
        log("Gagal dekompresi; memakai byte apa adanya.");
      }
    }
    return bytes;
  }

  /* --- jalur 1: halaman library (cara V2 menembak pertama) --- */
  async function resolveFromLibraryPage(id, log) {
    const r = await requestWithRetry(
      { method: "GET", url: "https://www.roblox.com/library/" + encodeURIComponent(id) + "/", withCredentials: true },
      log
    );
    if (!r.status) return null;
    const url = libraryPageCdnUrl(r.responseText);
    if (!url) return null;
    log("Isi aset ketemu lewat halaman library: " + url.replace(/\?.*$/, "") + "…");
    return url;
  }

  /* --- jalur 2: assetdelivery v1 langsung (ikut redirect ke CDN) --- */
  async function resolveFromAssetDelivery(id, st, log) {
    let url = ASSET_DELIVERY + encodeURIComponent(id);
    if (st && st.placeId) url += "&placeId=" + encodeURIComponent(st.placeId);
    const r = await requestWithRetry({ method: "GET", url, withCredentials: true, responseType: "arraybuffer" }, log);
    if (!r.status) throw new Error(explainSessionFailure(0, r.error));

    const buf = r.response ? new Uint8Array(r.response) : new Uint8Array(0);
    const head = buf.length && buf[0] === 0x7b ? new TextDecoder().decode(buf.slice(0, 2000)) : "";
    const err = errorFromBody(head) || errorFromBody(r.responseText);
    if (err) throw new Error(explainSessionFailure(r.status, err.message));
    if (r.status !== 200) throw new Error(explainSessionFailure(r.status, r.statusText));
    if (!buf.length) throw new Error("Roblox mengirim balasan kosong untuk aset ini.");
    return buf;
  }

  /* --- jalur 3: batch v2, satu-satunya yang memakai cookie + konteks game --- */
  async function resolveFromBatch(id, st, log) {
    const requestId = uuidish();
    const headers = {
      "content-type": "application/json",
      ...gameContextHeaders(st && st.placeId, st && st.gameId)
    };
    const body = buildBatchBody(id, { requestId, placeId: st && st.placeId, assetType: "Animation" });
    if (st && st.placeId) log("Sertakan konteks game (Place ID " + st.placeId + ") seperti yang dilakukan aplikasi V2.");
    const r = await requestWithRetry(
      { method: "POST", url: "https://assetdelivery.roblox.com/v2/assets/batch", withCredentials: true,
        headers, data: JSON.stringify(body) }, log
    );
    if (!r.status) throw new Error(explainSessionFailure(0, r.error));
    if (r.status === 401 || r.status === 403) {
      throw new Error("Sesi Roblox tidak diterima (HTTP " + r.status + "). Buka roblox.com, pastikan masih login, lalu coba lagi.");
    }
    let json = null;
    try { json = JSON.parse(r.responseText); } catch (_) {}
    if (!json) throw new Error("Jawaban batch tidak bisa dibaca (HTTP " + r.status + ").");
    const res = parseBatchResponse(json, requestId);
    if (!res.url) {
      if (res.accessDenied) {
        throw new Error("Akunmu sendiri tidak diberi akses ke aset ini oleh pemiliknya.");
      }
      throw new Error("Batch tidak memberi lokasi aset: " + (res.error || "sebab tidak jelas"));
    }
    log("Isi aset ketemu lewat batch v2.");
    return res.url;
  }

  /**
   * Tiga jalur seperti aplikasi V2, dijalankan berurutan sampai satu berhasil.
   * Semua permintaan berjalan DI BROWSER-MU dengan sesi yang sudah ada.
   */
  async function fetchAssetBytes(id, st, log) {
    const problems = [];

    try {
      const cdn = await resolveFromLibraryPage(id, log);
      if (cdn) return await fetchCdnBytes(cdn, log);
    } catch (e) { problems.push("halaman library: " + e.message); }

    try {
      return await resolveFromAssetDelivery(id, st, log);
    } catch (e) { problems.push("assetdelivery v1: " + e.message); }

    try {
      const cdn = await resolveFromBatch(id, st, log);
      if (cdn) return await fetchCdnBytes(cdn, log);
    } catch (e) { problems.push("batch v2: " + e.message); }

    // semua gagal: tampilkan sebab paling informatif (yang terakhir biasanya paling jelas)
    const last = problems[problems.length - 1];
    if (/tidak diberi akses|not authorized/i.test(problems.join(" "))) {
      throw new Error("Semua jalur gagal. Akunmu sendiri tidak diberi akses ke aset ini — cek asetnya di roblox.com sambil login.");
    }
    throw new Error("Semua jalur gagal. " + (last || ""));
  }

  function download(bytes, name, log) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    log("Terunduh: " + name + " (" + (bytes.length / 1024).toFixed(1) + " KB). Tarik file itu ke tab 'Dari file lokal'.");
  }

  /** Kirim byte ke situs ISM untuk di-upload pakai kunci API user. */
  async function sendToSite(bytes, id, st, log, statusEl) {
    const endpoint = apiUrl(st.site, "/api/jobs-file");
    if (!endpoint) throw new Error("Alamat situs ISM belum diisi di Pengaturan.");
    if (!st.apiKey) throw new Error("Kunci API belum diisi di Pengaturan.");
    if (!st.userId && !st.groupId) throw new Error("User ID atau Group ID tujuan belum diisi di Pengaturan.");

    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), safeFileName(id));
    fd.append("assetType", "Animation");
    fd.append("apiKey", st.apiKey);
    if (st.userId) fd.append("userId", st.userId);
    if (st.groupId) fd.append("groupId", st.groupId);
    fd.append("displayName", "Spoof " + id);

    log("Mengirim " + (bytes.length / 1024).toFixed(1) + " KB ke " + st.site + " …");
    const up = await request({ method: "POST", url: endpoint, data: fd, withCredentials: false });
    if (up.status !== 202) {
      let msg = up.statusText;
      try { msg = JSON.parse(up.responseText).message || JSON.parse(up.responseText).error || msg; } catch (_) {}
      throw new Error("Situs menolak (" + up.status + "): " + msg);
    }
    const jobId = JSON.parse(up.responseText).jobId;
    log("Job " + jobId + " dibuat. Menunggu hasil upload…");

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const st2 = await request({ method: "GET", url: apiUrl(st.site, "/api/jobs/" + jobId) });
      if (st2.status !== 200) continue;
      let snap;
      try { snap = JSON.parse(st2.responseText); } catch (_) { continue; }
      const it = (snap.items || [])[0];
      if (!it) continue;
      if (statusEl) statusEl.textContent = "job " + jobId + ": " + it.status;
      if (it.status === "done" && it.newId) {
        log("SELESAI — ID baru: " + it.newId);
        showResult(it.newId);
        return it.newId;
      }
      if (it.status === "error") throw new Error((it.error || "upload gagal") + (it.hint ? " — " + it.hint : ""));
    }
    throw new Error("Upload belum selesai dalam 90 detik. Cek halaman situs ISM-mu.");
  }

  /* ------------------------------------------------------------------ *
   * UI kecil: tombol melayang + panel
   * ------------------------------------------------------------------ */

  GM_addStyle(`
    #ism-fab{position:fixed;right:14px;bottom:14px;z-index:2147483646;display:flex;gap:8px;align-items:center;
      padding:10px 14px;border:0;border-radius:999px;font:600 13px/1.2 system-ui,sans-serif;color:#fff;cursor:pointer;
      background:linear-gradient(135deg,#6d28d9,#2563eb);box-shadow:0 8px 24px rgba(0,0,0,.35)}
    #ism-panel{position:fixed;right:14px;bottom:66px;z-index:2147483647;width:min(360px,92vw);display:none;
      background:#111226;color:#e7e9f5;border:1px solid rgba(255,255,255,.12);border-radius:14px;
      box-shadow:0 18px 50px rgba(0,0,0,.5);font:13px/1.5 system-ui,sans-serif;overflow:hidden}
    #ism-panel.on{display:block}
    #ism-panel header{padding:12px 14px;font-weight:700;background:rgba(255,255,255,.05);display:flex;justify-content:space-between;align-items:center}
    #ism-panel .body{padding:12px 14px;display:flex;flex-direction:column;gap:9px}
    #ism-panel input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);
      background:rgba(0,0,0,.35);color:#fff;font:12.5px/1.4 ui-monospace,monospace}
    #ism-panel .row{display:flex;gap:8px}
    #ism-panel button{flex:1;padding:9px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);
      background:rgba(255,255,255,.06);color:#fff;font:600 12.5px system-ui,sans-serif;cursor:pointer}
    #ism-panel button.main{background:linear-gradient(135deg,#6d28d9,#2563eb);border:0}
    #ism-log{max-height:120px;overflow:auto;font:11.5px/1.5 ui-monospace,monospace;color:#a9aec9;
      background:rgba(0,0,0,.35);border-radius:8px;padding:8px}
    #ism-log b{color:#8ef0b8}
    #ism-note{font-size:11.5px;color:#8f96b3}
    #ism-result{display:none;gap:6px;align-items:center;background:rgba(80,220,140,.12);border:1px solid rgba(80,220,140,.35);
      border-radius:8px;padding:8px 10px}
    #ism-result.on{display:flex}
    #ism-result code{font:12.5px ui-monospace,monospace;color:#a7f3c8;word-break:break-all}
  `);

  function el(tag, props, children) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    (children || []).forEach((c) => n.appendChild(c));
    return n;
  }

  let panel, logBox, statusEl, inputId, resultBox, resultCode;

  function log(msg) {
    if (!logBox) return;
    const line = document.createElement("div");
    line.textContent = msg;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function showResult(id) {
    if (!resultBox) return;
    resultCode.textContent = id;
    resultBox.classList.add("on");
  }

  function buildUI() {
    const fab = el("button", { id: "ism-fab", type: "button", textContent: "ISM · ambil aset" });
    panel = el("div", { id: "ism-panel" });
    const title = el("span", { textContent: "ISpooferMotion · ambil di sesimu" });
    const close = el("button", { type: "button", textContent: "✕" });
    close.style.flex = "none";
    close.style.width = "28px";
    close.onclick = () => panel.classList.remove("on");

    inputId = el("input", { type: "text", placeholder: "asset ID", inputMode: "numeric" });
    statusEl = el("div", { id: "ism-note", textContent: "siap" });
    logBox = el("div", { id: "ism-log" });
    logBox.innerHTML = "";

    const btnDownload = el("button", { type: "button", className: "main", textContent: "Ambil & unduh" });
    const btnSite = el("button", { type: "button", textContent: "Ambil & kirim ke situs" });
    const btnSettings = el("button", { type: "button", textContent: "Pengaturan" });

    resultBox = el("div", { id: "ism-result" });
    resultBox.appendChild(document.createTextNode("ID baru: "));
    resultCode = el("code", { textContent: "" });
    resultBox.appendChild(resultCode);

    const note = el("div", { id: "ism-note", textContent:
      "Cookie sesimu tidak dibaca dan tidak dikirim oleh script ini — browser yang melampirkannya ke Roblox. " +
      "Ke situs hanya dikirim byte file yang sudah jadi." });

    panel.appendChild(el("header", {}, [
      title,
      (() => { const w = el("span", {}); w.appendChild(close); return w; })()
    ]));
    const body = el("div", { className: "body" }, [
      inputId, el("div", { className: "row" }, [btnDownload, btnSite]), statusEl, logBox, resultBox,
      el("div", { className: "row" }, [btnSettings]), note
    ]);
    panel.appendChild(body);

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    fab.onclick = () => {
      panel.classList.toggle("on");
      const guess = assetIdFromUrl(location.href);
      if (guess && !inputId.value) inputId.value = guess;
    };

    btnDownload.onclick = () => run("download");
    btnSite.onclick = () => run("site");
    btnSettings.onclick = openSettings;
  }

  function currentId() {
    const v = String(inputId.value || "").trim();
    if (/^\d{3,}$/.test(v)) return v;
    const guess = assetIdFromUrl(location.href);
    if (guess) { inputId.value = guess; return guess; }
    return null;
  }

  async function run(mode) {
    const id = currentId();
    if (!id) { log("Isi asset ID dulu."); return; }
    const st = loadSettings();
    statusEl.textContent = "mengambil " + id + " …";
    try {
      const bytes = await fetchAssetBytes(id, st, log);
      log("Berhasil mengambil " + (bytes.length / 1024).toFixed(1) + " KB dari Roblox (memakai sesi browser ini).");
      if (mode === "download") {
        download(bytes, safeFileName(id), log);
        statusEl.textContent = "selesai (unduh)";
      } else {
        const newId = await sendToSite(bytes, id, st, log, statusEl);
        statusEl.textContent = "selesai (upload)";
        log("Tempel ID itu ke plugin: " + id + " = " + newId + ",");
      }
    } catch (e) {
      statusEl.textContent = "gagal";
      log("GAGAL: " + (e && e.message ? e.message : e));
    }
  }

  function openSettings() {
    const st = loadSettings();
    const site = prompt("Alamat situs ISpooferMotion (contoh: https://production-4df40a.up.railway.app):", st.site || "");
    if (site === null) return;
    const apiKey = prompt("Open Cloud API key (disimpan hanya di browser ini):", st.apiKey || "");
    if (apiKey === null) return;
    const userId = prompt("User ID tujuan (boleh dikosongkan kalau pakai Group ID):", st.userId || "");
    if (userId === null) return;
    const groupId = prompt("Group ID tujuan (boleh dikosongkan):", st.groupId || "");
    if (groupId === null) return;
    const placeId = prompt("Place ID game (opsional — isi kalau asetnya dibatasi sebuah game):", st.placeId || "");
    if (placeId === null) return;
    const clean = saveSettings({
      site: site.trim(), apiKey: apiKey.trim(), userId: userId.trim(),
      groupId: groupId.trim(), placeId: placeId.trim(),
      gameId: st.gameId || uuidish()
    });
    log("Pengaturan disimpan di browser ini." + (looksLikeApiKey(clean.apiKey) ? "" : " (Catatan: panjang kunci " + clean.apiKey.length + " karakter — kunci Open Cloud biasanya ~48.)"));
    statusEl.textContent = clean.site ? "siap · " + clean.site : "alamat situs belum diisi";
  }

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("ISM · ambil aset", () => { buildUI(); panel.classList.add("on"); inputId.value = assetIdFromUrl(location.href) || ""; });
    GM_registerMenuCommand("ISM · pengaturan", () => { buildUI(); openSettings(); });
  }

  buildUI();
  inputId.value = assetIdFromUrl(location.href) || "";
  statusEl.textContent = loadSettings().site ? "siap · " + loadSettings().site : "siap · atur situs dulu di Pengaturan";
})();
