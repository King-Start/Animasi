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
