import { describe, expect, it } from 'vitest';
import type { AudioClip } from '../types/audio';
import {
  copyClips,
  duplicateClips,
  groupFitShift,
  pasteClips,
  resolveGroupOverlap,
  splitClipsAt,
} from './clipOps';

const clip = (id: string, trackId: string, startTime: number, duration: number): AudioClip => ({
  id,
  trackId,
  name: id,
  bufferId: `buf_${id}`,
  startTime,
  offset: 0,
  duration,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  pitchSemitones: 0,
  playbackRate: 1,
  color: '#fff',
});

let n = 0;
const id = () => `new${++n}`;
const overlaps = (clips: AudioClip[]) =>
  clips.some((a) =>
    clips.some(
      (b) =>
        a !== b &&
        a.trackId === b.trackId &&
        a.startTime < b.startTime + b.duration - 1e-6 &&
        b.startTime < a.startTime + a.duration - 1e-6
    )
  );

describe('overlap resolution', () => {
  it('leaves non-overlapping clips alone', () => {
    const clips = [clip('a', 't', 0, 2), clip('b', 't', 3, 2)];
    expect(groupFitShift(clips, new Set(['b']))).toBe(0);
  });

  it('moves a dropped clip to the nearest gap', () => {
    const clips = [clip('a', 't', 0, 4), clip('b', 't', 3, 2)]; // b dropped onto a's tail
    const res = resolveGroupOverlap(clips, new Set(['b']));
    expect(res.find((c) => c.id === 'b')!.startTime).toBeCloseTo(4);
    expect(overlaps(res)).toBe(false);
  });

  it('moves a multi-track group as one unit', () => {
    const clips = [
      clip('a', 't1', 0, 4),
      clip('g1', 't1', 3, 1),
      clip('g2', 't2', 3.5, 1),
      clip('c', 't2', 10, 1),
    ];
    const res = resolveGroupOverlap(clips, new Set(['g1', 'g2']));
    const g1 = res.find((c) => c.id === 'g1')!;
    const g2 = res.find((c) => c.id === 'g2')!;
    expect(g2.startTime - g1.startTime).toBeCloseTo(0.5); // relative layout kept
    expect(overlaps(res)).toBe(false);
  });

  it('clips on other tracks never block', () => {
    const clips = [clip('a', 't1', 0, 4), clip('b', 't2', 1, 2)];
    expect(groupFitShift(clips, new Set(['b']))).toBe(0);
  });
});

describe('split / duplicate / copy / paste', () => {
  it('splits only selected clips spanning the playhead', () => {
    const clips = [clip('a', 't', 0, 4), clip('b', 't2', 0, 1)];
    const res = splitClipsAt(clips, new Set(['a', 'b']), 2, id);
    expect(res.rightIds).toHaveLength(1);
    const left = res.clips.find((c) => c.id === 'a')!;
    const right = res.clips.find((c) => c.id === res.rightIds[0])!;
    expect(left.duration).toBeCloseTo(2);
    expect(right.startTime).toBeCloseTo(2);
    expect(right.offset).toBeCloseTo(2);
    expect(left.duration + right.duration).toBeCloseTo(4);
  });

  it('duplicates a group after its end without overlaps', () => {
    const clips = [clip('a', 't', 0, 2), clip('b', 't', 2, 1)];
    const res = duplicateClips(clips, new Set(['a', 'b']), id);
    expect(res.newIds).toHaveLength(2);
    const copies = res.clips.filter((c) => res.newIds.includes(c.id));
    expect(Math.min(...copies.map((c) => c.startTime))).toBeCloseTo(3);
    expect(overlaps(res.clips)).toBe(false);
  });

  it('copy + paste keeps relative timing and original tracks', () => {
    const clips = [clip('a', 't1', 1, 1), clip('b', 't2', 1.5, 1)];
    const board = copyClips(clips, new Set(['a', 'b']))!;
    const res = pasteClips(clips, board, 10, new Set(['t1', 't2']), 't1', () => '#000', id);
    const pasted = res.clips.filter((c) => res.newIds.includes(c.id));
    expect(pasted.map((c) => c.startTime).sort()).toEqual([10, 10.5]);
    expect(pasted.map((c) => c.trackId).sort()).toEqual(['t1', 't2']);
  });

  it('paste falls back to the selected track when the source track is gone', () => {
    const board = copyClips([clip('a', 'gone', 0, 1)], new Set(['a']))!;
    const res = pasteClips([], board, 0, new Set(['t9']), 't9', () => '#123', id);
    expect(res.clips[0].trackId).toBe('t9');
    expect(res.clips[0].color).toBe('#123');
  });
});
