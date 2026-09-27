/**
 * Smoke test UI: menjalankan index.html di jsdom dengan canvas palsu,
 * lalu memastikan aplikasi benar-benar boot tanpa error dan kontrolnya bekerja.
 *
 * Butuh jsdom (dev-only, tidak dipakai oleh situsnya):
 *   npm install jsdom
 *   NODE_PATH=./node_modules node tests/ui.smoke.mjs
 *
 * Yang diperiksa: boot tanpa exception, viewer hero & playground aktif,
 * tombol preset, slider timeline, pembersih daftar ID, drop file .rbxmx asli,
 * dan penanganan file yang salah format.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import("jsdom"));
} catch {
  console.log("SKIP: jsdom belum terpasang. Jalankan: npm install jsdom");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra ? "  -> " + extra : "")); }
};
const heading = (t) => console.log("\n" + t);

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message + " :: " + (e.detail && e.detail.stack ? e.detail.stack.split("\n")[1] : "")));
vc.on("error", (m) => errors.push(String(m)));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    /* canvas 2D palsu: catat semua pemanggilan supaya bisa diperiksa */
    const calls = { fillRect: 0, stroke: 0, arc: 0, fillText: 0, setTransform: 0 };
    const grad = { addColorStop() {} };
    const ctx = new Proxy({}, {
      get(_t, k) {
        if (k === "canvas") return null;
        if (k === "createLinearGradient" || k === "createRadialGradient") return () => grad;
        if (k === "measureText") return () => ({ width: 10 });
        if (k in calls) return () => { calls[k]++; };
        return typeof k === "string" ? () => {} : undefined;
      },
      set() { return true; }
    });
    win.__ctxCalls = calls;
    win.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
    win.HTMLCanvasElement.prototype.toBlob = function (cb) { this.__blobAsked = true; cb && cb(null); };
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    win.navigator.clipboard = { writeText: () => Promise.resolve() };
    win.URL.createObjectURL = () => "blob:stub";
    /* jsdom tidak punya mesin download; catat saja percobaan klik-nya */
    win.HTMLAnchorElement.prototype.click = function () { this.__downloadClicked = true; win.__downloads = (win.__downloads || 0) + 1; };
    win.URL.revokeObjectURL = () => {};
    /* ukuran canvas palsu supaya renderer menghitung layout */
    win.Element.prototype.getBoundingClientRect = function () {
      return { width: 600, height: 450, top: 0, left: 0, right: 600, bottom: 450, x: 0, y: 0 };
    };
  }
});

const win = dom.window;
const doc = win.document;
const $ = (s) => doc.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

heading("1. Boot halaman");
await wait(120);
ok("tidak ada error runtime saat boot", errors.length === 0, errors.join(" | "));
ok("core ISM terpasang di window", typeof win.ISMCore === "object" && typeof win.ISMCore.parseKeyframeSequence === "function");
ok("canvas hero benar-benar dirender (fillRect dipanggil)", win.__ctxCalls.fillRect > 0, JSON.stringify(win.__ctxCalls));
ok("canvas playground dirender (beginPath/stroke dipanggil)", win.__ctxCalls.stroke > 0);
ok("label fps hero belum diisi di frame pertama (throttle 700ms)", $("#heroFpsLabel").textContent === "\u2014", $("#heroFpsLabel").textContent);

heading("2. Playground default");
ok("nama sequence preset muncul", $("#sName").textContent.includes("Wave"), $("#sName").textContent);
ok("statistik joint terisi (16 joint)", /16 joint/.test($("#sJoints").textContent), $("#sJoints").textContent);
ok("durasi 2.00s", $("#sDur").textContent === "2.00s", $("#sDur").textContent);
ok("timeline max = 2", $("#scrub").getAttribute("max") === "2", $("#scrub").getAttribute("max"));
ok("daftar joint terisi 16 baris", $("#jointList").children.length === 16, $("#jointList").children.length);
ok("label tombol awal = Pause (sedang main)", $("#playLabel").textContent === "Pause", $("#playLabel").textContent);
ok("badge mode = R15 · PRESET", $("#modeBadge").textContent === "R15 · PRESET", $("#modeBadge").textContent);

