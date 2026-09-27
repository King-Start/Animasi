/**
 * Klien Roblox untuk ISpooferMotion Web.
 *
 * Aturan keras yang dipegang file ini:
 *  1. TIDAK pernah menyentuh cookie sesi. Auth hanya dua jalur resmi:
 *     Open Cloud API key (`x-api-key`) atau OAuth 2.0 (`Authorization: Bearer`).
 *  2. Fetch (ambil isi aset) memakai endpoint publik yang memang tidak butuh auth,
 *     jadi tidak ada kredensial yang dipakai di langkah ini.
 *  3. Upload menyalin byte apa adanya (byte-for-byte) — tidak ada re-encode, tidak
 *     ada parsing yang bisa merusak isi animasi.
 *
 * Semua base URL bisa di-override supaya bisa diuji terhadap server tiruan.
 */
import { createHash } from "node:crypto";

export const DEFAULTS = {
  apisBase: "https://apis.roblox.com",
  assetDeliveryBase: "https://assetdelivery.roblox.com",
  oauthBase: "https://apis.roblox.com/oauth/v1",
  usersBase: "https://users.roblox.com",
  // Daftar aset milik seorang kreator (publik, tanpa kredensial). Dipakai untuk
  // menemukan kembali aset yang sudah jadi diupload Roblox tapi belum terkonfirmasi.
  inventoryBase: "https://inventory.roblox.com",
  // Aset publik yang dipakai untuk menguji kunci (read-only, tidak mengubah apa pun)
  probeAssetId: "180435571",
  maxAssetBytes: 20 * 1024 * 1024, // batas 20 MB dari dokumentasi Open Cloud
  userAgent: "ISpooferMotion-Web/1.0 (+https://github.com/ISpooferMotion)",
  // Roblox menolak sebagian User-Agent dari IP data center. Daftar ini ditiru dari
  // ISpooferMotion V2 (src-tauri/.../spoofer/download/api.rs) yang mencoba bergilir.
  userAgents: [
    "Roblox/WinInet",
    "RobloxStudio/WinInet",
    "RobloxApp/WinInet",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "ISpooferMotion-Web/1.0 (+https://github.com/ISpooferMotion)"
  ],
  allowedAssetHosts: [], // tambahan host yang diizinkan; default hanya host Roblox
  probeAssetId: "180435571", // aset publik untuk uji fungsi kunci
  inventoryBase: "https://inventory.roblox.com",
  assetTypeIdAnimation: 24
};

/** Karakter non-ASCII pertama di sebuah kunci (atau null kalau semua ASCII). */
export function firstNonAscii(value) {
  const m = String(value == null ? "" : value).match(/[^\x20-\x7E]/);
  return m ? m[0] : null;
}

/** Penanda cookie sesi Roblox — dua bentuk yang dipakai Roblox selama ini. */
const COOKIE_MARKER = /DO-NOT-SHARE|Sharing-this-will-allow/i;

/**
 * Menebak JENIS kredensial dari bentuknya (bukan dari isinya, dan tidak pernah
 * mengembalikan nilainya). Dipakai supaya situs ini tidak pernah diam-diam
 * meneruskan cookie sesi Roblox ke mana pun.
 */
export function classifyCredential(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { kind: "empty", length: 0, label: "kosong" };
  const cleaned = normalizeApiKey(s);
  const length = cleaned.length;
  if (COOKIE_MARKER.test(s) || /^_\|/.test(s) || /\|_/.test(s)) {
    return { kind: "cookie", length, label: "cookie sesi Roblox (.ROBLOSECURITY)" };
  }
  if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(cleaned)) {
    return { kind: "jwt", length, label: "token OAuth (JWT)" };
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) {
    if (length <= 96) return { kind: "apikey", length, label: "kunci API Open Cloud" };
    return {
      kind: "opaque-long",
      length,
      label: `kredensial ${length} karakter — bukan bentuk kunci API Open Cloud (biasanya ~48)`
    };
  }
  return { kind: "unknown", length, label: "bentuk kredensial tidak dikenal" };
}

export class RobloxError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = "RobloxError";
    this.code = info.code ?? "unknown";
    this.status = info.status ?? 0;
    this.retryable = info.retryable ?? false;
    this.detail = info.detail;
  }
}

/* ------------------------------------------------------------------ utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Handle kemungkinan isi aset ter-gzip. Perlu hati-hati karena ada DUA jalur:
 *  a) CDN mengirim gzip lewat header `content-encoding`, dan runtime fetch (undici)
 *     sering sudah men-decompress sendiri tanpa membuang header itu;
 *  b) URL memakai `?encoding=gzip` dan body-nya memang gzip mentah.
 * Jadi jangan percaya header — periksa magic bytes (1f 8b), dan kalau decompress
 * gagal, pakai byte aslinya. Salah di sini bikin aset rusak (dan upload-nya ditolak).
 */
function looksLikeGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function maybeGunzip(bytes, _contentEncoding) {
  if (!looksLikeGzip(bytes)) return bytes;
  if (typeof DecompressionStream === "undefined") return bytes;
  try {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    const out = new Uint8Array(buf);
    return out.length ? out : bytes;
  } catch {
    // sudah didecompress runtime, atau body bukan gzip valid → pakai apa adanya
    return bytes;
  }
}

/**
 * PENTING: parameter `encoding=gzip` JANGAN dibuang dari URL CDN.
 * Uji langsung ke Roblox menunjukkan tanpa parameter itu CDN menjawab
 * HTTP 403 (error edge Akamai), sedangkan dengan parameter itu 200 +
 * `content-encoding: gzip`. Karena itu URL diambil apa adanya, dan urusan
 * dekompresi diserahkan ke runtime + pengecekan magic bytes di maybeGunzip().
 */
function keepLocationAsIs(location) {
  try {
    return new URL(location).toString();
  } catch {
    return location;
  }
}

/**
 * Cegah SSRF: URL isi aset harus host Roblox. Daftar tambahan bisa diberikan
 * lewat config `allowedAssetHosts` (mis. untuk mirror CDN atau server tiruan
 * saat pengujian) — jangan diisi dengan host sembarangan di produksi.
 */
export const DEFAULT_ASSET_HOSTS = ["rbxcdn.com", "*.rbxcdn.com", "*.roblox.com", "roblox.com"];

export function isAllowedAssetHost(location, extraHosts = []) {
  try {
    const host = new URL(location).hostname.toLowerCase();
    const patterns = [...DEFAULT_ASSET_HOSTS, ...extraHosts];
    return patterns.some((p) => {
      const pat = String(p).toLowerCase().trim();
      if (!pat) return false;
      if (pat.startsWith("*.")) return host === pat.slice(2) || host.endsWith(pat.slice(1));
      return host === pat;
    });
  } catch {
    return false;
  }
}

/* --------------------------------------------------------- tipe aset */

const ASSET_TYPE_NAMES = {
  3: "Audio",
  10: "Model",
  13: "Decal",
  24: "Animation",
  38: "Plugin",
  40: "Mesh",
  62: "Video"
};

