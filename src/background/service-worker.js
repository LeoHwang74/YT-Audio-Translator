/**
 * MV3 service worker: the only place that owns the DeepSeek API key and talks to the API.
 *
 * Content scripts connect through a long-lived Port ("dsl-translate") so the worker can
 * stream translation deltas back while it is alive. One-shot jobs (selection bubble,
 * connection test) use regular runtime messages.
 */
importScripts(
  '/src/shared/settings.js',
  '/src/shared/languages.js',
  '/src/shared/prompts.js',
  '/src/shared/text.js',
  '/src/shared/deepseek.js',
  '/src/shared/audio.js',
  '/src/shared/asr.js'
);

const D = self.DSL;
const {
  SETTINGS_KEY,
  STATS_KEY,
  MAX_SUBTITLE_CHARS,
  MAX_SELECTION_CHARS,
  sanitizeSettings,
  mergeSettings,
  emptyStats,
  sanitizeStats,
  applyUsage,
  isTargetCode
} = D;

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 240;

let settingsCache = null;
let statsChain = Promise.resolve();
const translationCache = new Map(); // key -> { text, at }

/* ------------------------------------------------------------------ settings */

async function readSettings() {
  if (settingsCache) return settingsCache;
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = sanitizeSettings(data[SETTINGS_KEY]);
  return settingsCache;
}

async function patchSettings(patch) {
  const current = await readSettings();
  const next = mergeSettings(current, patch);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  settingsCache = next;
  return next;
}

async function readStats() {
  const data = await chrome.storage.local.get(STATS_KEY);
  return sanitizeStats(data[STATS_KEY]);
}

/** Serialize read-modify-write cycles so parallel tabs do not clobber the counters. */
function updateStats(mutator) {
  statsChain = statsChain
    .catch(() => {})
    .then(async () => {
      const current = await readStats();
      const next = mutator(current) || current;
      await chrome.storage.local.set({ [STATS_KEY]: next });
      return next;
    });
  return statsChain;
}

function recordSuccess(usage, latencyMs) {
  return updateStats((stats) => {
    const next = applyUsage(stats, usage, latencyMs);
    next.lastAt = Date.now();
    return next;
  }).catch(() => {});
}

function recordError() {
  return updateStats((stats) => {
    const next = sanitizeStats(stats);
    next.errors += 1;
    next.lastAt = Date.now();
    return next;
  }).catch(() => {});
}

function bumpCacheHit() {
  return updateStats((stats) => {
    const next = sanitizeStats(stats);
    next.cacheHits += 1;
    return next;
  }).catch(() => {});
}

/* ------------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safePost(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch (_) {
    return false;
  }
}

function readCache(key) {
  const hit = translationCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }
  // refresh LRU position
  translationCache.delete(key);
  translationCache.set(key, hit);
  return hit.text;
}

function writeCache(key, text) {
  translationCache.delete(key);
  translationCache.set(key, { text, at: Date.now() });
  while (translationCache.size > CACHE_LIMIT) {
    translationCache.delete(translationCache.keys().next().value);
  }
}

function languagePrompt(code) {
  const lang = D.getLanguage(code);
  return lang ? lang.prompt : D.getLanguage('zh').prompt;
}

function sourcePrompt(code, targetCode) {
  if (code && code !== 'auto') return languagePrompt(code);
  const target = D.getLanguage(targetCode);
  return 'Auto-detect (the source may be English, German, Russian, Korean, Japanese, Thai or another language)';
}

function makeMessages(text, settings, context, kind) {
  return D.buildMessages({
    text,
    targetName: languagePrompt(settings.targetLang),
    sourceName: sourcePrompt(settings.sourceLang, settings.targetLang),
    context: D.buildContext(context, settings.contextLines),
    kind: kind || 'subtitle'
  });
}

function apiOptions(settings, extra) {
  return Object.assign(
    {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeoutMs: 45000
    },
    extra || {}
  );
}

/* ------------------------------------------------------------------ live audio */

const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen/offscreen.html');
const AUDIO_TAB_KEY = 'ds.audio.tab';
let offscreenPromise = null;
const audioSessions = new Map();

