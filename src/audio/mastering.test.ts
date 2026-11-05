import { describe, expect, it } from 'vitest';
import {
  limitInPlace,
  masterChannels,
  masterFromPreset,
  measureIntegratedLufs,
  measureTruePeakDb,
} from './mastering';
import { noise, SR } from '../test/signals';

describe('loudness (ITU-R BS.1770)', () => {
  it.each([44100, 48000])('stereo 997 Hz sine at -23 dBFS reads -23.0 LUFS @ %i Hz', (sr) => {
    const n = sr * 5;
    const a = Math.pow(10, -23 / 20);
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = a * Math.sin((2 * Math.PI * 997 * i) / sr);
    expect(measureIntegratedLufs([l, l.slice()], sr)).toBeCloseTo(-23, 1);
  });

  it('silence and very short audio are -Infinity', () => {
    expect(measureIntegratedLufs([new Float32Array(SR * 2)], SR)).toBe(-Infinity);
    expect(measureIntegratedLufs([new Float32Array(1000).fill(0.5)], SR)).toBe(-Infinity);
  });
});

describe('lookahead true-peak limiter', () => {
  it('keeps the true peak at or below the ceiling', () => {
    const rnd = noise(7);
    const n = SR * 2;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const spike = i % 11025 < 200 ? 1.8 * Math.sin(i * 0.3) : 0;
      l[i] = rnd() * 0.5 + spike;
      r[i] = l[i] * 0.9;
    }
    expect(measureTruePeakDb([l, r])).toBeGreaterThan(5);
    limitInPlace([l, r], SR, -1);
    expect(measureTruePeakDb([l, r])).toBeLessThanOrEqual(-0.99);
  });
});

describe('mastering', () => {
  const song = () => {
    const rnd = noise(3);
    const n = SR * 6;
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = 0.05 * Math.sin((2 * Math.PI * 110 * i) / SR) + 0.02 * rnd() + (i % 22050 < 300 ? 0.4 * rnd() : 0);
    }
    return [l, l.slice()];
  };

  it.each(['streaming', 'loud', 'warm', 'voice'] as const)('%s preset reaches its LUFS target within the ceiling', (id) => {
    const settings = masterFromPreset(id);
    const res = masterChannels(song(), SR, settings);
    expect(res.report.outputLufs).toBeGreaterThan(settings.targetLufs - 1);
    expect(res.report.outputLufs).toBeLessThan(settings.targetLufs + 0.5);
    expect(res.report.truePeakDb).toBeLessThanOrEqual(settings.ceilingDb + 0.05);
  });

  it('"off" leaves audio untouched', () => {
    const ch = song();
    const res = masterChannels(ch, SR, masterFromPreset('off'));
    expect(res.channels).toBe(ch);
    expect(res.report.gainDb).toBe(0);
  });
});
