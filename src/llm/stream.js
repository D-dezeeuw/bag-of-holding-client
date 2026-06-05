// src/llm/stream.js — JsonFieldStreamer: stream one string field out of a
// JSON object as it arrives, token by token.
//
// Many structured narrators stream a JSON object like {"narration":"..."}; the
// UI wants only the live text of one field. This watches the delta stream for
// `"<field>":"` and decodes the value until the unescaped closing quote, carrying
// a partial tail across chunk boundaries. Generalized from a game-specific
// extractor; the field name is a constructor argument and \u/\r escapes are
// handled correctly.

export class JsonFieldStreamer {
  constructor(field = 'narration') {
    this._marker = `"${field}":"`;
    this._buf    = '';
    this._active = false;  // entered the field value
    this._done   = false;  // closing quote seen
  }

  feed(raw) {
    if (this._done) return '';
    this._buf += raw;

    if (!this._active) {
      const idx = this._buf.indexOf(this._marker);
      if (idx === -1) {
        // Keep enough tail to detect a marker spanning two chunks.
        if (this._buf.length > this._marker.length) {
          this._buf = this._buf.slice(-(this._marker.length - 1));
        }
        return '';
      }
      this._active = true;
      this._buf = this._buf.slice(idx + this._marker.length);
    }

    let out = '';
    let i   = 0;
    while (i < this._buf.length) {
      const ch = this._buf[i];
      if (ch === '\\') {
        if (i + 1 >= this._buf.length) break; // incomplete escape — wait for more
        const esc = this._buf[i + 1];
        if (esc === 'u') {
          if (i + 6 > this._buf.length) break; // need \uXXXX — wait for the 4 hex digits
          const code = parseInt(this._buf.slice(i + 2, i + 6), 16);
          out += Number.isNaN(code) ? '' : String.fromCharCode(code);
          i += 6;
        } else {
          out += esc === '"' ? '"'
               : esc === 'n' ? '\n'
               : esc === 't' ? '\t'
               : esc === 'r' ? ''
               : esc === '\\' ? '\\'
               : esc === '/' ? '/'
               : esc;
          i += 2;
        }
      } else if (ch === '"') {
        this._done = true;
        i++;
        break;
      } else {
        out += ch;
        i++;
      }
    }
    this._buf = this._buf.slice(i);
    return out;
  }
}
