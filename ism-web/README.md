# ISpooferMotion Web

Web spoofer: **masukkan asset ID → keluar ID baru**, tanpa install aplikasi desktop.

Cara kerjanya singkat: server mengambil isi aset dari ID-nya (langkah ini tidak butuh
kredensial apa pun), lalu meng-upload balik ke akun/grup tujuanmu lewat
**Open Cloud Assets API** resmi Roblox memakai **Open Cloud API key** atau **OAuth 2.0**.

Hasilnya keluar dalam format yang persis diminta tombol **Replace Ids** di plugin
ISpooferMotion: `id_lama = id_baru,` satu per baris.

---

## Kenapa perlu server (dan bukan murni browser)

Dua alasan teknis, bukan pilihan desain:

1. **CORS.** Endpoint upload Roblox tidak mengizinkan permintaan dari halaman web,
   jadi panggilannya harus lewat server.
2. **Cookie akun tidak boleh lewat web.** Sesi Roblox bersifat HttpOnly dan terikat ke
   domain `roblox.com`. Satu-satunya cara sebuah situs "login sebagai kamu" adalah
   meminta kamu menempelkan cookie — dan itu persis pola phishing. Karena itu server ini
   **tidak punya jalur auth berbasis cookie sama sekali**, hanya API key dan OAuth resmi.

Kabar baiknya: server Node-nya kecil, jalan dari satu perintah, dan tidak butuh
installer desktop apa pun.

---

## Menjalankan

Butuh **Node 20+**.

```bash
# 1. (opsional) set konfigurasi
export ROBLOX_API_KEY="kunci-open-cloud-mu"   # kalau tidak diisi, user mengisi sendiri di UI
export CONCURRENCY=3                          # job paralel
export ACCESS_PASSWORD="rahasia"              # kalau server ini bisa diakses orang lain

# 2. jalankan
node ism-web/server.mjs

# 3. buka
#    http://localhost:8787/spoof.html
```

Server yang sama juga menyajikan seluruh situs di `http://localhost:8787/`
(termasuk playground viewer `.rbxmx`).

### Konfigurasi (environment variable)

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `8787` | port server |
| `HOST` | `0.0.0.0` | alamat bind |
| `STATIC_ROOT` | `../ism-site` | folder situs statis |
| `ROBLOX_API_KEY` | — | kalau diisi, user tidak perlu mengisi kunci di UI |
| `ACCESS_PASSWORD` | — | gerbang password; **wajib kalau server ini publik** |
| `SESSION_SECRET` | acak | dipakai menandatangani cookie gate/sesi OAuth |
| `CONCURRENCY` | `3` | job diproses paralel (1–6) |
| `MAX_ITEMS` | `120` | batas jumlah ID per job (1–500) |
| `JOB_RATE_LIMIT` | `10` | job per menit per IP |
| `ALLOWED_ORIGINS` | — | daftar origin CORS (mis. kalau UI di-host di GitHub Pages) |
| `ALLOW_ASSET_HOSTS` | — | host CDN tambahan (khusus dev/mirror; default hanya host Roblox) |
| `ROBLOX_OAUTH_CLIENT_ID` / `_SECRET` | — | mengaktifkan tombol login OAuth 2.0 |
| `ROBLOX_APIS_BASE` / `ROBLOX_ASSET_DELIVERY_BASE` / `ROBLOX_OAUTH_BASE` | resmi | untuk pengujian |
| `OAUTH_REDIRECT_URI` | otomatis | override kalau di belakang proxy |

---

## Membuat Open Cloud API key

1. Buka **create.roblox.com → Credentials → API Keys → Create API Key**.
2. Di **Access Permissions**, pilih API **Assets**, lalu aktifkan operasi **Read** dan **Write**.
3. Batasi **creator**-nya ke User ID atau Group ID tempat aset akan di-upload.
4. Opsional tapi disarankan: pasang **Accepted IP Addresses** dan tanggal kedaluwarsa.
5. Copy kuncinya ke halaman spoofer (atau ke `ROBLOX_API_KEY` kalau ini servermu sendiri).

Alternatifnya, daftarkan **OAuth 2.0 app** dengan scope `asset:read asset:write`, isi
`ROBLOX_OAUTH_CLIENT_ID` + `ROBLOX_OAUTH_CLIENT_SECRET`, dan user bisa login lewat tombol
di halaman spoofer — tanpa API key sama sekali.

