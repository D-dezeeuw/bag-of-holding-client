// src/llm/audio.js — TTS synthesis + STT transcription fetch cores.
//
// The host owns capture (MediaRecorder) and playback (HTMLAudioElement); these
// own the HTTP contract + the byte-level decode. Both are config-injected and
// return plain data (ArrayBuffer / string) so the host wraps them in browser
// objects. `pcmToWav`, `bytesToBase64`, and the model/format selection are pure
// and node-testable; only the fetch itself needs a runtime.

import { ApiError, post } from './transport.js';
import { resolveModel } from './tiers.js';

// Fallback chain tried when the primary TTS model returns 429 (capacity).
export const TTS_FALLBACKS = [
  'openai/gpt-4o-mini-tts-2025-12-15',
  'x-ai/grok-voice-tts-1.0',
  'mistralai/voxtral-mini-tts-2603',
];

// Models that return raw 16-bit PCM (wrapped in a WAV header) instead of mp3.
export const PCM_MODELS = new Set([
  'google/gemini-3.1-flash-tts-preview',
]);

// Wrap a raw PCM buffer in a RIFF/WAV header so it can be played as audio/wav.
// Defaults match Gemini TTS: 16-bit linear PCM, 24 000 Hz, mono. Pure → returns
// a new ArrayBuffer.
export function pcmToWav(pcmBuffer, sampleRate = 24000, bits = 16, channels = 1) {
  const byteRate   = sampleRate * channels * bits / 8;
  const blockAlign = channels * bits / 8;
  const dataLen    = pcmBuffer.byteLength;
  const out = new ArrayBuffer(44 + dataLen);
  const v   = new DataView(out);
  const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  str(0,  'RIFF'); v.setUint32(4,  36 + dataLen,  true);
  str(8,  'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1,           true); v.setUint16(22, channels,    true);
  v.setUint32(24, sampleRate,  true); v.setUint32(28, byteRate,    true);
  v.setUint16(32, blockAlign,  true); v.setUint16(34, bits,        true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  new Uint8Array(out).set(new Uint8Array(pcmBuffer), 44);
  return out;
}

// Base64-encode bytes (ArrayBuffer or Uint8Array). Uses btoa in the browser,
// Buffer under Node — so it loads and tests in both. Pure.
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < u8.byteLength; i++) binary += String.fromCharCode(u8[i]);
    return btoa(binary);
  }
  return Buffer.from(u8).toString('base64');
}

// Synthesize speech. Walks the model fallback chain on 429, picks pcm/mp3 +
// voice per model, and returns { audio: ArrayBuffer, mimeType, model, charCount }
// for the host to wrap in a Blob and play. Returns null if no TTS model is
// configured; throws ApiError if every model fails for a non-429 reason.
export async function synthesizeSpeech(config, text, opts = {}) {
  if (!text?.trim()) return null;
  const { model, fallbacks = TTS_FALLBACKS, pcmModels = PCM_MODELS, costPerChar = 0.000015 } = opts;
  const primary = model ?? resolveModel('tts', config, config?.defaultModels);
  if (!primary) return null;

  let res, usedModel, lastErr;
  for (const m of [primary, ...fallbacks]) {
    const isPcm = pcmModels.has(m);
    try {
      res = await post(config, '/audio/speech', {
        model:           m,
        input:           text,
        voice:           isPcm ? 'Umbriel' : 'alloy',
        response_format: isPcm ? 'pcm' : 'mp3',
      });
      usedModel = m;
      break;
    } catch (e) {
      lastErr = e;
      if (e instanceof ApiError && e.status === 429) continue; // capacity — next model
      throw e;
    }
  }
  if (!res) throw lastErr ?? new ApiError(429, 'all TTS models at capacity');

  config?.onCost?.(parseFloat((text.length * costPerChar).toFixed(6)));

  const raw = await res.arrayBuffer();
  return pcmModels.has(usedModel)
    ? { audio: pcmToWav(raw), mimeType: 'audio/wav',  model: usedModel, charCount: text.length }
    : { audio: raw,           mimeType: 'audio/mpeg', model: usedModel, charCount: text.length };
}

// Transcribe audio bytes. Host-agnostic: takes raw bytes + a format string (the
// host does MediaRecorder capture and blob→bytes), so it carries no Web capture
// API. Returns the trimmed transcript. Throws ApiError on failure.
export async function transcribeAudio(config, { bytes, format = 'webm', language, model } = {}) {
  const m = model ?? resolveModel('stt', config, config?.defaultModels);
  if (!m) throw new ApiError(400, 'no STT model configured');

  const res = await post(config, '/audio/transcriptions', {
    model:       m,
    input_audio: { data: bytesToBase64(bytes), format },
    language,
  });
  const result = await res.json();
  return (result.text ?? '').trim();
}
