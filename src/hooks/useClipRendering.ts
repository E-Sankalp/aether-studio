import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import {
  AudioClip,
  AudioTrack,
  BufferOperationType,
  ClipProcessSettings,
  DEFAULT_CLIP_PROCESSES,
  WaveformSelection,
} from '../types/audio';
import { audioEngine } from '../audio/audioEngine';
import { notify } from '../components/Toaster';

export interface PendingClipState {
  processes: ClipProcessSettings;
  pitchSemitones: number;
  sourceBufferId: string;
}

interface Options {
  liveRef: MutableRefObject<{ tracks: AudioTrack[]; clips: AudioClip[] }>;
  pushHistory: (tracks: AudioTrack[], clips: AudioClip[]) => void;
  selection: WaveformSelection | null;
  selectedClipId: string;
}

/**
 * Background clip rendering (pitch + processes in a Web Worker).
 *
 * Each commit (slider release / button) bumps a per-clip sequence number; only the newest render
 * for a clip is applied, so fast successive edits never land out of order. `pendingClipState`
 * holds the latest *requested* settings so edits made while a render is still running build on
 * each other instead of on the last finished render.
 */
export function useClipRendering({ liveRef, pushHistory, selection, selectedClipId }: Options) {
  const renderSeqRef = useRef(new Map<string, number>());
  const pendingClipStateRef = useRef(new Map<string, PendingClipState>());
  const [renderingClipIds, setRenderingClipIds] = useState<ReadonlySet<string>>(new Set());

  const setClipRendering = (clipId: string, on: boolean) =>
    setRenderingClipIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(clipId);
      else next.delete(clipId);
      return next;
    });

  /** Invalidates in-flight renders (e.g. on undo/redo) so they can't overwrite restored state. */
  const cancelPendingRenders = useCallback(() => {
    renderSeqRef.current.forEach((seq, id) => renderSeqRef.current.set(id, seq + 1));
    pendingClipStateRef.current.clear();
    setRenderingClipIds(new Set());
  }, []);

  /** Region of the clip that processes apply to (waveform selection, or the whole clip). */
  const regionOf = useCallback(
    (clip: AudioClip) => {
      const hasSel =
        selection &&
        selection.clipId === clip.id &&
        selection.endOffset - selection.startOffset > 0.03;
      return {
        start: hasSel ? selection.startOffset : 0,
        end: hasSel ? selection.endOffset : clip.duration,
      };
    },
    [selection]
  );

  const commitClipRender = useCallback(
    async (
      clipId: string,
      change: { processes?: Partial<ClipProcessSettings>; pitchSemitones?: number; sourceBufferId?: string },
      extra: Partial<AudioClip> = {}
    ) => {
      const clip = liveRef.current.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const base = pendingClipStateRef.current.get(clipId) ?? {
        processes: { ...DEFAULT_CLIP_PROCESSES, ...clip.processes },
        pitchSemitones: clip.pitchSemitones,
        sourceBufferId: clip.sourceBufferId || clip.bufferId,
      };
      const next: PendingClipState = {
        processes: { ...base.processes, ...change.processes },
        pitchSemitones: change.pitchSemitones ?? base.pitchSemitones,
        sourceBufferId: change.sourceBufferId ?? base.sourceBufferId,
      };
      pendingClipStateRef.current.set(clipId, next);
      const seq = (renderSeqRef.current.get(clipId) ?? 0) + 1;
      renderSeqRef.current.set(clipId, seq);
      setClipRendering(clipId, true);

      const region = regionOf(clip);
      const track = liveRef.current.tracks.find((t) => t.id === clip.trackId);

      try {
        const newBufId = await audioEngine.renderClip({
          clipId,
          sourceBufferId: next.sourceBufferId,
          regionStartSec: clip.offset + region.start * clip.playbackRate,
          regionEndSec: clip.offset + region.end * clip.playbackRate,
          processes: next.processes,
          scaleId: track?.effects.autoPitchScale || 'C_major',
          pitchSemitones: next.pitchSemitones,
        });
        if (renderSeqRef.current.get(clipId) !== seq) return; // superseded by a newer edit
        pendingClipStateRef.current.delete(clipId);
        const latest = liveRef.current;
        if (!newBufId || !latest.clips.some((c) => c.id === clipId)) return;
        pushHistory(
          latest.tracks,
          latest.clips.map((c) =>
            c.id === clipId
              ? {
                  ...c,
                  ...extra,
                  sourceBufferId: next.sourceBufferId,
                  processes: next.processes,
                  pitchSemitones: next.pitchSemitones,
                  renderedPitch: next.pitchSemitones,
                  bufferId: newBufId,
                }
              : c
          )
        );
      } catch (err) {
        console.error('Clip render failed:', err);
        if (renderSeqRef.current.get(clipId) === seq) {
          pendingClipStateRef.current.delete(clipId);
          notify('Could not process this clip. Please try again.', 'error');
        }
      } finally {
        if (renderSeqRef.current.get(clipId) === seq) setClipRendering(clipId, false);
      }
    },
    [liveRef, pushHistory, regionOf]
  );

  const updateClipProcesses = useCallback(
    (patch: Partial<ClipProcessSettings>) => {
      if (selectedClipId) void commitClipRender(selectedClipId, { processes: patch });
    },
    [selectedClipId, commitClipRender]
  );

  const commitClipPitch = useCallback(
    (semitones: number) => {
      if (selectedClipId) void commitClipRender(selectedClipId, { pitchSemitones: semitones });
    },
    [selectedClipId, commitClipRender]
  );

  /** Switches a comp clip to another take (keeps its pitch/process settings). */
  const selectTake = useCallback(
    (clipId: string, takeIndex: number) => {
      const clip = liveRef.current.clips.find((c) => c.id === clipId);
      const take = clip?.takes?.[takeIndex];
      if (!clip || !take || clip.activeTake === takeIndex) return;
      void commitClipRender(clipId, { sourceBufferId: take.bufferId }, { activeTake: takeIndex });
    },
    [liveRef, commitClipRender]
  );

  /** Edit-panel buttons: toggles for each process, plus destructive "silence region". */
  const applyBufferOp = useCallback(
    (op: BufferOperationType) => {
      const clip = liveRef.current.clips.find((c) => c.id === selectedClipId);
      if (!clip) return;
      // Toggles build on the latest requested settings (a render may still be running)
      const pending = pendingClipStateRef.current.get(clip.id);
      const cur: ClipProcessSettings = pending?.processes ?? {
        ...DEFAULT_CLIP_PROCESSES,
        ...clip.processes,
      };
      const toggles: Partial<Record<BufferOperationType, Partial<ClipProcessSettings>>> = {
        autoPitch: { autoPitch: cur.autoPitch > 0 ? 0 : 80 },
        harmony: { harmony: cur.harmony > 0 ? 0 : 65 },
        voiceSoften: { voiceSoften: cur.voiceSoften > 0 ? 0 : 70 },
        denoise: { denoise: cur.denoise > 0 ? 0 : 65 },
        normalize: { normalize: cur.normalize > 0 ? 0 : 100 },
        boost: { boostDb: Math.min(12, cur.boostDb + 3) },
        attenuate: { boostDb: Math.max(-12, cur.boostDb - 3) },
        fadeIn: { fadeInShape: cur.fadeInShape > 0 ? 0 : 35 },
        fadeOut: { fadeOutShape: cur.fadeOutShape > 0 ? 0 : 35 },
        reverse: { reverse: !cur.reverse },
      };
      const toggle = toggles[op];
      if (toggle) {
        updateClipProcesses(toggle);
        return;
      }
      if (op === 'silence') {
        // Destructive edit on the untouched source, then re-render pitch + processes on top
        const region = regionOf(clip);
        const source = pending?.sourceBufferId ?? clip.sourceBufferId ?? clip.bufferId;
        const newSrc = audioEngine.silenceRegion(
          source,
          clip.offset + region.start * clip.playbackRate,
          clip.offset + region.end * clip.playbackRate
        );
        if (newSrc) void commitClipRender(clip.id, { sourceBufferId: newSrc });
      }
    },
    [liveRef, selectedClipId, regionOf, updateClipProcesses, commitClipRender]
  );

  return {
    renderingClipIds,
    pendingClipStateRef,
    commitClipRender,
    cancelPendingRenders,
    updateClipProcesses,
    commitClipPitch,
    selectTake,
    applyBufferOp,
  };
}
