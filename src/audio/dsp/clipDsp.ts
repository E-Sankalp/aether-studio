/**
 * Pure, DOM-free clip DSP. Runs inside the clip-processing Web Worker (and as an inline fallback),
 * operating on plain Float32Array channels so nothing blocks the UI thread.
 */
import type { ClipProcessSettings } from '../../types/audio';

export interface ClipRenderRequest {
  channels: Float32Array[];
  sampleRate: number;
  /** Region (in samples) the clip processes apply to */
  startSample: number;
  endSample: number;
  processes: ClipProcessSettings;
  /** Pitch classes (0-11) of the auto-pitch scale */
  scaleSemitones: number[];
  /** Duration-preserving transpose applied to the whole buffer first */
  pitchSemitones: number;
}

export function isDefaultProcesses(p: ClipProcessSettings): boolean {
  return (
    p.autoPitch <= 0 &&
    p.harmony <= 0 &&
    p.voiceSoften <= 0 &&
    p.denoise <= 0 &&
    p.normalize <= 0 &&
    Math.abs(p.boostDb) < 0.05 &&
    p.fadeInShape <= 0 &&
    p.fadeOutShape <= 0 &&
    !p.reverse
  );
}

/* --------------------------------- helpers --------------------------------- */

function detectPitchHz(frame: Float32Array, sampleRate: number): number | null {
  let rms = 0;
  for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
  rms = Math.sqrt(rms / frame.length);
  if (rms < 0.015) return null; // unvoiced or silence

  const minLag = Math.floor(sampleRate / 850); // max ~850 Hz
  const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / 75)); // min ~75 Hz
  let bestLag = -1;
  let bestCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let normA = 0;
    let normB = 0;
    const n = frame.length - lag;
    for (let i = 0; i < n; i += 2) {
      const a = frame[i];
      const b = frame[i + lag];
      sum += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    const corr = denom > 0.00001 ? sum / denom : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return bestLag > 0 && bestCorr > 0.55 ? sampleRate / bestLag : null;
}

function snapMidiToScale(midiFloat: number, semitones: number[]): number {
  const scale = semitones.length > 0 ? semitones : [0, 2, 4, 5, 7, 9, 11];
  const nearestInt = Math.round(midiFloat);
  const octave = Math.floor(nearestInt / 12);
  const pc = ((nearestInt % 12) + 12) % 12;
  let bestPc = scale[0];
  let minDist = 99;
  for (const st of scale) {
    const dist = Math.abs(st - pc);
    if (dist < minDist) {
      minDist = dist;
      bestPc = st;
    }
  }
  return octave * 12 + bestPc;
}

function hann(n: number): Float32Array {
  // Periodic Hann: overlaps at 50 % sum to a constant
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/** In-place 2nd-order Butterworth low-pass. */
function lowpassInPlace(x: Float32Array, cutoff: number, sampleRate: number): void {
  const w0 = (2 * Math.PI * Math.min(cutoff, sampleRate * 0.49)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/* ------------------------ duration-preserving pitch shift ------------------- */

/**
 * WSOLA time-stretch: changes duration by `factor` without changing pitch. Frame alignment is
 * computed once on a mono reference and applied to every channel to keep stereo phase intact.
 */
export function timeStretch(
  channels: Float32Array[],
  factor: number,
  sampleRate: number
): Float32Array[] {
  const n = channels[0].length;
  const N = Math.max(256, Math.round(sampleRate * 0.04) & ~1); // ~40 ms frames
  const Hs = N / 2; // synthesis hop (50 % overlap)
  const Ha = Hs / factor; // analysis hop
  const tol = Math.round(sampleRate * 0.01); // ±10 ms search
  const outLen = Math.max(1, Math.round(n * factor));
  const win = hann(N);

  // Zero-padded mono reference so the correlation loop needs no bounds checks
  const pad = tol + N;
  const ref = new Float32Array(n + 2 * pad);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) ref[pad + i] += ch[i] / channels.length;
  }

  // Normalized cross-correlation between ref[c..] and ref[s..] over the overlap length
  const corr = (c: number, s: number, step: number) => {
    const cc = Math.max(-pad, Math.min(n + pad - Hs, c)) + pad;
    const ss = Math.max(-pad, Math.min(n + pad - Hs, s)) + pad;
    let sum = 0;
    let energy = 1e-9;
    for (let i = 0; i < Hs; i += step) {
      const a = ref[cc + i];
      sum += a * ref[ss + i];
      energy += a * a;
    }
    return sum / Math.sqrt(energy);
  };

  const out = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const frames = Math.ceil(outLen / Hs) + 1;
  let prevPos = 0;

  for (let k = 0; k < frames; k++) {
    const outPos = k * Hs;
    let pos = 0;
    if (k > 0) {
      const nominal = Math.round(k * Ha);
      const natural = prevPos + Hs; // where the previous frame "wants" to continue
      let best = nominal;
      let bestScore = -Infinity;
      // Coarse search, then refine around the best candidate
      for (let d = -tol; d <= tol; d += 6) {
        const score = corr(nominal + d, natural, 6);
        if (score > bestScore) {
          bestScore = score;
          best = nominal + d;
        }
      }
      const coarse = best;
      bestScore = -Infinity;
      for (let d = -5; d <= 5; d++) {
        const score = corr(coarse + d, natural, 2);
        if (score > bestScore) {
          bestScore = score;
          best = coarse + d;
        }
      }
      pos = Math.max(0, best);
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let i = 0; i < N; i++) {
        const s = pos + i;
        if (s < n) dst[outPos + i] += src[s] * win[i];
      }
    }
    for (let i = 0; i < N; i++) norm[outPos + i] += win[i];
    prevPos = pos;
  }

  return out.map((d) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? d[i] / norm[i] : 0;
    return r;
  });
}

