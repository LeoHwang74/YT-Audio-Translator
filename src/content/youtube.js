/**
 * YT音轨翻译 · YouTube overlay (audio-only)
 *
 * The extension never reads YouTube CC subtitles. The offscreen document captures the
 * tab audio, DeepSeek ASR transcribes it, and this content script streams translations
 * into an overlay that lives inside the player (so fullscreen works).
 */
(function () {
  'use strict';

  const D = window.DSL;
  if (!D) return;
  if (window.__DS_YT_LOADED__) return;
  window.__DS_YT_LOADED__ = true;

  const HOST_ID = 'ds-overlay-host';
  const TARGET_LANG = 'zh';
  const MAX_CHARS = D.MAX_SUBTITLE_CHARS || 2000;
  const TICK_MS = 800;

  const state = {
    settings: D.sanitizeSettings({}),
    apiKeySet: false,
    player: null,
    host: null,
    shadow: null,
    els: null,
    resizeObserver: null,
    transcript: '',
    translatedFor: '',
    inflight: null,
    debounceTimer: 0,
    pendingTimer: 0,
    hideTimer: 0,
    seq: 0,
    port: null,
    reconnectAttempts: 0,
    cache: new D.LruCache(300),
    context: [],
    translatedCount: 0,
    lastError: '',
    audioActive: false,
    audioState: 'idle',
    lineStartedAt: 0,
    timersStarted: false,
    hinted: false
  };

  const CSS = `
    :host { all: initial; display: block; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", Roboto, sans-serif; }
    .layer { position: absolute; inset: 0; pointer-events: none; z-index: 2147483000; }
    .panel {
      position: absolute; left: 50%; bottom: calc(var(--ds-offset, 12) * 1%);
      transform: translateX(-50%); width: min(92%, 1040px);
      display: flex; flex-direction: column; align-items: center; gap: 7px;
      text-align: center; opacity: 0; transition: opacity .18s ease; pointer-events: none;
    }
    .panel[data-visible="1"] { opacity: 1; }
    .orig {
      max-width: 100%; padding: 3px 12px; border-radius: 9px;
      background: rgba(6, 8, 14, .42); color: rgba(238, 243, 255, .84);
      font-size: calc(var(--ds-font, 28px) * .55); line-height: 1.35; font-weight: 500;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .85); overflow-wrap: anywhere;
    }
    .orig:empty { display: none; }
    .trans {
      max-width: 100%; padding: 7px 18px 8px; border-radius: 12px;
      background: linear-gradient(180deg, rgba(9, 12, 20, .64), rgba(7, 9, 15, .82));
      border: 1px solid rgba(255, 255, 255, .09);
      box-shadow: 0 10px 34px rgba(0, 0, 0, .34), inset 0 1px 0 rgba(255, 255, 255, .05);
      backdrop-filter: blur(9px) saturate(1.1);
      color: #fff; font-size: var(--ds-font, 28px); line-height: 1.34;
      font-weight: 650; letter-spacing: .006em; text-align: center;
      text-shadow: 0 2px 9px rgba(0, 0, 0, .82); overflow-wrap: anywhere;
      transition: opacity .18s ease;
    }
    .trans:empty { display: none; }
    .trans[data-stale="1"] { opacity: .58; }
    .trans[data-busy="1"]::after {
      content: "▍"; margin-left: 3px; font-weight: 400; opacity: .75;
      animation: ds-blink .95s steps(2, start) infinite;
    }
    @keyframes ds-blink { 50% { opacity: 0; } }
    .meta {
      display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px;
      border-radius: 20px; background: rgba(6, 8, 14, .5);
      color: rgba(226, 233, 248, .76); font-size: 11px; line-height: 1.6;
      letter-spacing: .02em; max-width: 100%;
    }
    .meta[data-kind="error"] { color: #ffb4b4; }
    .meta[data-kind="hint"] { color: #ddd6fe; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #6f7d95; flex: none; }
    .meta[data-kind="ok"] .dot { background: #a78bfa; box-shadow: 0 0 8px rgba(167, 139, 250, .8); }
    .meta[data-kind="working"] .dot { background: #8b5cf6; animation: ds-pulse 1.1s ease-in-out infinite; }
    .meta[data-kind="error"] .dot { background: #ff6b6b; }
    .meta[data-kind="hint"] .dot { background: #a78bfa; }
    @keyframes ds-pulse { 50% { opacity: .25; } }
    .bar {
      position: absolute; top: 10px; left: 10px; display: flex; align-items: center; gap: 6px;
      padding: 5px 7px; border-radius: 10px;
      background: rgba(8, 18, 14, .8); border: 1px solid rgba(255, 255, 255, .12);
      box-shadow: 0 8px 24px rgba(0, 0, 0, .3); backdrop-filter: blur(12px);
      opacity: 0; transform: translateY(-4px); transition: opacity .18s ease, transform .18s ease;
      pointer-events: none; font-size: 12px;
    }
    :host([data-hover="1"]) .bar, .bar:focus-within { opacity: 1; transform: none; pointer-events: auto; }
    .brand {
      font-size: 10px; font-weight: 800; letter-spacing: .12em; color: #c4b5fd;
      padding: 0 2px 0 3px; white-space: nowrap;
    }
    .target {
      padding: 3px 8px; border-radius: 7px; color: #ede9fe; font-size: 11.5px;
      background: rgba(139, 92, 246, .14); border: 1px solid rgba(139, 92, 246, .28);
      white-space: nowrap;
    }
    .bar button {
      border: 0; border-radius: 7px; padding: 4px 8px; cursor: pointer;
      background: rgba(255, 255, 255, .06); color: #dde4f1; font-size: 12px; line-height: 1.45;
    }
    .bar button:hover { background: rgba(255, 255, 255, .14); }
    .bar button[data-on="1"] { background: rgba(139, 92, 246, .25); color: #ede9fe; }
    .bar button.icon { padding: 2px 7px; font-size: 15px; color: #a8b2c6; }
  `;

  /* ------------------------------------------------------------------ settings */

  function applySettings(raw) {
    const full = D.sanitizeSettings(raw);
    state.apiKeySet = D.hasApiKey(full);
    full.apiKey = '';
    full.targetLang = TARGET_LANG;
    state.settings = full;
    if (state.els) {
      updateOverlayStyle();
      state.els.origBtn.dataset.on = full.showOriginal ? '1' : '0';
      if (!full.showOriginal) state.els.orig.textContent = '';
      state.els.meta.style.display = full.showStatus ? '' : 'none';
    }
  }

  async function patchSettings(patch) {
    const data = await chrome.storage.local.get(D.SETTINGS_KEY);
    const next = D.mergeSettings(data[D.SETTINGS_KEY], patch);
    await chrome.storage.local.set({ [D.SETTINGS_KEY]: next });
    applySettings(next);
  }

  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get(D.SETTINGS_KEY);
      applySettings(data[D.SETTINGS_KEY]);
    } catch (_) {
      applySettings(D.DEFAULT_SETTINGS);
    }
  }

  /* ------------------------------------------------------------------ overlay */

  function findPlayer() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  function attach(player) {
    detach(true);
    state.player = player;
    try {
      const style = getComputedStyle(player);
      if (style && style.position === 'static') player.style.position = 'relative';
    } catch (_) {
      /* ignore */
    }

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:absolute;inset:0;pointer-events:none;z-index:2147483000;';
    player.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      `<style>${CSS}</style>` +
      `<div class="layer">` +
      `<div class="panel" data-visible="0" aria-live="polite">` +
      `<div class="orig"></div><div class="trans"></div>` +
      `<div class="meta" data-kind="idle"><span class="dot"></span><span class="label">等待音频</span></div>` +
      `</div>` +
      `<div class="bar" role="toolbar" aria-label="YT音轨翻译">` +
      `<span class="brand">YT</span><span class="target">简体中文</span>` +
      `<button type="button" data-act="copy" title="复制当前译文">复制</button>` +
      `<button type="button" data-act="orig" title="显示/隐藏原文">原文</button>` +
      `<button type="button" data-act="settings" title="打开设置">设置</button>` +
      `<button type="button" data-act="close" class="icon" title="停止并关闭">×</button>` +
      `</div></div>`;

    state.host = host;
    state.shadow = shadow;
    state.els = {
      panel: shadow.querySelector('.panel'),
      orig: shadow.querySelector('.orig'),
      trans: shadow.querySelector('.trans'),
      meta: shadow.querySelector('.meta'),
      metaLabel: shadow.querySelector('.meta .label'),
      copy: shadow.querySelector('[data-act="copy"]'),
      origBtn: shadow.querySelector('[data-act="orig"]'),
      settingsBtn: shadow.querySelector('[data-act="settings"]'),
      closeBtn: shadow.querySelector('[data-act="close"]')
    };

    state.els.copy.addEventListener('click', copyTranslation);
    state.els.origBtn.addEventListener('click', () => patchSettings({ showOriginal: !state.settings.showOriginal }));
    state.els.settingsBtn.addEventListener('click', () => sendRuntime({ type: 'dsl:open-options' }));
    state.els.closeBtn.addEventListener('click', () => {
      sendRuntime({ type: 'dsl:stop-audio' });
      hideOverlay();
    });

    for (const type of ['mousedown', 'pointerdown', 'click', 'dblclick']) {
      host.addEventListener(type, (event) => event.stopPropagation(), false);
    }

    const showBar = () => host.setAttribute('data-hover', '1');
    const hideBar = () => host.removeAttribute('data-hover');
    player.addEventListener('mouseenter', showBar);
    player.addEventListener('mouseleave', hideBar);
    player.addEventListener('focusin', showBar);
    player.addEventListener('focusout', hideBar);
    showBar();
    setTimeout(hideBar, 3200);

    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(() => updateOverlayStyle());
      state.resizeObserver.observe(player);
    }

    updateOverlayStyle();
    state.els.origBtn.dataset.on = state.settings.showOriginal ? '1' : '0';
    state.els.meta.style.display = state.settings.showStatus ? '' : 'none';
    setPanelVisible(false);

    if (state.audioActive) {
      setAudioState('capturing', '正在聆听音轨…');
    } else {
      setTimeout(() => {
        if (!state.transcript && !state.audioActive) maybeHint();
      }, 1200);
    }
  }

  function detach(keepSettings) {
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
    abortInflight();
    if (state.host) state.host.remove();
    state.player = null;
    state.host = null;
    state.shadow = null;
    state.els = null;
    if (!keepSettings) {
      state.transcript = '';
      state.translatedFor = '';
    }
  }

  function updateOverlayStyle() {
    if (!state.host) return;
    const base = state.settings.fontSize;
    let scale = 1;
    const height = state.player ? state.player.clientHeight : 0;
    if (height > 0) scale = Math.min(1.25, Math.max(0.66, height / 720));
    const px = Math.round(Math.max(13, Math.min(64, base * scale)));
    state.host.style.setProperty('--ds-font', px + 'px');
    state.host.style.setProperty('--ds-offset', String(state.settings.offsetPercent));
    if (state.els && state.els.trans) {
      state.els.trans.style.background = `linear-gradient(180deg, rgba(9, 12, 20, ${Math.min(
        0.95,
        state.settings.opacity * 0.76
      )}), rgba(7, 9, 15, ${Math.min(0.97, state.settings.opacity)}))`;
    }
  }

  /* ------------------------------------------------------------------ transcripts */

  function pushTranscript(raw) {
    const text = D.truncate(D.normalizeCaption(raw), MAX_CHARS);
    if (!text || text === state.transcript) return;
    state.transcript = text;
    state.lineStartedAt = Date.now();
    clearTimeout(state.hideTimer);
    state.hideTimer = 0;
    state.lastError = '';
    if (state.els) {
      if (state.settings.showOriginal) state.els.orig.textContent = text;
      state.els.trans.dataset.stale = state.translatedFor === text ? '0' : '1';
      setPanelVisible(true);
    }
    scheduleTranslate();
  }

  function scheduleTranslate(maxDelay) {
    if (!state.transcript) return;
    clearTimeout(state.debounceTimer);
    const mode = state.settings.liveMode;
    let delay = D.debounceForMode(mode);
    if (mode === 'stable') {
      const age = Date.now() - state.lineStartedAt;
      delay = age >= 2600 ? 140 : Math.max(delay, state.settings.settleMs);
    }
    if (D.looksComplete(state.transcript)) delay = Math.min(delay, 150);
    if (Number.isFinite(maxDelay) && maxDelay >= 0) delay = Math.min(delay, maxDelay);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = 0;
      requestTranslation(state.transcript);
    }, Math.max(0, delay));
  }

  /* ------------------------------------------------------------------ translation */

  function localCacheKey(text) {
    return D.cacheKey(TARGET_LANG, state.settings.model + '\u0001' + text);
  }

  function abortInflight() {
    if (state.inflight && state.port) {
      try {
        state.port.postMessage({ type: 'abort', id: state.inflight.id });
      } catch (_) {
        /* ignore */
      }
    }
    state.inflight = null;
  }

  function ensurePort() {
    if (state.port) return state.port;
    try {
      const port = chrome.runtime.connect({ name: 'dsl-translate' });
      port.onMessage.addListener(onPortMessage);
      port.onDisconnect.addListener(() => {
        state.port = null;
        if (state.inflight) {
          state.inflight = null;
          if (state.reconnectAttempts < 3) {
            state.reconnectAttempts += 1;
            setTimeout(() => requestTranslation(state.transcript), 700);
          } else {
            setStatus('error', '与扩展后台的连接已断开，请刷新页面。');
          }
        }
      });
      state.port = port;
      state.reconnectAttempts = 0;
      return port;
    } catch (_) {
      return null;
    }
  }

  function requestTranslation(text) {
    if (!text) return;
    if (state.inflight) return;

    const cached = state.cache.get(localCacheKey(text));
    if (cached) {
      commitTranslation(cached, text);
      return;
    }

    const port = ensurePort();
    if (!port) {
      setStatus('error', '无法连接扩展后台，请刷新页面后重试。');
      return;
    }
    const id = ++state.seq;
    state.inflight = {
      id,
      text,
      buffer: '',
      startedAt: Date.now(),
      renderPending: false
    };
    if (state.els) state.els.trans.dataset.stale = '1';
    setStatus('working', 'DeepSeek 翻译中…');
    try {
      port.postMessage({
        type: 'translate',
        id,
        text,
        targetLang: TARGET_LANG,
        context: state.context
      });
    } catch (_) {
      state.inflight = null;
      state.port = null;
      setStatus('error', '无法连接扩展后台，请刷新页面后重试。');
    }
  }

  function onPortMessage(message) {
    const job = state.inflight;
    if (!job || !message || message.id !== job.id) return;
    if (message.type === 'delta') {
      job.buffer += typeof message.text === 'string' ? message.text : '';
      scheduleStreamRender(job);
      return;
    }
    if (message.type === 'done') {
      if (typeof message.text === 'string' && message.text) job.buffer = message.text;
      finishJob(job);
      return;
    }
    if (message.type === 'error') {
      state.inflight = null;
      if (state.els) state.els.trans.dataset.busy = '0';
      state.lastError = message.message || '翻译失败';
      setStatus('error', state.lastError);
      setPanelVisible(true);
    }
  }

  function scheduleStreamRender(job) {
    if (job.renderPending) return;
    job.renderPending = true;
    setTimeout(() => {
      job.renderPending = false;
      if (state.inflight !== job || !state.els) return;
      if (!job.buffer) return;
      state.els.trans.textContent = job.buffer;
      state.els.trans.dataset.busy = '1';
      state.els.trans.dataset.stale = '0';
      setPanelVisible(true);
    }, 50);
  }

  function finishJob(job) {
    state.inflight = null;
    const finalText = (job.buffer || '').trim();
    if (!finalText) {
      setStatus('error', 'DeepSeek 没有返回译文，请稍后重试。');
      return;
    }
    state.cache.set(localCacheKey(job.text), finalText);
    state.reconnectAttempts = 0;
    if (job.text === state.transcript) {
      commitTranslation(finalText, job.text);
      state.translatedCount += 1;
    } else if (state.transcript && state.transcript !== state.translatedFor) {
      const gap = Math.max(100, 280 - (Date.now() - job.startedAt));
      clearTimeout(state.pendingTimer);
      state.pendingTimer = setTimeout(() => requestTranslation(state.transcript), gap);
    }
  }

  function commitTranslation(text, sourceText) {
    state.translatedFor = sourceText;
    if (state.els) {
      state.els.trans.textContent = text;
      state.els.trans.dataset.busy = '0';
      state.els.trans.dataset.stale = '0';
    }
    setPanelVisible(true);
    setStatus('ok', '实时翻译 · 简体中文');
    const last = state.context[state.context.length - 1];
    if (last && (sourceText.startsWith(last.src) || last.src.startsWith(sourceText))) {
      last.src = sourceText;
      last.tgt = text;
    } else if (!last || last.src !== sourceText) {
      state.context.push({ src: sourceText, tgt: text });
      while (state.context.length > 6) state.context.shift();
    }
  }

  /* ------------------------------------------------------------------ status */

  function setPanelVisible(visible) {
    if (state.els) state.els.panel.dataset.visible = visible ? '1' : '0';
  }

  function setStatus(kind, message) {
    if (!state.els) return;
    state.els.meta.dataset.kind = kind;
    state.els.metaLabel.textContent = message;
    if (kind === 'error' || kind === 'hint') setPanelVisible(true);
  }

  function setAudioState(kind, message) {
    state.audioState = kind;
    state.audioActive = kind === 'capturing';
    if (kind === 'capturing') {
      clearTimeout(state.hideTimer);
      state.hideTimer = 0;
      setStatus('working', message || '正在聆听音轨…');
      setPanelVisible(true);
    } else if (kind === 'stopped') {
      setStatus('idle', message || '音频翻译已停止');
      clearTimeout(state.hideTimer);
      state.hideTimer = setTimeout(() => {
        if (!state.audioActive) hideOverlay();
      }, 4500);
    } else if (kind === 'error') {
      state.lastError = message || '语音识别失败';
      setStatus('error', state.lastError);
      setPanelVisible(true);
    }
  }

  function maybeHint() {
    if (state.hinted || state.audioActive || state.transcript) return;
    state.hinted = true;
    setStatus('hint', '点击扩展图标 → 开始音频翻译');
    setPanelVisible(true);
    setTimeout(() => {
      if (!state.transcript && !state.audioActive) setPanelVisible(false);
    }, 5000);
  }

  function hideOverlay() {
    abortInflight();
    state.transcript = '';
    state.translatedFor = '';
    if (state.els) {
      state.els.trans.textContent = '';
      state.els.orig.textContent = '';
      state.els.trans.dataset.busy = '0';
      state.els.trans.dataset.stale = '0';
      setPanelVisible(false);
      setStatus('idle', '等待音频');
    }
  }

  function copyTranslation() {
    const text = state.els ? state.els.trans.textContent : '';
    if (!text) return;
    const done = () => {
      if (!state.els) return;
      state.els.copy.textContent = '已复制';
      setTimeout(() => {
        if (state.els) state.els.copy.textContent = '复制';
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      done();
    }
  }

  function sendRuntime(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ lifecycle */

  function tick() {
    const player = findPlayer();
    if (!player) {
      if (state.host) detach();
      return;
    }
    if (player !== state.player || !state.host || !state.host.isConnected) {
      attach(player);
    } else if (!document.fullscreenElement && state.host.parentElement !== player) {
      player.appendChild(state.host);
    }
  }

  function onFullscreenChange() {
    const fullscreen = document.fullscreenElement;
    if (state.host && state.player) {
      if (fullscreen) {
        if (!fullscreen.contains(state.host)) fullscreen.appendChild(state.host);
      } else if (state.host.parentElement !== state.player) {
        state.player.appendChild(state.host);
      }
    }
    updateOverlayStyle();
  }

  function startTimers() {
    if (state.timersStarted) return;
    state.timersStarted = true;
    setInterval(tick, TICK_MS);
    document.addEventListener('yt-navigate-finish', onNavigate, true);
    document.addEventListener('yt-page-data-updated', onNavigate, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('resize', () => updateOverlayStyle());
  }

  function onNavigate() {
    setTimeout(() => {
      state.transcript = '';
      state.translatedFor = '';
      state.context = [];
      state.audioActive = false;
      state.audioState = 'idle';
      if (state.els) hideOverlay();
      tick();
    }, 350);
  }

  function statusPayload() {
    return {
      ok: true,
      attached: !!state.host,
      audioActive: state.audioActive,
      audioState: state.audioState,
      translatedCount: state.translatedCount,
      targetLang: TARGET_LANG,
      liveMode: state.settings.liveMode,
      lastError: state.lastError,
      apiKeySet: state.apiKeySet
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'dsl:status') {
      sendResponse(statusPayload());
      return;
    }
    if (message.type === 'dsl:audio-start') {
      state.hinted = true;
      state.audioActive = true;
      state.audioState = 'capturing';
      state.transcript = '';
      state.translatedFor = '';
      state.context = [];
      if (state.els) {
        state.els.trans.textContent = '';
        state.els.orig.textContent = '';
        state.els.trans.dataset.busy = '0';
        state.els.trans.dataset.stale = '0';
      }
      setAudioState('capturing', '正在聆听音轨…');
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'dsl:audio-text') {
      if (!state.audioActive) state.audioActive = true;
      if (state.audioState !== 'capturing') state.audioState = 'capturing';
      pushTranscript(message.text);
      return;
    }
    if (message.type === 'dsl:audio-status') {
      setAudioState(message.state || 'idle', message.message || '');
      return;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[D.SETTINGS_KEY]) return;
    applySettings(changes[D.SETTINGS_KEY].newValue);
  });

  loadSettings().then(() => {
    startTimers();
    tick();
  });

  window.__DS_YT_STATUS__ = statusPayload;
})();
