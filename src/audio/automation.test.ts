import { describe, expect, it } from 'vitest';
import { gainToDbLabel, normalizePoints, scheduleAutomation, valueAt } from './automation';
import { delaySeconds } from './fxReturns';

describe('automation curves', () => {
  const pts = [
    { t: 1, v: 1 },
    { t: 3, v: 0 },
  ];

  it('interpolates linearly and holds flat outside the points', () => {
    expect(valueAt(pts, 0)).toBe(1);
    expect(valueAt(pts, 2)).toBeCloseTo(0.5);
    expect(valueAt(pts, 10)).toBe(0);
    expect(valueAt([], 5)).toBe(1);
    expect(valueAt(undefined, 5, 0.7)).toBe(0.7);
  });

  it('normalizePoints sorts and clamps', () => {
    expect(normalizePoints([{ t: 2, v: 9 }, { t: -1, v: -1 }])).toEqual([
      { t: 0, v: 0 },
      { t: 2, v: 1.5 },
    ]);
  });

  it('schedules a segment onto an AudioParam (loop iteration)', () => {
    const calls: string[] = [];
    const param = {
      cancelScheduledValues: (t: number) => calls.push(`cancel@${t}`),
      setValueAtTime: (v: number, t: number) => calls.push(`set ${v}@${t}`),
      linearRampToValueAtTime: (v: number, t: number) => calls.push(`ramp ${v}@${t}`),
    } as unknown as AudioParam;
    // timeline [2, 4) plays at context time 10
    scheduleAutomation(param, pts, 2, 4, 10);
    expect(calls).toEqual(['cancel@10', 'set 0.5@10', 'ramp 0@11', 'ramp 0@12']);
  });

  it('labels gain in dB', () => {
    expect(gainToDbLabel(1)).toBe('0.0 dB');
    expect(gainToDbLabel(1.5)).toBe('+3.5 dB');
    expect(gainToDbLabel(0)).toBe('-∞ dB');
    expect(gainToDbLabel(0.5)).toBe('-6.0 dB');
  });
});

describe('tempo-synced delay', () => {
  it('converts note values at the project tempo', () => {
    expect(delaySeconds('1/4', 120)).toBeCloseTo(0.5);
    expect(delaySeconds('1/8d', 120)).toBeCloseTo(0.375);
    expect(delaySeconds('1/16', 90)).toBeCloseTo(60 / 90 / 4);
  });
});
