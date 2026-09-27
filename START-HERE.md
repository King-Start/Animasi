# ISpooferMotion Web — mulai dari sini

## 1. Butuh apa
- **Node.js 20+** → cek dengan `node --version`
- **Open Cloud API key** dari Roblox (gratis, 30 detik) → lihat langkah 3

## 2. Jalankan server
```bash
cd ism-web
node server.mjs
```
Lalu buka: **http://localhost:8787/spoof.html**

(Windows: jalankan di Command Prompt atau PowerShell, perintahnya sama.)

## 3. Buat Open Cloud API key
1. Buka https://create.roblox.com/credentials → **Create API Key**
2. Bagian **Access Permissions** → pilih API **Assets**
3. Aktifkan operasi **Read** + **Write**
4. (Disarankan) pasang **Accepted IP Addresses** dan tanggal kedaluwarsa
5. Copy kuncinya (mulai dengan karakter acak panjang) → tempel di halaman spoofer

> Alternatif tanpa API key: kalau kamu punya OAuth 2.0 app, set
> `ROBLOX_OAUTH_CLIENT_ID` + `ROBLOX_OAUTH_CLIENT_SECRET` lalu pakai tombol
> "Login dengan Roblox".

## 4. Pakai
1. Tempel daftar asset ID (keluaran plugin **Get Ids** langsung bisa ditempel)
2. Isi **User ID** (akunmu) atau **Group ID** (kalau upload ke grup)
3. Tempel **API key**
4. Tekan **Uji ambil saja** dulu kalau mau lihat ID mana yang bisa ditarik (tanpa kredensial)
5. Tekan **Jalankan Spoofer**
6. Copy hasilnya → tempel ke tombol **Replace Ids** di plugin ISpooferMotion di Studio

## Mau taruh di internet (GitHub + Railway)?
Ikuti langkah lengkap di **DEPLOY.md** — termasuk bagian yang paling penting:
memilih antara "tiap user bawa kunci sendiri" (aman untuk publik) dan
"server memegang kunci" (wajib pakai ACCESS_PASSWORD, kalau tidak server menolak start).

## Kalau mau orang lain memakai
```bash
export ACCESS_PASSWORD="rahasia"      # WAJIB, kalau tidak siapa pun bisa pakai kunci di server ini
export ROBLOX_API_KEY="kunci-mu"      # user jadi tidak perlu mengisi apa pun, cukup tempel ID
node server.mjs
```
Untuk publik, taruh di belakang HTTPS (mis. Cloudflare Tunnel atau Caddy), jangan expose HTTP polos.

## Yang perlu diketahui
- Server ini **tidak pernah** memakai cookie akun Roblox. Auth hanya API key / OAuth.
- API key tidak ditulis ke disk dan tidak masuk log.
- Hanya proses aset yang kamu punya hak atau izinnya.
- Audio (Sound) tidak bisa ditarik dari ID → pakai tab "Dari file lokal".

---

## Aset yang dikunci (mis. animasi grup lain)

Server ini **tidak memakai cookie**, jadi server memang tidak bisa mengambil aset yang hanya
boleh dibuka sesi login. Yang bisa: `ism-site/ism-fetch.user.js`.

1. Pasang Tampermonkey / Violentmonkey di browser atau HP-mu.
2. Buka halaman aset Roblox-nya, tekan tombol **ISM · ambil aset**.
3. Pilih **Ambil & unduh** (lanjut tarik file ke tab *Dari file lokal*), atau isi Pengaturan
   sekali (alamat situs + kunci API + User/Group ID) lalu **Ambil & kirim ke situs** —
   ID barunya langsung muncul.

Cookie sesimu tidak dibaca script itu dan tidak pernah dikirim ke server mana pun:
browser-mu sendiri yang melampirkannya ke Roblox, sama seperti halaman Roblox biasa.

### Cara memasang userscript-nya (pilih sesuai perangkat)

File script: `ism-site/ism-fetch.user.js` di paket/ZIP ini, atau unduh dari halaman spoofer
(tautan **unduh ism-fetch.user.js** di tab *Dari file lokal*), yaitu alamat
`https://ALAMAT-SITUS-MU/ism-fetch.user.js`.

**Komputer (Chrome / Edge / Brave / Firefox):**
1. Pasang ekstensi **Tampermonkey** dari toko ekstensi browser-mu, tunggu ikonnya muncul.
2. Buka `https://ALAMAT-SITUS-MU/ism-fetch.user.js` di tab baru.
3. Tampermonkey otomatis menampilkan halaman instalasi, tekan **Install**.
4. Buka halaman aset Roblox-nya, tombol **ISM - ambil aset** muncul di kanan bawah.

**Android:**
Chrome Android **tidak bisa** memasang ekstensi. Pakai salah satu:
- **Firefox Android** (paling mudah): menu (titik tiga) -> *Add-ons* -> **Tampermonkey** -> pasang ->
  buka `https://ALAMAT-SITUS-MU/ism-fetch.user.js` -> **Install**.
- **Kiwi Browser** (Chromium yang bisa ekstensi): menu -> *Extensions* -> buka Chrome Web Store ->
  Tampermonkey -> pasang -> buka URL script -> **Install**.

**Kalau tidak bisa membuka URL script** (mis. situs belum ke-deploy): buka dashboard
Tampermonkey -> tab "+" (script baru) -> hapus isinya -> tempel seluruh isi file
`ism-fetch.user.js` -> simpan (Ctrl+S).

**Cek sudah terpasang:** buka halaman aset Roblox apa pun; kalau tombol bulat
**ISM - ambil aset** ada di kanan bawah, script hidup.

### Setelan sekali pakai (untuk tombol "Ambil & kirim ke situs")
Tekan **Pengaturan** di panel script, isi:
- **Alamat situs**: `https://ALAMAT-SITUS-MU` (tanpa garis miring di ujung)
- **Kunci API Open Cloud** (create.roblox.com -> Credentials -> API Keys -> API Assets, Read + Write)
- **User ID** dan/atau **Group ID** tujuan

Ketiganya disimpan **di browser kamu sendiri** (penyimpanan Tampermonkey), bukan di server mana pun.
