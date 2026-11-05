/**
 * Pure clip-editing operations (no React, no audio): overlap resolution, split, duplicate,
 * copy/paste. Kept separate so they can be unit-tested.
 */
import type { AudioClip } from '../types/audio';

/** Collision-free ids (several clips/tracks can be created in the same millisecond). */
export const makeId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const EPS = 0.001;
const end = (c: AudioClip) => c.startTime + c.duration;

/**
 * Smallest extra time shift that makes the clips in `groupIds` overlap no other clip on their
 * tracks (the group moves as a unit). Returns 0 when they already fit, or null if nothing fits.
 */
export function groupFitShift(clips: AudioClip[], groupIds: Set<string>): number | null {
  const group = clips.filter((c) => groupIds.has(c.id));
  const others = clips.filter((c) => !groupIds.has(c.id));
  if (group.length === 0) return 0;

  const fitsWith = (shift: number) =>
    group.every((m) => {
      const s = m.startTime + shift;
      if (s < -EPS) return false;
      return others.every(
        (o) => o.trackId !== m.trackId || s + m.duration <= o.startTime + EPS || s >= end(o) - EPS
      );
    });

  if (fitsWith(0)) return 0;
  const candidates: number[] = [];
  for (const m of group) {
    candidates.push(-m.startTime); // group's member lands at 0
    for (const o of others) {
      if (o.trackId !== m.trackId) continue;
      candidates.push(end(o) - m.startTime); // just after o
      candidates.push(o.startTime - end(m)); // just before o
    }
  }
  const best = candidates
    .filter((d) => fitsWith(d))
    .sort((a, b) => Math.abs(a) - Math.abs(b))[0];
  return best === undefined ? null : best;
}

/** Applies groupFitShift (no-op if the group already fits or nothing fits). */
export function resolveGroupOverlap(clips: AudioClip[], groupIds: Set<string>): AudioClip[] {
  const shift = groupFitShift(clips, groupIds);
  if (!shift) return clips;
  return clips.map((c) => (groupIds.has(c.id) ? { ...c, startTime: c.startTime + shift } : c));
}

/** Splits every clip in `ids` that spans time `t`. Returns new clips + ids of the right halves. */
export function splitClipsAt(
  clips: AudioClip[],
  ids: Set<string>,
  t: number,
  newId: () => string = () => makeId('clp')
): { clips: AudioClip[]; rightIds: string[] } {
  const out: AudioClip[] = [];
  const rightIds: string[] = [];
  for (const c of clips) {
    if (!ids.has(c.id) || t <= c.startTime + 0.08 || t >= end(c) - 0.08) {
      out.push(c);
      continue;
    }
    const firstDur = t - c.startTime;
    out.push({ ...c, duration: firstDur, fadeOut: Math.min(c.fadeOut, 0.02) || 0.02 });
    const right: AudioClip = {
      ...c,
      id: newId(),
      name: /\(\d+\)$/.test(c.name) ? c.name : `${c.name} (2)`,
      startTime: t,
      offset: c.offset + firstDur * c.playbackRate,
      duration: c.duration - firstDur,
      fadeIn: 0.02,
    };
    out.push(right);
    rightIds.push(right.id);
  }
  return { clips: out, rightIds };
}

/** Duplicates the clips in `ids` as a group, placed right after the group's end. */
export function duplicateClips(
  clips: AudioClip[],
  ids: Set<string>,
  newId: () => string = () => makeId('clp')
): { clips: AudioClip[]; newIds: string[] } {
  const group = clips.filter((c) => ids.has(c.id));
  if (group.length === 0) return { clips, newIds: [] };
  const groupStart = Math.min(...group.map((c) => c.startTime));
  const groupEnd = Math.max(...group.map(end));
  const span = groupEnd - groupStart;
  const copies = group.map((c) => ({ ...c, id: newId(), startTime: c.startTime + span }));
  const newIds = copies.map((c) => c.id);
  return { clips: resolveGroupOverlap([...clips, ...copies], new Set(newIds)), newIds };
}

export interface ClipClipboard {
  /** Copied clips with startTime relative to the earliest one */
  clips: AudioClip[];
}

export function copyClips(clips: AudioClip[], ids: Set<string>): ClipClipboard | null {
  const group = clips.filter((c) => ids.has(c.id));
  if (group.length === 0) return null;
  const anchor = Math.min(...group.map((c) => c.startTime));
  return { clips: group.map((c) => ({ ...c, startTime: c.startTime - anchor })) };
}

/**
 * Pastes clipboard clips at time `at`. Clips go back to their original track if it exists in
 * this project, otherwise to `fallbackTrackId`. Overlaps are resolved as a group.
 */
export function pasteClips(
  clips: AudioClip[],
  board: ClipClipboard,
  at: number,
  trackIds: Set<string>,
  fallbackTrackId: string,
  trackColor: (trackId: string) => string | undefined,
  newId: () => string = () => makeId('clp')
): { clips: AudioClip[]; newIds: string[] } {
  const pasted = board.clips.map((c) => {
    const trackId = trackIds.has(c.trackId) ? c.trackId : fallbackTrackId;
    return {
      ...c,
      id: newId(),
      trackId,
      startTime: Math.max(0, at + c.startTime),
      color: trackColor(trackId) ?? c.color,
    };
  });
  const newIds = pasted.map((c) => c.id);
  return { clips: resolveGroupOverlap([...clips, ...pasted], new Set(newIds)), newIds };
}

/** App-wide clip clipboard (survives switching projects, so clips can be pasted elsewhere). */
let board: ClipClipboard | null = null;
export const clipboard = {
  get: (): ClipClipboard | null => board,
  set: (next: ClipClipboard | null): void => {
    board = next;
  },
};
