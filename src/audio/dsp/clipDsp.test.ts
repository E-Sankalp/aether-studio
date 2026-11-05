import { describe, expect, it } from 'vitest';
import { pitchShift, renderClipChannels } from './clipDsp';
import { DEFAULT_CLIP_PROCESSES } from '../../types/audio';
import { harmonicTone, peakHz, spectrum, SR } from '../../test/signals';

describe('pitchShift (duration-preserving)', () => {
  it.each([-5, 3, 7, 12])('%i semitones: exact length, correct pitch', (st) => {
    const x = harmonicTone(220, 2);
    const [y] = pitchShift([x], st, SR);
    expect(y.length).toBe(x.length);
    const expected = 220 * Math.pow(2, st / 12);
    const found = peakHz(spectrum(y), expected * 0.8, expected * 1.2);
    expect(Math.abs(found - expected) / expected).toBeLessThan(0.015);
  });

  it('0 semitones returns the input', () => {
    const x = harmonicTone(220, 0.5);
    expect(pitchShift([x], 0, SR)[0]).toBe(x);
  });
});

describe('renderClipChannels', () => {
  it('default settings return an untouched copy', () => {
    const x = harmonicTone(220, 0.5);
    const [y] = renderClipChannels({
      channels: [x],
      sampleRate: SR,
      startSample: 0,
      endSample: x.length,
      processes: DEFAULT_CLIP_PROCESSES,
      scaleSemitones: [0, 2, 4, 5, 7, 9, 11],
      pitchSemitones: 0,
    });
    expect(y).not.toBe(x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('only processes the selected region', () => {
    const x = harmonicTone(220, 1);
    const [y] = renderClipChannels({
      channels: [x],
      sampleRate: SR,
      startSample: SR * 0.5,
      endSample: SR,
      processes: { ...DEFAULT_CLIP_PROCESSES, boostDb: -12 },
      scaleSemitones: [],
      pitchSemitones: 0,
    });
    expect(Array.from(y.subarray(0, SR * 0.5))).toEqual(Array.from(x.subarray(0, SR * 0.5)));
    expect(Math.abs(y[SR * 0.75])).toBeLessThan(Math.abs(x[SR * 0.75]) + 1e-9);
  });
});
