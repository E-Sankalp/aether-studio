/**
 * Vocal DSP used by clip processes (runs in the clip worker):
 *  - spectralDenoise: STFT noise reduction with a learned noise profile
 *  - deEss: dynamic split-band de-esser (only acts while sibilance is present)
 *  - psolaAutotune: TD-PSOLA pitch correction that keeps the voice's formants
 * All functions are pure and operate in place on a region [start, end) of each channel.
 */

/* ---------------------------------- FFT ------------------------------------ */

/** In-place iterative radix-2 complex FFT (inverse when `inverse`, unscaled). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/* --------------------------- spectral noise reduction ------------------------ */

/**
 * Learns the noise spectrum from the quietest 10 % of frames, then applies a smoothed
 * Wiener-style gain per frequency bin. `amount` 0..1 sets over-subtraction and the maximum
 * reduction (6 dB .. 30 dB). Speech/singing (well above the noise) passes almost untouched.
 */
export function spectralDenoise(
  x: Float32Array,
  start: number,
  end: number,
  amount: number
): void {
  const N = 2048;
  const H = N / 4; // 75 % overlap
  const count = end - start;
  if (count < N || amount <= 0) return;
  const amt = Math.min(1, amount);
  const bins = N / 2 + 1;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));

  const frames = Math.floor((count - N) / H) + 1;
  const mags: Float32Array[] = [];
  const phases: Float32Array[] = [];
  const energy = new Float64Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let f = 0; f < frames; f++) {
    const off = start + f * H;
    for (let i = 0; i < N; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const m = new Float32Array(bins);
    const p = new Float32Array(bins);
    let e = 0;
    for (let k = 0; k < bins; k++) {
      m[k] = Math.hypot(re[k], im[k]);
      p[k] = Math.atan2(im[k], re[k]);
      e += m[k] * m[k];
    }
    mags.push(m);
    phases.push(p);
    energy[f] = e;
  }

  // Noise profile: mean spectrum of the quietest 10 % of frames (at least 4)
  const order = Array.from(energy.keys()).sort((a, b) => energy[a] - energy[b]);
  const quiet = order.slice(0, Math.max(4, Math.floor(frames * 0.1)));
  const noise = new Float64Array(bins);
  for (const f of quiet) for (let k = 0; k < bins; k++) noise[k] += mags[f][k] / quiet.length;

  const alpha = 1.5 + amt * 2; // over-subtraction
  const floor = Math.pow(10, -(6 + amt * 24) / 20); // max reduction
  const prevG = new Float64Array(bins).fill(1);
  const out = new Float64Array(count + N);
  const norm = new Float64Array(count + N);

  for (let f = 0; f < frames; f++) {
    const m = mags[f];
    const g = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      const snr = (m[k] * m[k]) / ((alpha * noise[k]) ** 2 + 1e-20);
      g[k] = Math.max(floor, Math.min(1, (snr - 1) / snr));
    }
    // Smooth across frequency (3 bins) and time (fast attack, slower release) against
    // "musical noise" artefacts
    for (let k = 0; k < bins; k++) {
      const gs = (g[Math.max(0, k - 1)] + g[k] + g[Math.min(bins - 1, k + 1)]) / 3;
      const coef = gs > prevG[k] ? 0.6 : 0.25;
      prevG[k] = prevG[k] + coef * (gs - prevG[k]);
    }
    const p = phases[f];
    for (let k = 0; k < bins; k++) {
      const a = m[k] * prevG[k];
      re[k] = a * Math.cos(p[k]);
      im[k] = a * Math.sin(p[k]);
      if (k > 0 && k < N / 2) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    fft(re, im, true);
    const off = f * H;
    for (let i = 0; i < N; i++) {
      out[off + i] += (re[i] / N) * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }

  // Overlap-add normalisation; untouched tail samples (shorter than one hop) pass through
  for (let i = 0; i < count; i++) {
    if (norm[i] > 1e-3) x[start + i] = out[i] / norm[i];
  }
}

/* ------------------------------ dynamic de-esser ---------------------------- */

/** 2nd-order Butterworth section (Direct Form I) with its own state. */
function butter(type: 'lp' | 'hp', f0: number, sr: number) {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (type === 'lp' ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b1 = (type === 'lp' ? 1 - cos : -(1 + cos)) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  return (x: number) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/**
 * Split-band de-esser. A Linkwitz-Riley (4th-order) crossover at ~5.5 kHz splits the signal
 * into bands that sum back flat; only the high band is turned down, and only while it is loud
 * and dominates the signal (an "s"/"sh"). amount 0 = exact pass-through.
 */
export function deEss(
  x: Float32Array,
  start: number,
  end: number,
  sampleRate: number,
  amount: number
): void {
  if (amount <= 0) return;
  const amt = Math.min(1, amount);
  const fc = 5500;
  const lp1 = butter('lp', fc, sampleRate);
  const lp2 = butter('lp', fc, sampleRate);
  const hp1 = butter('hp', fc, sampleRate);
  const hp2 = butter('hp', fc, sampleRate);

  const thr = Math.pow(10, (-20 - amt * 20) / 20); // -20 .. -40 dBFS on the sibilance band
  const ratio = 2 + amt * 8;
  const maxCut = Math.pow(10, -(6 + amt * 12) / 20); // up to -18 dB
  const att = Math.exp(-1 / (0.0008 * sampleRate));
  const rel = Math.exp(-1 / (0.06 * sampleRate));
  let envS = 0,
    envX = 0,
    gSmooth = 1;
  for (let i = start; i < end; i++) {
    const xi = x[i];
    const lo = lp2(lp1(xi));
    const hi = hp2(hp1(xi));
    const as = Math.abs(hi);
    const ax = Math.abs(xi);
    envS = as > envS ? att * envS + (1 - att) * as : rel * envS + (1 - rel) * as;
    envX = ax > envX ? att * envX + (1 - att) * ax : rel * envX + (1 - rel) * ax;
    let g = 1;
    if (envS > thr && envS > 0.35 * envX) {
      g = Math.max(maxCut, Math.pow(thr / envS, 1 - 1 / ratio));
    }
    // instant attack, ~10 ms recovery
    gSmooth = g < gSmooth ? g : gSmooth + 0.002 * (g - gSmooth);
    // LR4 bands sum flat (verified: 0.00 dB from 100 Hz to 15 kHz at gain 1)
    x[i] = lo + hi * gSmooth;
  }
}

/* --------------------------- PSOLA pitch correction -------------------------- */

function detectPeriod(x: Float32Array, at: number, sr: number, frame: number): number | null {
  const s = Math.max(0, at - (frame >> 1));
  const e = Math.min(x.length, s + frame);
  const n = e - s;
  if (n < frame * 0.75) return null;
  let rms = 0;
  for (let i = s; i < e; i++) rms += x[i] * x[i];
  if (Math.sqrt(rms / n) < 0.012) return null; // silence / breath
  const minLag = Math.floor(sr / 900);
  const maxLag = Math.min(n - 2, Math.floor(sr / 70));
  let best = -1;
  let bestC = 0;
  // Normalized autocorrelation; take the FIRST strong peak to avoid octave errors
  const corrs = new Float64Array(maxLag + 1);
  let maxC = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0,
      na = 0,
      nb = 0;
    for (let i = s; i + lag < e; i += 2) {
      const a = x[i];
      const b = x[i + lag];
      sum += a * b;
      na += a * a;
      nb += b * b;
    }
    const c = sum / (Math.sqrt(na * nb) + 1e-12);
    corrs[lag] = c;
    if (c > maxC) maxC = c;
  }
  if (maxC < 0.6) return null; // unvoiced
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const c = corrs[lag];
    if (c >= 0.9 * maxC && c >= corrs[lag - 1] && c >= corrs[lag + 1]) {
      best = lag;
      bestC = c;
      break;
    }
  }
  if (best < 0) return null;
  // Parabolic interpolation for sub-sample period
  const yA = corrs[best - 1];
  const yB = bestC;
  const yC = corrs[best + 1];
  const denom = yA - 2 * yB + yC;
  const shift = Math.abs(denom) > 1e-9 ? (0.5 * (yA - yC)) / denom : 0;
  return best + Math.max(-0.5, Math.min(0.5, shift));
}

function snapToScale(midi: number, scale: number[]): number {
  const pcs = scale.length > 0 ? scale : [0, 2, 4, 5, 7, 9, 11];
  let best = midi;
  let bestDist = Infinity;
  const base = Math.floor(midi / 12) * 12;
  for (const oct of [-12, 0, 12]) {
    for (const pc of pcs) {
      const cand = base + oct + pc;
      const d = Math.abs(cand - midi);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
      }
    }
  }
  return best;
}

