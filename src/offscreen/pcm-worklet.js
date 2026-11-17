/**
 * AudioWorklet PCM collector.
 *
 * Runs on the audio rendering thread, downmixes to mono, accumulates ~128 ms blocks
 * and transfers them to the offscreen document for VAD and WAV encoding.
 */
class DSProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0]) return true;

    const frames = channels[0].length;
    const channelCount = channels.length;
    for (let i = 0; i < frames; i += 1) {
      let sample = 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        sample += channels[channel][i] || 0;
      }
      this.buffer[this.offset] = sample / channelCount;
      this.offset += 1;
      if (this.offset >= this.buffer.length) {
        const block = this.buffer.slice(0, this.offset);
        this.offset = 0;
        this.port.postMessage(block, [block.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('ds-pcm-processor', DSProcessor);
