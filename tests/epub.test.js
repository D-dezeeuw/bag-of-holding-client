// tests/epub.test.js — the first headless EPUB test.
//
// buildEpub was browser-only because of exactly one global (OffscreenCanvas,
// used only for the rendered cover). With `cover: false` or caller-supplied
// PNG bytes it runs under node — and with explicit `uuid`/`modified` the
// output is byte-deterministic, which is the property a server export needs
// to promise "same world, same book".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildEpub } from '../src/output/epub.js';

const CHAPTERS = [
  { heading: 'The Salt Reach', text: 'A coast of drowned bells.\nNobody counts them twice.' },
  { heading: 'The Crossing', text: 'Forty days by sea.' },
];
const OPTS = {
  title: 'The Quiet Stair', subtitle: 'A world book', lang: 'en',
  chapters: CHAPTERS, tone: 'mysterious', tagline: 'what was buried is still there',
  uuid: '00000000-0000-4000-8000-000000000077', modified: '2026-08-15T00:00:00Z',
};

const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const text = (u8) => new TextDecoder('latin1').decode(u8);

describe('buildEpub, headless', () => {
  it('coverless: mimetype first, no cover anywhere, chapters lead the reading order', async () => {
    const book = text(await bytes(await buildEpub({ ...OPTS, cover: false })));

    // The EPUB contract: the FIRST local file header names `mimetype`,
    // stored, immediately followed by the media type.
    assert.equal(book.indexOf('mimetype'), 30, 'mimetype is the first entry');
    assert.ok(book.startsWith('PK'));
    assert.ok(book.includes('mimetypeapplication/epub+zip'), 'stored, not deflated');

    assert.ok(!book.includes('images/cover.png'), 'no cover image');
    assert.ok(!book.includes('cover.xhtml'), 'no cover page');
    assert.ok(!book.includes('np-cover'), 'no cover navPoint');
    assert.ok(book.includes('chapter-01.xhtml') && book.includes('chapter-02.xhtml'),
      'one chapter file per input');
    assert.ok(book.includes('playOrder="1"') && book.includes('The Salt Reach'),
      'the first chapter takes playOrder 1 — no gap where the cover was');
    assert.ok(book.includes('urn:uuid:00000000-0000-4000-8000-000000000077'));
    assert.ok(book.includes('2026-08-15T00:00:00Z'));
  });

  it('is byte-identical across two runs when uuid and modified are pinned', async () => {
    const a = await bytes(await buildEpub({ ...OPTS, cover: false }));
    const b = await bytes(await buildEpub({ ...OPTS, cover: false }));
    assert.deepEqual(a, b);
  });

  it('caller-supplied cover bytes embed without a canvas', async () => {
    // A 1×1 PNG (8-byte signature + minimal chunks) — validity does not
    // matter to the zip, recognisability does.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const book = text(await bytes(await buildEpub({ ...OPTS, cover: png })));
    assert.ok(book.includes('images/cover.png'), 'the supplied cover is in the archive');
    assert.ok(book.includes('cover.xhtml'), 'and gets its page');
    assert.ok(book.includes('properties="cover-image"'), 'and its manifest role');
    assert.ok(book.includes('np-cover'), 'and its navPoint');
    assert.ok(book.includes('playOrder="2"') && book.includes('The Salt Reach'),
      'chapters resume after the cover');
  });

  it('a bare uuid and a urn-prefixed one land identically', async () => {
    const bare = text(await bytes(await buildEpub({ ...OPTS, cover: false })));
    const urn = text(await bytes(await buildEpub({
      ...OPTS, cover: false, uuid: 'urn:uuid:00000000-0000-4000-8000-000000000077',
    })));
    assert.equal(bare, urn);
  });
});
