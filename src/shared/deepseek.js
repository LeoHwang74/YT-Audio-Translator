/**
 * Minimal, dependency-free DeepSeek chat client with SSE streaming.
 * Runs in the MV3 service worker (fetch with host permission) and under Node for tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSL = Object.assign(root.DSL || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class DeepSeekError extends Error {
    constructor(message, opts) {
      super(message);
      const o = opts || {};
      this.name = 'DeepSeekError';
      this.code = o.code || 'ERROR';
      this.status = o.status || 0;
      this.retryable = !!o.retryable;
      this.detail = o.detail || '';
    }
  }

  /** Incremental Server-Sent Events parser for `data: {...}` lines. */
  class SseParser {
    constructor() {
      this.buffer = '';
    }

    push(chunk) {
      this.buffer += String(chunk == null ? '' : chunk);
      const events = [];
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        let line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        this._consumeLine(line, events);
      }
      return events;
    }

    flush() {
      const events = [];
      const rest = this.buffer.trim();
      this.buffer = '';
      if (rest) this._consumeLine(rest, events);
      return events;
    }

    _consumeLine(line, events) {
      if (!line || line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        events.push({ done: true });
        return;
      }
      try {
        events.push({ data: JSON.parse(payload) });
      } catch (_) {
        /* Ignore keep-alive garbage or partial frames. */
      }
    }
  }

  function normalizeBaseUrl(input) {
    let url = String(input == null ? '' : input).trim();
    if (!url) url = 'https://api.deepseek.com';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url.replace(/\/+$/, '');
  }

  function buildEndpoint(baseUrl) {
    const base = normalizeBaseUrl(baseUrl);
    if (/\/chat\/completions$/i.test(base)) return base;
    return base + '/chat/completions';
  }

  function errorFromStatus(status, detail) {
    const suffix = detail ? '（' + String(detail).slice(0, 160) + '）' : '';
    const map = {
      400: { code: 'BAD_REQUEST', message: '请求参数有误，请检查模型与设置。' },
      401: { code: 'AUTH', message: 'DeepSeek API Key 无效或已过期，请在设置中重新填写。' },
      402: { code: 'INSUFFICIENT_BALANCE', message: 'DeepSeek 账户余额不足，请前往开放平台充值。' },
      403: { code: 'FORBIDDEN', message: 'DeepSeek 拒绝了此次请求（403）。' },
      404: { code: 'NOT_FOUND', message: '接口地址不存在，请检查 Base URL 是否正确。' },
      422: { code: 'INVALID', message: '请求格式不正确（422）。' },
      429: { code: 'RATE_LIMIT', message: '请求过于频繁，已触发 DeepSeek 速率限制。', retryable: true },
      500: { code: 'SERVER', message: 'DeepSeek 服务器错误（500）。', retryable: true },
      502: { code: 'SERVER', message: 'DeepSeek 网关错误（502）。', retryable: true },
      503: { code: 'SERVER', message: 'DeepSeek 服务暂时不可用（503）。', retryable: true },
      504: { code: 'SERVER', message: 'DeepSeek 服务响应超时（504）。', retryable: true }
    };
    const info = map[status] || {
      code: 'HTTP_' + status,
      message: 'DeepSeek 请求失败（HTTP ' + status + '）。',
      retryable: status >= 500
    };
    return new DeepSeekError(info.message + suffix, {
      code: info.code,
      status,
      retryable: !!info.retryable,
      detail: detail || ''
    });
  }

  function parseErrorText(raw) {
    if (!raw) return '';
    try {
      const data = JSON.parse(raw);
      if (data && data.error) return data.error.message || data.error.type || raw;
      if (typeof data === 'string') return data;
    } catch (_) {
      /* raw text is fine */
    }
    return String(raw).replace(/<[^>]+>/g, ' ').trim();
  }

  /**
   * Stream a chat completion. Returns { text, usage, finishReason, model }.
   * Every text delta is forwarded to onDelta(delta).
   */
  async function streamChat(options) {
    const opts = options || {};
    const apiKey = String(opts.apiKey == null ? '' : opts.apiKey).trim();
    if (!apiKey) {
      throw new DeepSeekError('尚未配置 DeepSeek API Key，请点击扩展图标 → 设置。', { code: 'NO_KEY' });
    }
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new DeepSeekError('当前环境不支持 fetch。', { code: 'NO_FETCH' });

    const endpoint = buildEndpoint(opts.baseUrl);
    const model = opts.model || 'deepseek-chat';
    const payload = {
      model,
      messages: Array.isArray(opts.messages) ? opts.messages : [],
      stream: true,
      temperature: Number.isFinite(opts.temperature) ? opts.temperature : 1.3,
      max_tokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 512,
      stream_options: { include_usage: true }
    };

    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 45000;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const external = opts.signal;
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) {
        clearTimeout(timer);
        throw new DeepSeekError('请求已取消。', { code: 'ABORTED' });
      }
      external.addEventListener('abort', onExternalAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    };

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: 'Bearer ' + apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (err) {
      cleanup();
      if (timedOut) throw new DeepSeekError('DeepSeek 请求超时，请检查网络后重试。', { code: 'TIMEOUT', retryable: true });
      if (controller.signal.aborted) throw new DeepSeekError('请求已取消。', { code: 'ABORTED' });
      throw new DeepSeekError('无法连接 DeepSeek API，请检查网络或代理设置。', {
        code: 'NETWORK',
        retryable: true,
        detail: err && err.message ? err.message : ''
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
        throw errorFromStatus(response.status, parseErrorText(raw));
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.indexOf('application/json') !== -1 || !response.body) {
        const data = await response.json();
        const choice = data && data.choices && data.choices[0];
        const text = (choice && choice.message && choice.message.content) || (choice && choice.text) || '';
        if (!text) throw new DeepSeekError('DeepSeek 未返回翻译内容。', { code: 'EMPTY' });
        if (opts.onDelta) opts.onDelta(text);
        if (opts.onUsage && data.usage) opts.onUsage(data.usage);
        return { text, usage: data.usage || null, finishReason: choice && choice.finish_reason, model };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const parser = new SseParser();
      let full = '';
      let usage = null;
      let finishReason = null;

      const handleEvents = (events) => {
        for (const event of events) {
          if (!event || event.done || !event.data) continue;
          const data = event.data;
          if (data.usage) {
            usage = data.usage;
            if (opts.onUsage) opts.onUsage(usage);
          }
          if (data.error) {
            throw new DeepSeekError('DeepSeek 流式响应出错：' + (data.error.message || ''), {
              code: 'STREAM_ERROR'
            });
          }
          const choice = data.choices && data.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta || {};
          const piece = delta.content;
          if (typeof piece === 'string' && piece) {
            full += piece;
            if (opts.onDelta) opts.onDelta(piece);
          }
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        handleEvents(parser.push(decoder.decode(value, { stream: true })));
      }
      handleEvents(parser.push(decoder.decode()));
      handleEvents(parser.flush());

      if (!full.trim()) {
        throw new DeepSeekError('DeepSeek 返回了空结果，请稍后重试。', { code: 'EMPTY', retryable: true });
      }
      return { text: full, usage, finishReason, model };
    } catch (err) {
      if (err instanceof DeepSeekError) throw err;
      if (timedOut) throw new DeepSeekError('DeepSeek 响应超时。', { code: 'TIMEOUT', retryable: true });
      if (controller.signal.aborted) throw new DeepSeekError('请求已取消。', { code: 'ABORTED' });
      throw new DeepSeekError('读取 DeepSeek 响应失败：' + (err && err.message ? err.message : ''), {
        code: 'STREAM_READ',
        retryable: true
      });
    } finally {
      cleanup();
    }
  }

  async function translateOnce(options) {
    const opts = options || {};
    let text = '';
    const result = await streamChat(
      Object.assign({}, opts, {
        onDelta: (piece) => {
          text += piece;
          if (opts.onDelta) opts.onDelta(piece);
        }
      })
    );
    return { text: text || result.text, usage: result.usage, finishReason: result.finishReason, model: result.model };
  }

  function describeError(err) {
    if (err instanceof DeepSeekError) {
      return { message: err.message, code: err.code, status: err.status, retryable: err.retryable };
    }
    return {
      message: (err && err.message) || '未知错误，请稍后重试。',
      code: 'UNKNOWN',
      status: 0,
      retryable: false
    };
  }

  return {
    DeepSeekError,
    SseParser,
    buildEndpoint,
    normalizeBaseUrl,
    errorFromStatus,
    streamChat,
    translateOnce,
    describeError
  };
});
