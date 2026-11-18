import { describe, expect, it } from 'vitest';
import { deEss, diatonicShift, doubleVoice, fft, harmonyVoice, psolaAutotune, spectralDenoise } from './vocalDsp';
import { renderClipChannels } from './clipDsp';
import { DEFAULT_CLIP_PROCESSES } from '../../types/audio';
import { db, harmonicTone, noise, peakHz, power, spectrum, SR, voiceTone } from '../../test/signals';

describe('fft', () => {
  it('round-trips (forward + inverse / N)', () => {
    const rnd = noise(1);
    const n = 1024;
    const re = new Float64Array(n).map(() => rnd());
    const orig = re.slice();
    const im = new Float64Array(n);
    fft(re, im);
    fft(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i] / n).toBeCloseTo(orig[i], 9);
  });
});

describe('spectralDenoise', () => {
  it('removes steady hiss in gaps and keeps the voice', () => {
    const rnd = noise(2);
    const n = SR * 4;
    const clean = new Float32Array(n);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      if (t % 1 < 0.6) for (let h = 1; h <= 8; h++) v += (Math.sin(2 * Math.PI * 220 * h * t) * 0.25) / h;
      clean[i] = v;
      x[i] = v + rnd() * 0.02;
    }
    const before = x.slice();
    spectralDenoise(x, 0, n, 0.8);
    const gap: [number, number] = [Math.floor(SR * 1.7), Math.floor(SR * 1.95)];
    const voice: [number, number] = [Math.floor(SR * 1.1), Math.floor(SR * 1.5)];
    expect(db(power(before, ...gap)) - db(power(x, ...gap))).toBeGreaterThan(15);
    expect(Math.abs(db(power(before, ...voice)) - db(power(x, ...voice)))).toBeLessThan(1);
  });

  it('amount 0 is a no-op', () => {
    const x = harmonicTone(220, 1);
    const before = x.slice();
    spectralDenoise(x, 0, x.length, 0);
    expect(x).toEqual(before);
  });
});

describe('deEss (dynamic, split-band)', () => {
  const sibilant = () => {
    const rnd = noise(5);
    const n = SR * 2;
    const x = new Float32Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const w = rnd();
      const hf = w - prev; // high-tilted noise
      prev = w;
      x[i] = 0.3 * Math.sin(2 * Math.PI * 300 * t) + (t % 0.5 < 0.12 ? 0.35 * hf : 0);
    }
    return x;
  };
  const bandDb = (x: Float32Array, centerSec: number, loHz: number, hiHz: number) => {
    const n = 4096;
    const mag = spectrum(x, n, centerSec * SR);
    let e = 0;
    for (let k = Math.ceil((loHz * n) / SR); k < (hiHz * n) / SR; k++) e += mag[k] ** 2;
    return db(e);
  };

  it('amount 0 is an exact pass-through', () => {
    const x = sibilant();
    const before = x.slice();
    deEss(x, 0, x.length, SR, 0);
    expect(x).toEqual(before);
  });

  it('cuts the "s" band during sibilance and leaves the lows alone', () => {
    const x = sibilant();
    const before = x.slice();
    deEss(x, 0, x.length, SR, 1);
    expect(bandDb(before, 0.555, 5500, 20000) - bandDb(x, 0.555, 5500, 20000)).toBeGreaterThan(10);
    expect(Math.abs(bandDb(before, 0.555, 50, 2000) - bandDb(x, 0.555, 50, 2000))).toBeLessThan(0.5);
    // tone-only stretch is untouched
    const a = Math.floor(SR * 0.75);
    const b = Math.floor(SR * 0.95);
    expect(Math.abs(db(power(before, a, b)) - db(power(x, a, b)))).toBeLessThan(0.2);
  });
});

