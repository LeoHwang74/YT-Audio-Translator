/**
 * Language catalogue shared by the service worker, content scripts, popup and options page.
 * Loaded as a classic script (UMD) so the same file also works under Node for tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSL = Object.assign(root.DSL || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LANGUAGES = Object.freeze([
    { code: 'auto', name: '自动检测', native: 'Auto', prompt: 'Auto-detect', short: 'AUTO' },
    { code: 'zh', name: '简体中文', native: '简体中文', prompt: 'Simplified Chinese (简体中文)', short: '中' },
    { code: 'en', name: '英语', native: 'English', prompt: 'English', short: 'EN' },
    { code: 'de', name: '德语', native: 'Deutsch', prompt: 'German (Deutsch)', short: 'DE' },
    { code: 'ru', name: '俄语', native: 'Русский', prompt: 'Russian (Русский)', short: 'RU' },
    { code: 'ko', name: '韩语', native: '한국어', prompt: 'Korean (한국어)', short: 'KO' },
    { code: 'ja', name: '日语', native: '日本語', prompt: 'Japanese (日本語)', short: 'JA' },
    { code: 'th', name: '泰语', native: 'ไทย', prompt: 'Thai (ไทย)', short: 'TH' }
  ]);

  const TARGET_LANGUAGES = Object.freeze(LANGUAGES.filter((l) => l.code !== 'auto'));
  const TARGET_CODES = Object.freeze(TARGET_LANGUAGES.map((l) => l.code));

  const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));

  function getLanguage(code) {
    return byCode.get(code) || byCode.get('auto');
  }

  function isTargetCode(code) {
    return TARGET_CODES.indexOf(code) !== -1;
  }

  /** BCP-47 tag, useful for the Web Speech API and <html lang> style hints. */
  function bcp47(code) {
    switch (code) {
      case 'zh': return 'zh-CN';
      case 'en': return 'en-US';
      case 'de': return 'de-DE';
      case 'ru': return 'ru-RU';
      case 'ko': return 'ko-KR';
      case 'ja': return 'ja-JP';
      case 'th': return 'th-TH';
      default: return 'und';
    }
  }

  return { LANGUAGES, TARGET_LANGUAGES, TARGET_CODES, getLanguage, isTargetCode, bcp47 };
});
