// src/output/zip.js — minimal store-only ZIP writer (no compression).
//
// The byte assembly (`zipBytes` + `crc32`) is pure and node-testable; `buildZip`
// wraps the bytes in a browser Blob. Store-only with the mimetype-first ordering
// EPUB requires, but generic enough for any "bundle files into a download" use.
//
// An entry is { path: string, data: Uint8Array }.

const _enc = new TextEncoder();

// CRC-32 (IEEE) — table built once at module load.
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Assemble the entries into a single store-only ZIP byte stream (Uint8Array).
// Pure — no DOM, no Blob — so it unit-tests under node.
export function zipBytes(entries) {
  const parts   = [];
  const central = [];
  let offset    = 0;

  for (const { path, data } of entries) {
    const nameBytes = _enc.encode(path);
    const crc       = crc32(data);

    // Local file header (30 bytes + name + data)
    const local = new ArrayBuffer(30 + nameBytes.length + data.length);
    const lv    = new DataView(local);
    const lu    = new Uint8Array(local);
    lv.setUint32(0,  0x04034b50, true);  // signature
    lv.setUint16(4,  20, true);          // version needed
    lv.setUint16(6,  0, true);           // flags
    lv.setUint16(8,  0, true);           // compression: store
    lv.setUint16(10, 0, true);           // mod time
    lv.setUint16(12, 0, true);           // mod date
    lv.setUint32(14, crc, true);         // crc32
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra length
    lu.set(nameBytes, 30);
    lu.set(data, 30 + nameBytes.length);
    parts.push(lu);

    // Central directory entry (46 bytes + name)
    const cen = new ArrayBuffer(46 + nameBytes.length);
    const cv  = new DataView(cen);
    const cu  = new Uint8Array(cen);
    cv.setUint32(0,  0x02014b50, true);  // signature
    cv.setUint16(4,  20, true);          // version made by
    cv.setUint16(6,  20, true);          // version needed
    cv.setUint16(8,  0, true);           // flags
    cv.setUint16(10, 0, true);           // compression: store
    cv.setUint16(12, 0, true);           // mod time
    cv.setUint16(14, 0, true);           // mod date
    cv.setUint32(16, crc, true);         // crc32
    cv.setUint32(20, data.length, true); // compressed size
    cv.setUint32(24, data.length, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra length
    cv.setUint16(32, 0, true);           // comment length
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, offset, true);      // local header offset
    cu.set(nameBytes, 46);
    central.push(cu);
    offset += lu.length;
  }

  // End-of-central-directory record
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const end = new ArrayBuffer(22);
  const ev  = new DataView(end);
  ev.setUint32(0,  0x06054b50, true);    // signature
  ev.setUint16(4,  0, true);             // disk number
  ev.setUint16(6,  0, true);             // disk with central dir
  ev.setUint16(8,  entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);        // central dir offset
  ev.setUint16(20, 0, true);             // comment length

  const chunks = [...parts, ...central, new Uint8Array(end)];
  const total  = chunks.reduce((n, c) => n + c.length, 0);
  const out    = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// Wrap the assembled bytes in a Blob (browser). `mimeType` lets callers brand the
// archive (e.g. 'application/epub+zip').
export function buildZip(entries, { mimeType = 'application/zip' } = {}) {
  return new Blob([zipBytes(entries)], { type: mimeType });
}
