/**
 * Smoke test UI untuk spoof.html (halaman Web Spoofer).
 *
 *   npm install jsdom         (di folder ism-site)
 *   node ism-web/tests/spoof.ui.test.mjs
 *
 * fetch() dan EventSource diganti versi palsu, jadi test ini memeriksa logika
 * halaman (validasi, pratinjau parser, tabel progres, format keluaran) tanpa
 * perlu server Roblox atau kredensial sungguhan.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

/* jsdom adalah dev-dependency di ism-site; cari di beberapa lokasi yang wajar */
let JSDOM, VirtualConsole;
for (const candidate of [
  "jsdom",
  join(here, "..", "..", "ism-site", "node_modules", "jsdom"),
  join(here, "..", "..", "node_modules", "jsdom")
]) {
  try {
    const mod = req(candidate);
    JSDOM = mod.JSDOM;
    VirtualConsole = mod.VirtualConsole;
    break;
  } catch { /* coba lokasi berikutnya */ }
}
if (!JSDOM) {
  console.log("SKIP: jsdom belum terpasang. Jalankan: cd ism-site && npm install jsdom");
  process.exit(0);
}
const html = readFileSync(join(here, "..", "..", "ism-site", "spoof.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log("  \u2713 " + n); } else { fail++; console.log("  \u2717 " + n + (e !== undefined ? "  -> " + e : "")); } };
const heading = (t) => console.log("\n" + t);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* kumpulan respons palsu dari "server" */
const calls = [];
let healthBody = {
  ok: true, version: "1.0.0", gate: false, gateOk: true,
  authModes: { serverKey: false, oauth: true, apiKey: true },
  limits: { maxItems: 120, concurrency: 3, maxBytes: 20971520 },
  cookieAuth: false, note: "tidak menerima cookie"
};
let meBody = { loggedIn: false };
let jobSnapshot = null;
let checkKeyBody = {
  ok: false, usingServerKey: false,
  findings: [
    { level: "error", message: "API Assets sudah ada, tapi operasi Write belum dicentang (yang ada: read). Upload butuh Read + Write." },
    { level: "info", message: "Buka create.roblox.com untuk memperbaiki." }
  ],
  profile: { id: "1234567", name: "TesterISM", displayName: "Tester ISM" },
  key: { enabled: true, expired: false, expiresAt: "2027-01-01T00:00:00Z", name: "ISM_TEST" },
  scopes: [{ name: "asset", operations: ["read"], userIds: ["*"], groupIds: [] }]
};

class FakeEventSource {
  constructor(url) { this.url = url; FakeEventSource.last = this; }
  close() { this.closed = true; }
  emit(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
}

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message));
vc.on("error", (m) => errors.push(String(m)));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    win.EventSource = FakeEventSource;
    win.navigator.clipboard = { writeText: () => Promise.resolve() };
    win.HTMLAnchorElement.prototype.click = function () { win.__downloads = (win.__downloads || 0) + 1; };
    win.URL.createObjectURL = () => "blob:palsu";
    win.URL.revokeObjectURL = () => {};
    win.fetch = (url, opts) => {
      const path = String(url);
      calls.push({ path, method: (opts && opts.method) || "GET", body: opts && opts.body });
      const reply = (status, body) => Promise.resolve({
        ok: status >= 200 && status < 300, status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
        headers: { getSetCookie: () => [] }
      });
      if (path.endsWith("/api/health")) return reply(200, healthBody);
      if (path.endsWith("/api/me")) return reply(200, meBody);
      if (path.endsWith("/api/parse")) {
        const ids = String((JSON.parse(opts.body).input || "").match(/\d{6,}/g) || []);
        return reply(200, { total: ids.length, items: ids.map((id) => ({ id })), typeHint: null });
      }
      if (path.endsWith("/api/check-key")) {
        return reply(200, checkKeyBody);
      }
      if (path.endsWith("/api/jobs") && (!opts || opts.method === "POST")) {
        const sent = JSON.parse(opts.body);
        if (!sent.apiKey) return reply(401, { error: "cookie ditolak" });
        return reply(202, { jobId: "job-uji", total: 2 });
      }
      if (path.includes("/api/jobs/job-uji/events")) return reply(200, {});
      if (path.includes("/api/jobs/job-uji")) return reply(200, jobSnapshot);
      if (path.endsWith("/api/logout")) return reply(200, { ok: true });
      return reply(404, { error: "tidak ada di mock: " + path });
    };
  }
});