/** Cubic (Catmull-Rom) interpolated read. */
function readCubic(x: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const t = pos - i;
  const n = x.length;
  const p0 = x[Math.max(0, Math.min(n - 1, i - 1))];
  const p1 = x[Math.max(0, Math.min(n - 1, i))];
  const p2 = x[Math.max(0, Math.min(n - 1, i + 1))];
  const p3 = x[Math.max(0, Math.min(n - 1, i + 2))];
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

/**
 * Transposes by `semitones` while keeping the exact original length (stretch by r, then
 * resample by r). Formants move with the pitch, so keep large shifts for creative use.
 */
export function pitchShift(
  channels: Float32Array[],
  semitones: number,
  sampleRate: number
): Float32Array[] {
  if (Math.abs(semitones) < 0.01 || channels.length === 0) return channels;
  const n = channels[0].length;
  const r = Math.pow(2, semitones / 12);
  const stretched = timeStretch(channels, r, sampleRate);
  return stretched.map((s) => {
    if (r > 1) {
      // Reading faster folds content above Nyquist / r: band-limit first (4th order)
      const cutoff = (0.45 * sampleRate) / r;
      lowpassInPlace(s, cutoff, sampleRate);
      lowpassInPlace(s, cutoff, sampleRate);
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = readCubic(s, i * r);
    return out;
  });
}

/* ------------------------------ clip processing ----------------------------- */

/** Renders pitch + all clip processes. Returns the processed channels (same length as input). */
export function renderClipChannels(req: ClipRenderRequest): Float32Array[] {
  const { sampleRate: sr, processes, scaleSemitones } = req;
  const channels = pitchShift(
    req.channels.map((c) => new Float32Array(c)),
    req.pitchSemitones,
    sr
  );
  const length = channels[0]?.length ?? 0;
  const startSample = Math.max(0, Math.min(length, req.startSample));
  const endSample = Math.max(startSample, Math.min(length, req.endSample));
  const count = endSample - startSample;
  if (count <= 1 || isDefaultProcesses(processes)) return channels;

  // 1. Noise Removal (0..100%)
  if (processes.denoise > 0) {
    const amt = Math.min(1, processes.denoise / 100);
    const threshold = 0.015 + amt * 0.065;
    for (const data of channels) {
      const copy = data.slice(startSample, endSample);
      let env = 0;
      for (let i = 0; i < count; i++) {
        const abs = Math.abs(copy[i]);
        env = env * 0.985 + abs * 0.015;
        const gateGain = env < threshold ? Math.pow(env / threshold, 1.5 + amt * 2.2) : 1.0;
        const prev = i > 0 ? copy[i - 1] : copy[i];
        const next = i < count - 1 ? copy[i + 1] : copy[i];
        const smoothed = copy[i] * (1 - amt * 0.45) + (prev + next) * (amt * 0.225);
        data[startSample + i] = copy[i] * (1 - amt) + smoothed * gateGain * amt;
      }
    }
  }

  // 2. Voice Soften (0..100%)
  if (processes.voiceSoften > 0) {
    const amt = Math.min(1, processes.voiceSoften / 100);
    for (const data of channels) {
      const copy = data.slice(startSample, endSample);
      let lpState = 0;
      for (let i = 0; i < count; i++) {
        const x = copy[i];
        lpState = lpState * (0.65 + amt * 0.2) + x * (0.35 - amt * 0.2);
        const highTransient = x - lpState;
        const softenedHigh = Math.tanh(highTransient * 1.5) * (0.5 - amt * 0.28);
        const wet = Math.tanh((lpState * (1 + amt * 0.2) + softenedHigh) * 1.04);
        data[startSample + i] = x * (1 - amt) + wet * amt;
      }
    }
  }

  // 3. Auto-Pitch Tune (0..100%)
  if (processes.autoPitch > 0) {
    const frameSize = Math.floor(sr * 0.04);
    const hopSize = Math.floor(frameSize / 2);
    const strength = Math.max(0.05, Math.min(1, processes.autoPitch / 100));
    const ch0 = channels[0].slice(startSample, endSample);
    const numHops = Math.max(1, Math.floor((count - frameSize) / hopSize));
    const ratios = new Float32Array(numHops);
    let prevRatio = 1.0;

    for (let h = 0; h < numHops; h++) {
      const offset = h * hopSize;
      const f0 = detectPitchHz(ch0.subarray(offset, offset + frameSize), sr);
      if (f0) {
        const midiFloat = 69 + 12 * Math.log2(f0 / 440);
        const targetMidi = snapMidiToScale(midiFloat, scaleSemitones);
        const targetFreq = 440 * Math.pow(2, (targetMidi - 69) / 12);
        const rawRatio = Math.max(0.75, Math.min(1.35, targetFreq / f0));
        const blended = 1.0 + (rawRatio - 1.0) * strength;
        prevRatio = prevRatio * 0.25 + blended * 0.75;
        ratios[h] = prevRatio;
      } else {
        ratios[h] = 1.0;
      }
    }

    for (const data of channels) {
      const orig = data.slice(startSample, endSample);
      const out = new Float32Array(count);
      const weight = new Float32Array(count);
      for (let h = 0; h < numHops; h++) {
        const offset = h * hopSize;
        const ratio = ratios[h];
        for (let i = 0; i < frameSize && offset + i < count; i++) {
          const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
          const srcPos = offset + i * ratio;
          const idx0 = Math.min(count - 1, Math.floor(srcPos));
          const idx1 = Math.min(count - 1, idx0 + 1);
          const frac = srcPos - idx0;
          out[offset + i] += (orig[idx0] * (1 - frac) + orig[idx1] * frac) * win;
          weight[offset + i] += win;
        }
      }
      for (let i = 0; i < count; i++) {
        data[startSample + i] = weight[i] > 0.01 ? out[i] / weight[i] : orig[i];
      }
    }
  }

  // 4. 3-Part Vocal Harmony (0..100%)
  if (processes.harmony > 0) {
    const amt = Math.min(1, processes.harmony / 100);
    const grain = Math.floor(sr * 0.045);
    const ratioThird = Math.pow(2, 4 / 12);
    const ratioFifth = Math.pow(2, 7 / 12);
    channels.forEach((data, ch) => {
      const orig = data.slice(startSample, endSample);
      const ratio = ch === 0 ? ratioThird : ratioFifth;
      for (let i = 0; i < count; i++) {
        const grainIdx = Math.floor(i / grain) * grain;
        const posInGrain = i - grainIdx;
        const win = Math.sin((Math.PI * posInGrain) / grain);
        const shiftPos = Math.min(count - 1, Math.floor(grainIdx + posInGrain * ratio));
        const harmonySample = orig[shiftPos] * win * (0.65 * amt);
        data[startSample + i] = Math.tanh(orig[i] * (1 - amt * 0.18) + harmonySample);
      }
    });
  }

  // 5. Peak Normalize (0..100%)
  if (processes.normalize > 0) {
    const amt = Math.min(1, processes.normalize / 100);
    let maxAbs = 0.0001;
    for (const data of channels) {
      for (let i = startSample; i < endSample; i++) maxAbs = Math.max(maxAbs, Math.abs(data[i]));
    }
    const scale = 1 + (0.96 / maxAbs - 1) * amt;
    for (const data of channels) {
      for (let i = startSample; i < endSample; i++) {
        data[i] = Math.max(-1, Math.min(1, data[i] * scale));
      }
    }
  }

  // 6. Gain Boost / Cut (-12..+12 dB)
  if (Math.abs(processes.boostDb) >= 0.05) {
    const mult = Math.pow(10, processes.boostDb / 20);
    for (const data of channels) {
      for (let i = startSample; i < endSample; i++) data[i] = Math.tanh(data[i] * mult);
    }
  }

  // 7. Envelope Fade-In & Fade-Out
  if (processes.fadeInShape > 0) {
    const fadeSamples = Math.max(1, Math.floor(count * Math.min(1, processes.fadeInShape / 100)));
    for (const data of channels) {
      for (let i = 0; i < fadeSamples; i++) {
        const ratio = i / fadeSamples;
        data[startSample + i] *= ratio * ratio;
      }
    }
  }
  if (processes.fadeOutShape > 0) {
    const fadeSamples = Math.max(1, Math.floor(count * Math.min(1, processes.fadeOutShape / 100)));
    for (const data of channels) {
      for (let i = 0; i < fadeSamples; i++) {
        const ratio = 1 - i / fadeSamples;
        data[endSample - fadeSamples + i] *= ratio * ratio;
      }
    }
  }

  // 8. Reverse
  if (processes.reverse) {
    for (const data of channels) {
      const slice = data.slice(startSample, endSample);
      slice.reverse();
      data.set(slice, startSample);
    }
  }

  return channels;
}
