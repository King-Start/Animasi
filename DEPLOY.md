# Deploy: GitHub + Railway

Panduan lengkap dari folder ini sampai jalan di internet. Total sekitar 5 menit,
tanpa kartu kredit untuk percobaan awal (Railway memberi kredit percobaan; untuk
pemakaian terus-menerus cek halaman harga mereka).

> **Kesimpulan singkat: bisa.** Server ini memang dibuat untuk itu — dia menghormati
> `PORT` dari platform, bind ke `0.0.0.0`, punya endpoint health check, tidak menulis
> apa pun ke disk, dan OAuth otomatis memakai HTTPS dari Railway.

---

## Bagian 1 — Upload ke GitHub

```bash
# dari folder ini (root repo)
git init
git add -A
git commit -m "feat: ISpooferMotion Web — web spoofer via Open Cloud Assets API"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```

Sebelum push, pastikan **tidak ada rahasia yang ikut**:

```bash
git status --short          # tinjau file yang akan masuk
grep -rn "ROBLOX_API_KEY=" --include="*.mjs" --include="*.html" .   # tidak boleh ada kunci asli hardcoded
```

`.gitignore` sudah disiapkan: `.env`, `.env.*`, `node_modules/`, `*.key`, `*.pem`
tidak akan ikut ter-commit. Kunci API hanya boleh ada di **Variables** Railway.

---

## Bagian 2 — Deploy di Railway

1. Buka <https://railway.app> → **New Project** → **Deploy from GitHub repo**.
2. Pilih repo yang tadi. Kalau repo-nya privat, izinkan Railway mengaksesnya.
3. Railway membaca `package.json` + `railway.json` di root dan otomatis:
   - build dengan Nixpacks (tanpa dependency, jadi cepat),
   - menjalankan `node ism-web/server.mjs`,
   - mengecek kesehatan lewat `/api/health`.
4. **Root Directory: biarkan kosong** (root repo). Jangan diarahkan ke `ism-site` atau `ism-web`.
5. Setelah deploy sukses: **Settings → Networking → Generate Domain**.
   Kamu dapat URL seperti `https://nama-repo-production.up.railway.app`.

Cek cepat: buka `https://URL-KAMU/api/health` → harus keluar JSON `{"ok":true,...}`.
Lalu halaman spoofer: `https://URL-KAMU/spoof.html`.

---

## Bagian 3 — Pilih mode kredensial (INI YANG PALING PENTING)

Ada dua mode. Pilih sadar, jangan asal.

### Mode A — tiap user bawa kunci sendiri ← **disarankan untuk publik**

Jangan set `ROBLOX_API_KEY`. Setiap orang membuka halaman, menempelkan
Open Cloud API key miliknya sendiri, lalu menjalankan. Kunci hanya singgah di
memori server selama job berjalan, tidak ditulis ke disk, dan tidak masuk log.

Kelebihan: kamu tidak menanggung risiko apa pun; tidak ada kunci milikmu di server publik.
Kekurangan: user harus punya kunci sendiri (gratis, 30 detik di Creator Dashboard)
dan kuncinya melewati server kamu — jadi **wajib HTTPS** (Railway sudah HTTPS otomatis)
dan sebaiknya jalankan server ini sendiri, bukan di server orang yang tidak kamu percaya.

### Mode B — server memegang kunci (untuk kamu/tim sendiri)

Set `ROBLOX_API_KEY` di Railway Variables **dan wajib** set `ACCESS_PASSWORD`.
Kalau kamu lupa, **server akan menolak start** dan menjelaskan alasannya — ini pengaman
yang saya pasang supaya kunci tidak pernah terbuka di URL publik tanpa sengaja.

---

## Variables yang perlu diisi di Railway

**Settings → Variables** (jangan pernah di file yang di-commit):

