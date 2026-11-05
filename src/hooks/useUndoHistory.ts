import { useCallback, useRef, useState } from 'react';
import type { AudioClip, AudioTrack } from '../types/audio';

export interface HistorySnapshot {
  tracks: AudioTrack[];
  clips: AudioClip[];
}

const MAX_STEPS = 50;
const BURST_MS = 800;

/**
 * Undo/redo for tracks + clips.
 *  - pushHistory: a discrete action (split, delete, render result...) = one undo step.
 *  - recordUndoPoint: continuous edits (slider drags, clip moves, typing). The first change in a
 *    burst snapshots the state; further changes to the same target within 800 ms join it, so
 *    one gesture = one undo step.
 * `liveRef` always holds the latest tracks/clips, for async work whose closure may be stale.
 */
export function useUndoHistory(
  tracks: AudioTrack[],
  clips: AudioClip[],
  setTracks: (t: AudioTrack[]) => void,
  setClips: (c: AudioClip[]) => void
) {
  const [past, setPast] = useState<HistorySnapshot[]>([]);
  const [future, setFuture] = useState<HistorySnapshot[]>([]);
  const liveRef = useRef<HistorySnapshot>({ tracks, clips });
  liveRef.current = { tracks, clips };
  const burstRef = useRef<{ key: string; timer: number } | null>(null);

  const endBurst = useCallback(() => {
    if (burstRef.current) window.clearTimeout(burstRef.current.timer);
    burstRef.current = null;
  }, []);

  const recordUndoPoint = useCallback((key: string) => {
    const burst = burstRef.current;
    if (burst && burst.key === key) {
      window.clearTimeout(burst.timer);
      burst.timer = window.setTimeout(() => (burstRef.current = null), BURST_MS);
      return;
    }
    if (burst) window.clearTimeout(burst.timer);
    const current = liveRef.current;
    setPast((prev) => [...prev.slice(-(MAX_STEPS - 1)), current]);
    setFuture([]);
    burstRef.current = {
      key,
      timer: window.setTimeout(() => (burstRef.current = null), BURST_MS),
    };
  }, []);

  const pushHistory = useCallback(
    (nextTracks: AudioTrack[], nextClips: AudioClip[]) => {
      const current = liveRef.current;
      setPast((prev) => [...prev.slice(-(MAX_STEPS - 1)), current]);
      setFuture([]);
      endBurst(); // a discrete action ends any running edit burst
      liveRef.current = { tracks: nextTracks, clips: nextClips };
      setTracks(nextTracks);
      setClips(nextClips);
    },
    [endBurst, setTracks, setClips]
  );

  const undo = useCallback(() => {
    if (past.length === 0) return false;
    endBurst();
    const previous = past[past.length - 1];
    // Capture now: updater functions must be pure (React may run them twice), and the ref
    // will already hold the restored state by then
    const current = liveRef.current;
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [current, ...prev]);
    setTracks(previous.tracks);
    setClips(previous.clips);
    return true;
  }, [past, endBurst, setTracks, setClips]);

  const redo = useCallback(() => {
    if (future.length === 0) return false;
    endBurst();
    const next = future[0];
    const current = liveRef.current; // capture outside the (possibly re-run) updater
    setFuture((prev) => prev.slice(1));
    setPast((prev) => [...prev, current]);
    setTracks(next.tracks);
    setClips(next.clips);
    return true;
  }, [future, endBurst, setTracks, setClips]);

  /** Clears history (new/opened project). */
  const resetHistory = useCallback(() => {
    endBurst();
    setPast([]);
    setFuture([]);
  }, [endBurst]);

  return {
    past,
    future,
    liveRef,
    recordUndoPoint,
    pushHistory,
    undo,
    redo,
    endBurst,
    resetHistory,
  };
}