/* ------------------------------ PSOLA building blocks ------------------------ */

export interface PitchTrack {
  /** Analysis hop in samples */
  hop: number;
  /** Period (samples) per hop, 0 = unvoiced */
  period: Float64Array;
}

/** Pitch track of x[start, end): 5 ms hops, 40 ms frames, median-of-3 smoothed. */
export function trackPitch(x: Float32Array, start: number, end: number, sr: number): PitchTrack {
  const count = end - start;
  const hop = Math.floor(sr * 0.005);
  const frame = Math.floor(sr * 0.04);
  const hops = Math.ceil(count / hop) + 1;
  const raw = new Float64Array(hops);
  for (let h = 0; h < hops; h++) raw[h] = detectPeriod(x, start + h * hop, sr, frame) ?? 0;
  const period = new Float64Array(hops);
  for (let h = 0; h < hops; h++) {
    if (raw[h] === 0) continue; // unvoiced stays 0
    const voicedNeighbours = [raw[Math.max(0, h - 1)], raw[h], raw[Math.min(hops - 1, h + 1)]]
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    period[h] = voicedNeighbours[Math.floor(voicedNeighbours.length / 2)];
  }
  return { hop, period };
}

/**
 * TD-PSOLA resynthesis of x[start, end) with a pitch ratio per hop (1 = unchanged). Grains are
 * pitch-synchronous, so formants stay put. `edges`: crossfade the region edges into the original
 * signal (in-place correction) or fade from/to silence (a new voice that is mixed in).
 */