async function rememberAudioTab(tabId) {
  try {
    await chrome.storage.session.set({ [AUDIO_TAB_KEY]: tabId });
  } catch (_) {
    /* session storage unavailable */
  }
}

async function forgetAudioTab() {
  try {
    await chrome.storage.session.remove(AUDIO_TAB_KEY);
  } catch (_) {
    /* ignore */
  }
}

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [OFFSCREEN_URL]
      });
      if (contexts && contexts.length) return;
    } catch (_) {
      /* fall through to create */
    }
  }
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = chrome.offscreen
    .createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture the current tab audio for live speech translation'
    })
    .catch((err) => {
      const message = String((err && err.message) || err);
      if (!/single offscreen|Only a single/i.test(message)) throw err;
    })
    .finally(() => {
      offscreenPromise = null;
    });
  return offscreenPromise;
}

function sendOffscreen(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'offscreen unavailable'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function sendOffscreenWithRetry(message, attempts) {
  let lastError = null;
  const tries = attempts || 10;
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await sendOffscreen(message);
      if (response) return response;
    } catch (err) {
      lastError = err;
    }
    await sleep(80);
  }
  throw lastError || new Error('音频捕获模块未响应');
}

function isOffscreenSender(sender) {
  return !!(sender && sender.url && sender.url.indexOf(OFFSCREEN_URL) === 0);
}

function notifyTab(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
  } catch (_) {
    /* tab closed */
  }
}

async function startAudioSession(tabId, streamId) {
  if (!Number.isFinite(tabId) || !streamId) throw new Error('缺少标签页或音轨信息');
  const prefs = await readSettings();
  if (!D.hasAsrKey(prefs)) {
    throw new D.DeepSeekError('尚未配置语音识别 API Key，请到设置页填写。', { code: 'ASR_NO_KEY' });
  }
  for (const existing of audioSessions.values()) existing.active = false;
  audioSessions.clear();

  const session = { tabId, active: true, queue: [], busy: false, lastText: '' };
  audioSessions.set(tabId, session);

  try {
    await ensureYouTubeContent(tabId);
    await ensureOffscreen();
    const response = await sendOffscreenWithRetry({ type: 'dsl:offscreen-start', streamId, tabId });
    if (!response || !response.ok) throw new Error((response && response.message) || '音轨捕获失败');
  } catch (err) {
    session.active = false;
    audioSessions.delete(tabId);
    throw err;
  }

  notifyTab(tabId, { type: 'dsl:audio-status', state: 'capturing', message: '正在监听音轨' });
  await rememberAudioTab(tabId);
  return { ok: true, tabId };
}

async function stopAudioSession(tabId) {
  const id = Number(tabId);
  const session = audioSessions.get(id);
  if (session) session.active = false;
  audioSessions.delete(id);
  await forgetAudioTab();
  try {
    await sendOffscreen({ type: 'dsl:offscreen-stop' });
  } catch (_) {
    /* already stopped */
  }
  notifyTab(id, { type: 'dsl:audio-status', state: 'stopped', message: '已停止' });
  return { ok: true };
}

function handleOffscreenStatus(message) {
  const tabId = Number(message.tabId);
  if (!Number.isFinite(tabId)) return;
  notifyTab(tabId, {
    type: 'dsl:audio-status',
    state: message.state || 'idle',
    message: message.message || ''
  });
  if (message.state === 'stopped' || message.state === 'error') {
    const session = audioSessions.get(tabId);
    if (session) session.active = false;
    audioSessions.delete(tabId);
    forgetAudioTab();
  }
}

async function enqueueAudioChunk(message) {
  const tabId = Number(message.tabId);
  let session = audioSessions.get(tabId);
  if (!session) {
    // The MV3 worker may have been restarted during a moment of silence.
    let stored = null;
    try {
      stored = await chrome.storage.session.get(AUDIO_TAB_KEY);
    } catch (_) {
      /* ignore */
    }
    if (!stored || Number(stored[AUDIO_TAB_KEY]) !== tabId) return;
    session = { tabId, active: true, queue: [], busy: false, lastText: '' };
    audioSessions.set(tabId, session);
  }
  if (!session.active) return;
  session.queue.push({
    wavBase64: message.wavBase64,
    durationMs: Number(message.durationMs) || 0
  });
  if (!session.busy) processAudioQueue(session);
}

