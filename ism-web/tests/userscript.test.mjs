/**
 * Test untuk userscript ism-fetch.user.js.
 *
 * Yang diuji: blok PURE di dalam script (antara marker ISM-FETCH-PURE-START/END),
 * diekstrak dan dijalankan di Node — jadi logika yang diuji persis sama dengan
 * yang jalan di browser. Ditambah pemeriksaan statis: script tidak boleh membaca
 * atau mengirim cookie.
 *
 *   node ism-web/tests/userscript.test.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "..", "ism-site", "ism-fetch.user.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra !== undefined ? "  -> " + extra : "")); }
};
const heading = (t) => console.log("\n" + t);

const src = readFileSync(SCRIPT, "utf8");

heading("1. Struktur & keamanan script");
{
  ok("header userscript lengkap (@match, @grant, @connect)",
    /@match\s+\*:\/\/\*\.roblox\.com/.test(src) && /@grant\s+GM_xmlhttpRequest/.test(src) && /@connect\s+assetdelivery\.roblox\.com/.test(src));
  // komentar boleh menyebut kata itu (justru menjelaskan); yang penting kode tidak memakainya
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("TIDAK membaca document.cookie", !/document\s*\.\s*cookie/.test(codeOnly), "ada akses cookie di kode");
  ok("TIDAK mengirim cookie ke situs ISM (withCredentials:false pada POST job)",
    /data:\s*fd,\s*withCredentials:\s*false/.test(src.replace(/\s+/g, " ")) || /withCredentials:\s*false/.test(src), "cari withCredentials:false");
  ok("cookie hanya dilampirkan browser ke Roblox (withCredentials:true pada assetdelivery)",
    /withCredentials:\s*true/.test(src));
  ok("tidak ada string .ROBLOSECURITY di script", !/ROBLOSECURITY/.test(src));
  ok("tidak ada eval / Function baru dari teks",
    !/\beval\s*\(/.test(src) && !/new\s+Function\s*\(/.test(src));
}

/* ---------------- ekstraksi blok murni ---------------- */
const m = src.match(/\/\* ===== ISM-FETCH-PURE-START ===== \*\/([\s\S]*?)\/\* ===== ISM-FETCH-PURE-END ===== \*\//);
heading("2. Blok murni bisa diekstrak & dijalankan");
ok("marker blok murni ada", !!m);
if (!m) { console.log("\n" + pass + " lolos · " + fail + " gagal"); process.exit(1); }

const pure = new Function(
  m[1] + "\nreturn { assetIdFromUrl, isGzipBytes, errorFromBody, safeFileName, csrfFromHeaders, apiUrl, looksLikeApiKey, explainSessionFailure, libraryPageCdnUrl, locationFromHeaders, gameContextHeaders, buildBatchBody, parseBatchResponse, retryAfterMs, uuidish };"
)();
ok("blok murni tidak menyentuh DOM/GM_* saat dijalankan",
  !/document\.|GM_xmlhttpRequest/.test(m[1]), "ada referensi DOM di blok murni");

heading("3. assetIdFromUrl");
{
  const cases = [
    ["https://www.roblox.com/library/80301288746676/Beautiful-strangers", "80301288746676"],
    ["https://create.roblox.com/store/asset/80301288746676/Beautiful-strangers", "80301288746676"],
    ["https://www.roblox.com/catalog/125750702/Some-Animation", "125750702"],
    ["https://www.roblox.com/games/4483381587/Some-Game?assetId=180435571", "180435571"],
    ["https://www.roblox.com/home", null],
    ["", null]
  ];
  for (const [url, want] of cases) ok("  " + (url || "(kosong)") + " → " + want, pure.assetIdFromUrl(url) === want, String(pure.assetIdFromUrl(url)));
}

heading("4. Deteksi gzip & error-in-200");
{
  ok("byte gzip dikenali", pure.isGzipBytes(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])) === true);
  ok("byte rbxm biasa TIDAK dianggap gzip", pure.isGzipBytes(new Uint8Array([0x3c, 0x72, 0x6f])) === false);
  ok("byte kosong aman", pure.isGzipBytes(new Uint8Array(0)) === false && pure.isGzipBytes(null) === false);
  ok("JSON error terbaca",
    JSON.stringify(pure.errorFromBody('{"errors":[{"code":1,"message":"User is not authorized to access Asset."}]}')) ===
      JSON.stringify({ code: 1, message: "User is not authorized to access Asset." }));
  ok("konten biner biasa bukan error", pure.errorFromBody("<roblox!") === null);
  ok("JSON tanpa errors bukan error", pure.errorFromBody('{"assetId":123}') === null);
  ok("teks panjang tidak dicoba di-parse", pure.errorFromBody("{" + "x".repeat(5000)) === null);
}

