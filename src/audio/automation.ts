/** Automation curves: breakpoint interpolation and scheduling onto AudioParams. */
import type { AutomationPoint } from '../types/audio';

export const AUTOMATION_MAX = 1.5;

/** Sorted copy with values clamped to the valid range. */
export function normalizePoints(points: AutomationPoint[]): AutomationPoint[] {
  return [...points]
    .map((p) => ({ t: Math.max(0, p.t), v: Math.max(0, Math.min(AUTOMATION_MAX, p.v)) }))
    .sort((a, b) => a.t - b.t);
}

/** Value at time `t`: linear between points, held flat before the first and after the last. */
export function valueAt(points: AutomationPoint[] | undefined, t: number, fallback = 1): number {
  if (!points || points.length === 0) return fallback;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (t <= b.t) {
      const a = points[i - 1];
      const span = b.t - a.t;
      return span <= 1e-9 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / span;
    }
  }
  return last.v;
}

/**
 * Schedules the curve for timeline range [from, to) onto `param`, where timeline `from` plays
 * at context time `ctxStart`. Earlier events stay intact (cancel only from `ctxStart`), so
 * consecutive loop iterations can be scheduled ahead of time.
 */
export function scheduleAutomation(
  param: AudioParam,
  points: AutomationPoint[] | undefined,
  from: number,
  to: number,
  ctxStart: number
): void {
  param.cancelScheduledValues(ctxStart);
  if (!points || points.length === 0) {
    param.setValueAtTime(1, ctxStart);
    return;
  }
  param.setValueAtTime(valueAt(points, from), ctxStart);
  for (const p of points) {
    if (p.t > from && p.t < to) param.linearRampToValueAtTime(p.v, ctxStart + (p.t - from));
  }
  if (Number.isFinite(to)) {
    param.linearRampToValueAtTime(valueAt(points, to), ctxStart + (to - from));
  }
}

/** Gain multiplier -> dB label. */
export function gainToDbLabel(v: number): string {
  if (v <= 0.0005) return '-∞ dB';
  const db = 20 * Math.log10(v);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}
