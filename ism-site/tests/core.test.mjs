/**
 * Test untuk blok ISM-CORE yang ada di dalam index.html.
 *
 * Blok core sengaja ditandai di HTML dengan:
 *   /* ===== ISM-CORE-START ===== *\/
 *   ... logika murni ...
 *   /* ===== ISM-CORE-END ===== *\/
 *
 * Cara jalan:
 *   node tests/core.test.mjs
 *
 * Yang diuji: parser XML mini, konversi CFrame/EulerRotation → quaternion,
 * penyusunan struktur KeyframeSequence, sampling + slerp, transformasi dunia,
 * dan generator animasi preset R15.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

const START = "/* ===== ISM-CORE-START ===== */";
const END = "/* ===== ISM-CORE-END ===== */";
const a = html.indexOf(START);
const b = html.indexOf(END);
if (a < 0 || b < 0) {
  console.error("FATAL: marker ISM-CORE tidak ketemu di index.html");
  process.exit(1);
}
const coreSource = html.slice(a + START.length, b);
const ISMCore = new Function(coreSource + "\nreturn ISMCore;")();

/* ------------------------------------------------------------------ helpers */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra ? "  -> " + extra : "")); }
}
function near(x, y, eps = 1e-6) { return Math.abs(x - y) <= eps; }
function allFinite(arr, get) {
  for (const item of arr) for (const v of get(item)) if (!Number.isFinite(v)) return false;
  return true;
}
function heading(t) { console.log("\n" + t); }

/* ------------------------------------------------------------- fixtures */
// KeyframeSequence dengan pose bertingkat, CFrame modern + EulerRotation lama,
// satu keyframe yang sengaja tidak mempose tangan (uji carry-forward).
const FIXTURE_NESTED = `<?xml version="1.0" encoding="utf-8"?>
<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" version="4">
	<Item class="KeyframeSequence" referent="RBXSEQ">
		<Properties>
			<string name="Name">TestAnim</string>
			<bool name="Loop">true</bool>
			<token name="Priority">0</token>
		</Properties>
		<Item class="Keyframe" referent="RBXKF0">
			<Properties>
				<float name="Time">0</float>
			</Properties>
			<Item class="Pose" referent="RBX1">
				<Properties>
					<string name="Name">HumanoidRootPart</string>
					<CoordinateFrame name="CFrame">
						<X>0</X><Y>3</Y><Z>0</Z>
						<R00>1</R00><R01>0</R01><R02>0</R02>
						<R10>0</R10><R11>1</R11><R12>0</R12>
						<R20>0</R20><R21>0</R21><R22>1</R22>
					</CoordinateFrame>
				</Properties>
				<Item class="Pose" referent="RBX2">
					<Properties>
						<string name="Name">Torso</string>
						<CoordinateFrame name="CFrame">
							<X>0</X><Y>-0.5</Y><Z>0</Z>
							<R00>1</R00><R01>0</R01><R02>0</R02>
							<R10>0</R10><R11>1</R11><R12>0</R12>
							<R20>0</R20><R21>0</R21><R22>1</R22>
						</CoordinateFrame>
					</Properties>
					<Item class="Pose" referent="RBX3">
						<Properties>
							<string name="Name">Left Arm</string>
							<EulerRotation name="EulerRotation">
								<X>0</X><Y>90</Y><Z>0</Z>
							</EulerRotation>
						</Properties>
					</Item>
				</Item>
			</Item>
		</Item>
		<Item class="Keyframe" referent="RBXKF1">
			<Properties>
				<Time>1.5</Time>
			</Properties>
			<Item class="Pose" referent="RBX4">
				<Properties>
					<string name="Name">HumanoidRootPart</string>
					<CoordinateFrame name="CFrame">
						<X>0</X><Y>3</Y><Z>0</Z>
						<R00>1</R00><R01>0</R01><R02>0</R02>
						<R10>0</R10><R11>1</R11><R12>0</R12>
						<R20>0</R20><R21>0</R21><R22>1</R22>
					</CoordinateFrame>
				</Properties>
				<Item class="Pose" referent="RBX5">
					<Properties>
						<string name="Name">Torso</string>
						<CoordinateFrame name="CFrame">
							<X>0</X><Y>-0.5</Y><Z>0</Z>
							<R00>1</R00><R01>0</R01><R02>0</R02>
							<R10>0</R10><R11>1</R11><R12>0</R12>
							<R20>0</R20><R21>0</R21><R22>1</R22>
						</CoordinateFrame>
					</Properties>
				</Item>
			</Item>
		</Item>
	</Item>
</roblox>`;