async function processAudioQueue(session) {
  session.busy = true;
  try {
    while (session.active && session.queue.length) {
      const item = session.queue.shift();
      const settings = await readSettings();
      const asr = D.resolveAsr(settings);
      if (!D.hasAsrKey(settings)) {
        throw new D.DeepSeekError('尚未配置语音识别 API Key，请到设置页填写。', { code: 'ASR_NO_KEY' });
      }
      let result = null;
      let lastError = null;
      let lastInfo = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await D.transcribeWav({
            provider: asr.provider,
            model: asr.model,
            apiKey: asr.apiKey,
            baseUrl: asr.baseUrl,
            wav: D.fromBase64(item.wavBase64),
            timeoutMs: 30000
          });
          break;
        } catch (err) {
          lastError = err;
          lastInfo = D.describeError(err);
          if (!lastInfo.retryable) break;
          await sleep(450);
        }
      }

      if (!result) {
        throw lastError || new Error((lastInfo && lastInfo.message) || '语音识别失败');
      }

      const raw = D.normalizeCaption(result.text);
      if (!raw) continue;
      const fresh = D.mergeOverlap(session.lastText, raw);
      session.lastText = raw;
      if (fresh) {
        notifyTab(session.tabId, {
          type: 'dsl:audio-text',
          text: fresh,
          raw,
          durationMs: result.durationMs || item.durationMs
        });
      }
    }
  } catch (err) {
    const info = D.describeError(err);
    notifyTab(session.tabId, {
      type: 'dsl:audio-status',
      state: 'error',
      message: info.message || '语音识别失败'
    });
    session.active = false;
    audioSessions.delete(session.tabId);
    forgetAudioTab();
    sendOffscreen({ type: 'dsl:offscreen-stop' }).catch(() => {});
  } finally {
    session.busy = false;
  }
}

/* ------------------------------------------------------------------ messaging */

async function translateOnceMessage(message) {
  const base = await readSettings();
  const settings = message.settings ? mergeSettings(base, message.settings) : base;
  if (!settings.apiKey) {
    return {
      ok: false,
      error: { code: 'NO_KEY', message: '尚未配置翻译 API Key，请先打开扩展设置填写。', retryable: false }
    };
  }
  const targetLang = isTargetCode(message.targetLang) ? message.targetLang : settings.targetLang;
  const text = D.truncate(String(message.text == null ? '' : message.text).trim(), MAX_SELECTION_CHARS);
  if (!text) {
    return { ok: false, error: { code: 'EMPTY_INPUT', message: '没有可翻译的文本。', retryable: false } };
  }
  const effective = Object.assign({}, settings, { targetLang });
  const startedAt = Date.now();
  try {
    const result = await D.translateOnce(
      apiOptions(
        effective,
        {
          messages: makeMessages(text, effective, message.context, 'selection'),
          timeoutMs: 40000
        }
      )
    );
    const latencyMs = Date.now() - startedAt;
    await recordSuccess(result.usage, latencyMs);
    return {
      ok: true,
      text: result.text,
      usage: result.usage,
      latencyMs,
      targetLang
    };
  } catch (err) {
    await recordError();
    const info = D.describeError(err);
    return { ok: false, error: info };
  }
}