| Variable | Wajib? | Isi |
| --- | --- | --- |
| `SESSION_SECRET` | ✅ | teks acak panjang (mis. hasil `openssl rand -hex 32`) |
| `ACCESS_PASSWORD` | ✅ kalau pakai Mode B | password untuk masuk halaman |
| `ROBLOX_API_KEY` | hanya Mode B | Open Cloud API key (scope Assets: Read + Write) |
| `ROBLOX_OAUTH_CLIENT_ID` | opsional | untuk tombol "Login dengan Roblox" |
| `ROBLOX_OAUTH_CLIENT_SECRET` | opsional | pasangannya |
| `OAUTH_REDIRECT_URI` | opsional | `https://URL-KAMU/api/oauth/callback` (kalau tidak diset, dihitung otomatis) |
| `CONCURRENCY` | opsional | `3` (1–6) |
| `MAX_ITEMS` | opsional | `120` (1–500) |
| `JOB_RATE_LIMIT` | opsional | `10` job/menit/IP |

> **Jangan set `PORT` atau `HOST`** — Railway mengisi `PORT` sendiri dan server
> sudah bind ke `0.0.0.0`.

Kalau memakai OAuth: daftarkan aplikasinya di
<https://create.roblox.com/credentials> dengan **Redirect URI** yang **persis sama**
dengan `https://URL-KAMU/api/oauth/callback` (skema, domain, path — semua harus cocok),
dan scope `asset:read asset:write`.

---

## Kalau mau URL-nya privat

Tiga cara, dari yang paling sederhana:

1. **`ACCESS_PASSWORD`** — satu kolom password sebelum halaman bisa dipakai. Cukup untuk
   dibagi ke teman/tim.
2. **Jangan generate domain publik** — Railway menyediakan domain internal; kamu bisa akses
   lewat `railway run` / tunnel pribadi. Tidak praktis untuk pemakaian harian.
3. **Pakai Cloudflare Tunnel dari komputermu** — server jalan di laptop, tunnel memberi HTTPS,
   dan bisa dibatasi lewat Cloudflare Access (login Google/email). Nol biaya hosting,
   tapi laptop harus menyala.

---

## Setelah deploy: verifikasi 4 hal ini

```bash
BASE=https://URL-KAMU

# 1. server hidup
curl -s $BASE/api/health

# 2. halaman tersaji
curl -s -o /dev/null -w "%{http_code}\n" $BASE/spoof.html      # harus 200

# 3. mode kredensial sesuai keinginanmu
curl -s $BASE/api/health | python3 -c "import sys,json;d=json.load(sys.stdin);print('serverKey:',d['authModes']['serverKey'],'| gate:',d['gate'],'| oauth:',d['authModes']['oauth'])"

# 4. fetch asli ke Roblox jalan dari server itu (tanpa kredensial apa pun)
curl -s -X POST $BASE/api/probe -H 'content-type: application/json' -d '{"input":"180435571"}'
```

`api/probe` harus mengembalikan `ok: true` dengan ukuran byte — itu membuktikan
server di Railway bisa menjangkau Roblox.

---

## Masalah yang sering muncul