export function assetTypeName(assetTypeId) {
  return ASSET_TYPE_NAMES[Number(assetTypeId)] || (assetTypeId ? "Type#" + assetTypeId : "?");
}

/** Jenis konten yang diterima Open Cloud, per dokumentasi Assets API. */
const CONTENT_TYPES = {
  Animation: "model/x-rbxm",
  Model: "model/x-rbxm",
  Audio: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/flac"],
  Decal: ["image/png", "image/jpeg", "image/bmp", "image/tga"],
  Image: ["image/png", "image/jpeg", "image/bmp", "image/tga"],
  Video: ["video/mp4", "video/mov"]
};

export function contentTypeFor(assetType, fileName = "") {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  const byExtension = {
    rbxm: "model/x-rbxm", rbxmx: "model/x-rbxm", rbx: "model/x-rbxm",
    ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", bmp: "image/bmp", tga: "image/tga",
    mp4: "video/mp4", mov: "video/mov", fbx: "model/fbx", gltf: "model/gltf+json", glb: "model/gltf-binary"
  };
  const wanted = CONTENT_TYPES[assetType];
  const candidate = byExtension[ext];
  if (Array.isArray(wanted)) return wanted.includes(candidate) ? candidate : wanted[0];
  return candidate || (typeof wanted === "string" ? wanted : "application/octet-stream");
}

export function guessAssetTypeFromFile(fileName) {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  if (ext === "rbxm" || ext === "rbxmx" || ext === "rbx") return "Animation";
  if (["ogg", "mp3", "wav", "flac"].includes(ext)) return "Audio";
  if (["png", "jpg", "jpeg", "bmp", "tga"].includes(ext)) return "Decal";
  if (["mp4", "mov"].includes(ext)) return "Video";
  if (["fbx", "gltf", "glb"].includes(ext)) return "Model";
  return "Animation";
}

/* ------------------------------------------------ parsing error Roblox */
/**
 * Roblox sering menjawab HTTP 200 walau isinya error, mis:
 *   {"errors":[{"code":401,"message":"Authentication required to access Asset."}]}
 * Jadi status code saja tidak cukup — isi body harus diperiksa.
 */
function detectBodyError(body, status) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.errors) && body.errors.length) {
    const e = body.errors[0];
    return new RobloxError(e.message || "Roblox menolak permintaan", {
      code: e.code ?? status,
      status,
      retryable: e.code === 429 || e.code >= 500
    });
  }
  return null;
}

/* --------------------------------------------------- OAuth 2.0 helpers */

export function buildAuthorizeUrl(cfg, { state, nonce, redirectUri }) {
  const url = new URL(cfg.oauthBase.replace(/\/$/, "") + "/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", cfg.scopes || "asset:read asset:write");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompts", "login consent");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(cfg, { code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret
  });
  const res = await (cfg.fetch || fetch)(cfg.oauthBase.replace(/\/$/, "") + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.access_token) {
    throw new RobloxError("Gagal menukar authorization code jadi access token", {
      code: (json && json.error) || res.status, status: res.status, detail: json
    });
  }
  return json; // { access_token, refresh_token, expires_in, ... }
}

export async function fetchUserInfo(cfg, accessToken) {
  const res = await (cfg.fetch || fetch)(cfg.oauthBase.replace(/\/$/, "") + "/userinfo", {
    headers: { authorization: "Bearer " + accessToken, accept: "application/json" }
  });
  if (!res.ok) return null;
  return res.json().catch(() => null); // { sub, preferred_username, ... }
}

/* -------------------------------------------- normalisasi & pesan error */

/**
 * Kunci API sering tersalin dengan spasi/newline/kutip di ujung — itu saja
 * sudah cukup bikin Roblox menolak dengan "not provided in a valid format".
 */
export function normalizeApiKey(raw) {
  // Catatan: \s di JavaScript TIDAK mencakup U+200B (zero width space), U+200C/U+200D,
  // U+2060, dan U+FEFF. Karakter itu sering ikut tersalin dari halaman web / HP, dan
  // kalau lolos ke header HTTP, fetch langsung melempar "Cannot convert argument to a
  // ByteString" (bukan pesan Roblox). Jadi dibuang eksplisit di sini.
  return String(raw == null ? "" : raw)
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, "");
}

/**
 * Terjemahkan pesan error Roblox jadi penjelasan + langkah perbaikan.
 * Dipakai agar user tahu harus apa, bukan cuma melihat kalimat Inggris mentah.
 */