export function psolaResynth(
  x: Float32Array,
  start: number,
  end: number,
  sr: number,
  track: PitchTrack,
  ratio: Float64Array,
  edges: 'original' | 'silence' = 'original'
): Float32Array {
  const count = end - start;
  const out = new Float32Array(count);
  const { hop, period } = track;
  const hops = period.length;

  // Analysis marks: pitch-synchronous in voiced parts (aligned to waveform peaks),
  // fixed spacing in unvoiced parts
  const marks: number[] = [];
  const markPeriod: number[] = [];
  let t = 0;
  while (t < count) {
    const P = period[Math.min(hops - 1, Math.floor(t / hop))];
    if (P > 0) {
      const lo = Math.max(0, Math.floor(t - P * 0.2));
      const hi = Math.min(count - 1, Math.ceil(t + P * 0.2));
      let best = Math.round(t);
      let bestV = -Infinity;
      for (let i = lo; i <= hi; i++) {
        const v = Math.abs(x[start + i]);
        if (v > bestV) {
          bestV = v;
          best = i;
        }
      }
      if (marks.length === 0 || best > marks[marks.length - 1] + P * 0.5) {
        marks.push(best);
        markPeriod.push(P);
      }
      t = Math.max(best, t) + P;
    } else {
      marks.push(Math.round(t));
      markPeriod.push(hop);
      t += hop;
    }
  }
  if (marks.length < 2) {
    if (edges === 'original') out.set(x.subarray(start, end));
    return out;
  }

  // Synthesis: walk output time with the new period, OLA the nearest analysis grain
  const weight = new Float32Array(count);
  let ts = marks[0];
  let mi = 0;
  while (ts < count) {
    while (mi < marks.length - 1 && Math.abs(marks[mi + 1] - ts) < Math.abs(marks[mi] - ts)) mi++;
    const Pa = markPeriod[mi];
    const voiced = Pa !== hop;
    const rr = voiced ? ratio[Math.min(hops - 1, Math.floor(ts / hop))] : 1;
    const half = Math.max(8, Math.round(voiced ? Pa : hop * 2));
    const c = marks[mi];
    for (let j = -half; j < half; j++) {
      const src = c + j;
      const dst = Math.round(ts) + j;
      if (src < 0 || src >= count || dst < 0 || dst >= count) continue;
      const w = 0.5 * (1 + Math.cos((Math.PI * j) / half));
      out[dst] += x[start + src] * w;
      weight[dst] += w;
    }
    ts += voiced ? Pa / rr : hop;
  }
  for (let i = 0; i < count; i++) {
    out[i] = weight[i] > 0.05 ? out[i] / weight[i] : edges === 'original' ? x[start + i] : 0;
  }
  // 5 ms edge fades (no clicks)
  const xf = Math.min(Math.floor(sr * 0.005), Math.floor(count / 4));
  for (let i = 0; i < xf; i++) {
    const g = i / xf;
    const a0 = edges === 'original' ? x[start + i] : 0;
    const a1 = edges === 'original' ? x[end - 1 - i] : 0;
    out[i] = out[i] * g + a0 * (1 - g);
    out[count - 1 - i] = out[count - 1 - i] * g + a1 * (1 - g);
  }
  return out;
}

const midiOf = (periodSamples: number, sr: number) => 69 + 12 * Math.log2(sr / periodSamples / 440);

/**
 * Pitch correction with TD-PSOLA. Each voiced pitch period is cut out with a 2-period window
 * and overlap-added at the corrected period spacing, so the pitch moves while the spectral
 * envelope (formants: the "character" of the voice) stays where it was.
 *
 * `strength` 0..1 blends from natural to fully snapped; `speed` 0..1 is the retune speed
 * (1 = instant "hard-tune", lower = smoother, more natural glides).
 * Returns the processed region (length end - start); the input is not modified.
 */
