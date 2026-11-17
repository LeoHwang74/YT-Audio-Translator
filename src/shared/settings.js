/**
 * Settings schema, defaults and small persistence helpers.
 *
 * All settings live in one chrome.storage.local record (key: dsl.settings.v1).
 * The API key never leaves the extension: content scripts only ever get it through
 * the service worker, and the worker is the only place that talks to DeepSeek.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSL = Object.assign(root.DSL || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SETTINGS_KEY = 'dsl.settings.v1';
  const STATS_KEY = 'dsl.stats.v1';
  const DEFAULT_BASE_URL = 'https://api.deepseek.com';
  // Speech recognition stays on DeepSeek by default; translation can point anywhere
  // that speaks the OpenAI chat-completions protocol.
  const ASR_DEFAULT_BASE_URL = 'https://api.deepseek.com';
  // This build is fully local: translation goes to Ollama, speech recognition to
  // faster-whisper. Both listen on loopback, so no cloud key is involved. The
  // placeholder key exists because the OpenAI wire format still sends a header.
  const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
  const OLLAMA_PLACEHOLDER_KEY = 'local';
  const DEFAULT_MODEL = 'qwen2.5:3b';

  // No API key ships with this build. Every user supplies their own key once in
  // the options page; it is stored only in chrome.storage.local on their machine.
  // Never commit a real key here — the repo is public and git history is forever.
  const MODELS = Object.freeze([
    { id: 'deepseek-chat', label: 'deepseek-chat', hint: 'DeepSeek 官方' },
    { id: 'glm-4-flash', label: 'glm-4-flash', hint: '智谱 GLM，永久免费' },
    { id: 'glm-4.7-flash', label: 'glm-4.7-flash', hint: '智谱 GLM，永久免费' },
    { id: 'qwen-plus', label: 'qwen-plus', hint: '阿里通义' },
    { id: 'hunyuan-lite', label: 'hunyuan-lite', hint: '腾讯混元' }
  ]);
  const LIVE_MODES = Object.freeze([
    { id: 'fast', label: '极速', hint: '更频繁地翻译变化中的字幕（约 180ms 防抖）' },
    { id: 'balanced', label: '均衡', hint: '推荐：约 320ms 防抖，兼顾速度与费用' },
    { id: 'stable', label: '稳定', hint: '句子稳定后再翻译，最省 token' }
  ]);
  const TARGET_CODES = ['zh', 'en', 'de', 'ru', 'ko', 'ja', 'th'];
  const SOURCE_CODES = ['auto'].concat(TARGET_CODES);
  const MAX_SUBTITLE_CHARS = 2000;
  const MAX_SELECTION_CHARS = 6000;

  const DEFAULT_SETTINGS = Object.freeze({
    apiKey: OLLAMA_PLACEHOLDER_KEY,
    baseUrl: OLLAMA_BASE_URL,
    model: DEFAULT_MODEL,
    // Empty means "use ASR_DEFAULT_BASE_URL" (DeepSeek); its key inherits apiKey
    // only while both endpoints share a host, so a GLM translation key is never
    // silently sent to DeepSeek.
    // This build ships wired to a local Speaches / faster-whisper server.
    asrBaseUrl: 'http://127.0.0.1:8000/v1',
    asrApiKey: '',
    asrProvider: 'openai',
    asrModel: 'Systran/faster-whisper-base',
    targetLang: 'zh',
    sourceLang: 'auto',
    // Small local models leak source-language tokens at high temperature;
    // 0.3 keeps subtitles stable without making them stiff.
    temperature: 0.3,
    maxTokens: 512,
    contextLines: 3,
    liveMode: 'fast',
    settleMs: 900,
    showOriginal: false,
    fontSize: 39,
    opacity: 1,
    offsetPercent: 12,
    enabled: true,
    selectionEnabled: true,
    showStatus: false
  });

  function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function asBool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function normalizeBaseUrl(input) {
    let url = String(input == null ? '' : input).trim();
    if (!url) url = DEFAULT_BASE_URL;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    url = url.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(url)) return url.replace(/\/chat\/completions$/i, '');
    return url;
  }

  function endpointFor(baseUrl) {
    const base = normalizeBaseUrl(baseUrl);
    return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
  }

  function originPattern(baseUrl) {
    try {
      const url = new URL(normalizeBaseUrl(baseUrl));
      return url.protocol + '//' + url.host + '/*';
    } catch (_) {
      return '';
    }
  }

  function sanitizeModel(input) {
    const value = typeof input === 'string' ? input.trim() : '';
    return value ? value.slice(0, 80) : DEFAULT_MODEL;
  }

  function sanitizeSettings(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const out = Object.assign({}, DEFAULT_SETTINGS, input);
    out.apiKey =
      typeof input.apiKey === 'string' ? input.apiKey.trim() : DEFAULT_SETTINGS.apiKey;
    out.baseUrl = normalizeBaseUrl(input.baseUrl || DEFAULT_SETTINGS.baseUrl);
    out.model = sanitizeModel(input.model);
    // Settings saved by an older build still carry model "deepseek-chat". Against
    // the local endpoint that is a 404 ("model not found"), and the options page
    // no longer exposes the field, so migrate it automatically.
    if (out.model === 'deepseek-chat' && hostOf(out.baseUrl) !== hostOf(DEFAULT_BASE_URL)) {
      out.model = DEFAULT_MODEL;
    }
    out.asrBaseUrl =
      typeof input.asrBaseUrl === 'string' ? input.asrBaseUrl.trim() : DEFAULT_SETTINGS.asrBaseUrl;
    out.asrApiKey = typeof input.asrApiKey === 'string' ? input.asrApiKey.trim() : '';
    out.asrProvider =
      input.asrProvider === 'openai' || input.asrProvider === 'deepseek'
        ? input.asrProvider
        : DEFAULT_SETTINGS.asrProvider;
    out.asrModel =
      typeof input.asrModel === 'string'
        ? input.asrModel.trim().slice(0, 80)
        : DEFAULT_SETTINGS.asrModel;
    out.targetLang = TARGET_CODES.indexOf(input.targetLang) !== -1 ? input.targetLang : DEFAULT_SETTINGS.targetLang;
    out.sourceLang = SOURCE_CODES.indexOf(input.sourceLang) !== -1 ? input.sourceLang : DEFAULT_SETTINGS.sourceLang;
    out.temperature = clampNumber(input.temperature, DEFAULT_SETTINGS.temperature, 0, 2);
    out.maxTokens = Math.round(clampNumber(input.maxTokens, DEFAULT_SETTINGS.maxTokens, 64, 4096));
    out.contextLines = Math.round(clampNumber(input.contextLines, DEFAULT_SETTINGS.contextLines, 0, 8));
    out.liveMode = LIVE_MODES.some((m) => m.id === input.liveMode) ? input.liveMode : DEFAULT_SETTINGS.liveMode;
    out.settleMs = Math.round(clampNumber(input.settleMs, DEFAULT_SETTINGS.settleMs, 250, 4000));
    out.fontSize = Math.round(clampNumber(input.fontSize, DEFAULT_SETTINGS.fontSize, 14, 64));
    out.opacity = clampNumber(input.opacity, DEFAULT_SETTINGS.opacity, 0.2, 1);
    out.offsetPercent = Math.round(clampNumber(input.offsetPercent, DEFAULT_SETTINGS.offsetPercent, 0, 55));
    out.enabled = asBool(input.enabled, DEFAULT_SETTINGS.enabled);
    out.showOriginal = asBool(input.showOriginal, DEFAULT_SETTINGS.showOriginal);
    out.selectionEnabled = asBool(input.selectionEnabled, DEFAULT_SETTINGS.selectionEnabled);
    out.showStatus = asBool(input.showStatus, DEFAULT_SETTINGS.showStatus);
    return out;
  }

  function mergeSettings(raw, patch) {
    return sanitizeSettings(Object.assign({}, raw && typeof raw === 'object' ? raw : {}, patch || {}));
  }

  /** The key actually used for requests: whatever the user stored, or nothing. */
  function effectiveApiKey(settings) {
    return settings && typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
  }

  function hasApiKey(settings) {
    return !!effectiveApiKey(settings);
  }

  function hostOf(url) {
    try {
      return new URL(normalizeBaseUrl(url)).host;
    } catch (_) {
      return '';
    }
  }

  /**
   * Where ASR requests go, and with which key.
   *
   * The chat key is reused only when the translation and ASR endpoints share a
   * host — otherwise a GLM key would be sent to DeepSeek and fail with 401.
   *
   * `provider` selects the wire protocol:
   *   deepseek → POST {base}/v1/tools/asr      (DeepSeek's own shape)
   *   openai   → POST {base}/v1/audio/transcriptions (multipart, needs `model`)
   */
  function resolveAsr(settings) {
    const opts = settings && typeof settings === 'object' ? settings : {};
    const provider = opts.asrProvider === 'openai' ? 'openai' : 'deepseek';
    // An empty URL means the default for that provider in this build.
    const fallbackBase =
      provider === 'openai' ? DEFAULT_SETTINGS.asrBaseUrl : ASR_DEFAULT_BASE_URL;
    const baseUrl = normalizeBaseUrl(opts.asrBaseUrl || fallbackBase);
    const explicit = String(opts.asrApiKey || '').trim();
    const sameHost = hostOf(baseUrl) === hostOf(opts.baseUrl);
    const apiKey = explicit || (sameHost ? effectiveApiKey(opts) : '');
    const model =
      provider === 'openai'
        ? String(opts.asrModel || '').trim() || DEFAULT_SETTINGS.asrModel || 'whisper-1'
        : '';
    return { provider, baseUrl, apiKey, model, explicit: !!explicit, sameHost };
  }

  /** Local OpenAI-compatible servers usually skip auth, so only DeepSeek requires a key. */
  function hasAsrKey(settings) {
    const asr = resolveAsr(settings);
    return asr.provider === 'openai' ? true : !!asr.apiKey;
  }

  function debounceForMode(mode) {
    if (mode === 'fast') return 180;
    if (mode === 'stable') return 900;
    return 320;
  }

  function emptyStats() {
    return {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      errors: 0,
      cacheHits: 0,
      lastLatencyMs: 0,
      lastAt: 0
    };
  }

  function sanitizeStats(raw) {
    const base = emptyStats();
    if (!raw || typeof raw !== 'object') return base;
    for (const key of Object.keys(base)) {
      const n = Number(raw[key]);
      if (Number.isFinite(n) && n >= 0) base[key] = key === 'lastAt' ? Math.round(n) : Math.round(n);
    }
    return base;
  }

  function applyUsage(stats, usage, latencyMs) {
    const next = sanitizeStats(stats);
    next.requests += 1;
    if (usage) {
      next.promptTokens += Number(usage.prompt_tokens) || 0;
      next.completionTokens += Number(usage.completion_tokens) || 0;
      next.cachedTokens += Number(usage.prompt_cache_hit_tokens) || 0;
    }
    if (Number.isFinite(latencyMs)) next.lastLatencyMs = Math.round(latencyMs);
    next.lastAt = Date.now();
    return next;
  }

  function isYouTubeUrl(url) {
    try {
      const u = new URL(url);
      return /(^|\.)youtube\.com$/.test(u.hostname) || /(^|\.)youtu\.be$/.test(u.hostname);
    } catch (_) {
      return false;
    }
  }

  return {
    SETTINGS_KEY,
    STATS_KEY,
    DEFAULT_BASE_URL,
    ASR_DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_SETTINGS,
    MODELS,
    LIVE_MODES,
    TARGET_CODES,
    SOURCE_CODES,
    MAX_SUBTITLE_CHARS,
    MAX_SELECTION_CHARS,
    sanitizeSettings,
    sanitizeModel,
    mergeSettings,
    effectiveApiKey,
    hasApiKey,
    resolveAsr,
    hasAsrKey,
    normalizeBaseUrl,
    endpointFor,
    originPattern,
    debounceForMode,
    emptyStats,
    sanitizeStats,
    applyUsage,
    isYouTubeUrl
  };
});
