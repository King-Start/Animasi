# Peta repo org ISpooferMotion — dan di mana web ini harus ditaruh

Ditulis setelah membaca isi tiap repo langsung (GitHub API + file mentah), bukan dari deskripsi.

## Isi org saat ini

| Repo | Isi sebenarnya | Ada logika ambil-aset? | Perannya |
| --- | --- | --- | --- |
| **ISM-Library** | 36 file: kit UI React (Accordion, Button, Input, Modal, MultiSelect, Progress, Switch, Tooltip, `theme/ism-library.css` dengan token warna, `layout/Layout.tsx`, hooks) + bun workspace + tsup + changesets | **Tidak** | Tampilan V2. Token warnanya berguna untuk menyamakan tampilan web. |
| **ISpooferMotion-V2** | 631 file: Tauri 2 (Rust) + React 19 + plugin Luau di `plugin/` | **Ya** — inti masalahmu ada di sini | Aplikasi desktop resmi |
| **Proxy** | 18 file: hanya `.github/workflows/*` (build daemon, loader, mcp-server, studio-payload, ui, runtime) + 5 skrip rilis | **Tidak** | CI/rilis, bukan aplikasi |
| **Core** | Runtime UI immediate-mode untuk aplikasi Tauri | Tidak | Pustaka internal |
| **ISpooferMotion** (v1) | Versi lama (Electron) | Ya (versi lama) | Arsip |

## Bagaimana V2 mengunduh aset terkunci (bukti dari kodenya)

**Kredensial** — `src-tauri/src/commands/auth/cookies.rs`:
- membaca `keyring::Entry` dengan nama `https://www.roblox.com:RobloxStudioAuth.ROBLOSECURITY` (cookie yang disimpan Roblox Studio di keyring OS),
- kalau tidak ada, menyisir database cookie browser: Chrome/Edge (`Network/Cookies`), Firefox (`cookies.sqlite`),
- menyimpannya untuk profil di keyring `ISpooferMotion.RobloxProfileCookie`.

**Pengambilan** — `src-tauri/src/commands/spoofer/download/api.rs`: tiga jalur berurutan
1. `GET https://www.roblox.com/library/{id}/` → cari `data-mediathumb-url="…"` di HTML;
2. `GET https://assetdelivery.roblox.com/v1/asset/?id={id}&expectedAssetType=Audio` tanpa mengikuti redirect → baca header `Location` (harus `rbxcdn.com`);
3. `POST https://assetdelivery.roblox.com/v2/assets/batch` dengan header `Cookie: .ROBLOSECURITY=…`, body `BatchAssetRequest[]` (`assetName, assetType, assetId, requestId, placeId?, serverPlaceId?, clientInsert`), User-Agent bergilir `RobloxStudio/WinInet` → `RobloxApp/WinInet` → `Roblox/WinInet`, plus header konteks game `Roblox-Place-Id`, `Roblox-Game-Id`, `Roblox-Session-Id`.
- HTTP **401** → "Your ROBLOSECURITY cookie is missing, invalid, or expired"; **429** → tunggu `Retry-After`.

**Kesimpulan:** aset terkunci memang **hanya** bisa lewat sesi login. V2 melakukannya **di komputer user** — cookie tidak pernah dikirim ke server.

## Keputusan untuk proyek web ini

- **Server web tidak menerima cookie.** Itu bukan kekurangan implementasi; Roblox tidak menyediakan API kunci untuk aset kreator lain (sudah diuji: `assets/v1/assets/{id}` hanya metadata, tidak ada endpoint konten; `assetdelivery` menolak tanpa sesi).
- **Padanannya:** userscript `ism-site/ism-fetch.user.js` — berjalan di browser user, memakai sesi yang sudah ada (`credentials: "include"`), dengan **tiga jalur yang sama seperti V2** (halaman library → assetdelivery v1 → batch v2 + konteks Place ID). Cookie tidak dibaca script dan tidak pernah dikirim ke server; ke server hanya byte file yang sudah jadi.
- **Plugin Luau** (`plugin/src/net/http.luau`) hanya bicara ke daemon lokal (`BASE_URL`) — jadi bagian "tempel ID ke plugin" tetap tugas plugin, sama seperti sekarang.

## Tema

Halaman web sekarang memakai token resmi dari `ISM-Library/packages/ui/theme/ism-library.css`
(palet gelap: `#08090c` / `#111114` / `#18181c`, teks `#eeedf2`, aksen mint `#a7f3d0`,
danger `#f87171`, success `#4ade80`, warning `#fbbf24`) — nilainya ditanam inline di
`spoof.html` + `index.html`, dan salinannya ada di `ism-site/ism-theme.css`.

## Di mana repo web ini sebaiknya ditaruh

Rekomendasi: **repo baru** di org, mis. `ISpooferMotion/ism-web` (jangan digabung ke ISM-Library —
itu kit UI untuk V2, dan web ini HTML/CSS/JS + Node tanpa build step).

Langkah push ada di `DEPLOY.md` (Bagian 1). Yang perlu ada di repo: 27 file yang ada di ZIP ini,
termasuk `.github/workflows/ci.yml` (5 suite tes) dan `pages.yml` (situs statis ke GitHub Pages).

Opsional berikutnya, kalau kamu mau: pakai `ISM-Library` betulan di web (butuh build step:
Vite + React + `@ism/ui`), supaya komponennya benar-benar sama dengan V2 — bukan sekadar warna.