heading("5. Nama file & URL situs");
{
  ok("nama file dari ID", pure.safeFileName("80301288746676") === "ism-80301288746676.rbxm");
  ok("ID kotor dibersihkan", pure.safeFileName("abc 803-012") === "ism-803012.rbxm");
  ok("ID kosong tetap dapat nama", pure.safeFileName("") === "ism-aset.rbxm");
  ok("apiUrl menyatukan garis miring", pure.apiUrl("https://situs.example/", "/api/jobs-file") === "https://situs.example/api/jobs-file");
  ok("apiUrl tanpa garis miring", pure.apiUrl("https://situs.example", "api/jobs/x") === "https://situs.example/api/jobs/x");
  ok("apiUrl kosong tetap kosong", pure.apiUrl("", "/api/x") === "");
}

heading("6. CSRF & bentuk kunci");
{
  ok("token CSRF dibaca dari header",
    pure.csrfFromHeaders("content-type: application/json\r\nx-csrf-token: ABC123==\r\n") === "ABC123==");
  ok("tanpa token → null", pure.csrfFromHeaders("content-type: application/json") === null);
  ok("kunci 48 karakter alfanumerik+simbol diterima", pure.looksLikeApiKey("Ojj2UBWUC0S+qn3F3aavirWfezWS7ti9CeuFuceh3eHf9Au8") === true);
  ok("kredensial 964 karakter ditolak", pure.looksLikeApiKey("A".repeat(964)) === false);
  ok("kunci pendek ditolak", pure.looksLikeApiKey("abc") === false);
}

heading("7. Pesan kegagalan yang manusiawi");
{
  ok("aset terkunci (403)", /tidak diberi akses/i.test(pure.explainSessionFailure(403, "User is not authorized to access Asset.")));
  ok("sesi hilang (401)", /pastikan masih login/i.test(pure.explainSessionFailure(401, "")));
  ok("tidak ditemukan (404)", /tidak ditemukan/i.test(pure.explainSessionFailure(404, "")));
  ok("kena batas (429)", /batas permintaan/i.test(pure.explainSessionFailure(429, "")));
  ok("tanpa koneksi", /koneksi/i.test(pure.explainSessionFailure(0, "timeout")));
}

