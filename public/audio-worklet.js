class PCM16WorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.outputFrameSamples = 320;
    this.sourceBuffer = [];
    this.resampleCursor = 0;
    this.pendingSamples = [];
  }

  appendInput(inputChannels) {
    if (!inputChannels || inputChannels.length === 0 || !inputChannels[0]) {
      return;
    }

    const frameLength = inputChannels[0].length;
    for (let index = 0; index < frameLength; index += 1) {
      let sample = 0;
      for (let channel = 0; channel < inputChannels.length; channel += 1) {
        sample += inputChannels[channel][index] || 0;
      }
      this.sourceBuffer.push(sample / inputChannels.length);
    }
  }

  resampleAvailableAudio() {
    const ratio = sampleRate / this.targetSampleRate;
    while (this.resampleCursor + ratio <= this.sourceBuffer.length) {
      const sourceIndex = Math.floor(this.resampleCursor);
      const nextIndex = Math.min(sourceIndex + 1, this.sourceBuffer.length - 1);
      const alpha = this.resampleCursor - sourceIndex;
      const sample =
        this.sourceBuffer[sourceIndex] * (1 - alpha) + this.sourceBuffer[nextIndex] * alpha;
      this.pendingSamples.push(sample);
      this.resampleCursor += ratio;
    }

    const consumed = Math.floor(this.resampleCursor);
    if (consumed > 0) {
      this.sourceBuffer = this.sourceBuffer.slice(consumed);
      this.resampleCursor -= consumed;
    }
  }

  flushFrames() {
    while (this.pendingSamples.length >= this.outputFrameSamples) {
      const frame = this.pendingSamples.splice(0, this.outputFrameSamples);
      const pcm = new Int16Array(frame.length);

      for (let index = 0; index < frame.length; index += 1) {
        const clamped = Math.max(-1, Math.min(1, frame[index]));
        pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }

      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
  }

  process(inputs) {
    this.appendInput(inputs[0]);
    this.resampleAvailableAudio();
    this.flushFrames();
    return true;
  }
}

registerProcessor("pcm16-worklet", PCM16WorkletProcessor);
