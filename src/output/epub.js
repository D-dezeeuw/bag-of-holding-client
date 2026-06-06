// src/output/epub.js — zero-dep EPUB 3 builder.  ⚠️ BROWSER-ONLY.
//
//   buildEpub({ title, subtitle, lang, chapters, tone, tagline, brand }) → Promise<Blob>
//
// Each chapter: { heading, text, imageDataUri? }. Images are pulled out of their
// data-URIs and embedded as PNG/JPEG; the cover is rendered on an OffscreenCanvas.
// Relies on OffscreenCanvas / atob / crypto.randomUUID / Blob, so it runs in a
// browser, not under `node --test` (the store-only ZIP core in ./zip.js is the
// node-testable half). `brand` (default '') prefixes the metadata title and is
// drawn (upper-cased) on the cover — pass '' for an unbranded book.

import { buildZip } from './zip.js';

const _enc = new TextEncoder();
const _str = s => _enc.encode(s);

function _escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _dataUriToBytes(uri) {
  const m = uri.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!m) return null;
  const binary = atob(m[2]);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = m[1] === 'image/jpeg' ? 'jpg' : 'png';
  return { mime: m[1], ext, bytes };
}

// ─── Cover image (canvas-rendered) ───────────────────────────────────────────

const TONE_PALETTE = {
  grimdark:   { bg: '#1a0a0a', border: '#6b2020', accent: '#a03030', text: '#d4a878', brand: '#8c5a3a' },
  heroic:     { bg: '#0a1a3a', border: '#2a4a7a', accent: '#c8a020', text: '#e0d8c0', brand: '#8ca0c0' },
  mysterious: { bg: '#1a0a2a', border: '#4a2a6a', accent: '#8a6ab0', text: '#d0c8e0', brand: '#9080a8' },
};
const DEFAULT_PALETTE = { bg: '#f5e6c8', border: '#8c6a3a', accent: '#c8a878', text: '#3a2a1a', brand: '#8c6a3a' };

async function _renderCover(title, subtitle, tone, tagline, brand) {
  const W = 600, H = 800;
  const canvas = new OffscreenCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  const p      = TONE_PALETTE[tone] ?? DEFAULT_PALETTE;

  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = p.border;
  ctx.lineWidth   = 2;
  ctx.strokeRect(30, 30, W - 60, H - 60);
  ctx.strokeRect(36, 36, W - 72, H - 72);

  if (brand) {
    ctx.fillStyle = p.brand;
    ctx.font      = '18px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(brand.toUpperCase(), W / 2, 100);
  }
  ctx.textAlign = 'center';

  ctx.strokeStyle = p.accent;
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(100, 120); ctx.lineTo(W - 100, 120); ctx.stroke();

  // Title — word-wrapped
  ctx.fillStyle = p.text;
  ctx.font      = 'bold 36px Georgia, serif';
  const words = title.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > W - 120) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);

  const lineH = 46;
  const titleY = 280 - (lines.length * lineH) / 2;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], W / 2, titleY + i * lineH);

  const ruleY = titleY + lines.length * lineH + 20;
  ctx.strokeStyle = p.accent;
  ctx.beginPath(); ctx.moveTo(100, ruleY); ctx.lineTo(W - 100, ruleY); ctx.stroke();

  ctx.fillStyle = p.brand;
  ctx.font      = 'italic 20px Georgia, serif';
  ctx.fillText(subtitle, W / 2, ruleY + 50);

  if (tagline) {
    ctx.fillStyle = p.accent;
    ctx.font      = 'italic 14px Georgia, serif';
    const tagWords = tagline.split(' ');
    const tagLines = [];
    let tl = '';
    for (const w of tagWords) {
      const test = tl ? `${tl} ${w}` : w;
      if (ctx.measureText(test).width > W - 140) { tagLines.push(tl); tl = w; }
      else tl = test;
    }
    if (tl) tagLines.push(tl);
    const tagY = ruleY + 90;
    for (let i = 0; i < Math.min(tagLines.length, 3); i++) ctx.fillText(tagLines[i], W / 2, tagY + i * 20);
  }

  ctx.fillStyle = p.accent;
  ctx.font      = '28px serif';
  ctx.fillText('⁂', W / 2, H - 80);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// ─── EPUB assembly ───────────────────────────────────────────────────────────

