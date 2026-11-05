/** Test signal helpers (deterministic). */
import { fft } from '../audio/dsp/vocalDsp';

export const SR = 44100;

/** Deterministic noise in [-1, 1]. */
export function noise(seed = 12345): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

export const db = (power: number) => 10 * Math.log10(power + 1e-30);

/** Mean power of x[a, b). */
export function power(x: Float32Array, a = 0, b = x.length): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return s / Math.max(1, b - a);
}

/** Magnitude spectrum of a Hann-windowed block of `n` (power of two) centred in x. */
export function spectrum(x: Float32Array, n = 16384, center = x.length / 2): number[] {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const off = Math.max(0, Math.floor(center - n / 2));
  for (let i = 0; i < n; i++) re[i] = (x[off + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  return Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
}

/** Frequency of the strongest bin within [lo, hi] Hz. */
export function peakHz(mag: number[], lo: number, hi: number, n = 16384, sr = SR): number {
  let best = 0;
  let bestV = -1;
  for (let k = Math.floor((lo * n) / sr); k <= Math.ceil((hi * n) / sr); k++) {
    if (mag[k] > bestV) {
      bestV = mag[k];
      best = k;
    }
  }
  return (best * sr) / n;
}

/** Harmonic tone with an optional formant (Gaussian spectral envelope peak). */
export function harmonicTone(
  f0: number,
  seconds: number,
  formantHz?: number,
  sr = SR
): Float32Array {
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  for (let h = 1; h * f0 < Math.min(5000, sr / 2); h++) {
    const f = h * f0;
    const amp = formantHz
      ? Math.exp(-(((f - formantHz) / 160) ** 2)) * 0.3 + 0.02 / h
      : 0.25 / h;
    for (let i = 0; i < n; i++) x[i] += Math.sin((2 * Math.PI * f * i) / sr) * amp;
  }
  return x;
}