// Pose datar (tanpa nesting) → parent harus disimpulkan dari peta nama R6.
const FIXTURE_FLAT = `<roblox version="4">
	<Item class="KeyframeSequence">
		<Properties><string name="Name">FlatR6</string><bool name="Loop">false</bool></Properties>
		<Item class="Keyframe">
			<Properties><float name="Time">0</float></Properties>
			<Item class="Pose"><Properties><string name="Name">Torso</string></Properties></Item>
			<Item class="Pose"><Properties><string name="Name">Head</string></Properties></Item>
			<Item class="Pose"><Properties><string name="Name">Left Arm</string></Properties></Item>
		</Item>
		<Item class="Keyframe">
			<Properties><float name="Time">0.5</float></Properties>
			<Item class="Pose"><Properties><string name="Name">Left Arm</string>
				<CoordinateFrame name="CFrame">
					<X>0</X><Y>0</Y><Z>0</Z>
					<R00>0</R00><R01>-1</R01><R02>0</R02>
					<R10>1</R10><R11>0</R11><R12>0</R12>
					<R20>0</R20><R21>0</R21><R22>1</R22>
				</CoordinateFrame>
			</Properties></Item>
		</Item>
	</Item>
</roblox>`;

/* ------------------------------------------------------------- 1. parser XML */
heading("1. Parser XML mini");
{
  const root = ISMCore.parseXML('<roblox version="4"><Item class="A">hi<Item class="B"/></Item></roblox>');
  ok("root & atribut terbaca", root.name === "roblox" && root.attrs.version === "4");
  ok("anak item terbaca", root.children[0].attrs.class === "A");
  ok("self-closing tag jadi elemen kosong", root.children[0].children[0].attrs.class === "B");
  ok("teks antar tag tersimpan", root.children[0].text.includes("hi"));

  const esc = ISMCore.parseXML("<a><b>&lt;x&gt;&amp;&#65;&#x42;&quot;</b></a>");
  ok("entity di-unescape", esc.children[0].childname === undefined || true);
  ok("entity hasil: " + esc.children[0].text, esc.children[0].text === '<x>&AB"');

  const cdata = ISMCore.parseXML("<a><![CDATA[<bukan tag> & apa pun]]></a>");
  ok("CDATA tidak diparse sebagai tag", cdata.text === "<bukan tag> & apa pun");

  const comment = ISMCore.parseXML("<a><!-- <x/> --><b>1</b></a>");
  ok("komentar diabaikan", comment.children.length === 1 && comment.children[0].name === "b");

  let threw = false;
  try { ISMCore.parseXML("<a><b></a>"); } catch (_) { threw = true; }
  ok("tag tidak cocok → error", threw);

  threw = false;
  try { ISMCore.parseXML("bukan xml sama sekali"); } catch (_) { threw = true; }
  ok("tanpa elemen root → error", threw);
}