const STYLE_CSS = `
body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.8; color: #3a2a1a; margin: 1em; }
h1 { text-align: center; font-size: 1.8em; color: #5c3d1a; margin-bottom: 0.3em; }
h2 { font-size: 1.2em; color: #5c3d1a; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #c8a878; padding-bottom: 0.4em; margin: 1.5em 0 0.8em; }
p { margin: 0.6em 0; text-align: justify; }
.subtitle { text-align: center; color: #8c6a3a; font-style: italic; margin-bottom: 2em; }
.cover-img { text-align: center; }
.cover-img img { max-width: 100%; max-height: 100%; }
.scene-img { margin: 1em 0; text-align: center; }
.scene-img img { max-width: 100%; border: 1px solid #c8a878; }
.ornament { text-align: center; color: #c8a878; font-size: 1.5em; margin: 1.5em 0; }
`;

export async function buildEpub({ title, subtitle, lang, chapters, tone, tagline, brand = '' }) {
  const uuid = 'urn:uuid:' + crypto.randomUUID();
  const titled = brand ? `${_escXml(brand)}: ${_escXml(title)}` : _escXml(title);
  const entries = [];

  // mimetype MUST be first, stored, no extra fields
  entries.push({ path: 'mimetype', data: _str('application/epub+zip') });
  entries.push({ path: 'META-INF/container.xml', data: _str(
    `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  )});
  entries.push({ path: 'OEBPS/style.css', data: _str(STYLE_CSS) });

  const coverPng = await _renderCover(title, subtitle, tone, tagline, brand);
  entries.push({ path: 'OEBPS/images/cover.png', data: coverPng });

  const imageFiles = [];
  for (let i = 0; i < chapters.length; i++) {
    if (!chapters[i].imageDataUri) continue;
    const img = _dataUriToBytes(chapters[i].imageDataUri);
    if (!img) continue;
    const filename = `scene-${String(i + 1).padStart(2, '0')}.${img.ext}`;
    imageFiles.push({ chapterIdx: i, filename, mime: img.mime, bytes: img.bytes });
    entries.push({ path: `OEBPS/images/${filename}`, data: img.bytes });
  }

  entries.push({ path: 'OEBPS/cover.xhtml', data: _str(
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"><head><title>Cover</title><link rel="stylesheet" href="style.css"/></head><body><div class="cover-img"><img src="images/cover.png" alt="Cover"/></div></body></html>`
  )});

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const imgFile = imageFiles.find(f => f.chapterIdx === i);
    const imgTag  = imgFile ? `<div class="scene-img"><img src="images/${imgFile.filename}" alt="Scene illustration"/></div>` : '';
    const paras   = _escXml(ch.text).split('\n').map(p => p.trim()).filter(Boolean).map(p => `<p>${p}</p>`).join('\n');
    const num     = String(i + 1).padStart(2, '0');
    entries.push({ path: `OEBPS/chapter-${num}.xhtml`, data: _str(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"><head><title>${_escXml(ch.heading)}</title><link rel="stylesheet" href="style.css"/></head><body>${imgTag}<h2>${_escXml(ch.heading)}</h2>\n${paras}\n<div class="ornament">⁂</div></body></html>`
    )});
  }

  const manifestItems = [
    `<item id="style" href="style.css" media-type="text/css"/>`,
    `<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>`,
    `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
  ];
  const spineItems = [`<itemref idref="cover"/>`];
  for (let i = 0; i < chapters.length; i++) {
    const num = String(i + 1).padStart(2, '0');
    manifestItems.push(`<item id="ch-${num}" href="chapter-${num}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="ch-${num}"/>`);
  }
  for (const img of imageFiles) {
    manifestItems.push(`<item id="img-${img.filename}" href="images/${img.filename}" media-type="${img.mime}"/>`);
  }

  entries.push({ path: 'OEBPS/content.opf', data: _str(
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${uuid}</dc:identifier><dc:title>${titled}</dc:title><dc:language>${lang}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata>\n<manifest>\n${manifestItems.join('\n')}\n</manifest>\n<spine toc="ncx">\n${spineItems.join('\n')}\n</spine>\n</package>`
  )});

  const navPoints = chapters.map((ch, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `<navPoint id="np-${num}" playOrder="${i + 2}"><navLabel><text>${_escXml(ch.heading)}</text></navLabel><content src="chapter-${num}.xhtml"/></navPoint>`;
  });
  entries.push({ path: 'OEBPS/toc.ncx', data: _str(
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uuid}"/></head><docTitle><text>${titled}</text></docTitle><navMap><navPoint id="np-cover" playOrder="1"><navLabel><text>Cover</text></navLabel><content src="cover.xhtml"/></navPoint>\n${navPoints.join('\n')}\n</navMap></ncx>`
  )});

  return buildZip(entries, { mimeType: 'application/epub+zip' });
}