const win = dom.window, doc = win.document;
const $ = (s) => doc.querySelector(s);
const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const type = (el, v) => { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
await wait(160);

heading("1. Boot & status server");
ok("tidak ada error runtime", errors.length === 0, errors.join(" | "));
ok("health dipanggil", calls.some((c) => c.path.endsWith("/api/health")));
ok("label server online", /online/.test($("#healthTag").textContent), $("#healthTag").textContent);
ok("banner 'server belum jalan' tersembunyi", $("#serverDown").className.includes("hide"));
ok("tombol login OAuth ditampilkan (authModes.oauth)", !$("#authOauth").className.includes("hide"));
ok("kotak API key tetap tersedia", $("#authKey").style.display !== "none");

heading("2. Validasi tombol run");
ok("tombol run awalnya mati", $("#runBtn").disabled === true);
type($("#input"), "180435571\n180426354");
ok("pratinjau parser menghitung 2 ID", /2 ID unik/.test($("#inputCount").textContent), $("#inputCount").textContent);
ok("masih mati karena target belum diisi", $("#runBtn").disabled === true, $("#runHint").textContent);
type($("#userId"), "1234567");
ok("masih mati karena kredensial kosong", $("#runBtn").disabled === true, $("#runHint").textContent);
type($("#apiKey"), "kunci-uji-panjang");
ok("setelah semua lengkap, tombol hidup", $("#runBtn").disabled === false, $("#runHint").textContent);
ok("hint menyebut tujuan upload", /user 1234567/.test($("#runHint").textContent), $("#runHint").textContent);

heading("3. Saling mengunci User ID ↔ Group ID");
type($("#groupId"), "33445566");
ok("mengisi Group ID mengosongkan User ID", $("#userId").value === "");
ok("hint berpindah ke group", /group 33445566/.test($("#runHint").textContent), $("#runHint").textContent);
type($("#userId"), "1234567");
ok("mengisi User ID mengosongkan Group ID", $("#groupId").value === "");

heading("4. Tombol contoh & pembersihan input");
click($("#sampleBtn"));
ok("contoh mengisi 5 ID terverifikasi", /5 ID unik/.test($("#inputCount").textContent), $("#inputCount").textContent);
ok("header TYPE dari contoh terbaca", /tipe ANIMATION/.test($("#inputCount").textContent), $("#inputCount").textContent);
click($("#clearBtn"));
ok("tombol kosongkan bekerja", $("#input").value === "" && $("#runBtn").disabled === true);

heading("5. Tab file lokal");
click($("#tabFile"));
ok("pane file tampil, pane ID tersembunyi", $("#paneFile").className === "" && $("#paneId").className === "hide");
ok("tab aria-pressed benar", $("#tabFile").getAttribute("aria-pressed") === "true" && $("#tabId").getAttribute("aria-pressed") === "false");
ok("tanpa file, run tetap mati", $("#runBtn").disabled === true, $("#runHint").textContent);
{
  const file = new win.File([new Uint8Array([60, 114, 111, 98, 108, 111, 120, 33])], "anim.rbxm", { type: "model/x-rbxm" });
  const ev = new win.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  $("#drop").dispatchEvent(ev);
}
ok("file terpilih tercantum", /anim\.rbxm/.test($("#fileInfo").textContent), $("#fileInfo").textContent);
ok("setelah file dipilih, tombol run hidup", $("#runBtn").disabled === false, $("#runHint").textContent);
click($("#tabId"));

heading("6. Menjalankan job & menerima progres");
type($("#input"), "180435571\n180426354");
click($("#runBtn"));
await wait(80);
const jobCall = calls.filter((c) => c.path.endsWith("/api/jobs") && c.method === "POST").pop();
ok("job dikirim ke server", Boolean(jobCall));
const sentBody = JSON.parse(jobCall.body);
ok("API key ikut dikirim", sentBody.apiKey === "kunci-uji-panjang");
ok("opsi lengkap (userId, prefix, assetType)", sentBody.options.userId === "1234567" && sentBody.options.assetType === "Animation", JSON.stringify(sentBody.options));
ok("EventSource dibuat untuk job", Boolean(FakeEventSource.last) && /job-uji\/events$/.test(FakeEventSource.last.url), FakeEventSource.last && FakeEventSource.last.url);

FakeEventSource.last.emit({
  type: "snapshot", status: "running", summary: { total: 2, done: 0, error: 0, skipped: 0, pending: 2 },
  items: [{ id: "180435571", status: "pending" }, { id: "180426354", status: "pending" }]
});
ok("tabel terisi 2 baris", $("#rows").children.length === 2, $("#rows").children.length);
ok("ringkasan total = 2", $("#sTotal").textContent === "2");

FakeEventSource.last.emit({ type: "item", id: "180435571", status: "fetching" });
FakeEventSource.last.emit({ type: "item", id: "180435571", status: "done", newId: "9876543210", ms: 1234, sha256: "abcdef1234567890" });
FakeEventSource.last.emit({ type: "item", id: "180426354", status: "error", error: "Authentication required to access Asset.", hint: "Isi aset ini dibatasi Roblox atau kreatornya. Pakai tab 'Dari file lokal'." });
ok("status sukses tampil di tabel", /selesai/.test($("#rows").textContent));
ok("ID baru tampil sebagai tautan library", /roblox\.com\/library\/9876543210/.test($("#rows").innerHTML));
ok("error item tampil di tabel", /Authentication required/.test($("#rows").textContent));
  ok("petunjuk perbaikan ikut tampil di tabel", /Dari file lokal/.test($("#rows").textContent), $("#rows").textContent.slice(0, 200));
ok("log mencatat hasil sukses", /9876543210/.test($("#log").textContent), JSON.stringify($("#log").textContent.slice(0, 300)));
ok("log mencatat kegagalan", /gagal/.test($("#log").textContent));

jobSnapshot = {
  status: "finished-with-errors",
  summary: { total: 2, done: 1, error: 1, skipped: 0, pending: 0 },
  items: [{ id: "180435571", status: "done", newId: "9876543210", bytesLength: 4369, sha256: "abc" },
          { id: "180426354", status: "error", error: "Authentication required to access Asset." }],
  output: { plugin: "180435571 = 9876543210,", plain: "9876543210", pairs: "180435571,9876543210" }
};
FakeEventSource.last.emit({ type: "job", status: "finished-with-errors", summary: jobSnapshot.summary });
await wait(120);
ok("status job akhir tercatat", /finished-with-errors/.test($("#jobState").textContent), $("#jobState").textContent);
ok("progres bar terisi 100%", $("#bar").style.width === "100%", $("#bar").style.width);
ok("EventSource ditutup setelah selesai", FakeEventSource.last.closed === true);

heading("7. Format keluaran");
ok("default = format plugin", $("#output").value === "180435571 = 9876543210,", JSON.stringify($("#output").value));
click(doc.querySelector('.seg button[data-fmt="plain"]'));
ok("beralih ke ID baru saja", $("#output").value === "9876543210", JSON.stringify($("#output").value));
click(doc.querySelector('.seg button[data-fmt="pairs"]'));
ok("beralih ke CSV", $("#output").value === "180435571,9876543210", JSON.stringify($("#output").value));
click(doc.querySelector('.seg button[data-fmt="plugin"]'));
ok("kembali ke format plugin", $("#output").value === "180435571 = 9876543210,");
click($("#copyBtn"));
click($("#dlBtn"));
await wait(20);
ok("copy & download tidak error", errors.length === 0, errors.join(" | "));
ok("download .txt terpicu", (win.__downloads || 0) >= 1, String(win.__downloads));

heading("7b. Tombol 'Cek kunci' (diagnosa)");
{
  type($("#apiKey"), "kunci-uji-panjang-1234567890");
  click($("#checkKeyBtn"));
  await wait(120);

  const box = $("#keyCheck");
  ok("panel hasil muncul (tidak lagi disembunyikan)", !box.className.includes("hide"));
  ok("panel memakai gaya error karena ada temuan", /notice err/.test(box.className), box.className);
  ok("temuan error ditampilkan dengan penanda ✗", /Write belum dicentang/.test(box.textContent) && box.innerHTML.includes("\u2717"), box.textContent.slice(0, 120));
  ok("temuan info juga ditampilkan", /create\.roblox\.com/.test(box.textContent));
  ok("identitas pemilik kunci ditampilkan", /@TesterISM/.test(box.textContent) && /User ID 1234567/.test(box.textContent), box.textContent);
  ok("masa berlaku kunci ditampilkan", /kedaluwarsa: 2027-01-01/.test(box.textContent), box.textContent);
  ok("scope kunci ditampilkan", /asset\[read\]/.test(box.textContent), box.textContent);
  ok("temuan error juga masuk ke log", /Write belum dicentang/.test($("#log").textContent));

  // sekarang skenario kunci sehat
  checkKeyBody = {
    ok: true, usingServerKey: true,
    findings: [{ level: "ok", message: "Kunci valid dan siap dipakai untuk upload." }],
    profile: { id: "1234567", name: "TesterISM", displayName: "Tester ISM" },
    key: { enabled: true, expired: false, expiresAt: null, name: "ISM_TEST" },
    scopes: [{ name: "asset", operations: ["read", "write"], userIds: ["*"], groupIds: ["33445566"] }]
  };
  click($("#checkKeyBtn"));
  await wait(120);
  ok("kunci sehat → panel hijau", /notice ok/.test($("#keyCheck").className), $("#keyCheck").className);
  ok("pesan siap dipakai muncul", /siap dipakai/i.test($("#keyCheck").textContent));
  ok("ditandai memakai kunci dari server", /memakai kunci dari server/.test($("#keyCheck").textContent), $("#keyCheck").textContent);
  ok("log mencatat kunci valid", /cek kunci: valid/.test($("#log").textContent));

  // kunci kosong & tanpa kunci server → tidak boleh request
  const callsBefore = calls.filter((c) => c.path.endsWith("/api/check-key")).length;
  type($("#apiKey"), "");
  const healthBefore = state_health_serverKey();
  if (!healthBefore) {
    click($("#checkKeyBtn"));
    await wait(80);
    ok("kunci kosong tanpa kunci server → peringatan, tanpa request",
      calls.filter((c) => c.path.endsWith("/api/check-key")).length === callsBefore && /Isi kunci API dulu/.test($("#keyCheck").textContent), $("#keyCheck").textContent);
  } else {
    ok("(dilewati: server punya kunci sendiri)", true);
  }
}

function state_health_serverKey() { return false; }

heading("8. Sesi OAuth & gate");
meBody = { loggedIn: true, username: "TesterISM", userId: "1234567" };
const dom2 = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(win2) {
    win2.EventSource = FakeEventSource;
    win2.fetch = (url) => {
      const p = String(url);
      const reply = (s, b) => Promise.resolve({ ok: s < 300, status: s, json: () => Promise.resolve(b), text: () => Promise.resolve(""), headers: { getSetCookie: () => [] } });
      if (p.endsWith("/api/health")) return reply(200, healthBody);
      if (p.endsWith("/api/me")) return reply(200, meBody);
      return reply(404, {});
    };
  }
});
await wait(160);
const $2 = (s) => dom2.window.document.querySelector(s);
ok("status login OAuth ditampilkan", /TesterISM/.test($2("#authServerKey").textContent), $2("#authServerKey").textContent);
ok("tombol logout muncul setelah login", !$2("#logoutBtn").className.includes("hide"));
ok("form API key disembunyikan saat login OAuth", $2("#authOauth").className.includes("hide"));

const dom3 = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(win3) {
    win3.EventSource = FakeEventSource;
    win3.fetch = (url) => {
      const p = String(url);
      const reply = (s, b) => Promise.resolve({ ok: s < 300, status: s, json: () => Promise.resolve(b), text: () => Promise.resolve(""), headers: { getSetCookie: () => [] } });
      if (p.endsWith("/api/health")) return reply(200, { ...healthBody, gate: true, gateOk: false });
      if (p.endsWith("/api/me")) return reply(200, { loggedIn: false });
      return reply(401, { error: "gate-required" });
    };
  }
});
await wait(160);
ok("kotak password gate muncul saat gate tertutup", dom3.window.document.querySelector("#gateBox").style.display === "block");

console.log("\n" + "=".repeat(54));
console.log(`${pass} lolos · ${fail} gagal`);
dom.window.close(); dom2.window.close(); dom3.window.close();
process.exit(fail ? 1 : 0);