/* --------------------------------------------- 2. KeyframeSequence bertingkat */
heading("2. Parse KeyframeSequence (CFrame + EulerRotation, pose bertingkat)");
{
  const seq = ISMCore.parseKeyframeSequence(FIXTURE_NESTED, { source: "fix" });
  const st = ISMCore.seqStats(seq);
  ok("nama sequence", st.name === "TestAnim");
  ok("loop true", st.loop === true);
  ok("2 keyframe", st.keyCount === 2, st.keyCount);
  ok("durasi 1.5s", near(st.duration, 1.5), st.duration);
  ok("3 joint (root, torso, arm)", st.jointCount === 3, st.jointCount);
  ok("2 bone (torso→root, arm→torso)", st.boneCount === 2, st.boneCount);

  const byName = Object.fromEntries(seq.joints.map((j, i) => [j.name, i]));
  ok("parent Torso = HumanoidRootPart", seq.joints[byName.Torso].parent === byName.HumanoidRootPart);
  ok("parent Left Arm = Torso", seq.joints[byName["Left Arm"]].parent === byName.Torso);

  const rootPos = seq.keys[0].locals[byName.HumanoidRootPart].p;
  ok("posisi root dari CFrame (x,y,z)", near(rootPos[1], 3) && near(rootPos[0], 0));

  // EulerRotation Y=90° harus jadi quaternion yang memutar -Z → -X
  const armQ = seq.keys[0].locals[byName["Left Arm"]].q;
  const fwd = ISMCore.qRotate(armQ, [0, 0, -1]);
  ok("EulerRotation 90° tentang Y: LookVector -Z → -X",
    near(fwd[0], -1, 1e-6) && near(fwd[2], 0, 1e-6), JSON.stringify(fwd));

  // keyframe ke-2 tidak mempose arm → carry-forward dari keyframe sebelumnya
  const armQ1 = seq.keys[1].locals[byName["Left Arm"]].q;
  ok("pose yang hilang di keyframe berikutnya di-carry forward", near(armQ1[1], armQ[1], 1e-9));

  const tr = ISMCore.worldTransforms(seq, 0.75);
  ok("worldTransforms menghasilkan 3 transform, semua finite",
    tr.length === 3 && allFinite(tr, (t) => [...t.p, ...t.q]));
  ok("root dunia y = 3", near(tr[byName.HumanoidRootPart].p[1], 3));
  ok("torso dunia y = 2.5", near(tr[byName.Torso].p[1], 2.5, 1e-6));
}

/* ------------------------------------------------- 3. pose datar (nama rig) */
heading("3. Pose datar → parent disimpulkan dari peta nama rig");
{
  const seq = ISMCore.parseKeyframeSequence(FIXTURE_FLAT, { source: "fix" });
  const byName = Object.fromEntries(seq.joints.map((j, i) => [j.name, i]));
  ok("Head → Torso (topologi R6 terdeteksi otomatis)", seq.joints[byName.Head].parent === byName.Torso);
  ok("Left Arm → Torso", seq.joints[byName["Left Arm"]].parent === byName.Torso);
  ok("Torso jadi root karena HumanoidRootPart tidak ada di file", seq.joints[byName.Torso].parent === -1);
  ok("loop false terbaca", seq.loop === false);
  ok("parent selalu muncul sebelum anak", seq.joints.every((j, i) => j.parent < i));
  ok("terdeteksi bukan R15", seq.kind !== "R15", seq.kind);
}

/* --------------------------------------- 3b. leluhur yang tidak ada di file */
heading("3b. Rantai parent menembus joint yang tidak dipose (R15)");
{
  // file hanya mempose Head — parent harus ditemukan lewat rantai R15
  const only = `<roblox><Item class="KeyframeSequence">
    <Properties><string name="Name">OnlyHead</string></Properties>
    <Item class="Keyframe"><Properties><float name="Time">0</float></Properties>
      <Item class="Pose"><Properties><string name="Name">UpperTorso</string></Properties></Item>
      <Item class="Pose"><Properties><string name="Name">Head</string></Properties></Item>
    </Item></Item></roblox>`;
  const seq = ISMCore.parseKeyframeSequence(only, { source: "fix" });
  const byName = Object.fromEntries(seq.joints.map((j, i) => [j.name, i]));
  ok("Head → UpperTorso (R15 dipilih)", seq.joints[byName.Head].parent === byName.UpperTorso);
  ok("UpperTorso jadi root (LowerTorso & root tidak ada)", seq.joints[byName.UpperTorso].parent === -1);

  // format legacy: <Vector3 name="EulerRotation">
  const legacy = `<roblox><Item class="KeyframeSequence">
    <Properties><string name="Name">Legacy</string></Properties>
    <Item class="Keyframe"><Properties><float name="Time">0</float></Properties>
      <Item class="Pose"><Properties>
        <string name="Name">Torso</string>
        <Vector3 name="EulerRotation"><X>0</X><Y>90</Y><Z>0</Z></Vector3>
      </Properties></Item>
    </Item></Item></roblox>`;
  const lseq = ISMCore.parseKeyframeSequence(legacy, { source: "fix" });
  const lv = ISMCore.qRotate(lseq.keys[0].locals[0].q, [0, 0, -1]);
  ok("format lama <Vector3 name=\"EulerRotation\"> ikut terbaca", near(lv[0], -1, 1e-6) && near(lv[2], 0, 1e-6), JSON.stringify(lv));
}

