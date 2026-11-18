/**
 * Parametric EQ model shared by the audio engine and the EQ display.
 *
 * Six fixed bands: low cut, low shelf, two bells, high shelf, high cut. Projects saved before the
 * parametric EQ only have the old 3-band fields (eqLowGain / eqMid* / eqHighGain); `resolveEq`
 * turns those into the same six bands, so old projects sound exactly as before.
 *
 * `bandResponseDb` uses the exact biquad formulas of the Web Audio spec (RBJ cookbook; shelves
 * with slope S = 1; lowpass/highpass Q in dB), so the drawn curve is what BiquadFilterNode does.
 */
import type { EqBand, EqBandType, TrackEffects } from '../types/audio';

export const EQ_BAND_COUNT = 6;
export const EQ_MIN_FREQ = 20;
export const EQ_MAX_FREQ = 20000;
export const EQ_MAX_GAIN = 18;

export const EQ_BAND_NAMES = ['Low cut', 'Low shelf', 'Low mid', 'Mid', 'High shelf', 'High cut'];
export const EQ_BAND_SHORT = ['LC', 'LS', 'LM', 'M', 'HS', 'HC'];
export const EQ_BAND_COLORS = ['#a78bfa', '#f59e0b', '#22c55e', '#38bdf8', '#f472b6', '#e5e7eb'];

/** Bands with a gain control (cuts only have frequency and resonance). */
export const hasGain = (type: EqBandType) => type !== 'highpass' && type !== 'lowpass';
/** Bands with a Q control (Web Audio shelves have a fixed slope). */
export const hasQ = (type: EqBandType) => type !== 'lowshelf' && type !== 'highshelf';

export const clampFreq = (f: number) => Math.min(EQ_MAX_FREQ, Math.max(EQ_MIN_FREQ, f));
export const clampGain = (g: number) => Math.min(EQ_MAX_GAIN, Math.max(-EQ_MAX_GAIN, g));
export const clampQ = (q: number) => Math.min(10, Math.max(0.3, q));

/** The six bands of a track: its parametric EQ, or the legacy 3-band settings mapped onto it. */
export function resolveEq(fx: TrackEffects): EqBand[] {
  if (fx.eq && fx.eq.length === EQ_BAND_COUNT) return fx.eq;
  return [
    { type: 'highpass', freq: 30, gain: 0, q: 0.71, on: false },
    { type: 'lowshelf', freq: 110, gain: fx.eqLowGain ?? 0, q: 0.71, on: true },
    { type: 'peaking', freq: 300, gain: 0, q: 1, on: true },
    { type: 'peaking', freq: fx.eqMidFreq ?? 1200, gain: fx.eqMidGain ?? 0, q: fx.eqMidQ ?? 1.2, on: true },
    { type: 'highshelf', freq: 7500, gain: fx.eqHighGain ?? 0, q: 0.71, on: true },
    { type: 'lowpass', freq: 18000, gain: 0, q: 0.71, on: false },
  ];
}

/** Whether a band changes the sound at all (off or 0 dB bands are exact pass-throughs). */
export const bandActive = (b: EqBand) => b.on && (!hasGain(b.type) || Math.abs(b.gain) > 0.01);

/** Q value to give a BiquadFilterNode (the spec reads lowpass/highpass Q in dB). */
export const nodeQ = (b: EqBand) => (hasGain(b.type) ? b.q : 20 * Math.log10(b.q));

interface Coeffs {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

function coefficients(b: EqBand, sampleRate: number): Coeffs {
  const f = Math.min(b.freq, sampleRate / 2 - 1);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = Math.pow(10, b.gain / 40);
  switch (b.type) {
    case 'lowpass':
    case 'highpass': {
      const alpha = sin / (2 * b.q);
      const lp = b.type === 'lowpass';
      const b0 = lp ? (1 - cos) / 2 : (1 + cos) / 2;
      return { b0, b1: lp ? 1 - cos : -(1 + cos), b2: b0, a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha };
    }
    case 'peaking': {
      const alpha = sin / (2 * b.q);
      return {
        b0: 1 + alpha * A,
        b1: -2 * cos,
        b2: 1 - alpha * A,
        a0: 1 + alpha / A,
        a1: -2 * cos,
        a2: 1 - alpha / A,
      };
    }
    case 'lowshelf':
    case 'highshelf': {
      const alpha = (sin / 2) * Math.SQRT2; // slope S = 1
      const k = 2 * Math.sqrt(A) * alpha;
      if (b.type === 'lowshelf') {
        return {
          b0: A * (A + 1 - (A - 1) * cos + k),
          b1: 2 * A * (A - 1 - (A + 1) * cos),
          b2: A * (A + 1 - (A - 1) * cos - k),
          a0: A + 1 + (A - 1) * cos + k,
          a1: -2 * (A - 1 + (A + 1) * cos),
          a2: A + 1 + (A - 1) * cos - k,
        };
      }
      return {
        b0: A * (A + 1 + (A - 1) * cos + k),
        b1: -2 * A * (A - 1 + (A + 1) * cos),
        b2: A * (A + 1 + (A - 1) * cos - k),
        a0: A + 1 - (A - 1) * cos + k,
        a1: 2 * (A - 1 - (A + 1) * cos),
        a2: A + 1 - (A - 1) * cos - k,
      };
    }
  }
}

/** Magnitude response of one band at `freq`, in dB (0 for a band that is switched off). */
export function bandResponseDb(b: EqBand, freq: number, sampleRate = 48000): number {
  if (!b.on) return 0;
  const c = coefficients(b, sampleRate);
  const w = (2 * Math.PI * Math.min(freq, sampleRate / 2)) / sampleRate;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2;
  const ni = -(c.b1 * sw + c.b2 * s2);
  const dr = c.a0 + c.a1 * cw + c.a2 * c2;
  const di = -(c.a1 * sw + c.a2 * s2);
  const mag2 = (nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di);
  return 10 * Math.log10(Math.max(1e-30, mag2));
}

/** Summed response of all bands at `freq`, in dB. */
export const eqResponseDb = (bands: EqBand[], freq: number, sampleRate = 48000) =>
  bands.reduce((sum, b) => sum + bandResponseDb(b, freq, sampleRate), 0);

export const formatFreq = (f: number) =>
  f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kHz` : `${Math.round(f)} Hz`;

/** "2.5k", "2500", "2.5 kHz", "80hz" -> Hz (null if not a frequency). */
export function parseFreq(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(k)?/i.exec(text.trim());
  if (!m) return null;
  const f = parseFloat(m[1]) * (m[2] ? 1000 : 1);
  return f > 0 ? clampFreq(f) : null;
}
