export const TARGET_SAMPLE_RATE = 16000;

export interface VoiceChunkerOptions {
  sampleRate: number;
  /** RMS volume threshold above which speech is detected (default ~0.015). */
  speechThreshold?: number;
  /** Consecutive silence duration (ms) required to cut a completed speech patch (default 320ms). */
  silenceCutMs?: number;
  /** Minimum speech patch duration (ms) before silence triggers a cut (default 1000ms). */
  minPatchMs?: number;
  /** Maximum patch duration (ms) before forcing a cut even without a long pause (default 18000ms). */
  maxPatchMs?: number;
  /** Pre-roll audio kept before speech begins so first syllables are never clipped (default 250ms). */
  preRollMs?: number;
  onChunk: (wavBlob: Blob, durationMs: number) => void;
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Downsamples mono Float32 PCM audio from `inputRate` to `targetRate` (16kHz)
 * using box averaging to prevent aliasing.
 */
export function downsampleMonoPcm(
  samples: Float32Array,
  inputRate: number,
  targetRate = TARGET_SAMPLE_RATE
): Float32Array {
  if (inputRate <= targetRate || samples.length === 0) {
    return samples;
  }
  const ratio = inputRate / targetRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < outLength) {
    const nextOffsetBuffer = Math.min(
      samples.length,
      Math.round((offsetResult + 1) * ratio)
    );
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += samples[i];
      count++;
    }
    out[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return out;
}

/**
 * Encodes mono Float32 PCM samples (-1..1) into a valid 16-bit PCM RIFF/WAV Blob.
 */
export function encodeMonoWav(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Blob {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Buffers continuous 16kHz PCM audio frames and cuts self-contained WAV patches
 * whenever a ~0.32s silence threshold follows active speech (or when maxPatchMs is reached),
 * with zero audio lost between patches.
 */
export class SilenceAudioChunker {
  private readonly inputSampleRate: number;
  private readonly speechThreshold: number;
  private readonly silenceCutMs: number;
  private readonly minPatchMs: number;
  private readonly maxPatchMs: number;
  private readonly maxPreRollSamples: number;
  private readonly onChunk: (wavBlob: Blob, durationMs: number) => void;

  private frames: Float32Array[] = [];
  private totalSamples = 0;
  private hasSpoken = false;
  private speechSamples = 0;
  private silenceMs = 0;
  private noiseFloor = 0.003;

  constructor(options: VoiceChunkerOptions) {
    this.inputSampleRate = options.sampleRate;
    this.speechThreshold = options.speechThreshold ?? 0.006;
    this.silenceCutMs = options.silenceCutMs ?? 300;
    this.minPatchMs = options.minPatchMs ?? 20000;
    this.maxPatchMs = options.maxPatchMs ?? 45000;
    const preRollMs = options.preRollMs ?? 250;
    this.maxPreRollSamples = Math.round((preRollMs / 1000) * TARGET_SAMPLE_RATE);
    this.onChunk = options.onChunk;
  }

  push(rawInputSamples: Float32Array): void {
    const pcm = downsampleMonoPcm(rawInputSamples, this.inputSampleRate, TARGET_SAMPLE_RATE);
    if (pcm.length === 0) return;

    const frameCopy = new Float32Array(pcm);
    const frameMs = (frameCopy.length / TARGET_SAMPLE_RATE) * 1000;
    const rms = computeRms(frameCopy);

    // Slowly track ambient noise floor when audio is quiet (capped so threshold stays sensitive)
    const dynamicThreshold = Math.max(this.speechThreshold, this.noiseFloor * 2.4);
    const isSpeechFrame = rms >= dynamicThreshold;

    if (!isSpeechFrame) {
      this.noiseFloor = Math.min(0.012, this.noiseFloor * 0.94 + rms * 0.06);
    }

    this.frames.push(frameCopy);
    this.totalSamples += frameCopy.length;

    if (isSpeechFrame) {
      this.hasSpoken = true;
      this.speechSamples += frameCopy.length;
      this.silenceMs = 0;
    } else if (this.hasSpoken) {
      this.silenceMs += frameMs;
    } else {
      // Trim leading silence to keep only a short pre-roll before first speech
      while (this.frames.length > 1 && this.totalSamples - this.frames[0].length >= this.maxPreRollSamples) {
        const removed = this.frames.shift()!;
        this.totalSamples -= removed.length;
      }
      return;
    }

    const patchDurationMs = (this.totalSamples / TARGET_SAMPLE_RATE) * 1000;
    const speechDurationMs = (this.speechSamples / TARGET_SAMPLE_RATE) * 1000;

    // 1. Primary rule: wait until at least minPatchMs (20s), then cut once silence hits >= 0.3s
    //    (any continued speech resets silenceMs to 0, naturally extending to 22-23s+ until a pause)
    if (
      this.hasSpoken &&
      speechDurationMs >= 160 &&
      patchDurationMs >= this.minPatchMs &&
      this.silenceMs >= this.silenceCutMs
    ) {
      this.emitCurrentPatch();
      return;
    }

    // 2. Generous safety ceiling for continuous non-stop speech with zero pauses
    if (
      this.hasSpoken &&
      ((patchDurationMs >= this.maxPatchMs && this.silenceMs >= 100) ||
        patchDurationMs >= this.maxPatchMs + 5000)
    ) {
      this.emitCurrentPatch();
    }
  }

  flush(): void {
    const speechDurationMs = (this.speechSamples / TARGET_SAMPLE_RATE) * 1000;
    if (this.hasSpoken && speechDurationMs >= 120 && this.totalSamples > 0) {
      this.emitCurrentPatch();
    } else {
      this.resetPatch();
    }
  }

  private emitCurrentPatch(): void {
    if (this.totalSamples === 0) {
      this.resetPatch();
      return;
    }
    const merged = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const frame of this.frames) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    const durationMs = (this.totalSamples / TARGET_SAMPLE_RATE) * 1000;
    const wavBlob = encodeMonoWav(merged, TARGET_SAMPLE_RATE);
    this.resetPatch();
    this.onChunk(wavBlob, durationMs);
  }

  private resetPatch(): void {
    this.frames = [];
    this.totalSamples = 0;
    this.hasSpoken = false;
    this.speechSamples = 0;
    this.silenceMs = 0;
  }
}