| Gejala | Sebab & solusi |
| --- | --- |
| Deploy gagal: `No start command` | `package.json` di root belum ikut ter-push. Pastikan `railway.json` + `package.json` ada di root repo. |
| Build jalan tapi app crash saat start | Baca log: kalau ada tulisan `DITOLAK START demi keamanan`, itu pengaman kunci API (lihat Mode B). |
| `Application failed to respond` | Server tidak mendengar di `PORT` yang diberikan. Jangan set `PORT` manual. |
| Halaman 404 di `/` | Root Directory Railway salah diarahkan. Set ke root repo (kosong). |
| Halaman muncul tapi progres tidak bergerak | Sudah ada fallback: kalau SSE diblokir proxy, UI otomatis pindah ke polling setiap 1,5 detik. Refresh halaman untuk melihat hasil akhir. |
| OAuth: `invalid redirect_uri` | Redirect URI di aplikasi Roblox harus sama persis dengan `https://URL-KAMU/api/oauth/callback`. Perhatikan `http` vs `https` dan ada/tidaknya trailing slash. |
| OAuth: `state tidak cocok` | Cookie sesi hilang antar-request. Set `SESSION_SECRET` tetap (jangan biarkan acak) supaya sesi tidak batal saat instance restart. |
| Upload lambat / timeout | Roblox memproses aset secara asinkron. Server menunggu sampai 90 detik per item; kalau lewat, cek Creator Dashboard — asetnya sering tetap muncul. |
| **Upload tidak bisa / "Invalid API Key"** | Klik **Cek kunci dulu** di halaman spoofer. Tombol itu sekarang melakukan **uji nyata**: memakai kunci kamu untuk membaca satu aset lewat jalur auth yang sama dengan upload, jadi hasilnya bukan tebakan. Panel menyebut: putusan DITERIMA/DITOLAK, hasil tiap uji (HTTP + pesan Roblox), panjang kunci yang benar-benar diterima server, ada/tidak karakter tak terlihat atau non-ASCII, lalu sebab lainnya (kunci dicabut, IP dibatasi, kedaluwarsa, scope Assets/Write belum dicentang, User ID ≠ pemilik kunci). |
| **Kunci "kelihatan benar" tapi ditolak** | Biasanya kunci tersalin tidak lengkap (blok-teks manual di HP) atau kunci sudah di-Regenerate. Di dashboard tekan tombol **Copy** pada baris kuncinya, lalu di halaman spoofer tekan **Tempel** (membaca clipboard langsung, jadi tidak ada bagian yang terpotong). Tombol **Lihat** membuka isi kolom supaya bisa dicek mata sendiri. |
| **Ambil aset gagal** ("User is not authorized to access Asset" / "Authentication required to access Asset") | Aset ini dibatasi Roblox/kreatornya: hanya sesi Roblox yang login yang boleh mengambil isinya, dan kunci API **tidak bisa** mengambil aset milik kreator lain. Dua jalan: (1) isi **Place ID** game tempat animasi itu dipakai, lalu jalankan ulang (kadang cukup); (2) unduh file `.rbxm`-nya lewat ekstensi/ALECTRA di browser-mu, lalu lewat tab **Dari file lokal**. Di baris error itu ada tombol yang langsung memindahkan kamu ke tab tersebut. |
| **Kunci "terbaca" tapi upload tetap gagal** | Cek baris **jenis kredensial** di panel "Cek kunci dulu". Kunci API Open Cloud bentuknya ~48 karakter; kalau panel bilang panjangnya ratusan karakter, itu biasanya token/cookie dari alat lain, bukan kunci API — buat kunci baru di create.roblox.com. Kalau yang ditempel cookie sesi (`.ROBLOSECURITY`), server ini **menolaknya** dan tidak meneruskannya ke mana pun. |
| Ingin batas lebih longgar | Naikkan `CONCURRENCY` (maks 6) atau `MAX_ITEMS`; atau `JOB_RATE_LIMIT` kalau banyak orang memakai. |

---

## Catatan jujur soal hosting publik

- **Job disimpan di memori**, bukan database. Kalau Railway me-restart container
  (deploy baru, atau replika dihentikan), job yang sedang jalan hilang. Untuk pemakaian
  normal (job selesai dalam menit) ini tidak masalah; kalau perlu tahan restart, tambahkan
  database — tapi itu menambah permukaan risiko, jadi saya sengaja tidak memasukkannya.
- **Satu instance.** Rate limit dan daftar job bersifat per-proses. Kalau kamu menyalakan
  banyak replika, batasnya jadi tidak akurat dan job bisa "hilang" dari UI setelah refresh
  (karena pindah replika). Jalankan 1 replika.
- **Kunci API itu tetap kredensial.** Di Mode A kunci milik user melewati server kamu;
  di Mode B memakai kunci milikmu. Karena itu: selalu HTTPS, jangan pakai kunci yang
  sama dengan proyek lain, batasi scope ke Assets, pasang expiry, dan cabut kalau bocor.
  **Tidak ada cookie akun Roblox yang terlibat di mana pun** — itu batas yang tidak
  saya lewati, karena situs yang meminta cookie Roblox adalah pola phishing.

---

## Alternatif selain Railway

Repo yang sama bisa dipakai apa adanya di:

- **Render** — Web Service, Build `npm install`, Start `node ism-web/server.mjs`
- **Fly.io** — sudah ada `Dockerfile` (port 8080, user non-root)
- **VPS sendiri** — `node ism-web/server.mjs` di belakang Caddy/Nginx untuk HTTPS
- **Komputermu sendiri** — paling aman: `node ism-web/server.mjs`, akses `http://localhost:8787`