export function explainError(message) {
  const m = String(message || "");
  const rules = [
    [/not provided in a valid format/i,
      "Format kunci tidak valid — biasanya kuncinya kepotong atau ada spasi ikut tersalin. Copy ulang SELURUH kunci dari Creator Dashboard, API Keys."],
    [/invalid api key/i,
      "Kunci API ditolak: salah, sudah dicabut, atau tidak lengkap. Copy ulang di create.roblox.com, Credentials, API Keys."],
    [/ip address|restrict|not allowed from/i,
      "Kunci API ini dibatasi IP. Matikan 'Restrict IP addresses' di pengaturan kunci, atau tambahkan IP server ini ke daftar izin."],
    [/expired/i,
      "Kunci API sudah kedaluwarsa. Buat kunci baru dengan masa berlaku lebih panjang."],
    [/does not have permission|permission to perform|insufficient|not authorized to create|unauthorized|forbidden/i,
      "Kunci API belum diberi izin lengkap. Di key-nya: Access Permissions, pilih API Assets, centang operasi Read DAN Write."],
    [/creator|authorized user|must match/i,
      "Target upload tidak cocok dengan pemilik kunci. User ID tujuan harus sama dengan akun pemilik kunci API (atau pakai Group ID yang kuncinya punya akses)."],
    [/moderat|pending review/i,
      "Aset masuk moderasi Roblox. Cek Creator Dashboard beberapa saat lagi."],
    [/too many requests|rate limit|quota|cdn sibuk.*429/i,
      "Kena batas permintaan Roblox (429). Roblox membatasi per-IP, dan IP server/data center sering dipakai bersama. Tunggu 1-2 menit lalu ulangi — atau ambil lewat userscript ism-fetch.user.js (jalan dari IP-mu, tidak kena batas ini)."],
    [/invalid authentication data provided/i,
      "Roblox menolak permintaan ini di pintu masuk (bukan soal asetnya) — biasanya IP server ini dibatasi Roblox. Coba ulangi; kalau terus terjadi, jalankan server di komputermu sendiri atau pakai userscript ism-fetch.user.js yang mengambil dari IP-mu."],
    [/gagal mengambil isi aset \(http 403|http 403 dari/i,
      "Roblox menolak permintaan dari IP server ini (403) walau asetnya publik. Jalankan server di komputermu sendiri, atau pakai userscript ism-fetch.user.js yang mengambil dari IP-mu."],
    [/file size|too large|exceeds|20 ?MB|maximum size/i,
      "File melebihi batas 20 MB per aset."],
    [/assettype|asset type/i,
      "Tipe aset tidak didukung untuk upload. Animasi: .rbxm/.rbxmx. Audio: .ogg/.mp3/.wav/.flac."],
    [/invalid file|corrupt|malformed|failed to parse/i,
      "File-nya tidak bisa dibaca Roblox. Ekspor ulang dari Roblox Studio sebagai .rbxm atau .rbxmx."],
    [/authentication required to access asset|not authorized to access asset/i,
      "Aset ini dibatasi: hanya sesi Roblox yang login boleh mengambil isinya, dan kunci API tidak bisa mengambil aset milik kreator lain. Dua jalan: (1) isi Place ID game tempat animasi ini dipakai, lalu jalankan ulang; (2) unduh file .rbxm-nya lewat ekstensi/ALECTRA di browser-mu, lalu pakai tab 'Dari file lokal'."],
    [/was not found|not found/i,
      "Asset ID tidak ditemukan: ID-nya salah, sudah dihapus, atau bukan aset publik."],
    [/wrong-type/i,
      "ID ini bukan Animation (mungkin Audio/Decal/Mesh). Untuk tipe lain, pakai tab 'Dari file lokal'."],
    [/timeout|belum selesai/i,
      "Roblox belum selesai memproses. Cek Creator Dashboard, asetnya sering tetap muncul."],
    [/gzip|decompress|incorrect header/i,
      "Isi aset dari CDN rusak saat diunduh. Coba jalankan ulang."]
  ];
  for (const [re, hint] of rules) if (re.test(m)) return hint;
  return null;
}

/* ------------------------------------------------------------- klien */

export function createRobloxClient(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const doFetch = cfg.fetch || fetch;

  function authHeaders(auth) {
    if (!auth) throw new RobloxError("Kredensial belum diisi. Butuh Open Cloud API key atau login OAuth.", { code: 401 });
    if (auth.kind === "apikey") {
      if (!auth.apiKey || String(auth.apiKey).length < 8) {
        throw new RobloxError("API key kosong atau terlalu pendek.", { code: 401 });
      }
      const credKind = classifyCredential(auth.apiKey);
      if (credKind.kind === "cookie") {
        throw new RobloxError(
          "Nilai di kolom kunci terlihat seperti cookie sesi Roblox. Server ini tidak meneruskan cookie ke mana pun. " +
            "Buat kunci API Open Cloud di create.roblox.com \u2192 Credentials \u2192 API Keys.",
          { code: 401 }
        );
      }
      const bad = firstNonAscii(normalizeApiKey(auth.apiKey));
      if (bad) {
        throw new RobloxError(
          `Kunci API memuat karakter non-ASCII (${JSON.stringify(bad)}) sehingga tidak bisa dikirim ke Roblox. ` +
            "Copy ulang kunci dari Creator Dashboard.",
          { code: 401 }
        );
      }
      return { "x-api-key": auth.apiKey };
    }
    if (auth.kind === "oauth") {
      if (!auth.accessToken) throw new RobloxError("Access token OAuth tidak ada.", { code: 401 });
      return { authorization: "Bearer " + auth.accessToken };
    }
    throw new RobloxError("Jenis kredensial tidak dikenal: " + auth.kind, { code: 401 });
  }

  /* --- 1. resolusi: ID -> daftar lokasi isi aset (TANPA auth) --- */
  /** Daftar User-Agent yang akan dicoba berurutan. */
  function userAgentList() {
    const list = Array.isArray(cfg.userAgents) && cfg.userAgents.length ? cfg.userAgents.slice() : [cfg.userAgent];
    if (cfg.userAgent && !list.includes(cfg.userAgent)) list.push(cfg.userAgent);
    return list;
  }

  /**
   * Coba satu endpoint dengan beberapa User-Agent bergilir.
   * Mengembalikan juga riwayat percobaan supaya kegagalan bisa dijelaskan apa adanya
   * (diblokir IP vs kena batas vs butuh login).
   */
  async function fetchWithAgents(url, init, { acceptStatuses = [] } = {}) {
    const attempts = [];
    let last = null;
    for (const ua of userAgentList()) {
      let res;
      try {
        res = await doFetch(url, { ...init, headers: { ...(init.headers || {}), "user-agent": ua } });
      } catch (err) {
        attempts.push({ ua, status: 0, message: err && err.message ? err.message : String(err) });
        last = { res: null, ua, error: err };
        continue;
      }
      attempts.push({ ua, status: res.status });
      last = { res, ua };
      // berhasil, atau status yang memang kita terima (mis. 302 → baca Location)
      if (res.ok || acceptStatuses.includes(res.status)) return { ...last, attempts };
      // hanya status "dinding" yang layak dicoba dengan UA lain
      if (![401, 403, 429].includes(res.status)) return { ...last, attempts };
      await sleep(150);
    }
    return { ...(last || { res: null, ua: null }), attempts };
  }

  async function resolveAsset(assetId, { placeId } = {}) {
    const id = String(assetId).trim();
    if (!/^\d{4,}$/.test(id)) {
      throw new RobloxError("Bukan asset ID yang valid: " + id, { code: 400 });
    }
    const attemptsAll = [];

    // jalur utama: v2 (jawabannya JSON berisi lokasi CDN)
    const v2 = new URL(`${cfg.assetDeliveryBase.replace(/\/$/, "")}/v2/assetId/${id}`);
    if (placeId) v2.searchParams.set("placeId", String(placeId));

    const v2Try = await fetchWithAgents(v2.toString(), {
      headers: { accept: "application/json" },
      redirect: "follow"
    });
    attemptsAll.push(...v2Try.attempts.map((a) => ({ ...a, endpoint: "v2/assetId" })));
    const res = v2Try.res;
    let body = res ? await res.json().catch(() => null) : null;

    const bodyErr = body
      ? detectBodyError(body, res.status)
      : new RobloxError("Tidak bisa menghubungi assetdelivery: " + (v2Try.error && v2Try.error.message ? v2Try.error.message : "tidak ada balasan"), { code: 502 });
    // Roblox sering mengirim {"errors":[{"code":0,…}]} — kode HTTP-nya yang informatif
    // (401/403/429). Simpan supaya UI bisa membedakan butuh login vs diblokir vs kena batas.
    if (bodyErr && !Number(bodyErr.code)) bodyErr.code = res.status;
    if (bodyErr) {
      // fallback: v1 mengembalikan redirect (302) ke CDN
      const v1 = new URL(`${cfg.assetDeliveryBase.replace(/\/$/, "")}/v1/asset`);
      v1.searchParams.set("id", id);
      if (placeId) v1.searchParams.set("placeId", String(placeId));
      const v1Try = await fetchWithAgents(v1.toString(), { headers: { accept: "*/*" }, redirect: "manual" }, { acceptStatuses: [302, 301, 303, 307, 308] });
      attemptsAll.push(...v1Try.attempts.map((a) => ({ ...a, endpoint: "v1/asset" })));
      const res1 = v1Try.res;
      if (!res1) {
        throw new RobloxError("Tidak bisa menghubungi assetdelivery (v1) sama sekali.", { code: 502, detail: { attempts: attemptsAll } });
      }
      const loc = res1.headers.get("location");
      if (loc) return { assetId: id, locations: [keepLocationAsIs(new URL(loc, v1).toString())], assetTypeId: null };
      if (res1.status === 200) {
        const bytes = new Uint8Array(await res1.arrayBuffer());
        return { assetId: id, inline: bytes, locations: [], assetTypeId: null };
      }
      bodyErr.detail = { ...(bodyErr.detail || {}), attempts: attemptsAll };
      throw bodyErr;
    }

    const locations = Array.isArray(body?.locations)
      ? body.locations.map((l) => l.location).filter(Boolean)
      : [];
    if (!locations.length) {
      throw new RobloxError("Roblox tidak memberi lokasi isi untuk aset ini.", { code: 404, detail: body });
    }
    return { assetId: id, locations, assetTypeId: body.assetTypeId ?? null, raw: body };
  }

  /* --- 2. download isi aset (TANPA auth) --- */
  async function downloadAsset(assetId, opts = {}) {
    const resolved = await resolveAsset(assetId, opts);
    if (resolved.inline) {
      const bytes = resolved.inline;
      if (bytes.length > cfg.maxAssetBytes) {
        throw new RobloxError(`Aset lebih besar dari batas ${cfg.maxAssetBytes / 1048576} MB.`, { code: 413 });
      }
      return { assetId: resolved.assetId, bytes, sha256: sha256(bytes), bytesLength: bytes.length,
        assetTypeId: resolved.assetTypeId, assetType: assetTypeName(resolved.assetTypeId), location: null };
    }

    let lastError = null;
    for (const location of resolved.locations) {
      if (!isAllowedAssetHost(location, cfg.allowedAssetHosts)) {
        lastError = new RobloxError("Lokasi isi bukan host Roblox — dibatalkan (proteksi SSRF).", { code: 400 });
        continue;
      }
      const url = keepLocationAsIs(location);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tried = await fetchWithAgents(url, { headers: { accept: "*/*" }, redirect: "follow" });
          const res = tried.res;
          if (!res) {
            lastError = new RobloxError("Tidak bisa menghubungi CDN Roblox: " + (tried.error && tried.error.message ? tried.error.message : "tanpa balasan"), { code: 502, retryable: true });
            await sleep(400 * (attempt + 1));
            continue;
          }
          if (res.status === 429 || res.status >= 500) {
            lastError = new RobloxError(
              "CDN sibuk (HTTP " + res.status + ")" + (res.status === 429 ? " — server ini kena batas permintaan Roblox, coba lagi sebentar lagi atau pakai tab 'Dari file lokal'." : ""),
              { code: res.status, retryable: true }
            );
            await sleep(400 * (attempt + 1));
            continue;
          }
          if (!res.ok) {
            lastError = new RobloxError(
              "Gagal mengambil isi aset (HTTP " + res.status + " dari " + (tried.ua || "?") + ")", { code: res.status }
            );
            break;
          }
          const raw = new Uint8Array(await res.arrayBuffer());
          const bytes = await maybeGunzip(raw, res.headers.get("content-encoding"));
          if (bytes.length > cfg.maxAssetBytes) {
            throw new RobloxError(`Aset ${bytes.length} byte melebihi batas ${cfg.maxAssetBytes / 1048576} MB.`, { code: 413 });
          }
          if (!bytes.length) {
            lastError = new RobloxError("Isi aset kosong.", { code: 502, retryable: true });
            continue;
          }
          return {
            assetId: resolved.assetId, bytes, sha256: sha256(bytes), bytesLength: bytes.length,
            assetTypeId: resolved.assetTypeId, assetType: assetTypeName(resolved.assetTypeId), location: url
          };
        } catch (err) {
          lastError = err instanceof RobloxError ? err : new RobloxError("Error jaringan saat mengambil aset: " + err.message, { retryable: true });
          await sleep(400 * (attempt + 1));
        }
      }
    }
    throw lastError || new RobloxError("Semua lokasi isi gagal diambil.", { code: 502 });
  }

  /* --- 3. upload ke Open Cloud (auth: API key atau OAuth) --- */
  async function uploadAsset({ bytes, fileName, assetType, displayName, description, creator, auth }) {
    if (!bytes || !bytes.length) throw new RobloxError("Tidak ada byte untuk di-upload.", { code: 400 });
    if (bytes.length > cfg.maxAssetBytes) {
      throw new RobloxError(`File ${(bytes.length / 1048576).toFixed(1)} MB melebihi batas 20 MB.`, { code: 413 });
    }
    const creatorId = String(creator?.userId || creator?.groupId || "").trim();
    if (!/^\d+$/.test(creatorId)) {
      throw new RobloxError("Target upload tidak valid. Isi User ID atau Group ID tujuan.", { code: 400 });
    }

    const request = {
      assetType,
      displayName: (displayName || "ISM Asset").slice(0, 50),
      description: (description || "Uploaded via ISpooferMotion Web").slice(0, 1000),
      creationContext: creator.groupId ? { creator: { groupId: creatorId } } : { creator: { userId: creatorId } }
    };

    const form = new FormData();
    form.append("request", JSON.stringify(request));
    form.append(
      "fileContent",
      new Blob([bytes], { type: contentTypeFor(assetType, fileName) }),
      fileName || "asset.rbxm"
    );

    const url = `${cfg.apisBase.replace(/\/$/, "")}/assets/v1/assets`;
    let res, json;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await doFetch(url, { method: "POST", headers: authHeaders(auth), body: form });
      json = await res.json().catch(() => null);
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 800 * (attempt + 1);
        await sleep(Math.min(wait, 8000));
        continue;
      }
      break;
    }

    if (!res.ok) {
      const msg = (json && json.errors && json.errors[0] && json.errors[0].message) || ("HTTP " + res.status);
      throw new RobloxError("Upload ditolak Roblox: " + msg, {
        code: (json?.errors?.[0]?.code) ?? res.status,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500
      });
    }

    return {
      operationPath: json?.path || null,
      operationId: json?.operationId || (json?.path ? String(json.path).split("/").pop() : null),
      done: !!json?.done,
      immediateAssetId: json?.response?.assetId || null
    };
  }

  /**
   * Uji IZIN UPLOAD tanpa membuat aset apa pun.
   *
   * Permintaannya SENGAJA tidak lengkap (tidak ada berkas) dan memakai assetType yang
   * tidak dikenal, jadi Roblox pasti menolak di tahap validasi isi — tidak ada aset
   * yang tercipta. Yang kita baca adalah URUTAN penolakannya:
   *   - kalau KUNCI/IZIN/IP yang bermasalah, penolakan datang lebih dulu (401/403/429);
   *   - kalau jawabannya 400 "isi permintaan tidak valid", artinya kunci & izin sudah
   *     diterima sampai tahap validasi → masalahnya bukan di kunci.
   * Ini yang membedakan "kunci kurang izin Write" dari "IP server ditolak Roblox".
   */
  async function probeUploadPermission({ auth, creator, assetType = "Animation" } = {}) {
    const creatorId = String((creator && (creator.userId || creator.groupId)) || "").trim();
    const url = `${cfg.apisBase.replace(/\/$/, "")}/assets/v1/assets`;
    const payload = {
      assetType: "__ism_preflight__",
      displayName: "ISM preflight (tidak diunggah)",
      creationContext: creator && creator.groupId
        ? { creator: { groupId: creatorId } }
        : { creator: { userId: creatorId } }
    };

    let status = 0, text = "", json = null, netErr = null;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { ...authHeaders(auth), "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      status = res.status;
      text = await res.text().catch(() => "");
      try { json = JSON.parse(text); } catch { /* balasan bukan JSON (biasanya halaman blokir) */ }
    } catch (e) {
      netErr = e;
    }

    const raw = String(
      (json && json.errors && json.errors[0] && json.errors[0].message) || text || (netErr && netErr.message) || ""
    ).slice(0, 400);
    const low = raw.toLowerCase();
    const isHtml = /^\s*</.test(text) || /<html/i.test(text);

    let verdict, hint, ok = false;
    if (netErr && /cookie sesi/i.test(String(netErr.message || ""))) {
      verdict = "cookie-refused";
      hint = "Yang ditempel berbentuk cookie sesi Roblox. Server ini tidak pernah meneruskan cookie — buat Open Cloud API key di create.roblox.com → Credentials → API Keys.";
    } else if (netErr) {
      verdict = "network";
      hint = "Server tidak berhasil menghubungi Roblox dari mesin ini. Coba lagi, atau jalankan server di komputermu.";
    } else if (status === 400 && /api key is not provided in a valid format|invalid authentication data/i.test(raw)) {
      verdict = "key-format";
      hint = "Bentuk kuncinya ditolak Roblox. Salin ulang kunci dari create.roblox.com → Credentials → API Keys (jangan pakai cookie).";
    } else if (status === 400) {
      ok = true;
      verdict = "ok";
      hint = "Kunci diterima sampai tahap validasi isi permintaan (400 memang diharapkan di uji ini). Ini artinya masalahnya BUKAN di kunci/izin.";
    } else if (status === 401) {
      verdict = "key-rejected";
      hint = "Kunci ditolak: kemungkinan kedaluwarsa, salah salin, atau belum punya izin Write untuk kredensial ini.";
    } else if (status === 403 && /permission|not authorized|forbidden|creator/i.test(raw)) {
      verdict = "scope";
      hint = "Kunci benar, tapi BELUM BOLEH menulis ke target itu. Di create.roblox.com → API Keys → Edit: centang operasi **Write** pada API Assets, dan pastikan User/Group ID tujuannya ada di daftar yang diizinkan.";
    } else if (status === 403 && isHtml) {
      verdict = "blocked-waf";
      hint = "Roblox menjawab dengan halaman blokir (bukan pesan API). Biasanya karena IP server ini dicurigai. Jalankan server di komputermu sendiri, atau pakai userscript dari browser.";
    } else if (status === 403) {
      verdict = "blocked";
      hint = "Roblox menolak permintaan dari IP server ini (bukan soal kuncimu). Jalankan server di komputermu sendiri, atau pakai userscript dari browser.";
    } else if (status === 429) {
      verdict = "rate-limited";
      hint = "Kena batas permintaan Roblox (per-IP). Tunggu 1–2 menit, atau jalankan server lokal.";
    } else if (status === 404) {
      verdict = "wrong-endpoint";
      hint = "Alamat API tidak dikenal server ini. Ganti alamat server (deploy ulang versi terbaru).";
    } else if (status >= 500) {
      verdict = "roblox-down";
      hint = "Roblox sendiri sedang bermasalah (5xx). Coba lagi beberapa menit.";
    } else {
      verdict = "unknown";
      hint = "Balasan tak terduga — kirim laporan ini supaya bisa diperiksa.";
    }

    return {
      ok, verdict, status, message: raw || ("HTTP " + status), htmlBlock: isHtml,
      target: creator && creator.groupId ? { groupId: creatorId } : { userId: creatorId },
      endpoint: url,
      hint
    };
  }

  /**
   * Uji IZIN UPLOAD tanpa membuat aset apa pun.
   *
   * Permintaannya SENGAJA tidak lengkap (tidak ada berkas) dan memakai assetType yang
   * tidak dikenal, jadi Roblox pasti menolak di tahap validasi isi — tidak ada aset
   * yang tercipta. Yang kita baca adalah URUTAN penolakannya:
   *   - kalau KUNCI/IZIN/IP yang bermasalah, penolakan datang lebih dulu (401/403/429);
   *   - kalau jawabannya 400 "isi permintaan tidak valid", artinya kunci & izin sudah
   *     diterima sampai tahap validasi → masalahnya bukan di kunci.
   * Ini yang membedakan "kunci kurang izin Write" dari "IP server ditolak Roblox".
   */
  /* --- 4. tunggu operasi selesai -> asset ID baru --- */
  async function pollOperation(operation, auth, { timeoutMs = 60000, intervalMs = 900 } = {}) {
    const auth2 = authHeaders(auth);
    const deadline = Date.now() + timeoutMs;
    let op = operation;

    if (op.immediateAssetId) return { assetId: String(op.immediateAssetId), attempts: 0 };

    while (Date.now() < deadline) {
      const path = op.operationPath
        ? (String(op.operationPath).startsWith("http") ? op.operationPath : `${cfg.apisBase.replace(/\/$/, "")}/${String(op.operationPath).replace(/^\//, "")}`)
        : `${cfg.apisBase.replace(/\/$/, "")}/assets/v1/operations/${op.operationId}`;

      const res = await doFetch(path, { headers: { ...auth2, accept: "application/json" } });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (json && json.errors && json.errors[0] && json.errors[0].message) || ("HTTP " + res.status);
        throw new RobloxError("Gagal cek status operasi: " + msg, { code: res.status, status: res.status });
      }
      if (json?.error) {
        throw new RobloxError("Upload gagal diproses Roblox: " + (json.error.message || json.error.code), { code: "operation-failed" });
      }
      const assetId = json?.response?.assetId || json?.assetId;
      if (json?.done && assetId) return { assetId: String(assetId), raw: json };
      if (json?.done && !assetId) {
        throw new RobloxError("Operasi selesai tapi Roblox tidak memberi asset ID.", { code: "no-asset-id", detail: json });
      }
      await sleep(intervalMs);
    }
    // PENTING: jangan pernah meng-upload ulang karena timeout — upload pertama
    // biasanya SUDAH jadi di Roblox, cuma jawabannya belum turun. Yang benar:
    // tandai "belum pasti", lalu lanjutkan memeriksa operasi yang sama.
    const err = new RobloxError(
      "Roblox belum memberi jawaban akhir setelah " + Math.round(timeoutMs / 1000) +
        " detik. Upload-nya biasanya tetap jadi — ID-nya menyusul.",
      { code: "timeout" }
    );
    err.uncertain = true;
    err.operation = { operationId: op.operationId || null, operationPath: op.operationPath || null };
    throw err;
  }

  /* --- diagnosa: periksa kunci API tanpa meng-upload apa pun --- */
  async function introspectKey(apiKey) {
    const url = `${cfg.apisBase.replace(/\/$/, "")}/api-keys/v1/introspect`;
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "x-api-key": normalizeApiKey(apiKey),
        "content-type": "application/json",
        accept: "application/json"
      },
      body: "{}"
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body: json };
  }

  async function getUserProfile(userId) {
    try {
      const base = cfg.usersBase.replace(/\/$/, "");
      const res = await doFetch(`${base}/v1/users/${encodeURIComponent(String(userId))}`, {
        headers: { accept: "application/json" }
      });
      if (!res.ok) return null;
      const j = await res.json();
      return { id: String(j.id ?? userId), name: j.name || null, displayName: j.displayName || null };
    } catch {
      return null;
    }
  }

  /**
   * Periksa kunci: aktif? punya izin Assets:Write? boleh dipakai untuk target
   * User ID / Group ID yang diisi? Hasilnya daftar temuan yang bisa langsung
   * ditindaklanjuti, bukan cuma "gagal".
   */
  /**
   * Statistik bentuk kunci yang benar-benar diterima server.
   * SENGAJA hanya mengembalikan hitungan & penanda — bukan kuncinya.
   */
  function describeKeyShape(raw) {
    const s = String(raw == null ? "" : raw);
    const cleaned = normalizeApiKey(s);
    const hiddenList = s.match(/[\u00A0\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g) || [];
    const nonAsciiList = s.match(/[^\x09\x0A\x0D\x20-\x7E]/g) || [];
    const spaces = (s.match(/\s/g) || []).length;
    const allowed = /^[A-Za-z0-9+/=_-]+$/;
    const odd = [...new Set(cleaned.split("").filter((c) => !/[A-Za-z0-9+/=_-]/.test(c)))];
    const stats = {
      rawLength: s.length,
      length: cleaned.length,
      hiddenChars: hiddenList.length,
      nonAscii: nonAsciiList.length,
      spaces,
      odd,
      trimmed: s !== cleaned,
      asciiOnly: /^[\x20-\x7E]*$/.test(cleaned),
      alphabetOk: allowed.test(cleaned)
    };
    return { cleaned, stats };
  }

  function rawMessage(res) {
    const b = res && res.body;
    if (!b) return "HTTP " + ((res && res.status) || 0);
    if (typeof b === "string") return b;
    if (b.message) return String(b.message);
    if (b.errors && b.errors[0] && b.errors[0].message) return String(b.errors[0].message) || "HTTP " + res.status;
    return "HTTP " + res.status;
  }

  /** Satu panggilan uji ke API Roblox memakai kunci user. */
  async function runProbe({ id, label, url, apiKey }) {
    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: { "x-api-key": apiKey, accept: "application/json" }
      });
      const body = await res.json().catch(() => null);
      const out = { id, label, status: res.status, ok: res.ok, message: rawMessage({ status: res.status, body }) };
      return out;
    } catch (e) {
      return { id, label, status: 0, ok: false, message: e && e.message ? e.message : "gagal konek" };
    }
  }

  /**
   * Uji fungsi kunci: ini jalur auth yang sama dengan upload, jadi hasilnya
   * jauh lebih bisa dipercaya daripada endpoint metadata.
   */
  async function verifyKey({ apiKey, userId } = {}) {
    const key = normalizeApiKey(apiKey);
    if (!key) return [];
    const base = cfg.apisBase.replace(/\/$/, "");
    const out = [];
    out.push(
      await runProbe({
        id: "asset-read",
        label: `baca aset ${cfg.probeAssetId} (Assets API)`,
        url: `${base}/assets/v1/assets/${cfg.probeAssetId}`,
        apiKey: key
      })
    );
    if (userId) {
      out.push(
        await runProbe({
          id: "user-read",
          label: `baca profil user ${userId} (Open Cloud v2)`,
          url: `${base}/cloud/v2/users/${encodeURIComponent(userId)}`,
          apiKey: key
        })
      );
    }
    return out;
  }

  async function checkKey({ apiKey, userId, groupId } = {}) {
    const findings = [];
    const key = normalizeApiKey(apiKey);
    const shape = describeKeyShape(apiKey);
    if (!key) {
      return {
        ok: false,
        verdict: "empty",
        findings: [{ level: "error", message: "Kunci API masih kosong." }],
        probes: [],
        keyShape: shape.stats
      };
    }

    const cred = classifyCredential(apiKey);

    // Cookie sesi: tolak di pintu. Situs ini tidak pernah meneruskan cookie ke mana pun.
    if (cred.kind === "cookie") {
      return {
        ok: false,
        verdict: "cookie",
        credential: cred,
        findings: [
          {
            level: "error",
            message:
              "Nilai di kolom kunci terlihat seperti cookie sesi Roblox (.ROBLOSECURITY). Server ini TIDAK meneruskannya ke Roblox \u2014 dan tidak akan pernah."
          },
          {
            level: "error",
            message:
              "Hapus nilai itu dari kolom ini. Kalau kamu baru menempelkannya di suatu tempat: tekan Log out dari Roblox di semua perangkat supaya cookie itu batal, lalu ganti password akunmu."
          },
          {
            level: "info",
            message:
              "Untuk upload, yang dibutuhkan kunci API Open Cloud: create.roblox.com \u2192 Credentials \u2192 API Keys \u2192 API Assets dengan Read + Write dicentang."
          }
        ],
        probes: [],
        keyShape: shape.stats,
        profile: null,
        key: null,
        scopes: []
      };
    }

    // Bentuk kredensial yang tidak lazim: kasih tahu apa adanya, jangan ditebak-tebak.
    if (cred.kind === "jwt") {
      findings.push({
        level: "warn",
        message:
          "Yang ditempel ini token OAuth (JWT), bukan kunci API Open Cloud. Token seperti ini sering bisa membaca, tapi upload biasanya ditolak karena scope-nya berbeda."
      });
      findings.push({ level: "info", message: "Cara paling pasti: buat kunci API Open Cloud (sekitar 48 karakter) dengan API Assets, Read + Write." });
    } else if (cred.kind === "opaque-long") {
      findings.push({
        level: "warn",
        message:
          `Panjang kredensial ${cred.length} karakter. Kunci API Open Cloud biasanya sekitar 48 karakter, jadi ini kemungkinan token/cookie dari alat lain, bukan kunci API.`
      });
      findings.push({
        level: "info",
        message: "Kalau kamu tidak yakin itu kunci apa: buat kunci API baru di create.roblox.com \u2192 Credentials \u2192 API Keys (jangan pakai token dari alat lain)."
      });
    } else if (cred.kind === "unknown") {
      findings.push({ level: "warn", message: "Bentuk kredensial ini tidak dikenal \u2014 pastikan itu kunci API Open Cloud dari Creator Dashboard." });
    }

    // (a) bentuk kunci — ini yang biasanya bikin "not provided in a valid format"
    if (shape.stats.hiddenChars > 0) {
      findings.push({
        level: "warn",
        message:
          `Kunci memuat ${shape.stats.hiddenChars} karakter tak terlihat (spasi nol-lebar / NBSP). ` +
          "Aku sudah membuangnya otomatis, tapi ini tanda kunci tersalin dari tempat yang salah."
      });
    }
    if (shape.stats.nonAscii > 0 && shape.stats.nonAscii !== shape.stats.hiddenChars) {
      findings.push({
        level: "error",
        message: `Ada ${shape.stats.nonAscii} karakter non-ASCII di kunci. Kunci Roblox hanya berisi huruf, angka, dan + / = - _ .`
      });
    }
    if (shape.stats.odd.length) {
      findings.push({
        level: "error",
        message:
          `Kunci memuat karakter yang tidak pernah ada di kunci Roblox: ${shape.stats.odd
            .map((c) => JSON.stringify(c))
            .join(", ")}. Ini tanda tersalin tidak lengkap atau kena format ulang.`
      });
    }
    if (shape.stats.trimmed) {
      findings.push({
        level: "info",
        message: `Ada spasi/kutip di ujung kunci (mentah ${shape.stats.rawLength} karakter → bersih ${shape.stats.length}). Sudah dibersihkan otomatis.`
      });
    }

    // Kalau masih ada karakter non-ASCII, permintaan HTTP-nya sendiri yang gagal
    // (fetch melempar ByteString error), jadi tidak usah diteruskan ke Roblox.
    const badChar = firstNonAscii(key);
    if (badChar) {
      findings.unshift({
        level: "error",
        message:
          `Kunci memuat karakter yang tidak pernah ada di kunci Roblox: ${JSON.stringify(badChar)} ` +
          `(posisi ke-${key.indexOf(badChar) + 1} dari ${key.length}). Karakter seperti itu tanda kunci tersalin ` +
          "dari tempat yang salah atau kena format ulang. Copy ulang dari Creator Dashboard."
      });
      findings.push({
        level: "info",
        message: 'Di halaman ini gunakan tombol "Tempel dari clipboard", bukan memilih teks manual.'
      });
      return {
        ok: false,
        verdict: "reject",
        findings,
        probes: [],
        keyShape: shape.stats,
        profile: null,
        key: null,
        scopes: []
      };
    }

    // (b) uji nyata: pakai kunci itu untuk memanggil API Roblox
    const probes = await verifyKey({ apiKey: key, userId });
    const anyOk = probes.some((p) => p.ok);
    const refused = probes.filter((p) => p.status === 401);
    const reached = probes.some((p) => p.status > 0);
    for (const p of probes) {
      if (p.ok) findings.push({ level: "ok", message: `Uji ${p.label}: berhasil (HTTP ${p.status}).` });
      else if (p.status === 401) findings.push({ level: "error", message: `Uji ${p.label}: ditolak Roblox — "${p.message}".` });
      else if (p.status === 403) findings.push({ level: "warn", message: `Uji ${p.label}: HTTP 403 "${p.message}" — kunci tidak sampai ke Roblox.` });
      else if (p.status === 0) findings.push({ level: "warn", message: `Uji ${p.label}: tidak bisa dihubungi — ${p.message}.` });
      else findings.push({ level: "warn", message: `Uji ${p.label}: HTTP ${p.status} ${p.message || ""}`.trim() });
    }

    // (c) metadata kunci (scope, masa berlaku, pemilik)
    const intro = await introspectKey(key);
    const raw = rawMessage(intro);
    let meta = null;
    let metaRejected = null;
    if (intro.ok && intro.body) meta = intro.body;
    else if (intro.status === 400 && /valid format/i.test(raw)) metaRejected = raw;
    else if (intro.status === 401 || intro.status === 403) metaRejected = raw;
    else findings.push({ level: "warn", message: `Pemeriksaan detail kunci gagal: ${raw}` });

    if (metaRejected) {
      if (anyOk) {
        findings.push({
          level: "info",
          message:
            `Pemeriksaan detail kunci menjawab "${metaRejected}", tapi uji nyata ke Roblox berhasil — kuncinya jalan. ` +
            "Daftar scope di bawah mungkin tidak lengkap."
        });
      } else {
        findings.push({
          level: "error",
          message:
            `Roblox menjawab "${metaRejected}". Kunci yang aku terima panjangnya ${shape.stats.length} karakter` +
            (shape.stats.hiddenChars ? ` (${shape.stats.hiddenChars} karakter tak terlihat sudah dibuang)` : "") +
            ", dan Roblox tidak mengenalinya sebagai kunci yang pernah ia terbitkan."
        });
        findings.push({
          level: "info",
          message:
            'Cara paling aman: di Creator Dashboard tekan tombol Copy pada kuncinya (jangan blok-teks manual, apalagi di HP), lalu tempel di sini pakai tombol "Tempel dari clipboard".'
        });
        findings.push({
          level: "info",
          message: "Kalau kamu menekan Regenerate / membuat kunci baru setelah menyalin, teks lama langsung mati — copy ulang yang baru."
        });
      }
    }

    // (d) isi metadata: scope, masa berlaku, kecocokan pemilik
    let profile = null;
    const scopes = meta && Array.isArray(meta.scopes) ? meta.scopes : [];
    if (meta) {
      const assetScope = scopes.find((sc) => /^asset$/i.test(String(sc.name || "")));
      const ops = ((assetScope && assetScope.operations) || []).map(String);
      const hasWrite = ops.some((o) => /write/i.test(o));
      const ownerId = meta.authorizedUserId != null ? String(meta.authorizedUserId) : null;

      if (meta.enabled === false) findings.push({ level: "error", message: "Kunci ini sedang dinonaktifkan di Creator Dashboard (Enabled: false)." });
      if (meta.expired) {
        findings.push({
          level: "error",
          message: "Kunci ini sudah kedaluwarsa" + (meta.expirationTimeUtc ? " (" + meta.expirationTimeUtc + ")" : "") + ". Buat kunci baru."
        });
      }
      if (!assetScope) {
        findings.push({ level: "error", message: 'Kunci belum diberi API "Assets". Di Access Permissions: Add API System, pilih Assets.' });
      } else if (!hasWrite) {
        findings.push({
          level: "error",
          message: `API Assets sudah ada, tapi operasi Write belum dicentang (yang ada: ${ops.join(", ") || "kosong"}). Upload butuh Read + Write.`
        });
      }

      if (groupId) {
        const gids = ((assetScope && assetScope.groupIds) || []).map(String);
        if (!gids.length) {
          findings.push({
            level: "error",
            message:
              "Kunci tidak memberi akses grup mana pun, jadi tidak bisa upload ke Group ID ini. Tambahkan grupnya di Access Permissions, atau kosongkan Group ID dan pakai User ID akunmu."
          });
        } else if (!(gids.includes("*") || gids.includes(String(groupId)))) {
          findings.push({
            level: "error",
            message: `Kunci tidak punya akses ke grup ${groupId} (yang diizinkan: ${gids.join(", ")}). Tambahkan grup itu di key-nya, atau ganti target.`
          });
        }
      } else if (userId) {
        if (ownerId && ownerId !== String(userId)) {
          const prof = await getUserProfile(ownerId);
          findings.push({
            level: "error",
            message:
              `User ID tujuan (${userId}) bukan pemilik kunci ini. Kunci ini milik User ID ${ownerId}` +
              (prof && prof.name ? " (@" + prof.name + ")" : "") +
              `. Ganti kolom User ID menjadi ${ownerId}.`
          });
        }
      }
      profile = ownerId ? await getUserProfile(ownerId) : null;
    } else if (!groupId && !userId) {
      findings.push({ level: "info", message: "Isi User ID atau Group ID tujuan supaya kecocokan kunci bisa diperiksa." });
    }

    // (e) putusan akhir
    const verdict = anyOk ? "ok" : refused.length ? "reject" : reached ? "unknown" : "offline";
    if (verdict === "ok") {
      findings.unshift({ level: "ok", message: "Kunci DITERIMA Roblox — uji baca aset berhasil, jalur auth-nya sama dengan saat upload." });
    } else if (verdict === "reject") {
      findings.unshift({ level: "error", message: "Kunci DITOLAK Roblox: kunci ini tidak dikenali. Copy ulang dari dashboard, atau buat kunci baru." });
    } else if (verdict === "unknown") {
      findings.unshift({ level: "warn", message: "Roblox menjawab, tapi jawabannya tidak jelas. Tunggu sebentar lalu coba lagi." });
    } else {
      findings.unshift({ level: "error", message: "Tidak bisa menghubungi Roblox dari server ini. Cek koneksi/Rate limit server, lalu ulangi." });
    }

    const hasError = findings.some((f) => f.level === "error");
    return {
      ok: verdict === "ok" && !hasError,
      verdict,
      credential: cred,
      findings,
      probes,
      keyShape: shape.stats,
      profile,
      key: meta
        ? {
            enabled: meta.enabled !== false,
            expired: !!meta.expired,
            expiresAt: meta.expirationTimeUtc || null,
            name: meta.name || null
          }
        : null,
      scopes: scopes.map((sc) => ({
        name: sc.name,
        operations: sc.operations,
        userIds: sc.userIds || [],
        groupIds: sc.groupIds || []
      }))
    };
  }

  /**
   * Daftar aset terbaru milik seorang kreator (animasi = tipe 24).
   * Tanpa kredensial apa pun — memakai inventaris publik Roblox.
   * Untuk target grup, Roblox tidak menyediakan jalur publik: kembalikan supported:false.
   */
  async function listCreatorAssets({ userId, groupId, assetTypeId = 24, limit = 25 } = {}) {
    if (!userId) {
      return {
        supported: false,
        reason: groupId
          ? "Roblox tidak menyediakan daftar aset publik untuk grup, jadi pemulihan otomatis tidak bisa dipakai untuk target grup."
          : "User ID/Group ID tujuan belum diisi."
      };
    }
    const base = cfg.inventoryBase.replace(/\/$/, "");
    const url = `${base}/v2/users/${encodeURIComponent(userId)}/inventory/${assetTypeId}?limit=${limit}&sortOrder=Desc`;
    const tried = await fetchWithAgents(url, { headers: { accept: "application/json" } });
    const res = tried.res;
    if (!res) {
      throw new RobloxError(
        "Tidak bisa membaca daftar aset kreator: " + (tried.error && tried.error.message ? tried.error.message : "tidak ada balasan"),
        { code: 502 }
      );
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json && json.errors && json.errors[0] && json.errors[0].message) || "HTTP " + res.status;
      throw new RobloxError("Daftar aset kreator ditolak: " + msg, { code: res.status });
    }
    const items = (json && Array.isArray(json.data) ? json.data : []).map((x) => ({
      assetId: x.assetId != null ? String(x.assetId) : null,
      name: x.assetName || null,
      created: x.created || null
    })).filter((x) => x.assetId);
    return { supported: true, items };
  }

  /** Bandingkan nama aset (abaikan besar-kecil huruf, spasi berlebih, ekstensi file). */
  function sameAssetName(a, b) {
    const norm = (v) =>
      String(v == null ? "" : v)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/\.(rbxm|rbxmx|rbx|rbxlx?)$/i, "");
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return false;
    return na === nb || na.startsWith(nb) || nb.startsWith(na);
  }

  /**
   * Cari kembali aset yang baru saja dibuat: cocokkan nama + waktu pembuatan.
   * `sinceMs` = waktu kita mulai meng-upload, jadi aset lama tidak ikut tertarik.
   */
  async function recoverNewAsset({ userId, groupId, displayName, sinceMs, assetTypeId = 24, limit = 25 } = {}) {
    const list = await listCreatorAssets({ userId, groupId, assetTypeId, limit });
    if (!list.supported) return { found: false, ...list };
    const floor = Number(sinceMs || 0) - 120000; // toleransi 2 menit (jam server bisa beda tipis)
    const candidates = list.items.filter((it) => {
      if (!sameAssetName(it.name, displayName)) return false;
      if (!it.created) return true;
      const t = Date.parse(it.created);
      return Number.isNaN(t) ? true : t >= floor;
    });
    if (!candidates.length) return { found: false, supported: true, scanned: list.items.length };
    const newest = candidates.sort((a, b) => Date.parse(b.created || 0) - Date.parse(a.created || 0))[0];
    return { found: true, supported: true, assetId: newest.assetId, name: newest.name, created: newest.created, scanned: list.items.length };
  }

  return {
    config: cfg,
    resolveAsset,
    introspectKey,
    describeKeyShape,
    verifyKey,
    getUserProfile,
    checkKey,
    normalizeApiKey,
    classifyCredential,
    listCreatorAssets,
    recoverNewAsset,
    sameAssetName,
    firstNonAscii,
    explainError,
    downloadAsset,
    uploadAsset,
    probeUploadPermission,
    pollOperation,
    assetTypeName,
    contentTypeFor,
    guessAssetTypeFromFile,
    sha256,
    authHeaders,
    /** Alur lengkap: ID lama -> byte -> upload -> ID baru */
    async spoofById(assetId, opts) {
      const dl = await downloadAsset(assetId, { placeId: opts.placeId });
      const assetType = opts.assetType || "Animation";
      if (dl.assetTypeId && dl.assetTypeId !== 24 && assetType === "Animation") {
        throw new RobloxError(
          `Aset ${assetId} bertipe ${dl.assetType}. Web spoofer hanya bisa mengambil isi tipe Animation tanpa login; ` +
          `untuk tipe lain, drag & drop filenya di mode "file lokal".`,
          { code: "wrong-type" }
        );
      }
      const up = await uploadAsset({
        bytes: dl.bytes, fileName: `ism-${assetId}.rbxm`, assetType,
        displayName: (opts.namePrefix || "ISM Spoof") + " " + assetId,
        description: opts.description || `Re-upload dari asset ${assetId} via ISpooferMotion Web`,
        creator: opts.creator, auth: opts.auth
      });
      const done = await pollOperation(up, opts.auth, { timeoutMs: opts.pollTimeoutMs });
      return {
        oldId: String(assetId), newId: done.assetId,
        bytesLength: dl.bytesLength, sha256: dl.sha256, sourceLocation: dl.location,
        assetType, assetTypeId: dl.assetTypeId
      };
    }
  };
}

export { sha256 };
