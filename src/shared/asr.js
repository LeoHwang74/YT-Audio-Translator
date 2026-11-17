/** DeepSeek Speech-to-Text client. The API accepts one complete WAV/Ogg file per request. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSL = Object.assign(root.DSL || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ds =
    typeof module === 'object' && module.exports
      ? require('./deepseek.js')
      : typeof globalThis !== 'undefined'
        ? globalThis.DSL
        : null;

  function normalizeBase(input) {
    let base = String(input == null ? '' : input).trim() || 'https://api.deepseek.com';
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    return base.replace(/\/+$/, '');
  }

  function asrEndpoint(baseUrl, provider) {
    const base = normalizeBase(baseUrl);
    if (provider === 'openai') {
      // OpenAI-compatible servers (Speaches, SiliconFlow, Groq, faster-whisper wrappers)
      if (/\/audio\/transcriptions$/i.test(base)) return base;
      if (/\/v1$/i.test(base)) return base + '/audio/transcriptions';
      return base + '/v1/audio/transcriptions';
    }
    if (/\/tools\/asr$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return base + '/tools/asr';
    return base + '/v1/tools/asr';
  }

  function asrError(status, detail) {
    const suffix = detail ? '（' + String(detail).slice(0, 160) + '）' : '';
    const map = {
      400: { code: 'ASR_BAD_AUDIO', message: '音频格式不支持，需要 16-bit PCM WAV 或 Ogg Opus。' },
      401: { code: 'AUTH', message: 'DeepSeek API Key 无效或已过期。' },
      402: { code: 'INSUFFICIENT_BALANCE', message: 'DeepSeek 账户余额不足。' },
      408: { code: 'ASR_TIMEOUT', message: '语音识别超时。', retryable: true },
      413: { code: 'ASR_TOO_LARGE', message: '音频分片过大。' },
      429: { code: 'RATE_LIMIT', message: '语音识别请求过于频繁。', retryable: true },
      500: { code: 'ASR_SERVER', message: '语音识别服务错误。', retryable: true },
      503: { code: 'ASR_SERVER', message: '语音识别服务繁忙。', retryable: true },
      504: { code: 'ASR_TIMEOUT', message: '语音识别超时。', retryable: true }
    };
    const info = map[status] || { code: 'ASR_HTTP_' + status, message: '语音识别失败（HTTP ' + status + '）。', retryable: status >= 500 };
    const ErrorClass = ds && ds.DeepSeekError ? ds.DeepSeekError : Error;
    const error = new ErrorClass(info.message + suffix, {
      code: info.code,
      status,
      retryable: !!info.retryable,
      detail: detail || ''
    });
    return error;
  }

  function parseDetail(raw) {
    if (!raw) return '';
    try {
      const data = JSON.parse(raw);
      if (data && data.error) return data.error.message || data.error.code || raw;
    } catch (_) {
      /* plain text */
    }
    return String(raw).replace(/<[^>]+>/g, ' ').trim();
  }

  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} options.baseUrl
   * @param {ArrayBuffer|Blob|Uint8Array} options.wav
   */
  async function transcribeWav(options) {
    const opts = options || {};
    const provider = opts.provider === 'openai' ? 'openai' : 'deepseek';
    const apiKey = String(opts.apiKey || '').trim();
    if (!apiKey && provider !== 'openai') {
      const ErrorClass = ds && ds.DeepSeekError ? ds.DeepSeekError : Error;
      throw new ErrorClass('尚未配置语音识别 API Key。', { code: 'NO_KEY' });
    }
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) {
      const ErrorClass = ds && ds.DeepSeekError ? ds.DeepSeekError : Error;
      throw new ErrorClass('当前环境不支持 fetch。', { code: 'NO_FETCH' });
    }

    const blob =
      opts.wav instanceof Blob
        ? opts.wav
        : new Blob([opts.wav], { type: 'audio/wav' });
    const form = new FormData();
    form.append('file', blob, opts.filename || 'chunk.wav');
    if (provider === 'openai') {
      // The OpenAI transcription contract requires an explicit model name.
      form.append('model', String(opts.model || 'whisper-1'));
      form.append('response_format', 'json');
    }

    const controller = new AbortController();
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const external = opts.signal;
    const onAbort = () => controller.abort();
    if (external) {
      if (external.aborted) {
        clearTimeout(timer);
        const ErrorClass = ds && ds.DeepSeekError ? ds.DeepSeekError : Error;
        throw new ErrorClass('请求已取消。', { code: 'ABORTED' });
      }
      external.addEventListener('abort', onAbort, { once: true });
    }

    const started = Date.now();
    let response;
    const headers = apiKey ? { Authorization: 'Bearer ' + apiKey } : {};
    try {
      response = await fetchImpl(asrEndpoint(opts.baseUrl, provider), {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (err) {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
      const ErrorClass = ds && ds.DeepSeekError ? ds.DeepSeekError : Error;
      if (timedOut) throw new ErrorClass('语音识别超时。', { code: 'ASR_TIMEOUT', retryable: true });
      if (controller.signal.aborted) throw new ErrorClass('请求已取消。', { code: 'ABORTED' });
      throw new ErrorClass('无法连接语音识别服务（' + opts.baseUrl + '）。', {
        code: 'NETWORK',
        retryable: true,
        detail: err && err.message
      });
    }

    try {
      if (!response.ok) {
        let raw = '';
        try {
          raw = await response.text();
        } catch (_) {
          /* ignore */
        }
        throw asrError(response.status, parseDetail(raw));
      }
      const data = await response.json();
      const text = String(data.text || '').replace(/\s+/g, ' ').trim();
      return {
        text,
        durationMs: Number(data.duration_ms) || 0,
        requestId: data.request_id || '',
        latencyMs: Date.now() - started
      };
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
  }

  return { asrEndpoint, transcribeWav, asrError };
});
