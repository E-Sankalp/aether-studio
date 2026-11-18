import { describe, expect, it } from 'vitest';
import { bandResponseDb, eqResponseDb, formatFreq, nodeQ, parseFreq, resolveEq } from './eq';
import { DEFAULT_EFFECTS } from './synthStems';
import type { EqBand } from '../types/audio';

const band = (b: Partial<EqBand>): EqBand => ({ type: 'peaking', freq: 1000, gain: 0, q: 1, on: true, ...b });

describe('parametric EQ', () => {
  it('a flat EQ is exactly 0 dB everywhere', () => {
    const bands = resolveEq(DEFAULT_EFFECTS);
    for (const f of [20, 100, 1000, 5000, 19000]) expect(Math.abs(eqResponseDb(bands, f))).toBeLessThan(1e-9);
  });

  it('old 3-band projects map onto the same curve', () => {
    const bands = resolveEq({ ...DEFAULT_EFFECTS, eqLowGain: 6, eqMidGain: -4, eqMidFreq: 2000, eqMidQ: 2, eqHighGain: 3 });
    expect(bands[1]).toMatchObject({ type: 'lowshelf', freq: 110, gain: 6 });
    expect(bands[3]).toMatchObject({ type: 'peaking', freq: 2000, gain: -4, q: 2 });
    expect(bands[4]).toMatchObject({ type: 'highshelf', freq: 7500, gain: 3 });
    expect(bands[0].on).toBe(false);
    expect(bands[5].on).toBe(false);
    // shelves reach their gain far from the corner; the bell hits its gain at the centre
    expect(eqResponseDb(bands, 25)).toBeCloseTo(6, 0);
    expect(bandResponseDb(bands[3], 2000)).toBeCloseTo(-4, 6);
    expect(eqResponseDb(bands, 19000)).toBeCloseTo(3, 0);
  });

  it('bells peak at their frequency, and a wider Q spreads further', () => {
    const narrow = band({ gain: 9, q: 4 });
    const wide = band({ gain: 9, q: 0.5 });
    expect(bandResponseDb(narrow, 1000)).toBeCloseTo(9, 6);
    expect(bandResponseDb(narrow, 2000)).toBeLessThan(1.5);
    expect(bandResponseDb(wide, 2000)).toBeGreaterThan(5);
  });

  it('cuts are -3 dB at the corner (Butterworth Q) and steep beyond', () => {
    const hp = band({ type: 'highpass', freq: 100, q: Math.SQRT1_2 });
    expect(bandResponseDb(hp, 100)).toBeCloseTo(-3.01, 1);
    expect(bandResponseDb(hp, 50)).toBeLessThan(-11); // 12 dB/oct
    expect(Math.abs(bandResponseDb(hp, 1000))).toBeLessThan(0.05);
    const lp = band({ type: 'lowpass', freq: 8000, q: Math.SQRT1_2 });
    expect(bandResponseDb(lp, 8000)).toBeCloseTo(-3.01, 1);
    // BiquadFilterNode reads lowpass/highpass Q in dB
    expect(nodeQ(lp)).toBeCloseTo(-3.01, 1);
  });

  it('a band that is off does nothing', () => {
    expect(bandResponseDb(band({ gain: 12, on: false }), 1000)).toBe(0);
    expect(bandResponseDb(band({ type: 'highpass', freq: 500, on: false }), 50)).toBe(0);
  });

  it('frequencies can be typed and read back', () => {
    expect(parseFreq('2.5k')).toBe(2500);
    expect(parseFreq('80 Hz')).toBe(80);
    expect(parseFreq('3 kHz')).toBe(3000);
    expect(parseFreq('99999')).toBe(20000);
    expect(parseFreq('abc')).toBeNull();
    expect(formatFreq(2500)).toBe('2.5 kHz');
    expect(formatFreq(12000)).toBe('12 kHz');
    expect(formatFreq(80)).toBe('80 Hz');
  });
});
