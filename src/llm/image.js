// src/llm/image.js — provider-quirk-tolerant image generation.
//
// Returns a data-URI string (ready for CSS background-image / <img src>), or null
// on any failure — image generation is decorative, so this never throws. The host
// supplies the art-direction prompt; the library owns the transport + the messy
// job of finding the image across the shapes different providers actually return.

import { post } from './transport.js';
import { resolveModel } from './tiers.js';

// Pull an image out of an OpenAI/OpenRouter chat response. Providers disagree on
// where it lands: Gemini-via-OpenRouter uses message.images[]; others use content
// parts (image_url / image+base64 / inline_data); a few inline a data-URI in a
// plain string. Pure — exported so the host can unit-test the shape handling.
export function parseImageFromResponse(data) {
  const msg     = data?.choices?.[0]?.message ?? {};
  const content = msg.content;

  if (Array.isArray(msg.images)) {
    for (const part of msg.images) {
      if (part.type === 'image_url' && part.image_url?.url) return part.image_url.url;
    }
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'image_url' && part.image_url?.url) return part.image_url.url;
      if (part.type === 'image' && part.data) return `data:image/png;base64,${part.data}`;
      if (part.inline_data?.data) {
        const mime = part.inline_data.mime_type || 'image/png';
        return `data:${mime};base64,${part.inline_data.data}`;
      }
    }
  }

  if (typeof content === 'string') {
    const m = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/]+=*/);
    if (m) return m[0];
  }

  return null;
}

// Generate one image. `prompt` is the host's full art-direction string. Resolves
// the image-tier model from config unless one is passed. Returns a data-URI or
// null (no model, no prompt, transport error, or no image in the response).
export async function generateImage(config, { prompt, model, maxTokens = 2048 } = {}) {
  const m = model ?? resolveModel('image', config, config?.defaultModels);
  if (!m || !prompt) return null;

  let res;
  try {
    res = await post(config, '/chat/completions', {
      model:      m,
      messages:   [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    });
  } catch {
    return null; // network error or non-2xx ApiError — silent (decorative)
  }

  let data;
  try { data = await res.json(); } catch { return null; }

  if (data.usage?.total_tokens) config?.onTokens?.(data.usage.total_tokens);
  return parseImageFromResponse(data);
}
