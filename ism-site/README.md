# ISM Site — dokumentasi + playground + Web Spoofer

Situs untuk project **ISpooferMotion**, tiga bagian:

1. **`index.html`** — dokumentasi: fitur, alur kerja, FAQ, dan playground viewer animasi.
2. **`spoof.html`** — **Web Spoofer**: masukkan asset ID → keluar ID baru, siap ditempel ke plugin Studio.
3. **`../ism-web/`** — server Node kecil yang melayani `spoof.html` (fetch + upload).

- **Tanpa build step.** Dua halaman HTML-nya berisi HTML + CSS + JS inline.
- **Tanpa resource eksternal.** Tidak ada CDN, font, atau gambar dari luar — bisa dibuka
  offline dan aman dipreview di iframe sandbox.
- **Playground tanpa login, tanpa cookie, tanpa server.** Viewer membaca file lokal di
  browser kamu saja; tidak ada satu byte pun yang dikirim keluar.

---

## Struktur

```
ism-site/
├── index.html                  # dokumentasi + playground (satu file)
├── spoof.html                  # Web Spoofer (butuh server di ../ism-web)
├── tests/
│   ├── core.test.mjs           # 69 test logika inti (node murni, tanpa dependency)
│   └── ui.smoke.mjs            # 67 test UI index.html di jsdom
├── .github/workflows/pages.yml # deploy otomatis ke GitHub Pages
└── package.json                # script test & serve

ism-web/
├── server.mjs                  # server: menyajikan situs + API fetch/upload
├── lib/roblox.mjs              # klien Roblox (delivery + Open Cloud + OAuth)
├── lib/parse.mjs               # parser daftar asset ID ala ISpooferMotion
├── tests/
│   ├── api.test.mjs            # 83 test end-to-end vs server Roblox tiruan
│   └── spoof.ui.test.mjs       # 47 test UI spoof.html di jsdom
└── .env.example
```

## Menjalankan

Cukup buka `index.html` di browser. Untuk versi ber-server (perlu kalau mau tes
drop-file / clipboard yang lebih ketat):

```bash
python3 -m http.server 8080     # lalu buka http://localhost:8080
```

## Test

```bash
node tests/core.test.mjs                    # logika inti — tanpa dependency apa pun
npm install jsdom                           # dev-only, untuk test UI
node tests/ui.smoke.mjs                     # UI index.html (canvas di-stub)
node ../ism-web/tests/spoof.ui.test.mjs     # UI spoof.html (fetch & SSE disimulasikan)
node ../ism-web/tests/api.test.mjs          # end-to-end vs server Roblox tiruan
```

Total **384 pengujian**: 69 (core) + 67 (situs) + 78 (UI spoofer) + 170 (API end-to-end).

`tests/core.test.mjs` bekerja dengan cara mengekstrak blok di antara marker
`/* ===== ISM-CORE-START ===== */` dan `/* ===== ISM-CORE-END ===== */` dari
`index.html`, lalu menjalankannya di Node. Jadi logika yang diuji adalah **kode yang
sama persis** dengan yang jalan di browser — bukan salinan terpisah yang bisa melenceng.

Yang diuji: parser XML mini, konversi `CFrame`/`EulerRotation` → quaternion, pemilihan
topologi rig R6 vs R15 secara otomatis, interpolasi + slerp, transformasi dunia, dan
generator animasi preset.

## Deploy

**GitHub Pages** — taruh folder ini di repo, aktifkan Settings → Pages → Source:
*GitHub Actions*. Workflow di `.github/workflows/pages.yml` akan menjalankan test core
lalu publish foldernya.

**Netlify / Vercel / Cloudflare Pages** — drag & drop folder ini, atau hubungkan repo
dan set publish directory ke `ism-site` (build command boleh dikosongkan).

---

## Bagian playground: apa yang sebenarnya dilakukan

Drop file `.rbxmx` / `.rbxm` / `.xml` berisi `Item class="KeyframeSequence"`:

1. **Parse** — parser XML mini sendiri (mendukung komentar, CDATA, entity, atribut
   ber-namespace), lalu item `KeyframeSequence` → `Keyframe` → `Pose`.
2. **Konversi** — `CFrame` (`R00`…`R22`) atau format lama `EulerRotation` → quaternion
   per joint, plus carry-forward untuk joint yang tidak dipose di keyframe tertentu.
3. **Rekonstruksi rig** — kalau pose disimpan bertingkat, nesting itu yang dipakai. Kalau
   datar, topologi disimpulkan otomatis dari nama joint (peta R15 dan R6 diuji, yang
   paling cocok menang).
4. **Render** — proyektor pseudo-3D di canvas 2D: bone, joint, kepala dengan penanda arah
   hadap, grid, bayangan, dan kamera orbit (drag + scroll).
5. **Interpolasi** — posisi linear, rotasi **slerp**, sama seperti cara engine memutar
   animasi. Timeline bisa di-scrub, speed 0.25×–2×, loop on/off, ekspor PNG.

File `.rbx` (biner) tidak didukung — buka di Roblox Studio lalu simpan ulang sebagai
`.rbxmx` (XML).

## Yang tools-nya lakukan

Pembersih daftar asset ID: tempel keluaran **Get Ids** dari plugin Studio (atau URL
`roblox.com/library/…`, `rbxassetid://…`, `assetId=…`, campur teks bebas) → keluar satu
ID per baris, unik dan terurut. Default hanya mengambil angka **≥ 6 digit** supaya angka
lain (versi, jumlah, koordinat) tidak ikut terbawa; ada opsi untuk ikut menyertakan
angka 4–5 digit.

---

## Web Spoofer (`spoof.html` + `../ism-web`)

Alur inti ISpooferMotion — **ID lama → ID baru** — dijalankan dari browser:

1. **Ambil isi aset.** `assetdelivery.roblox.com/v2/assetId/{id}` mengembalikan lokasi CDN
   **tanpa kredensial apa pun** (diuji langsung terhadap Roblox: 9 dari 15 animasi populer
   bisa ditarik; sisanya dijawab `Authentication required` dan harus lewat file lokal).
2. **Upload balik** lewat Open Cloud Assets API (`POST /assets/v1/assets`) memakai
   **Open Cloud API key** atau **OAuth 2.0**. Byte dikirim apa adanya — tidak ada re-encode.
3. **Hasil** keluar sebagai `id_lama = id_baru,` — format yang diminta tombol *Replace Ids*.

Kenapa perlu server kecil (bukan murni browser): endpoint upload Roblox kena CORS, dan
cookie akun tidak boleh lewat web. Detail lengkap + variabel konfigurasi ada di
[`../ism-web/README.md`](../ism-web/README.md).

### Yang TETAP tidak ada di situs ini, dan kenapa

**Cookie sesi Roblox tidak pernah dipakai.** Halaman spoofer tidak punya kolom cookie, dan
servernya tidak membaca/menyimpan/meneruskan cookie akun — hanya API key (yang bisa dicabut
dan dibatasi) atau token OAuth (scope `asset:read asset:write`). Ini diuji otomatis: dengan
sengaja mengirim `.ROBLOSECURITY` ke API-nya, server harus menolak dan tidak meneruskannya ke
Roblox.

Alasannya praktis: `.ROBLOSECURITY` = kunci penuh akun yang menembus 2FA. Situs yang meminta
cookie Roblox adalah pola phishing, apa pun niatnya. Jadi jalur web sengaja dibangun di atas
API resmi Roblox, bukan sesi.

## Lisensi

Project ISpooferMotion dilisensikan **GPL-3.0-or-later**. Kalau kode situs ini digabung
ke dalam repo project, ikut lisensi yang sama.

## Tanggung jawab pemakaian

Hanya proses aset yang kamu punya hak atau izinnya — aset buatan sendiri, aset tim/studio
kamu, atau yang pemiliknya sudah memberi izin. Re-upload karya orang lain tanpa izin
melanggar aturan platform sekaligus hak cipta mereka.
