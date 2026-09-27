/**
 * Parser input ala ISpooferMotion.
 *
 * Menerima SEMUA bentuk yang lazim ditemui:
 *   --[[ TYPE: ANIMATION ]]            <- header dari plugin (diabaikan)
 *   [1234567890] [Run Animation] [User:2],   <- keluaran plugin Get Ids
 *   https://www.roblox.com/library/1234567890/apa-pun
 *   rbxassetid://1234567890
 *   1234567890 = 9876543210,           <- output app (ID lama dipakai, yang baru diabaikan)
 *   1234567890  1234567891
 *   "assetId=1234567890" / "id: 1234567890"
 *
 * Hasil: daftar unik, urut menaik, dengan petunjuk (hint) dari plugin.
 */

const MIN_DIGITS = 6;

const HEADER_RE = /^--\[\[\s*TYPE:\s*([A-Z]+)\s*\]\]/i;
const BRACKET_RE = /^\[(\d{5,})\]\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?/;
const PAIR_RE = /(\d{5,})\s*=\s*(\d{5,})/g;
const GROUP_HINT_RE = /\[(Group|User):(\d+)\]/i;

/** Ambil angka apa pun yang panjangnya masuk akal sebagai asset ID. */
function bareNumbers(line) {
  const out = [];
  const re = new RegExp("\\d{" + MIN_DIGITS + ",}", "g");
  let m;
  while ((m = re.exec(line))) out.push(m[0]);
  return out;
}

export function parseAssetList(text) {
  const raw = String(text || "");
  const items = new Map();
  let typeHint = null;
  let lineNo = 0;

  for (const rawLine of raw.split(/\r?\n/)) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;

    const header = HEADER_RE.exec(line);
    if (header) {
      typeHint = header[1].toUpperCase();
      continue;
    }
    if (line.startsWith("--")) continue; // komentar Lua

    const bracket = BRACKET_RE.exec(line);
    if (bracket) {
      const id = bracket[1];
      const name = (bracket[2] || "").replace(/,\s*$/, "").trim();
      const creator = (bracket[3] || "").trim();
      const gh = GROUP_HINT_RE.exec(`[${creator}]`);
      add(items, id, {
        name: name || null,
        creatorType: gh ? gh[1] : null,
        creatorId: gh ? gh[2] : null,
        line: lineNo
      });
      continue;
    }

    // "lama = baru" → ambil sisi kiri saja (kita mau memproses ulang yang lama)
    const pair = line.match(new RegExp("^(\\d{" + MIN_DIGITS + ",})\\s*=\\s*(\\d{" + MIN_DIGITS + ",})"));
    if (pair) {
      add(items, pair[1], { replacedBy: pair[2], line: lineNo });
      continue;
    }

    // URL / rbxassetid / assetId= / id: / angka telanjang
    const prefixed =
      line.match(/(?:rbxassetid:\/\/|library\/|assetId=|assetid=|id=|id:\s*)(\d{5,})/i);
    if (prefixed) {
      add(items, prefixed[1], { line: lineNo });
      continue;
    }
    for (const n of bareNumbers(line)) add(items, n, { line: lineNo });
  }

  const list = [...items.values()].sort((a, b) => Number(a.id) - Number(b.id));
  return { items: list, typeHint, total: list.length };
}

function add(map, id, extra) {
  const key = String(id).replace(/^0+(?=\d)/, "");
  if (map.has(key)) {
    const prev = map.get(key);
    map.set(key, { ...prev, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)) });
    return;
  }
  map.set(key, { id: key, ...extra });
}

/** Output drop-in untuk plugin: `1234567890 = 9876543210,` */
export function formatForPlugin(pairs) {
  return pairs.map((p) => `${p.oldId} = ${p.newId},`).join("\n");
}

/** Format alternatif untuk ditampilkan / disimpan. */
export function formatPlain(pairs) {
  return pairs.map((p) => p.newId).join("\n");
}

export function formatPairs(pairs) {
  return pairs.map((p) => `${p.oldId},${p.newId}`).join("\n");
}
