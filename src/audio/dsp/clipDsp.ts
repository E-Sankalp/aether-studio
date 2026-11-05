/**
 * Pure, DOM-free clip DSP. Runs inside the clip-processing Web Worker (and as an inline fallback),
 * operating on plain Float32Array channels so nothing blocks the UI thread.
 */
import type { ClipProcessSettings } from '../../types/audio';
import { deEss, psolaAutotune, spectralDenoise } from './vocalDsp';

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

  // 1. Noise Removal (0..100%): spectral noise reduction with a learned noise profile
  if (processes.denoise > 0) {
    const amt = Math.min(1, processes.denoise / 100);
    for (const data of channels) spectralDenoise(data, startSample, endSample, amt);
  }

  // 2. Voice Soften (0..100%): dynamic de-esser (only acts on "s"/"sh" sounds)
  if (processes.voiceSoften > 0) {
    const amt = Math.min(1, processes.voiceSoften / 100);
    for (const data of channels) deEss(data, startSample, endSample, sr, amt);
  }

  // 3. Auto-Pitch Tune (0..100%): PSOLA pitch correction that keeps the voice's formants.
  //    Higher amounts also retune faster (100 % = hard "auto-tune" effect).
  if (processes.autoPitch > 0) {
    const strength = Math.max(0.05, Math.min(1, processes.autoPitch / 100));
    const speed = 0.35 + 0.65 * strength;
    for (const data of channels) {
      const tuned = psolaAutotune(data, startSample, endSample, sr, scaleSemitones, strength, speed);
      data.set(tuned, startSample);
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