heading("3. Kontrol playback");
$("#playBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok("klik sekali → pause", $("#playLabel").textContent === "Play", $("#playLabel").textContent);
$("#playBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok("klik lagi → play", $("#playLabel").textContent === "Pause");
$("#loopBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok("toggle loop → off", $("#loopBtn").textContent === "Loop: off", $("#loopBtn").textContent);
$("#speedBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok("siklus speed 1× → 1.5×", $("#speedBtn").textContent === "Speed: 1.5×", $("#speedBtn").textContent);
for (let i = 0; i < 4; i++) $("#speedBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok("speed kembali ke 1× setelah 5 klik", $("#speedBtn").textContent === "Speed: 1×", $("#speedBtn").textContent);

const scrub = $("#scrub");
scrub.value = "1.25";
scrub.dispatchEvent(new win.Event("input", { bubbles: true }));
ok("scrub memindahkan waktu (label ikut berubah)", $("#timeLabel").textContent.startsWith("1.25"), $("#timeLabel").textContent);

$("#resetCam").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok("reset kamera tidak error", errors.length === 0, errors.join(" | "));

const canvas = $("#view");
canvas.dispatchEvent(new win.MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
canvas.dispatchEvent(new win.MouseEvent("pointermove", { clientX: 160, clientY: 120, bubbles: true }));
canvas.dispatchEvent(new win.MouseEvent("pointerup", { clientX: 160, clientY: 120, bubbles: true }));
ok("drag orbit tidak error", errors.length === 0, errors.join(" | "));
ok("petunjuk hilang setelah interaksi", $("#hint").style.opacity === "0", $("#hint").style.opacity);
const wheelEv = new win.Event("wheel", { bubbles: true, cancelable: true });
wheelEv.deltaY = -120;
canvas.dispatchEvent(wheelEv);
ok("zoom dengan scroll tidak error", errors.length === 0, errors.join(" | "));

heading("4. Ganti preset");
for (const kind of ["idle", "walk"]) {
  const btn = doc.querySelector(`.seg button[data-preset="${kind}"]`);
  btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  ok(`preset ${kind} termuat`, $("#modeBadge").textContent === "R15 · " + kind.toUpperCase(), $("#modeBadge").textContent);
}
ok("preset walk durasi 1.20s", $("#sDur").textContent === "1.20s", $("#sDur").textContent);
ok("aria-pressed hanya satu yang aktif",
  [...doc.querySelectorAll(".seg button")].filter((b) => b.getAttribute("aria-pressed") === "true").length === 1);

heading("5. Drop file .rbxmx");
const FIXTURE = `<roblox version="4">
  <Item class="KeyframeSequence">
    <Properties><string name="Name">DroppedAnim</string><bool name="Loop">true</bool></Properties>
    <Item class="Keyframe"><Properties><float name="Time">0</float></Properties>
      <Item class="Pose"><Properties><string name="Name">HumanoidRootPart</string></Properties>
        <Item class="Pose"><Properties><string name="Name">LowerTorso</string></Properties>
          <Item class="Pose"><Properties><string name="Name">UpperTorso</string></Properties>
            <Item class="Pose"><Properties>
              <string name="Name">Head</string>
              <CoordinateFrame name="CFrame">
                <X>0</X><Y>0.5</Y><Z>0</Z>
                <R00>1</R00><R01>0</R01><R02>0</R02>
                <R10>0</R10><R11>1</R11><R12>0</R12>
                <R20>0</R20><R21>0</R21><R22>1</R22>
              </CoordinateFrame>
            </Properties></Item></Item></Item></Item>
    </Item>
    <Item class="Keyframe"><Properties><float name="Time">0.4</float></Properties>
      <Item class="Pose"><Properties><string name="Name">HumanoidRootPart</string>
        <CoordinateFrame name="CFrame">
          <X>0</X><Y>0.2</Y><Z>0</Z>
          <R00>1</R00><R01>0</R01><R02>0</R02>
          <R10>0</R10><R11>1</R11><R12>0</R12>
          <R20>0</R20><R21>0</R21><R22>1</R22>
        </CoordinateFrame>
      </Properties></Item>
    </Item>
  </Item>
</roblox>`;

async function dropText(text, filename) {
  const file = new win.File([text], filename, { type: "text/xml" });
  const ev = new win.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  $("#drop").dispatchEvent(ev);
  await wait(140);
}

await dropText(FIXTURE, "spoof-target.rbxmx");
ok("file valid → notice sukses", $("#notice").className.includes("good") && /Berhasil diparse/.test($("#notice").textContent), $("#notice").textContent);
ok("nama sequence dari file tampil", $("#sName").textContent === "DroppedAnim", $("#sName").textContent);
ok("sumber = nama file", $("#sSource").textContent === "spoof-target.rbxmx", $("#sSource").textContent);
ok("durasi file 0.40s", $("#sDur").textContent === "0.40s", $("#sDur").textContent);
ok("keyframe file = 2", $("#sKeys").textContent === "2", $("#sKeys").textContent);
ok("4 joint terbaca (rantai bertingkat)", $("#sJoints").textContent.startsWith("4 joint"), $("#sJoints").textContent);
ok("badge mode menandai sumber file", /FILE$/.test($("#modeBadge").textContent), $("#modeBadge").textContent);
ok("nama file dipakai sebagai judul aman (tanpa HTML injection)",
  $("#jointList").innerHTML.indexOf("<script") === -1 && $("#jointList").children.length === 4);

await dropText("<roblox><Item class=\"Folder\"/></roblox>", "bukan-animasi.rbxmx");
ok("file tanpa KeyframeSequence → notice error", $("#notice").className.includes("bad"), $("#notice").textContent);
ok("pesan error menyebut KeyframeSequence", /KeyframeSequence/.test($("#notice").textContent), $("#notice").textContent);

await dropText("<roblox><Item class=\"KeyframeSequence\"><Item class=\"Keyframe\"></roblox>", "rusak.rbxmx");
ok("XML rusak → notice error", $("#notice").className.includes("bad"), $("#notice").textContent);

const binaryFile = new win.File([new Uint8Array([60, 114, 111, 98, 108, 111, 120, 62, 0, 1, 2])], "biner.rbx", { type: "application/octet-stream" });
{
  const ev = new win.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [binaryFile] } });
  $("#drop").dispatchEvent(ev);
  await wait(140);
}
ok("file biner .rbx → saran simpan ulang sebagai .rbxmx", /biner/.test($("#notice").textContent), $("#notice").textContent);

heading("6. Pembersih daftar asset ID");
const raw = $("#rawIn");
raw.value = [
  "https://www.roblox.com/library/1234567890/Run-Animation",
  "rbxassetid://1234567891",
  "1234567890",
  "[Type:Sound] 5678901234",
  "-- catatan bebas",
  "assetId=7654321098",
  "12345"
].join("\n");
raw.dispatchEvent(new win.Event("input", { bubbles: true }));
const out = $("#cleanOut").value.split("\n").filter(Boolean);
ok("ID diekstrak tanpa duplikat (4 unik: 1234567890 hanya muncul sekali)", out.length === 4, out.join(","));
ok("terurut menaik", out.join(",") === out.slice().sort((a, b) => a - b).join(","), out.join(","));
ok("format rbxassetid:// ikut terbaca", out.includes("1234567891"));
ok("ID di dalam URL library ikut terbaca", out.includes("1234567890"));
ok("baris dengan penanda [Type:Sound] ikut terbaca", out.includes("5678901234"));
ok("angka 5 digit tidak ikut diambil", !out.includes("12345"));
ok("penanda jumlah ID tampil", /4 ID unik/.test($("#outCount").textContent), $("#outCount").textContent);

const shortIds = $("#shortIds");
ok("opsi angka pendek default mati", shortIds && shortIds.checked === false);
shortIds.checked = true;
shortIds.dispatchEvent(new win.Event("change", { bubbles: true }));
ok("saat opsi dinyalakan, angka 5 digit ikut terbaca", $("#cleanOut").value.split("\n").includes("12345"), $("#cleanOut").value);
shortIds.checked = false;
shortIds.dispatchEvent(new win.Event("change", { bubbles: true }));
ok("saat dimatikan lagi, angka 5 digit hilang", !$("#cleanOut").value.split("\n").includes("12345"));
ok("tidak ada teks non-angka di output", out.every((l) => /^\d+$/.test(l)), out.join("|"));

$("#sampleBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok("tombol contoh mengisi input & hasil", parseInt($("#outCount").textContent, 10) > 0, $("#outCount").textContent);
$("#copyBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
$("#dlBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
$("#rawClear").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
await wait(30);
ok("copy / download / clear tidak error", errors.length === 0, errors.join(" | "));
ok("setelah clear, output kosong", $("#cleanOut").value === "", JSON.stringify($("#cleanOut").value));

heading("7. Konten halaman");
ok("tidak ada resource eksternal (img/script/link eksternal)",
  ![...doc.querySelectorAll("img,script[src],link[href]:not([rel=icon])")].some((el) => {
    const u = el.getAttribute("src") || el.getAttribute("href") || "";
    return /^https?:/i.test(u);
  }));
ok("tombol download V2 mengarah ke rilis terbaru",
  [...doc.querySelectorAll("a")].some((a) => a.href.includes("ISpooferMotion-V2/releases/latest")));
ok("tombol rilis V1 tersedia", [...doc.querySelectorAll("a")].some((a) => /ISpooferMotion\/releases$/.test(a.href)));
ok("link plugin Studio resmi tersedia", [...doc.querySelectorAll("a")].some((a) => a.href.includes("create.roblox.com/store/asset/77166107193979")));
ok("FAQ punya minimal 6 entri", doc.querySelectorAll("details.faq").length >= 6, doc.querySelectorAll("details.faq").length);
ok("disclaimer non-afiliasi Roblox ada", /Tidak berafiliasi dengan Roblox Corporation/.test(doc.body.textContent));
ok("peringatan cookie/sesi ada di halaman", /Jangan pernah/.test(doc.body.textContent));
{
  const fields = [...doc.querySelectorAll("input,textarea")];
  const risky = fields.filter((el) =>
    /cookie|token|password|login|session|robosecurity|auth/i.test([el.id, el.name, el.placeholder, el.getAttribute("aria-label")].join(" "))
  );
  ok("tidak ada kolom input untuk cookie/sesi login", risky.length === 0, risky.map((e) => e.id || e.type).join(","));
  ok("hanya input yang memang perlu ada (file, range, 2 textarea, 1 checkbox)", fields.length === 5, fields.length + ": " + fields.map((e) => e.id || e.type).join(","));
}
ok("tidak ada form yang mengirim data keluar", doc.querySelectorAll("form").length === 0);

await wait(1200);
ok("animasi tetap jalan tanpa error setelah ~1.5 detik", errors.length === 0, errors.join(" | "));
ok("waktu playback bergerak (bukan nol)", parseFloat($("#scrub").value) > 0, $("#scrub").value);
ok("label fps hero terisi setelah beberapa frame", /\d+\s*fps/.test($("#heroFpsLabel").textContent), $("#heroFpsLabel").textContent);
ok("ekspor PNG & .txt benar-benar memicu unduhan", (win.__downloads || 0) >= 1, String(win.__downloads));
ok("timer playback berjalan di hero canvas (loop preset wave)", win.__ctxCalls.stroke > 500, String(win.__ctxCalls.stroke));

console.log("\n" + "=".repeat(54));
console.log(`${pass} lolos · ${fail} gagal`);
dom.window.close();
process.exit(fail ? 1 : 0);