Referensi resmi: <https://create.roblox.com/docs/cloud/guides/usage-assets>

---

## Endpoint HTTP

| Metode | Path | Fungsi |
| --- | --- | --- |
| `GET` | `/api/health` | status, mode auth yang tersedia, batas |
| `POST` | `/api/gate` | masuk dengan `ACCESS_PASSWORD` |
| `GET` | `/api/oauth/start` | mulai alur OAuth 2.0 |
| `GET` | `/api/oauth/callback` | callback OAuth → set sesi |
| `GET` | `/api/me` | status sesi login |
| `POST` | `/api/logout` | akhiri sesi OAuth |
| `POST` | `/api/parse` | uji parser input (tanpa membuat job) |
| `POST` | `/api/jobs` | buat job dari daftar ID |
| `POST` | `/api/jobs-file` | buat job dari file lokal (multipart) |
| `GET` | `/api/jobs/:id` | snapshot job + hasil siap tempel |
| `GET` | `/api/jobs/:id/events` | progres realtime (SSE) |
| `POST` | `/api/jobs/:id/cancel` | batalkan job |

Contoh:

```bash
curl -s localhost:8787/api/jobs -H 'content-type: application/json' -d '{
  "input": "180435571\n180426354",
  "apiKey": "KUNCI_OPEN_CLOUD",
  "options": { "userId": "1234567", "namePrefix": "ISM Spoof" }
}'
# → { "jobId": "...", "total": 2 }
```

---

## Pengujian

```bash
node ism-web/tests/api.test.mjs
```

128 pengujian, dijalankan terhadap **server Roblox tiruan** lewat HTTP sungguhan:

- alur lengkap ID → byte → upload → ID baru, termasuk upload ke grup dan operasi async
- **bukti byte identik**: SHA-256 byte yang diterima endpoint upload dibandingkan dengan byte dari CDN
  (memastikan tidak ada re-encode yang bisa merusak animasi)
- bentuk multipart & JSON request sesuai dokumentasi (`assetType`, `creationContext.creator`, `model/x-rbxm`)
- auth API key dan OAuth 2.0, retry pada 429, penanganan 404/401, gzip dari CDN
- **cookie akun tidak pernah dipakai** — termasuk diuji dengan sengaja mengirim
  `.ROBLOSECURITY` lalu memastikan server menolak dan tidak pernah meneruskannya ke Roblox
- path traversal, rate limit, kebocoran kunci di respons/log
- **parameter `?encoding=` di URL CDN harus dipertahankan** — tanpa itu CDN Roblox menjawab
  HTTP 403 (bug ini ketemu saat pengujian terhadap Roblox asli, dan sekarang dijaga test)

---

## Catatan keamanan

- **Tidak ada cookie.** Server tidak membaca, menyimpan, atau meneruskan cookie sesi Roblox.
  Satu-satunya cookie yang dipakai adalah milik server ini sendiri (gerbang + sesi OAuth).
- **Kunci API tidak ditulis ke disk** dan tidak pernah masuk log (yang di-log hanya bentuk teredaksi).
- **Kredensial per job dibuang** setelah job selesai, kecuali user memilih "ingat selama server hidup".
- **SSRF dijaga**: hanya URL isi aset di host Roblox yang diikuti (`ALLOW_ASSET_HOSTS` untuk dev).
- **Kalau server ini bisa diakses orang lain, wajib set `ACCESS_PASSWORD`** — kalau tidak, siapa pun
  yang bisa membuka halamannya bisa memakai kunci API yang kamu pasang di env.
- Untuk produksi: taruh di belakang HTTPS (mis. Cloudflare Tunnel / Caddy), dan batasi API key
  dengan IP allowlist + expiry.

## Yang belum didukung

- **Audio (Sound) dari ID**: isi audio di balik otentikasi, jadi harus lewat tab *Dari file lokal*.
- **`.rbx` biner** untuk mode file: upload menerima `.rbxm`/`.rbxmx` untuk Animation. File `.rbx`
  lama sebaiknya disimpan ulang sebagai `.rbxmx` dari Studio.
- **Patch permission aset** (yang di V2 desktop dilakukan lewat `asset-permissions-api`) belum
  diimplementasikan di jalur web.

## Lisensi

GPL-3.0-or-later, sama seperti project ISpooferMotion.
