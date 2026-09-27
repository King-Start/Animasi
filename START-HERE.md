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

## Kalau ID publik pun tidak bisa diambil

Buka **Uji ambil saja** dan lihat kode HTTP di kolom error:

| Yang muncul | Artinya | Yang dilakukan |
| --- | --- | --- |
| **HTTP 429** | Servermu kena batas permintaan Roblox (batasnya per-IP, IP data center dipakai bersama) | Tunggu 1–2 menit lalu ulangi; kalau sering, jalankan server di komputermu sendiri |
| **HTTP 401/403 di semua ID** | Roblox menolak permintaan dari IP server itu, bukan soal asetnya | Jalankan server lokal, atau pakai userscript (ambil dari IP-mu) |
| **Sebagian gagal** dengan `User is not authorized` | Aset itu memang dibatasi pemiliknya | Userscript / tab *Dari file lokal* |

Sejak pembaruan ini, tiap baris gagal menampilkan **HTTP status** dan **daftar percobaan** (endpoint + User-Agent + status), dan server mencoba lima User-Agent bergilir seperti aplikasi V2. `/api/health` juga menampilkan **IP keluar server** (`egressIp`) supaya bisa dicek kalau Roblox memblokir IP-nya.

## Kalau situs bilang "gagal" padahal asetnya sudah masuk

Kasus ini nyata: upload kadang **berhasil** di Roblox, tapi situs **belum sempat** menerima
jawaban akhirnya. Dulu itu dilaporkan sebagai `gagal` — dan karena dianggap bisa diulang,
sistem meng-upload ulang berkas yang sama (makanya di Creator Dashboard muncul beberapa aset
dengan nama mirip hanya berselang beberapa detik).

Sekarang:

| Keadaan | Yang ditampilkan situs | Artinya |
| --- | --- | --- |
| Roblox memberi ID akhir | `selesai` + ID baru | aman, ID bisa langsung dipakai |
| Roblox belum menjawab sampai batas waktu | **`belum pasti`** (tile "Belum pasti", bukan "Gagal") | upload **kemungkinan besar sudah jadi**; tidak ada upload ulang, tidak ada aset ganda |
| ID akhirnya ketemu di daftar asetmu | `selesai` + tanda *ID dipulihkan otomatis* | ID tetap kamu dapat tanpa upload ulang |

Cara memakainya:

1. Tunggu ± 15–60 detik.
2. Tekan **Periksa ulang hasil** (atau tombol **Periksa ulang** di baris item itu).
   Situs akan menanyakan lagi status operasi upload **dan** membaca daftar aset terbaru milik
   User ID tujuan, lalu mencocokkan namanya dengan item yang belum pasti.
3. Kalau tetap belum ketemu, buka tautan **Creator Dashboard** di baris itu — asetnya ada di
   sana karena upload memang sudah jalan.

Catatan: pemulihan otomatis hanya bekerja untuk **target User** (daftar aset pribadi yang
publik). Untuk **target Grup**, Roblox tidak menyediakan daftar aset publik — di situ item
dibiarkan `belum pasti` beserta saran cek dashboard, bukan diklaim gagal.

### Kenapa ID hasil re-upload tidak langsung "bisa dipakai"?

Karena re-upload menghasilkan **aset baru milikmu**, bukan salinan dari aset lama. Animasi
Roblox tetap dikunci seperti asalnya: kalau asal asetnya cuma bisa dipakai di game tertentu
atau butuh kepemilikan, aset baru itu pun butuh cara pakai yang sama. Jadi setelah dapat ID baru:

- pakai jalur **Place ID** (isi Place/Game ID di situs) bila animasinya terikat game, atau
- tarik berkasnya lewat **userscript** (sesi browser kamu) lalu upload dari tab **Dari file lokal**, atau
- tempel ID barunya di jendela **"Replace Ids"** milik plugin Studio — ID itu memang ID milikmu,
  jadi bisa kamu pakai di tempatmu sendiri.

## Kalau masih gagal: pakai tiga tombol ini

Halaman spoofer punya tiga tombol di panel **Jalankan** yang menjawab "kok gagal terus" tanpa menebak-nebak:

| Tombol | Yang dilakukan | Cara membaca hasilnya |
| --- | --- | --- |
| **Cek kunci** | Membaca status kunci + mencoba beberapa operasi baca | Melihat bentuk kunci, masa berlaku, dan daftar izinnya |
| **Uji izin upload** | Menembak endpoint upload dengan permintaan yang **sengaja tidak lengkap**, jadi **tidak ada aset yang dibuat** | Lihat tabel di bawah |
| **Unduh laporan** | Mengunduh laporan job dalam bentuk teks | Isinya: status tiap item, HTTP status, **pesan asli dari Roblox**, sha256, dan langkah saran. Aman dikirim ke siapa pun — **tanpa kunci API** |

Hasil **Uji izin upload**:

| Yang muncul | Artinya | Yang dilakukan |
| --- | --- | --- |
| `KUNCI & IZIN DITERIMA` (HTTP 400 pada uji kosong) | Kunci dan izin sudah benar; kalau upload tetap gagal, penyebabnya di isi berkas/tipe aset, bukan di kunci | Kirim laporan job |
| `key-rejected` (HTTP 401 `Invalid API Key`) | Kunci salah salin, sudah dicabut, atau bukan kunci Open Cloud | Buat ulang di create.roblox.com → Credentials → API Keys, lalu tempel ulang (jangan pakai cookie) |
| `scope` (HTTP 403 `Insufficient permission`) | Kunci benar, tapi belum boleh **menulis** ke User/Group itu | Edit kuncinya: centang operasi **Write** di API Assets + tambahkan User/Group ID tujuan ke daftar izin |
| `blocked` / `blocked-waf` (HTTP 403 + halaman HTML) | Roblox menolak IP server ini | Jalankan server di komputermu, atau pakai userscript |
| `rate-limited` (HTTP 429) | Kena batas permintaan per-IP | Tunggu 1–2 menit |
| `cookie-refused` | Yang ditempel berbentuk cookie sesi | Server ini tidak meneruskan cookie — pakai API key |

Catatan penting: sejak pembaruan ini, **setiap kegagalan upload menampilkan HTTP status aslinya**, dan pesan Roblox ditampilkan apa adanya. Jadi kalau kuncinya yang bermasalah, di tabel akan tertulis `HTTP 401` + `Invalid API Key` — bukan disamarkan jadi "gagal".

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
