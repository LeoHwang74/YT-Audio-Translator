(function () {
  'use strict';

  const D = window.DSL;
  const $ = (id) => document.getElementById(id);
  const YT_FILES = [
    'src/shared/settings.js',
    'src/shared/languages.js',
    'src/shared/text.js',
    'src/content/youtube.js'
  ];
  const SELECTION_FILES = [
    'src/shared/settings.js',
    'src/shared/languages.js',
    'src/shared/text.js',
    'src/content/selection.js'
  ];

  let tab = null;
  let audioActive = false;
  let starting = false;
  let toastTimer = 0;
  let pollTimer = 0;
  let closed = false;

  async function init() {
    $('version').textContent = 'v' + chrome.runtime.getManifest().version;
    bindEvents();
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs[0] ? tabs[0] : null;
    } catch (_) {
      tab = null;
    }
    await refresh();
    pollTimer = setInterval(() => {
      if (!starting) refresh();
    }, 1500);
    window.addEventListener('unload', () => {
      closed = true;
      clearInterval(pollTimer);
    });
  }

  function bindEvents() {
    $('audioBtn').addEventListener('click', onAudioClick);
    $('refreshBtn').addEventListener('click', refresh);
    $('openOptions').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
    $('selectionBtn').addEventListener('click', translateSelection);
  }

  function isYouTube() {
    return !!(tab && D.isYouTubeUrl(tab.url || tab.pendingUrl || ''));
  }

  function setStatus(kind, title, hint) {
    $('statusDot').className = 'dot ' + (kind || '');
    $('audioTitle').textContent = title;
    $('audioHint').textContent = hint || '';
  }

  function setButton(text, disabled, mode) {
    const button = $('audioBtn');
    button.textContent = text;
    button.disabled = !!disabled;
    button.dataset.mode = mode || '';
  }

  function render(status) {
    audioActive = !!(status && status.audioActive);
    const mode = status && status.liveMode === 'fast' ? '极速' : status && status.liveMode === 'stable' ? '稳定' : '均衡';

    if (!status) {
      setStatus('idle', '页面脚本未就绪', '若刚安装或更新扩展，请刷新 YouTube 页面');
      setButton(audioActive ? '停止音频翻译' : '开始音频翻译', !isYouTube(), audioActive ? 'stop' : '');
      return;
    }

    if (status.audioState === 'error') {
      setStatus('error', '语音识别出错', status.lastError || '请稍后重试');
      $('audioMeta').textContent = '可在设置中检查 API 状态';
      setButton('重新开始音频翻译', false, '');
      return;
    }

    if (audioActive) {
      setStatus('ok', '正在实时翻译', '自动识别音轨语言 → 简体中文');
      $('audioMeta').textContent = `已翻译 ${status.translatedCount || 0} 句 · 实时模式：${mode}`;
      setButton('停止音频翻译', false, 'stop');
      return;
    }

    setStatus('idle', '准备就绪', '自动识别音轨语言 → 简体中文');
    $('audioMeta').textContent = '点击开始后，浏览器会捕获当前标签页音轨';
    setButton('开始音频翻译', !isYouTube(), '');
  }

  async function refresh() {
    if (closed) return;
    if (!tab) {
      setStatus('idle', '未找到当前标签页', '请重新打开扩展弹窗');
      setButton('开始音频翻译', true, '');
      return;
    }
    if (!isYouTube()) {
      setStatus('idle', '当前不是 YouTube 页面', '请打开 YouTube 直播或视频页面');
      $('audioMeta').textContent = '音频翻译仅支持 YouTube 标签页';
      setButton('开始音频翻译', true, '');
      return;
    }

    let status = await sendToTab(tab.id, { type: 'dsl:status' }, 900);
    if (!status && !starting) {
      // Content script may be injected after the page loaded.
      const injected = await inject(tab.id, YT_FILES);
      if (injected) {
        await wait(250);
        status = await sendToTab(tab.id, { type: 'dsl:status' }, 1200);
      }
    }
    render(status);
  }

  function onAudioClick() {
    if (!tab) {
      toast('正在读取标签页信息，请稍后再试');
      return;
    }
    if (starting) return;
    if (audioActive) {
      stopAudio();
      return;
    }
    startAudio();
  }

  function startAudio() {
    if (!isYouTube()) {
      toast('请在 YouTube 直播页面使用');
      return;
    }
    starting = true;
    setButton('正在启动…', true, '');

    // Must be called directly from the click so Chrome grants tab capture.
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, async (streamId) => {
      const captureError = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (!streamId || captureError) {
        starting = false;
        toast('无法捕获音轨：' + (captureError || '请刷新页面后重试'));
        await refresh();
        return;
      }

      const response = await sendRuntime({ type: 'dsl:start-audio', tabId: tab.id, streamId });
      starting = false;
      if (!response || !response.ok) {
        toast((response && response.message) || '启动失败，请重试');
        await refresh();
        return;
      }

      audioActive = true;
      setStatus('working', '正在实时翻译', '已连接音轨，等待说话…');
      $('audioMeta').textContent = '自动识别音轨语言 → 简体中文';
      setButton('停止音频翻译', false, 'stop');
      setTimeout(refresh, 800);
    });
  }

  async function stopAudio() {
    if (!tab) return;
    starting = true;
    setButton('正在停止…', true, '');
    await sendRuntime({ type: 'dsl:stop-audio', tabId: tab.id });
    starting = false;
    audioActive = false;
    setStatus('idle', '已停止', '再次点击开始即可继续');
    setButton('开始音频翻译', false, '');
    setTimeout(refresh, 300);
  }

  async function translateSelection() {
    if (!tab) {
      toast('无法获取当前标签页');
      return;
    }
    if (!tab.url || /^(chrome|edge|about|devtools|chrome-extension):/i.test(tab.url)) {
      toast('浏览器内部页面不支持翻译');
      return;
    }
    const injected = await inject(tab.id, SELECTION_FILES);
    if (!injected) {
      toast('无法在当前页面显示翻译');
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'dsl:translate-selection' });
      window.close();
    } catch (_) {
      toast('未能读取选区，请刷新页面后重试');
    }
  }

  function inject(tabId, files) {
    return new Promise((resolve) => {
      try {
        chrome.scripting.executeScript({ target: { tabId }, files }, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function sendToTab(tabId, message, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs || 1500);
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch (_) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      }
    });
  }

  function sendRuntime(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, message: chrome.runtime.lastError.message || '扩展后台未响应' });
            return;
          }
          resolve(response || { ok: false, message: '扩展后台未响应' });
        });
      } catch (_) {
        resolve({ ok: false, message: '扩展上下文已失效' });
      }
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2800);
  }

  init();
})();
