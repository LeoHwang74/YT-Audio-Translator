(function () {
  'use strict';

  const D = window.DSL;
  const { SETTINGS_KEY, sanitizeSettings } = D;
  const $ = (id) => document.getElementById(id);

  const ASR_MODELS = [
    { id: 'Systran/faster-whisper-base', hint: '默认，最快' },
    { id: 'Systran/faster-whisper-small', hint: '更准，慢约 3 倍' },
    { id: 'FunAudioLLM/SenseVoiceSmall', hint: '硅基流动云端' }
  ];

  let current = sanitizeSettings({});
  let dirty = false;
  let toastTimer = 0;

  function init() {
    fillModels();
    bindEvents();
    loadAll();
  }

  function fillModels() {
    const list = $('asrModelOptions');
    for (const item of ASR_MODELS) {
      const option = document.createElement('option');
      option.value = item.id;
      option.label = item.id + ' · ' + item.hint;
      list.appendChild(option);
    }
  }

  async function loadAll() {
    try {
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      current = sanitizeSettings(data[SETTINGS_KEY]);
    } catch (_) {
      current = sanitizeSettings({});
    }
    writeForm(current);
    setDirty(false);
  }

  function writeForm(settings) {
    $('asrProvider').value = settings.asrProvider === 'openai' ? 'openai' : 'openai';
    $('asrBaseUrl').value = settings.asrBaseUrl || '';
    $('asrModel').value = settings.asrModel || '';
    $('fontSize').value = String(settings.fontSize);
    $('offsetPercent').value = String(settings.offsetPercent);
    $('opacity').value = String(Math.round(settings.opacity * 100));
    $('showOriginal').checked = settings.showOriginal;
    $('showStatus').checked = settings.showStatus;
    $('fontSizeOut').textContent = settings.fontSize + 'px';
    $('offsetOut').textContent = settings.offsetPercent + '%';
    $('opacityOut').textContent = Math.round(settings.opacity * 100) + '%';
    updatePreview();
  }

  function collect() {
    // Merge onto the stored settings so translation config survives this page.
    return sanitizeSettings(
      Object.assign({}, current, {
        asrProvider: $('asrProvider').value,
        asrBaseUrl: $('asrBaseUrl').value,
        asrModel: $('asrModel').value,
        fontSize: $('fontSize').value,
        offsetPercent: $('offsetPercent').value,
        opacity: Number($('opacity').value) / 100,
        showOriginal: $('showOriginal').checked,
        showStatus: $('showStatus').checked
      })
    );
  }

  function setDirty(value) {
    dirty = !!value;
    $('saveBtn').textContent = dirty ? '保存设置 •' : '保存设置';
  }

  function openAiEndpoint(baseUrl) {
    const base = D.normalizeBaseUrl(baseUrl || D.ASR_DEFAULT_BASE_URL);
    if (/\/audio\/transcriptions$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return base + '/audio/transcriptions';
    return base + '/v1/audio/transcriptions';
  }

  function updatePreview() {
    const endpoint = openAiEndpoint($('asrBaseUrl').value);
    $('asrPreview').textContent = endpoint;
    $('keyState').textContent = /127\.0\.0\.1|localhost/.test(endpoint) ? '本地服务' : '远程服务';
  }

  function updateRangeLabels() {
    $('fontSizeOut').textContent = $('fontSize').value + 'px';
    $('offsetOut').textContent = $('offsetPercent').value + '%';
    $('opacityOut').textContent = $('opacity').value + '%';
  }

  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast ' + (kind || '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  function ensureOrigin(baseUrl) {
    return new Promise((resolve) => {
      const pattern = D.originPattern(baseUrl);
      if (!pattern) {
        resolve(true);
        return;
      }
      try {
        chrome.permissions.request({ origins: [pattern] }, (granted) => resolve(!!granted));
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function onSave(event) {
    if (event) event.preventDefault();
    const next = collect();
    const granted = await ensureOrigin(next.asrBaseUrl);
    if (!granted) {
      toast('未获得该地址的访问权限，请重试并点「允许」', 'error');
      return;
    }
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      current = next;
      setDirty(false);
      updatePreview();
      toast('设置已保存', 'ok');
    } catch (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), 'error');
    }
  }

  function renderResult(kind, text) {
    const el = $('asrResult');
    el.hidden = false;
    el.className = 'test-result ' + kind;
    el.textContent = text;
  }

  async function onCheck() {
    const next = collect();
    const endpoint = openAiEndpoint(next.asrBaseUrl);
    const button = $('checkBtn');
    button.disabled = true;
    button.textContent = '检测中…';
    renderResult('', '正在请求 ' + endpoint + ' …');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: (() => {
          const form = new FormData();
          form.append('file', new Blob([silentWav()], { type: 'audio/wav' }), 'probe.wav');
          form.append('model', next.asrModel || 'whisper-1');
          form.append('response_format', 'json');
          return form;
        })(),
        cache: 'no-store'
      });
      const text = await response.text();
      if (!response.ok) {
        renderResult('error', 'HTTP ' + response.status + '：' + text.slice(0, 200));
      } else {
        let parsed = text;
        try {
          parsed = JSON.parse(text).text || text;
        } catch (_) {
          /* plain text */
        }
        renderResult('ok', '连接成功，模型返回："' + String(parsed).slice(0, 120) + '"');
      }
    } catch (err) {
      renderResult('error', '无法连接：' + (err && err.message ? err.message : '未知错误'));
    } finally {
      button.disabled = false;
      button.textContent = '测试服务';
    }
  }

  /** 0.4s of 16 kHz 16-bit PCM silence — enough to prove the endpoint answers. */
  function silentWav() {
    const rate = 16000;
    const samples = Math.round(rate * 0.4);
    const bytes = new Uint8Array(44 + samples * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, samples * 2, true);
    return bytes;
  }

  function bindEvents() {
    $('form').addEventListener('submit', onSave);
    $('checkBtn').addEventListener('click', onCheck);
    $('form').addEventListener('input', (event) => {
      if (event.target && ['asrBaseUrl', 'asrModel'].indexOf(event.target.id) !== -1) {
        updatePreview();
      }
      if (event.target && ['fontSize', 'offsetPercent', 'opacity'].indexOf(event.target.id) !== -1) {
        updateRangeLabels();
      }
      setDirty(true);
    });
    $('form').addEventListener('change', () => setDirty(true));
    window.addEventListener('beforeunload', (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  init();
})();
