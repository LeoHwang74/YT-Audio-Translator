/** Audio helpers shared by the offscreen capture document and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSL = Object.assign(root.DSL || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function writeString(view, offset, value) {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  }

  /** Encode mono Float32 samples (-1..1) as 16-bit PCM WAV. */
  function encodeWav(samples, sampleRate) {
    const frames = samples.length;
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + frames * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, frames * 2, true);
    let offset = 44;
    for (let i = 0; i < frames; i += 1) {
      let sample = samples[i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
    return buffer;
  }

  function toBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const block = 0x8000;
    for (let i = 0; i < bytes.length; i += block) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
    }
    return btoa(binary);
  }

  function fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function rms(samples) {
    if (!samples || !samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/;

  function cleanToken(token) {
    return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  function mergeOverlap(previous, next) {
    const prev = String(previous || '').replace(/\s+/g, ' ').trim();
    const curr = String(next || '').replace(/\s+/g, ' ').trim();
    if (!prev) return curr;
    if (!curr) return '';
    if (curr === prev) return '';

    const cjk = CJK.test(prev) || CJK.test(curr);
    const prevTokens = cjk ? Array.from(prev.replace(/[\s，。！？、；：,.!?;:]/g, '')) : prev.split(/\s+/);
    const currTokens = cjk ? Array.from(curr.replace(/[\s，。！？、；：,.!?;:]/g, '')) : curr.split(/\s+/);
    const max = Math.min(prevTokens.length, currTokens.length, 24);
    for (let k = max; k >= 3; k -= 1) {
      let match = true;
      for (let i = 0; i < k; i += 1) {
        if (cleanToken(prevTokens[prevTokens.length - k + i]) !== cleanToken(currTokens[i])) {
          match = false;
          break;
        }
      }
      if (match) {
        const remainder = cjk ? currTokens.slice(k).join('') : currTokens.slice(k).join(' ');
        return remainder.trim();
      }
    }
    return curr;
  }

  return { encodeWav, toBase64, fromBase64, rms, mergeOverlap, CJK };
});