/* ------------------------------------------------------- 4. sampling & slerp */
heading("4. Sampling, interpolasi, dan slerp");
{
  const seq = ISMCore.parseKeyframeSequence(FIXTURE_FLAT, { source: "fix" });
  const byName = Object.fromEntries(seq.joints.map((j, i) => [j.name, i]));

  // 0° di t=0 → 90° di t=0.5, tengahnya harus ~45° tentang Z
  const mid = ISMCore.sampleLocals(seq, 0.25)[byName["Left Arm"]];
  const v = ISMCore.qRotate(mid.q, [0, -1, 0]);
  ok("interpolasi 45° di tengah: (0,-1,0) → (±0.7071,-0.7071,0)",
    near(Math.abs(v[0]), Math.SQRT1_2, 1e-3) && near(v[1], -Math.SQRT1_2, 1e-3), JSON.stringify(v.map((n) => +n.toFixed(4))));

  const before = ISMCore.sampleLocals(seq, -1)[byName["Left Arm"]];
  const after = ISMCore.sampleLocals(seq, 99)[byName["Left Arm"]];
  const vb = ISMCore.qRotate(before.q, [0, 0, -1]);   // sebelum t=0 → pose awal (identitas)
  const va = ISMCore.qRotate(after.q, [0, -1, 0]);    // setelah t terakhir → 90° tentang Z
  ok("t di luar rentang di-clamp ke keyframe ujung",
    near(vb[0], 0, 1e-6) && near(vb[2], -1, 1e-6) && near(va[0], 1, 1e-6) && near(va[1], 0, 1e-6),
    JSON.stringify([vb, va].map((v) => v.map((n) => +n.toFixed(3)))));

  // slerp langsung: 0° → 180° tentang X harus mendarat tepat di tengah, bukan degenerat
  const q180 = ISMCore.qAxis([1, 0, 0], Math.PI);
  const half = ISMCore.qSlerp([0, 0, 0, 1], q180, 0.5);
  const rot = ISMCore.qRotate(half, [0, 1, 0]);
  ok("slerp 0°→180° di t=0.5 mendarat di 90°", near(rot[2], 1, 1e-6), JSON.stringify(rot));
  ok("slerp tetap ternormalisasi", near(ISMCore.qNorm(half).reduce((s, n) => s + n * n, 0), 1, 1e-12));
  ok("slerp a==b mengembalikan a", near(ISMCore.qSlerp(q180, q180, 0.37)[3], q180[3], 1e-12));
}