describe('psolaAutotune', () => {
  it('snaps pitch to the scale and keeps the formant (voice character)', () => {
    const x = harmonicTone(180, 2, 1000);
    const y = psolaAutotune(x, 0, x.length, SR, [0], 1, 1); // only C allowed -> C3 130.8 Hz
    expect(y.length).toBe(x.length);
    const out = spectrum(y);
    expect(peakHz(out, 100, 260)).toBeGreaterThan(130.8 * 0.98);
    expect(peakHz(out, 100, 260)).toBeLessThan(130.8 * 1.02);
    // Plain resampling would move the formant to ~785 Hz; PSOLA keeps it near 1000 Hz
    const formant = peakHz(out, 600, 1600);
    expect(formant).toBeGreaterThan(900);
    expect(formant).toBeLessThan(1120);
  });

  it('strength 0 leaves an in-tune note unchanged in pitch', () => {
    const x = harmonicTone(220, 1.5); // A3, in C major
    const y = psolaAutotune(x, 0, x.length, SR, [0, 2, 4, 5, 7, 9, 11], 0, 1);
    expect(peakHz(spectrum(y), 150, 300)).toBeCloseTo(220, -1);
  });
});

describe('harmonies', () => {
  const C_MAJOR = [0, 2, 4, 5, 7, 9, 11];

  it('diatonic intervals follow the key', () => {
    expect(diatonicShift(60, 2, C_MAJOR)).toBe(64); // C -> E (major 3rd)
    expect(diatonicShift(64, 2, C_MAJOR)).toBe(67); // E -> G (minor 3rd)
    expect(diatonicShift(71, 2, C_MAJOR)).toBe(74); // B -> D (next octave)
    expect(diatonicShift(60, -2, C_MAJOR)).toBe(57); // C -> A below
    expect(diatonicShift(60, 4, C_MAJOR)).toBe(67); // C -> G (5th)
    expect(diatonicShift(60, 2, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(64); // chromatic: major 3rd
  });

  it('a third above is major or minor depending on the sung note (C major)', () => {
    for (const [f0, expected] of [
      [261.63, 329.63], // C4 -> E4
      [329.63, 392.0], // E4 -> G4
    ]) {
      const x = voiceTone(f0, 1.5);
      const v = harmonyVoice(x, 0, x.length, SR, C_MAJOR, 2);
      const found = peakHz(spectrum(v), expected * 0.85, expected * 1.15);
      expect(Math.abs(found - expected) / expected).toBeLessThan(0.02);
    }
  });

  it('keeps the singer\u2019s formant', () => {
    const x = harmonicTone(200, 2, 1000);
    const v = harmonyVoice(x, 0, x.length, SR, C_MAJOR, 4); // 5th up: ~300 Hz
    const formant = peakHz(spectrum(v), 600, 1600);
    expect(formant).toBeGreaterThan(880);
    expect(formant).toBeLessThan(1150); // resampling would move it to ~1500
  });

  it('the doubler is a slightly late, barely detuned copy', () => {
    const x = harmonicTone(220, 2);
    for (let i = 0; i < x.length; i++) x[i] *= 0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / SR); // envelope to correlate
    const v = doubleVoice(x, 0, x.length, SR, 1);
    // timing offset from the envelope cross-correlation
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = 0; lag < SR * 0.04; lag += 8) {
      let s = 0;
      for (let i = SR * 0.2; i < SR * 1.6; i += 16) s += Math.abs(x[i]) * Math.abs(v[i + lag]);
      if (s > best) {
        best = s;
        bestLag = lag;
      }
    }
    expect(bestLag / SR).toBeGreaterThan(0.012);
    expect(bestLag / SR).toBeLessThan(0.03);
    const f = peakHz(spectrum(v), 180, 260);
    expect(Math.abs(1200 * Math.log2(f / 220))).toBeLessThan(15); // within 15 cents
  });

  it('choir harmony turns a mono take into stereo', () => {
    const x = harmonicTone(261.63, 1);
    const out = renderClipChannels({
      channels: [x],
      sampleRate: SR,
      startSample: 0,
      endSample: x.length,
      processes: { ...DEFAULT_CLIP_PROCESSES, harmony: 100, harmonyStyle: 'choir' },
      scaleSemitones: C_MAJOR,
      pitchSemitones: 0,
    });
    expect(out).toHaveLength(2);
    let diff = 0;
    for (let i = 0; i < x.length; i += 7) diff += Math.abs(out[0][i] - out[1][i]);
    expect(diff).toBeGreaterThan(1); // left and right carry different voices
  });
});
