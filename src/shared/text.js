/** Text helpers shared by the subtitle pipeline and the selection bubble. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSL = Object.assign(root.DSL || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/g;

  /**
   * Turn the messy text content of a YouTube caption window into one clean line.
   * Keeps punctuation and speaker markers, drops zero-width characters and collapses
   * the whitespace/newlines that the caption renderer sprinkles between spans.
   */
  function normalizeCaption(input) {
    if (typeof input !== 'string' || !input) return '';
    let text = input.replace(ZERO_WIDTH, '').replace(/&nbsp;/g, ' ');
    text = text.replace(/[\r\n\t]+/g, ' ').replace(/\u00a0/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    text = text.replace(/^(?:>>\s*)+/, '').trim();
    return text;
  }

  function codePointLength(text) {
    return Array.from(String(text || '')).length;
  }

  /** Cut a string without splitting surrogate pairs. */
  function truncate(text, max) {
    const chars = Array.from(String(text == null ? '' : text));
    if (chars.length <= max) return chars.join('');
    return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
  }

  function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
    return i;
  }

  /**
   * Whether `next` is the same live caption line as `prev` that simply grew
   * (YouTube auto captions append words, and sometimes fix one word).
   */
  function isCaptionGrowth(prev, next) {
    const a = normalizeCaption(prev);
    const b = normalizeCaption(next);
    if (!a || !b) return false;
    if (b === a) return true;
    if (b.startsWith(a)) return true;
    const shared = commonPrefixLength(a, b);
    const shorter = Math.min(a.length, b.length);
    return shared >= Math.max(4, Math.floor(shorter * 0.7));
  }

  /** True when the caption looks like a finished utterance. */
  function looksComplete(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return /[.!?。！？…]["'”’)\]]?$/.test(t) || /[。！？]$/.test(t);
  }

  class LruCache {
    constructor(limit) {
      this.limit = Math.max(1, limit || 300);
      this.map = new Map();
      this.hits = 0;
      this.misses = 0;
    }

    get(key) {
      if (!this.map.has(key)) {
        this.misses += 1;
        return undefined;
      }
      const value = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, value);
      this.hits += 1;
      return value;
    }

    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, value);
      while (this.map.size > this.limit) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
    }

    clear() {
      this.map.clear();
      this.hits = 0;
      this.misses = 0;
    }

    get size() {
      return this.map.size;
    }
  }

  function cacheKey(targetLang, text) {
    return targetLang + '\u0001' + text;
  }

  /**
   * Build a compact reference block from previous subtitle pairs. The model is told
   * to use it for terminology/continuity only, never to translate it again.
   */
  function buildContext(context, maxLines) {
    if (!Array.isArray(context) || !context.length || maxLines <= 0) return [];
    return context
      .filter((p) => p && p.src && p.tgt)
      .slice(-maxLines)
      .map((p) => ({ src: truncate(normalizeCaption(p.src), 240), tgt: truncate(normalizeCaption(p.tgt), 240) }));
  }

  return {
    normalizeCaption,
    codePointLength,
    truncate,
    commonPrefixLength,
    isCaptionGrowth,
    looksComplete,
    LruCache,
    cacheKey,
    buildContext
  };
});
