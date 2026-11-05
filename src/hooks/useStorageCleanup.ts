import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { AudioClip } from '../types/audio';
import type { HistorySnapshot } from './useUndoHistory';
import type { PendingClipState } from './useClipRendering';
import { audioEngine } from '../audio/audioEngine';
import { clipboard } from '../utils/clipOps';
import {
  collectReferencedBufferIds,
  loadAllProjectsFromLibrary,
  pruneUnusedBuffers,
} from '../utils/projectStorage';

/**
 * Deletes stored audio nobody can reach any more, 8 s after the last edit. Kept: anything used
 * by a saved project, the open project, undo/redo history, the clip clipboard, a render in
 * flight, or a buffer created in the last 2 minutes (its clip may not be committed yet).
 */
export function useStorageCleanup(
  enabled: boolean,
  clips: AudioClip[],
  past: HistorySnapshot[],
  future: HistorySnapshot[],
  pendingClipStateRef: MutableRefObject<Map<string, PendingClipState>>
): void {
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      const referenced = collectReferencedBufferIds(loadAllProjectsFromLibrary(), [
        ...clips,
        ...past.flatMap((s) => s.clips),
        ...future.flatMap((s) => s.clips),
        ...(clipboard.get()?.clips ?? []),
      ]);
      audioEngine.getRecentBufferIds().forEach((id) => referenced.add(id));
      pendingClipStateRef.current.forEach((p) => referenced.add(p.sourceBufferId));
      void pruneUnusedBuffers(referenced);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [enabled, clips, past, future, pendingClipStateRef]);
}