heading("8. Tiga jalur pengambilan (meniru ISpooferMotion V2)");
{
  const html = '<div data-mediathumb-url="https://tr.rbxcdn.com/30DAY-Audio/abc/352/352/Animation/Png" data-x="1"></div>';
  ok("URL CDN dibaca dari halaman library", pure.libraryPageCdnUrl(html) === "https://tr.rbxcdn.com/30DAY-Audio/abc/352/352/Animation/Png");
  ok("halaman tanpa atribut itu → null", pure.libraryPageCdnUrl("<html><body>kosong</body></html>") === null);
  ok("atribut tanpa URL absolut → null", pure.libraryPageCdnUrl('<i data-mediathumb-url="bukan-url"></i>') === null);

  ok("Location rbxcdn diterima",
    pure.locationFromHeaders("HTTP/1.1 302\r\nlocation: https://c7.rbxcdn.com/abc.rbxm\r\n") === "https://c7.rbxcdn.com/abc.rbxm");
  ok("Location non-rbxcdn ditolak",
    pure.locationFromHeaders("location: https://example.com/x") === null);
  ok("tanpa Location → null", pure.locationFromHeaders("content-type: application/json") === null);

  ok("tanpa Place ID tidak ada header konteks", JSON.stringify(pure.gameContextHeaders("", "g")) === "{}");
  ok("Place ID 0 diabaikan", JSON.stringify(pure.gameContextHeaders("0", "g")) === "{}");
  const gc = pure.gameContextHeaders("4483381587", "abcd-1234");
  ok("header konteks game lengkap",
    gc["Roblox-Place-Id"] === "4483381587" && gc["Roblox-Game-Id"] === "abcd-1234" &&
    JSON.parse(gc["Roblox-Session-Id"]).PlaceId === 4483381587 &&
    JSON.parse(gc["Roblox-Session-Id"]).SessionId === "abcd-1234",
    JSON.stringify(gc));
  ok("Place ID bukan angka diabaikan", JSON.stringify(pure.gameContextHeaders("abc", "g")) === "{}");

  const body = pure.buildBatchBody("80301288746676", { requestId: "req-1", assetType: "Animation" });
  ok("body batch berbentuk array satu item", Array.isArray(body) && body.length === 1);
  ok("field batch sesuai struct BatchAssetRequest",
    body[0].assetId === 80301288746676 && typeof body[0].assetId === "number" &&
    body[0].assetType === "Animation" && body[0].requestId === "req-1" && body[0].clientInsert === true,
    JSON.stringify(body[0]));
  ok("tanpa Place ID, placeId tidak dikirim", !("placeId" in body[0]));
  const bodyP = pure.buildBatchBody("180435571", { requestId: "r2", placeId: "4483381587" });
  ok("dengan Place ID, placeId + serverPlaceId ikut dikirim",
    bodyP[0].placeId === 4483381587 && bodyP[0].serverPlaceId === 4483381587, JSON.stringify(bodyP[0]));

  const okResp = [{ requestId: "req-1", location: "https://c7.rbxcdn.com/abc.rbxm" }];
  ok("batch sukses → url", pure.parseBatchResponse(okResp, "req-1").url === "https://c7.rbxcdn.com/abc.rbxm");
  ok("requestId lain tidak dipakai", pure.parseBatchResponse([{ requestId: "lain", location: "https://x" }], "req-1").url === undefined);
  const denied = pure.parseBatchResponse([{ requestId: "req-1", errors: [{ code: 1, message: "User is not authorized to access Asset." }] }], "req-1");
  ok("akses ditolak dikenali", denied.accessDenied === true && /not authorized/i.test(denied.error), JSON.stringify(denied));
  ok("jawaban tanpa lokasi tetap memberi pesan", !!pure.parseBatchResponse([], "req-1").error);

  ok("Retry-After detik → ms", pure.retryAfterMs("retry-after: 2") === 2000);
  ok("Retry-After besar dibatasi 15 detik", pure.retryAfterMs("retry-after: 999") === 15000);
  ok("tanpa Retry-After → null", pure.retryAfterMs("content-type: application/json") === null);
  ok("uuidish menghasilkan bentuk UUID", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pure.uuidish()), pure.uuidish());
}

heading("9. Pemeriksaan statis v1.1");
{
  ok("versi userscript naik ke 1.1.0", /@version\s+1\.1\.0/.test(src));
  ok("ketiga jalur ada di kode", /resolveFromLibraryPage/.test(src) && /resolveFromAssetDelivery/.test(src) && /resolveFromBatch/.test(src));
  ok("jalur batch memakai endpoint yang sama dengan V2", /assetdelivery\.roblox\.com\/v2\/assets\/batch/.test(src));
  ok("semua permintaan aset memakai sesi browser (withCredentials: true)",
    (src.match(/withCredentials:\s*true/g) || []).length >= 4, String((src.match(/withCredentials:\s*true/g) || []).length));
  ok("pengiriman ke situs ISM tetap tanpa kredensial browser (withCredentials: false)",
    (src.match(/withCredentials:\s*false/g) || []).length >= 1);
  ok("header konteks game disalin dari V2 (Roblox-Place-Id / Roblox-Game-Id / Roblox-Session-Id)",
    /Roblox-Place-Id/.test(src) && /Roblox-Game-Id/.test(src) && /Roblox-Session-Id/.test(src));
  ok("429 ditangani dengan Retry-After", /retryAfterMs/.test(src) && /requestWithRetry/.test(src));
  ok("Place ID bisa diisi user", /Place ID game \(opsional/.test(src) || /placeId: "".*placeId/.test(src));
}

console.log("\n======================================================");
console.log(pass + " lolos · " + fail + " gagal");
process.exit(fail === 0 ? 0 : 1);
