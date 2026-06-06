import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { crc32, zipBytes } from '../src/output/zip.js';

const enc = new TextEncoder();

describe('crc32', () => {
  it('matches known IEEE CRC-32 vectors', () => {
    assert.equal(crc32(enc.encode('')), 0x00000000);
    assert.equal(crc32(enc.encode('123456789')), 0xCBF43926); // canonical check value
    assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414FA339);
  });
});

describe('zipBytes — store-only ZIP', () => {
  const zip = zipBytes([
    { path: 'mimetype', data: enc.encode('application/epub+zip') },
    { path: 'hello.txt', data: enc.encode('hello world') },
  ]);

  it('returns a Uint8Array with the right signatures', () => {
    assert.ok(zip instanceof Uint8Array);
    const v = new DataView(zip.buffer);
    assert.equal(v.getUint32(0, true), 0x04034b50, 'starts with a local file header');
    // End-of-central-directory signature appears in the trailing 22 bytes.
    const endSig = new DataView(zip.buffer, zip.byteLength - 22).getUint32(0, true);
    assert.equal(endSig, 0x06054b50, 'ends with the EOCD record');
  });

  it('records the entry count in the EOCD', () => {
    const total = new DataView(zip.buffer, zip.byteLength - 22).getUint16(10, true);
    assert.equal(total, 2);
  });

  it('stores data uncompressed (compression method 0) with a real CRC', () => {
    const v = new DataView(zip.buffer);
    assert.equal(v.getUint16(8, true), 0, 'compression method = store');
    // first entry is "mimetype"; its CRC in the local header must match crc32()
    assert.equal(v.getUint32(14, true), crc32(enc.encode('application/epub+zip')));
  });
});
