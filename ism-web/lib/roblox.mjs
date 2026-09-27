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
  // Aset publik yang dipakai untuk menguji kunci (read-only, tidak mengubah apa pun)
  probeAssetId: "180435571",
  maxAssetBytes: 20 * 1024 * 1024, // batas 20 MB dari dokumentasi Open Cloud
  userAgent: "ISpooferMotion-Web/1.0 (+https://github.com/ISpooferMotion)",
  allowedAssetHosts: [], // tambahan host yang diizinkan; default hanya host Roblox
  probeAssetId: "180435571" // aset publik untuk uji fungsi kunci
};

/** Karakter non-ASCII pertama di sebuah kunci (atau null kalau semua ASCII). */
export function firstNonAscii(value) {
  const m = String(value == null ? "" : value).match(/[^\x20-\x7E]/);
  return m ? m[0] : null;
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
    [/too many requests|rate limit|quota/i,
      "Kena batas/kuota Roblox. Tunggu sebentar lalu jalankan ulang."],
    [/file size|too large|exceeds|20 ?MB|maximum size/i,
      "File melebihi batas 20 MB per aset."],
    [/assettype|asset type/i,
      "Tipe aset tidak didukung untuk upload. Animasi: .rbxm/.rbxmx. Audio: .ogg/.mp3/.wav/.flac."],
    [/invalid file|corrupt|malformed|failed to parse/i,
      "File-nya tidak bisa dibaca Roblox. Ekspor ulang dari Roblox Studio sebagai .rbxm atau .rbxmx."],
    [/authentication required to access asset/i,
      "Isi aset ini dibatasi Roblox atau kreatornya, jadi tidak bisa diambil tanpa login. Pakai tab 'Dari file lokal': kamu sediakan filenya, server hanya mengurus upload."],
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
  async function resolveAsset(assetId, { placeId } = {}) {
    const id = String(assetId).trim();
    if (!/^\d{4,}$/.test(id)) {
      throw new RobloxError("Bukan asset ID yang valid: " + id, { code: 400 });
    }

    // jalur utama: v2 (jawabannya JSON berisi lokasi CDN)
    const v2 = new URL(`${cfg.assetDeliveryBase.replace(/\/$/, "")}/v2/assetId/${id}`);
    if (placeId) v2.searchParams.set("placeId", String(placeId));

    let res = await doFetch(v2.toString(), {
      headers: { accept: "application/json", "user-agent": cfg.userAgent },
      redirect: "follow"
    });
    let body = await res.json().catch(() => null);

    const bodyErr = detectBodyError(body, res.status);
    if (bodyErr) {
      // fallback: v1 mengembalikan redirect (302) ke CDN
      const v1 = new URL(`${cfg.assetDeliveryBase.replace(/\/$/, "")}/v1/asset`);
      v1.searchParams.set("id", id);
      if (placeId) v1.searchParams.set("placeId", String(placeId));
      const res1 = await doFetch(v1.toString(), {
        headers: { accept: "*/*", "user-agent": cfg.userAgent },
        redirect: "manual"
      });
      const loc = res1.headers.get("location");
      if (loc) return { assetId: id, locations: [keepLocationAsIs(new URL(loc, v1).toString())], assetTypeId: null };
      if (res1.status === 200) {
        const bytes = new Uint8Array(await res1.arrayBuffer());
        return { assetId: id, inline: bytes, locations: [], assetTypeId: null };
      }
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
          const res = await doFetch(url, {
            headers: { accept: "*/*", "user-agent": cfg.userAgent },
            redirect: "follow"
          });
          if (res.status === 429 || res.status >= 500) {
            lastError = new RobloxError("CDN sibuk (HTTP " + res.status + ")", { code: res.status, retryable: true });
            await sleep(400 * (attempt + 1));
            continue;
          }
          if (!res.ok) {
            lastError = new RobloxError("Gagal mengambil isi aset (HTTP " + res.status + ")", { code: res.status });
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
    throw new RobloxError("Upload belum selesai setelah " + Math.round(timeoutMs / 1000) + " detik. Cek Creator Dashboard.", {
      code: "timeout", retryable: true
    });
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

  return {
    config: cfg,
    resolveAsset,
    introspectKey,
    describeKeyShape,
    verifyKey,
    getUserProfile,
    checkKey,
    normalizeApiKey,
    firstNonAscii,
    explainError,
    downloadAsset,
    uploadAsset,
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