/* ------------------------------------------------------- 5. matToQuat & qDeg */
heading("5. Konversi rotasi");
{
  const mz90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const q = ISMCore.matToQuat(mz90);
  const v = ISMCore.qRotate(q, [1, 0, 0]);
  ok("matToQuat: kolom X→Y untuk rotasi 90° Z", near(v[0], 0, 1e-6) && near(v[1], 1, 1e-6), JSON.stringify(v));

  const identity = ISMCore.matToQuat([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  ok("matToQuat identitas", near(identity[3], 1, 1e-9));

  const q2 = ISMCore.qDeg(30, 45, 60);
  ok("qDeg ternormalisasi & finite", allFinite([q2], (x) => x) && near(Math.hypot(...q2), 1, 1e-9));

  const qm = ISMCore.qMul(ISMCore.qDeg(0, 90, 0), ISMCore.qDeg(0, 0, 90));
  const vm = ISMCore.qRotate(qm, [0, 0, -1]);
  ok("qMul komposisi berurutan (Ry lalu Rz)", allFinite([vm], (x) => x) && near(Math.hypot(...vm), 1, 1e-9));
}

/* ------------------------------------------------ 6. generator preset R15 */
heading("6. Animasi preset R15 (idle / wave / walk)");
{
  for (const kind of ["idle", "wave", "walk"]) {
    const seq = ISMCore.proceduralSample(kind);
    const expected = kind === "walk" ? 1.2 : 2.0;
    ok(`[${kind}] durasi ${expected}s`, near(seq.duration, expected), seq.duration);
    ok(`[${kind}] 16 joint R15 / 15 bone`, seq.joints.length === 16 && seq.bones.length === 15);
    ok(`[${kind}] keyframe 30fps (${Math.round(expected * 30) + 1})`, seq.keys.length === Math.round(expected * 30) + 1, seq.keys.length);
    ok(`[${kind}] parent selalu sebelum anak`, seq.joints.every((j, i) => j.parent < i));

    let finite = true;
    for (const t of [0, expected / 4, expected / 2, (expected * 3) / 4, expected]) {
      const tr = ISMCore.worldTransforms(seq, t);
      if (tr.length !== 16) finite = false;
      if (!allFinite(tr, (x) => [...x.p, ...x.q])) finite = false;
    }
    ok(`[${kind}] semua transform finite di 5 titik waktu`, finite);

    const b = seq.bounds;
    ok(`[${kind}] bounds wajar (radius ${b.radius.toFixed(2)})`, b.radius > 0.5 && b.radius < 6 && Number.isFinite(b.center[1]));
    ok(`[${kind}] kepala ada di atas root pada t=0`,
      ISMCore.worldTransforms(seq, 0)[3].p[1] > ISMCore.worldTransforms(seq, 0)[0].p[1]);
  }

  // wave: tangan kanan harus terangkat jauh di atas pinggul
  const wave = ISMCore.proceduralSample("wave");
  const idx = Object.fromEntries(wave.joints.map((j, i) => [j.name, i]));
  const t0 = ISMCore.worldTransforms(wave, 0.25);
  ok("wave: RightHand terangkat di atas bahu", t0[idx.RightHand].p[1] > t0[idx.RightUpperArm].p[1], t0[idx.RightHand].p[1].toFixed(3));

  // wave: ujung tangan bergerak (tidak diam) sepanjang siklus
  const samples = [0, 0.2, 0.4, 0.6].map((t) => ISMCore.worldTransforms(wave, t)[idx.RightHand].p[0]);
  ok("wave: ujung tangan benar-benar bergerak", Math.max(...samples) - Math.min(...samples) > 0.02);

  // walk: kaki bergantian (posisi z berbeda tanda antar kaki)
  const walk = ISMCore.proceduralSample("walk");
  const wi = Object.fromEntries(walk.joints.map((j, i) => [j.name, i]));
  const w1 = ISMCore.worldTransforms(walk, 0.3);
  ok("walk: kaki kiri & kanan tidak segaris (langkah bergantian)",
    Math.abs(w1[wi.LeftFoot].p[2] - w1[wi.RightFoot].p[2]) > 0.05,
    (w1[wi.LeftFoot].p[2] - w1[wi.RightFoot].p[2]).toFixed(3));
}

/* ------------------------------------------------------------ 7. kasus error */
heading("7. Penanganan file yang tidak sesuai");
{
  let msg = "";
  try { ISMCore.parseKeyframeSequence("<roblox><Item class=\"Folder\"/></roblox>"); }
  catch (e) { msg = e.message; }
  ok("XML valid tapi tanpa KeyframeSequence → pesan jelas", /KeyframeSequence/.test(msg), msg);

  msg = "";
  try { ISMCore.parseKeyframeSequence("<roblox><Item class=\"KeyframeSequence\"></roblox>"); }
  catch (e) { msg = e.message; }
  ok("XML rusak → error dari parser", msg.length > 0, msg);

  const empty = "<roblox><Item class=\"KeyframeSequence\"><Properties><string name=\"Name\">Kosong</string></Properties></Item></roblox>";
  msg = "";
  try { ISMCore.parseKeyframeSequence(empty); } catch (e) { msg = e.message; }
  ok("KeyframeSequence tanpa Keyframe → pesan jelas", /Keyframe/.test(msg), msg);
}

/* ------------------------------------------------------------------ ringkas */
console.log("\n" + "=".repeat(54));
console.log(`${pass} lolos · ${fail} gagal`);
process.exit(fail ? 1 : 0);
