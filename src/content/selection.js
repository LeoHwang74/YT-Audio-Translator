/**
 * Selection translator. Injected on demand (context menu / popup button) into any
 * http(s) page; renders a floating bubble with a streaming-free DeepSeek translation.
 */
(function () {
  'use strict';

  if (window.__DSL_SELECTION_LOADED__) return;
  window.__DSL_SELECTION_LOADED__ = true;

  const D = window.DSL;
  if (!D) return;

  const HOST_ID = 'dsl-selection-host';
  const MAX_CHARS = D.MAX_SELECTION_CHARS || 6000;

  let settings = D.sanitizeSettings({});
  let host = null;
  let shadow = null;
  let bubble = null;
  let els = null;
  let lastSelection = null;
  let requestSeq = 0;
  let current = { text: '', targetLang: 'zh', rect: null };
  let hideTimer = 0;

  D.sanitizeSettings && chrome.storage.local.get(D.SETTINGS_KEY).then(
    (data) => {
      settings = D.sanitizeSettings(data[D.SETTINGS_KEY]);
      if (els && els.lang) els.lang.value = settings.targetLang;
    },
    () => {}
  );

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", Roboto, sans-serif; }
    .layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    .bubble {
      position: absolute; width: min(400px, calc(100vw - 24px));
      background: linear-gradient(180deg, rgba(17, 20, 29, .97), rgba(11, 13, 20, .98));
      color: #eef1f8; border: 1px solid rgba(255, 255, 255, .12);
      border-radius: 14px; box-shadow: 0 18px 50px rgba(0, 0, 0, .45), 0 2px 8px rgba(0, 0, 0, .3);
      backdrop-filter: blur(14px); overflow: hidden; pointer-events: auto;
      animation: dsl-pop .16s ease-out;
    }
    @keyframes dsl-pop { from { opacity: 0; transform: translateY(4px) scale(.985); } to { opacity: 1; transform: none; } }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, .08); background: rgba(255, 255, 255, .02);
    }
    .brand { font-size: 11px; font-weight: 700; letter-spacing: .08em; color: #8fb0ff; white-space: nowrap; }
    select {
      margin-left: auto; max-width: 108px; padding: 3px 4px; border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06);
      color: #e8ecf7; font-size: 12px; outline: none; cursor: pointer;
    }
    button {
      border: 0; background: rgba(255, 255, 255, .06); color: #dfe5f2; cursor: pointer;
      border-radius: 7px; padding: 4px 8px; font-size: 12px; line-height: 1.5;
    }
    button:hover { background: rgba(255, 255, 255, .13); }
    .close { padding: 2px 7px; font-size: 15px; color: #aab3c5; }
    .body { padding: 12px 14px 10px; max-height: min(52vh, 420px); overflow: auto; overscroll-behavior: contain; }
    .text { font-size: 14px; line-height: 1.62; white-space: pre-wrap; word-break: break-word; color: #f2f5fb; }
    .text:empty { display: none; }
    .error { color: #ff9b9b; font-size: 13px; line-height: 1.55; }
    .error a { color: #8fb0ff; }
    .loading { display: flex; align-items: center; gap: 9px; color: #a9b3c6; font-size: 13px; }
    .spinner {
      width: 14px; height: 14px; border-radius: 50%; flex: none;
      border: 2px solid rgba(143, 176, 255, .25); border-top-color: #8fb0ff;
      animation: dsl-spin .8s linear infinite;
    }
    @keyframes dsl-spin { to { transform: rotate(360deg); } }
    .skeleton { height: 9px; border-radius: 5px; background: linear-gradient(90deg, rgba(255,255,255,.07), rgba(255,255,255,.14), rgba(255,255,255,.07)); background-size: 200% 100%; animation: dsl-shimmer 1.2s infinite; margin-top: 9px; }
    .skeleton.short { width: 62%; }
    @keyframes dsl-shimmer { to { background-position: -200% 0; } }
    .foot { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-top: 1px solid rgba(255, 255, 255, .07); color: #7f889b; font-size: 11px; }
    .foot .lat { margin-left: auto; font-variant-numeric: tabular-nums; }
    .toast {
      position: absolute; left: 50%; top: 18px; transform: translateX(-50%);
      background: rgba(15, 18, 26, .96); color: #e8ecf7; border: 1px solid rgba(255,255,255,.12);
      padding: 9px 14px; border-radius: 10px; font-size: 13px; box-shadow: 0 10px 30px rgba(0,0,0,.4);
      pointer-events: none; animation: dsl-pop .16s ease-out;
    }
    [hidden] { display: none !important; }
  `;

  function buildUi() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      `<style>${CSS}</style>` +
      `<div class="layer">` +
      `<div class="bubble" role="dialog" aria-label="DeepSeek 翻译" hidden>` +
      `<div class="head"><span class="brand">DEEPSEEK</span>` +
      `<select class="lang" title="目标语言"></select>` +
      `<button class="copy" title="复制译文">复制</button>` +
      `<button class="close" title="关闭">×</button></div>` +
      `<div class="body"><div class="text"></div><div class="error" hidden></div>` +
      `<div class="loading" hidden><span class="spinner"></span><span>DeepSeek 正在翻译…</span></div>` +
      `<div class="skeleton-wrap" hidden><div class="skeleton"></div><div class="skeleton short"></div></div></div>` +
      `<div class="foot"><span>选中文本 · DeepSeek 翻译</span><span class="lat"></span></div>` +
      `</div><div class="toast" hidden></div></div>`;

    document.documentElement.appendChild(host);
    els = {
      bubble: shadow.querySelector('.bubble'),
      lang: shadow.querySelector('.lang'),
      copy: shadow.querySelector('.copy'),
      close: shadow.querySelector('.close'),
      text: shadow.querySelector('.text'),
      error: shadow.querySelector('.error'),
      loading: shadow.querySelector('.loading'),
      skeleton: shadow.querySelector('.skeleton-wrap'),
      lat: shadow.querySelector('.lat'),
      toast: shadow.querySelector('.toast')
    };

    for (const lang of D.TARGET_LANGUAGES) {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = lang.native;
      els.lang.appendChild(option);
    }
    els.lang.value = current.targetLang || settings.targetLang;

    els.lang.addEventListener('change', () => {
      current.targetLang = els.lang.value;
      translate(current.text, current.targetLang);
    });
    els.copy.addEventListener('click', () => copyText(els.text.textContent || ''));
    els.close.addEventListener('click', hide);
    bubble = els.bubble;

    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener(
      'scroll',
      (event) => {
        const path = event.composedPath ? event.composedPath() : [];
        if (host && path.indexOf(host) !== -1) return;
        hide();
      },
      true
    );
    window.addEventListener('resize', hide, true);
  }

  function onDocumentMouseDown(event) {
    if (!host || !bubble || bubble.hidden) return;
    const path = event.composedPath ? event.composedPath() : [];
    if (path.indexOf(host) === -1) hide();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') hide();
  }

  function captureSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return lastSelection;
    const text = String(selection).replace(/\s+/g, ' ').trim();
    if (!text) return lastSelection;
    let rect = null;
    try {
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      const box = range ? range.getBoundingClientRect() : null;
      if (box && (box.width || box.height)) {
        rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      }
    } catch (_) {
      /* ignore */
    }
    lastSelection = { text, rect };
    return lastSelection;
  }

  function position() {
    if (!bubble || !current.rect) {
      if (bubble) {
        bubble.style.left = Math.max(12, (window.innerWidth - 400) / 2) + 'px';
        bubble.style.top = '64px';
      }
      return;
    }
    const margin = 10;
    const width = Math.min(400, window.innerWidth - margin * 2);
    const height = bubble.offsetHeight || 180;
    const rect = current.rect;
    let left = rect.left;
    left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
    let top = rect.bottom + 10;
    if (top + height > window.innerHeight - margin) {
      const above = rect.top - height - 10;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }
    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  function show() {
    buildUi();
    bubble.hidden = false;
    clearTimeout(hideTimer);
  }

  function hide() {
    if (!bubble) return;
    bubble.hidden = true;
    els.error.hidden = true;
    els.toast.hidden = true;
  }

  function showToast(message) {
    buildUi();
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2600);
  }

  function setLoading(loading) {
    els.loading.hidden = !loading;
    els.skeleton.hidden = !loading;
    if (loading) {
      els.text.textContent = '';
      els.error.hidden = true;
      els.lat.textContent = '';
    }
  }

  function renderError(message) {
    els.loading.hidden = true;
    els.skeleton.hidden = true;
    els.error.hidden = false;
    els.error.textContent = message;
    els.error.insertAdjacentHTML(
      'beforeend',
      ' <a href="#" class="open-options">打开设置</a>'
    );
    const link = els.error.querySelector('.open-options');
    if (link) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        sendMessage({ type: 'dsl:open-options' });
      });
    }
    position();
  }

  function renderText(text, latencyMs) {
    els.loading.hidden = true;
    els.skeleton.hidden = true;
    els.error.hidden = true;
    els.text.textContent = text;
    els.lat.textContent = latencyMs ? latencyMs + ' ms' : '';
    position();
  }

  function copyText(text) {
    if (!text) return;
    const done = () => {
      els.copy.textContent = '已复制';
      setTimeout(() => {
        els.copy.textContent = '复制';
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.documentElement.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } catch (_) {
      /* ignore */
    }
    area.remove();
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: { message: '扩展已更新，请刷新页面后重试。' } });
            return;
          }
          resolve(response || { ok: false, error: { message: '没有收到翻译结果。' } });
        });
      } catch (err) {
        resolve({ ok: false, error: { message: '扩展上下文已失效，请刷新页面后重试。' } });
      }
    });
  }

  async function translate(text, targetLang) {
    const seq = ++requestSeq;
    current = { text, targetLang, rect: current.rect };
    show();
    setLoading(true);
    position();

    const response = await sendMessage({
      type: 'dsl:translate-once',
      text,
      targetLang
    });
    if (seq !== requestSeq) return;
    if (!response || !response.ok) {
      const info = response && response.error ? response.error : {};
      renderError(info.message || '翻译失败，请稍后重试。');
      return;
    }
    els.lang.value = response.targetLang || targetLang;
    renderText(response.text, response.latencyMs);
  }

  function openFromSelection() {
    const captured = captureSelection();
    if (!captured || !captured.text) {
      showToast('请先用鼠标选中要翻译的文字');
      return;
    }
    let text = captured.text;
    if (Array.from(text).length > MAX_CHARS) {
      text = Array.from(text).slice(0, MAX_CHARS).join('') + '…';
    }
    current = { text, targetLang: els && els.lang ? els.lang.value : settings.targetLang, rect: captured.rect };
    translate(text, current.targetLang);
  }

  document.addEventListener(
    'mouseup',
    () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) captureSelection();
    },
    true
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'dsl:translate-selection') {
      openFromSelection();
      sendResponse({ ok: true });
    }
  });
})();
