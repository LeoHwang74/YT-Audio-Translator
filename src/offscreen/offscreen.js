/**
 * Offscreen audio capture.
 *
 * Tab audio is captured with tabCapture, resampled to 16 kHz by the AudioContext,
 * sliced by a lightweight energy VAD, and encoded as WAV chunks for DeepSeek ASR.
 * Captured audio is also routed back to the speakers because tabCapture mutes the tab.
 */
(function () {
  'use strict';

  const A = window.DSL;
  const SAMPLE_RATE = 16000;
  const MAX_CHUNK_MS = 1600;
  const MIN_CHUNK_MS = 600;
  const SILENCE_MS = 250;
  const PRE_ROLL_BUFFERS = 3;
  const SPEECH_RMS = 0.003;
  const SILENCE_RMS = 0.002;

  let session = null;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch (_) {
      /* service worker unavailable */
    }
  }

  function status(state, message) {
    if (!session) return;
    send({ type: 'dsl:audio-status', tabId: session.tabId, state, message: message || '' });
  }

  function copyChunk(chunk, samples) {
    chunk.push(samples);
  }

  function takeSamples(sessionState) {
    const total = sessionState.chunkSamples;
    const samples = new Float32Array(total);
    let offset = 0;
    for (const block of sessionState.chunk) {
      samples.set(block, offset);
      offset += block.length;
    }
    return samples;
  }

  function flushSession(keepOverlap) {
    if (!session) return;
    const s = session;
    const durationMs = (s.chunkSamples / s.sampleRate) * 1000;

    if (durationMs >= 350) {
      const samples = takeSamples(s);
      const wav = A.encodeWav(samples, s.sampleRate);
      const base64 = A.toBase64(wav);
      s.seq += 1;
      send({
        type: 'dsl:audio-chunk',
        tabId: s.tabId,
        seq: s.seq,
        wavBase64: base64,
        durationMs: Math.round(durationMs)
      });
    }

    s.chunk = [];
    s.chunkSamples = 0;
    s.silenceSamples = 0;
    s.speechStarted = false;

    if (keepOverlap && durationMs >= 400) {
      const overlapFrames = Math.min(s.bufferSamples.length, Math.round(s.sampleRate * 0.22));
      const overlap = s.bufferSamples.slice(-overlapFrames);
      s.preRoll = [overlap];
    } else {
      s.preRoll = [];
    }
  }

  function onAudioBlock(block) {
    if (!session) return;
    const s = session;
    s.bufferSamples = block;
    const level = A.rms(block);

    if (!s.speechStarted) {
      s.preRoll.push(block);
      while (s.preRoll.length > PRE_ROLL_BUFFERS) s.preRoll.shift();
      if (level >= SPEECH_RMS) {
        s.speechStarted = true;
        for (const pre of s.preRoll) copyChunk(s.chunk, pre);
        s.chunkSamples = s.chunk.reduce((total, item) => total + item.length, 0);
        s.preRoll = [];
        s.silenceSamples = 0;
      }
      return;
    }

    copyChunk(s.chunk, block);
    s.chunkSamples += block.length;
    s.bufferSamples = block;

    if (level < SILENCE_RMS) s.silenceSamples += block.length;
    else s.silenceSamples = 0;

    const durationMs = (s.chunkSamples / s.sampleRate) * 1000;
    if (durationMs >= MAX_CHUNK_MS) {
      flushSession(true);
      return;
    }
    if (durationMs >= MIN_CHUNK_MS && s.silenceSamples >= (SILENCE_MS / 1000) * s.sampleRate) {
      flushSession(false);
    }
  }

  async function start(streamId, tabId) {
    await stop(false);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    await context.resume();
    if (!context.audioWorklet) throw new Error('当前浏览器不支持 AudioWorklet');
    await context.audioWorklet.addModule(chrome.runtime.getURL('src/offscreen/pcm-worklet.js'));

    // Play the captured tab audio back at the device's native rate; the 16 kHz
    // context below is only for VAD/ASR and would sound muffled if used for playback.
    const playback = new AudioContext();
    await playback.resume();
    const playbackSource = playback.createMediaStreamSource(stream);
    playbackSource.connect(playback.destination);

    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, 'ds-pcm-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit'
    });
    const mute = context.createGain();
    mute.gain.value = 0;

    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);

    session = {
      tabId,
      stream,
      context,
      playback,
      playbackSource,
      source,
      worklet,
      mute,
      sampleRate: context.sampleRate,
      seq: 0,
      chunk: [],
      chunkSamples: 0,
      silenceSamples: 0,
      speechStarted: false,
      preRoll: [],
      bufferSamples: new Float32Array(0)
    };
    worklet.port.onmessage = (event) => onAudioBlock(event.data);

    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (session) status('stopped', '音轨已结束');
        stop(false);
      });
    }

    status('capturing', '正在监听音轨');
    return { sampleRate: context.sampleRate };
  }

  async function stop(sendStatus) {
    const s = session;
    session = null;
    if (!s) return;
    if (s.chunkSamples > s.sampleRate * 0.4) {
      // Temporarily restore for flush.
      session = s;
      flushSession(false);
      session = null;
    }
    try {
      s.worklet.port.onmessage = null;
      s.worklet.disconnect();
      s.source.disconnect();
      s.mute.disconnect();
      s.playbackSource.disconnect();
      for (const track of s.stream.getTracks()) track.stop();
      await s.context.close();
      await s.playback.close();
    } catch (_) {
      /* already closed */
    }
    if (sendStatus !== false) {
      send({ type: 'dsl:audio-status', tabId: s.tabId, state: 'stopped', message: '已停止' });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'dsl:offscreen-start') {
      start(message.streamId, message.tabId).then(
        (result) => sendResponse({ ok: true, result }),
        (error) =>
          sendResponse({
            ok: false,
            message: error && error.name === 'NotAllowedError' ? '浏览器拒绝了音轨捕获' : (error && error.message) || '音轨捕获失败'
          })
      );
      return true;
    }
    if (message.type === 'dsl:offscreen-stop') {
      stop(true).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false })
      );
      return true;
    }
    if (message.type === 'dsl:offscreen-state') {
      sendResponse({ ok: true, capturing: !!session, tabId: session ? session.tabId : null });
      return false;
    }
    return false;
  });
})();
