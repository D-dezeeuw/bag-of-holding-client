import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseImageFromResponse } from '../src/llm/image.js';
import { pcmToWav, bytesToBase64, TTS_FALLBACKS, PCM_MODELS } from '../src/llm/audio.js';

describe('parseImageFromResponse — provider shapes', () => {
  it('reads the Gemini-via-OpenRouter message.images[] shape', () => {
    const data = { choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] } }] };
    assert.equal(parseImageFromResponse(data), 'data:image/png;base64,AAAA');
  });
  it('reads content[] image_url, image+data, and inline_data parts', () => {
    const url = { choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,U' } }] } }] };
    assert.equal(parseImageFromResponse(url), 'data:image/png;base64,U');
    const raw = { choices: [{ message: { content: [{ type: 'image', data: 'XYZ' }] } }] };
    assert.equal(parseImageFromResponse(raw), 'data:image/png;base64,XYZ');
    const inline = { choices: [{ message: { content: [{ inline_data: { mime_type: 'image/jpeg', data: 'JJ' } }] } }] };
    assert.equal(parseImageFromResponse(inline), 'data:image/jpeg;base64,JJ');
  });
  it('extracts a data-URI embedded in a string', () => {
    const data = { choices: [{ message: { content: 'here you go data:image/png;base64,Zm9v= done' } }] };
    assert.equal(parseImageFromResponse(data), 'data:image/png;base64,Zm9v=');
  });
  it('returns null when there is no image', () => {
    assert.equal(parseImageFromResponse({ choices: [{ message: { content: 'just text' } }] }), null);
    assert.equal(parseImageFromResponse({}), null);
    assert.equal(parseImageFromResponse(null), null);
  });
});

describe('pcmToWav', () => {
  it('prepends a 44-byte RIFF/WAV header and preserves the samples', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
    const wav = new Uint8Array(pcmToWav(pcm));
    assert.equal(wav.byteLength, 44 + 6);
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
    assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
    assert.equal(String.fromCharCode(...wav.slice(36, 40)), 'data');
    assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4, 5, 6]); // samples intact after header
    // little-endian data length field at byte 40
    const view = new DataView(wav.buffer);
    assert.equal(view.getUint32(40, true), 6);
  });
});

describe('bytesToBase64', () => {
  it('encodes ArrayBuffer and Uint8Array identically to Buffer', () => {
    const bytes = new Uint8Array([102, 111, 111]); // "foo"
    assert.equal(bytesToBase64(bytes), 'Zm9v');
    assert.equal(bytesToBase64(bytes.buffer), 'Zm9v');
  });
});

describe('TTS model policy', () => {
  it('exposes a fallback chain and the PCM model set', () => {
    assert.ok(Array.isArray(TTS_FALLBACKS) && TTS_FALLBACKS.length >= 1);
    assert.ok(PCM_MODELS instanceof Set);
    assert.ok(PCM_MODELS.has('google/gemini-3.1-flash-tts-preview'));
  });
});