export function psolaAutotune(
  x: Float32Array,
  start: number,
  end: number,
  sr: number,
  scale: number[],
  strength: number,
  speed = 0.75
): Float32Array {
  const count = end - start;
  if (count < sr * 0.05) return new Float32Array(count);
  const track = trackPitch(x, start, end, sr);
  const { period } = track;
  const ratio = new Float64Array(period.length).fill(1);
  const k = 0.02 + 0.6 * Math.max(0, Math.min(1, speed));
  let r = 1;
  for (let h = 0; h < period.length; h++) {
    if (period[h] > 0) {
      const midi = midiOf(period[h], sr);
      const semis = (snapToScale(midi, scale) - midi) * Math.max(0, Math.min(1, strength));
      r = r + k * (Math.pow(2, semis / 12) - r);
    } else {
      r = r + 0.3 * (1 - r);
    }
    ratio[h] = r;
  }
  return psolaResynth(x, start, end, sr, track, ratio, 'original');
}

/* -------------------------------- harmonies --------------------------------- */

/** Note `steps` scale degrees above (or below) `note` (an in-scale MIDI note). */
export function diatonicShift(note: number, steps: number, scale: number[]): number {
  const pcs = [...new Set((scale.length ? scale : [0, 2, 4, 5, 7, 9, 11]).map((p) => ((p % 12) + 12) % 12))].sort(
    (a, b) => a - b
  );
  if (pcs.length >= 12) {
    // Chromatic "scale": use the common major-key intervals instead of semitone steps
    const semis: Record<number, number> = { 2: 4, 4: 7, 7: 12, [-2]: -3, [-3]: -5, [-4]: -7, [-7]: -12 };
    return note + (semis[steps] ?? steps);
  }
  const n = pcs.length;
  const oct = Math.floor(note / 12);
  const pc = ((note % 12) + 12) % 12;
  let idx = pcs.indexOf(pc);
  if (idx < 0) idx = pcs.reduce((b, p, i) => (Math.abs(p - pc) < Math.abs(pcs[b] - pc) ? i : b), 0);
  const k = idx + steps;
  const octShift = Math.floor(k / n);
  return (oct + octShift) * 12 + pcs[((k % n) + n) % n];
}

/**
 * A harmony voice `steps` scale degrees from the sung note (2 = a third, 4 = a fifth,
 * -2 = a third below, 7 = an octave in a 7-note scale). The interval follows the key, so a third
 * is major or minor depending on where the melody is, like a real backing singer. The voice
 * keeps the lead's natural intonation and vibrato; only the interval is added.
 */
export function harmonyVoice(
  x: Float32Array,
  start: number,
  end: number,
  sr: number,
  scale: number[],
  steps: number,
  track: PitchTrack = trackPitch(x, start, end, sr)
): Float32Array {
  const { period } = track;
  const ratio = new Float64Array(period.length).fill(1);
  let r = 1;
  for (let h = 0; h < period.length; h++) {
    if (period[h] > 0) {
      const midi = midiOf(period[h], sr);
      const base = snapToScale(midi, scale);
      const target = diatonicShift(base, steps, scale);
      r = r + 0.35 * (Math.pow(2, (target - base) / 12) - r); // short glide between notes
    }
    ratio[h] = r;
  }
  return psolaResynth(x, start, end, sr, track, ratio, 'silence');
}

/**
 * A natural "double-tracked" copy: a slow random pitch drift of a few cents and a 18-26 ms
 * timing offset, like a singer recording the same line twice.
 */
export function doubleVoice(
  x: Float32Array,
  start: number,
  end: number,
  sr: number,
  seed: number,
  track: PitchTrack = trackPitch(x, start, end, sr)
): Float32Array {
  const { hop, period } = track;
  const ratio = new Float64Array(period.length);
  const phase = seed * 1.7;
  const rate = 0.25 + 0.1 * seed;
  for (let h = 0; h < period.length; h++) {
    const t = (h * hop) / sr;
    const cents = 7 * Math.sin(2 * Math.PI * rate * t + phase) + 3 * Math.sin(2 * Math.PI * rate * 2.3 * t + phase * 2);
    ratio[h] = Math.pow(2, cents / 1200);
  }
  const voice = psolaResynth(x, start, end, sr, track, ratio, 'silence');
  const delay = Math.round(sr * (0.018 + 0.008 * (seed % 2)));
  const out = new Float32Array(voice.length);
  out.set(voice.subarray(0, Math.max(0, voice.length - delay)), delay);
  return out;
}