async function testConnectionMessage(message) {
  const base = await readSettings();
  const settings = mergeSettings(base, message.overrides || {});
  if (!settings.apiKey) {
    return { ok: false, error: { code: 'NO_KEY', message: '请先填写翻译 API Key。', retryable: false } };
  }
  const sample = String(message.sample || 'Hello everyone, welcome to today\'s live stream!').slice(0, 300);
  const startedAt = Date.now();
  try {
    const result = await D.translateOnce(
      apiOptions(settings, {
        messages: makeMessages(sample, settings, [], 'selection'),
        timeoutMs: 40000
      })
    );
    return {
      ok: true,
      text: result.text,
      latencyMs: Date.now() - startedAt,
      model: result.model,
      usage: result.usage,
      targetLang: settings.targetLang,
      sample
    };
  } catch (err) {
    return { ok: false, error: D.describeError(err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'dsl:audio-chunk' && isOffscreenSender(sender)) {
    enqueueAudioChunk(message).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'dsl:audio-status' && isOffscreenSender(sender)) {
    handleOffscreenStatus(message);
    sendResponse({ ok: true });
    return false;
  }

  switch (message.type) {
    case 'dsl:start-audio':
      startAudioSession(Number(message.tabId), message.streamId).then(sendResponse, (err) =>
        sendResponse({ ok: false, message: D.describeError(err).message })
      );
      return true;
    case 'dsl:stop-audio': {
      const stopTabId = Number(message.tabId) || (sender.tab && sender.tab.id);
      stopAudioSession(stopTabId).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    case 'dsl:get-audio-state':
      sendResponse({ ok: true, active: audioSessions.has(Number(message.tabId)) });
      return false;
    case 'dsl:translate-once':
      translateOnceMessage(message).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: D.describeError(err) })
      );
      return true;
    case 'dsl:test-connection':
      testConnectionMessage(message).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: D.describeError(err) })
      );
      return true;
    case 'dsl:get-stats':
      readStats().then(sendResponse, () => sendResponse(emptyStats()));
      return true;
    case 'dsl:reset-stats':
      chrome.storage.local
        .set({ [STATS_KEY]: emptyStats() })
        .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    case 'dsl:open-options':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    case 'dsl:clear-cache':
      translationCache.clear();
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

/* ---------------------------------------------------------------- streaming jobs */

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'dsl-translate') return;
  const jobs = new Map();

  port.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'abort') {
      const job = jobs.get(message.id);
      if (job) job.controller.abort();
      return;
    }
    if (message.type !== 'translate') return;
    const id = Number(message.id);
    if (!Number.isFinite(id) || jobs.has(id)) return;
    if (jobs.size >= 6) {
      safePost(port, { type: 'error', id, message: '翻译任务过多，已跳过这一句。', code: 'BUSY', retryable: false });
      return;
    }
    const controller = new AbortController();
    jobs.set(id, { controller });
    runJob(port, id, message, controller)
      .catch(() => {})
      .finally(() => jobs.delete(id));
  });

  port.onDisconnect.addListener(() => {
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
  });
});

async function runJob(port, id, message, controller) {
  let sentAny = false;
  let latencyStart = Date.now();
  try {
    const settings = await readSettings();
    if (!settings.apiKey) {
      throw new D.DeepSeekError('尚未配置翻译 API Key，请点击扩展图标 → 设置。', { code: 'NO_KEY' });
    }
    const targetLang = isTargetCode(message.targetLang) ? message.targetLang : settings.targetLang;
    const text = D.truncate(D.normalizeCaption(message.text), MAX_SUBTITLE_CHARS);
    if (!text) {
      safePost(port, { type: 'done', id, text: '', usage: null, latencyMs: 0, cached: false });
      return;
    }
    const effective = Object.assign({}, settings, { targetLang });
    const cacheKey = targetLang + '\u0001' + settings.model + '\u0001' + text;
    const cached = readCache(cacheKey);
    if (cached) {
      safePost(port, { type: 'delta', id, text: cached });
      safePost(port, { type: 'done', id, text: cached, usage: null, latencyMs: 0, cached: true });
      bumpCacheHit();
      return;
    }

    const messages = makeMessages(text, effective, message.context, 'subtitle');
    const options = apiOptions(effective, {
      messages,
      signal: controller.signal,
      onDelta: (delta) => {
        sentAny = true;
        safePost(port, { type: 'delta', id, text: delta });
      }
    });

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      latencyStart = Date.now();
      try {
        const result = await D.streamChat(options);
        const latencyMs = Date.now() - latencyStart;
        writeCache(cacheKey, result.text);
        safePost(port, { type: 'done', id, text: result.text, usage: result.usage, latencyMs, cached: false });
        recordSuccess(result.usage, latencyMs);
        return;
      } catch (err) {
        lastError = err;
        const info = D.describeError(err);
        if (info.code === 'ABORTED') {
          safePost(port, { type: 'error', id, message: '翻译已取消。', code: 'ABORTED', retryable: false });
          return;
        }
        const canRetry = info.retryable && !sentAny && attempt < 2 && !controller.signal.aborted;
        if (!canRetry) break;
        await sleep(600 * (attempt + 1));
      }
    }

    const info = D.describeError(lastError);
    await recordError();
    safePost(port, {
      type: 'error',
      id,
      message: info.message,
      code: info.code,
      retryable: info.retryable
    });
  } catch (err) {
    const info = D.describeError(err);
    if (info.code !== 'ABORTED') await recordError();
    safePost(port, { type: 'error', id, message: info.message, code: info.code, retryable: info.retryable });
  }
}

/* -------------------------------------------------------------------- menus / badge */

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: 'dsl-translate-selection',
        title: '用 DS 翻译所选内容',
        contexts: ['selection']
      },
      () => void chrome.runtime.lastError
    );
    chrome.contextMenus.create(
      {
        id: 'dsl-toggle-audio',
        title: '开始/停止 DS 实时音频翻译',
        contexts: ['page'],
        documentUrlPatterns: ['https://www.youtube.com/*', 'https://m.youtube.com/*']
      },
      () => void chrome.runtime.lastError
    );
  });
}

function flashBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || '#d93025' });
    chrome.action.setBadgeText({ text });
    setTimeout(() => refreshBadge(), 2500);
  } catch (_) {
    /* ignore */
  }
}

async function refreshBadge() {
  try {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'DS音轨翻译' });
  } catch (_) {
    /* ignore */
  }
}

async function ensureYouTubeContent(tabId) {
  try {
    const status = await chrome.tabs.sendMessage(tabId, { type: 'dsl:status' });
    if (status && status.ok) return;
  } catch (_) {
    /* inject below */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      'src/shared/settings.js',
      'src/shared/languages.js',
      'src/shared/text.js',
      'src/content/youtube.js'
    ]
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'dsl-translate-selection') {
    const frameId = Number.isFinite(info.frameId) ? info.frameId : 0;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [frameId] },
        files: [
          'src/shared/settings.js',
          'src/shared/languages.js',
          'src/shared/text.js',
          'src/content/selection.js'
        ]
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'dsl:translate-selection' }, { frameId });
    } catch (_) {
      flashBadge('×');
    }
  } else if (info.menuItemId === 'dsl-toggle-audio') {
    if (audioSessions.has(tab.id)) {
      await stopAudioSession(tab.id);
      return;
    }
    try {
      await ensureYouTubeContent(tab.id);
    } catch (_) {
      flashBadge('×');
      return;
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, async (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        flashBadge('×');
        return;
      }
      try {
        await startAudioSession(tab.id, streamId);
      } catch (_) {
        flashBadge('×');
      }
    });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SETTINGS_KEY]) {
    settingsCache = null;
    refreshBadge();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-audio') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    if (audioSessions.has(tab.id)) {
      await stopAudioSession(tab.id);
      return;
    }
    await ensureYouTubeContent(tab.id);
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, async (streamId) => {
      if (chrome.runtime.lastError || !streamId) return;
      try {
        await startAudioSession(tab.id, streamId);
      } catch (_) {
        /* ignore */
      }
    });
  } catch (_) {
    /* not a supported tab */
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const next = sanitizeSettings(data[SETTINGS_KEY]);
  next.liveMode = 'fast';
  next.model = 'deepseek-chat';
  if (
    !data[SETTINGS_KEY] ||
    data[SETTINGS_KEY].apiKey !== next.apiKey ||
    data[SETTINGS_KEY].liveMode !== 'fast' ||
    data[SETTINGS_KEY].model !== 'deepseek-chat'
  ) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  }
  installMenus();
  refreshBadge();
  // First run: there is no bundled key, so land the user straight on the key field.
  if (details && details.reason === 'install' && !next.apiKey) {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {
      /* options page unavailable */
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  installMenus();
  refreshBadge();
});

refreshBadge();
