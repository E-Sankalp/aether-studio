import React, { useEffect, useRef } from 'react';
import { AudioClip } from '../types/audio';
import { audioEngine } from '../audio/audioEngine';
import { drawBufferWaveform } from '../utils/waveformDraw';

interface TimelineClipItemProps {
  clip: AudioClip;
  pixelsPerSecond: number;
  isSelected: boolean;
  snapToGrid: boolean;
  bpm: number;
  onSelectClip: (clipId: string, trackId: string, mode?: 'toggle' | 'press' | 'click') => void;
  /** Body drag (moves the selection as a group). Falls back to moving just this clip. */
  onDragMove?: (clipId: string, dtSec: number) => void;
  onUpdateClip: (clipId: string, patch: Partial<AudioClip>, commitHistory?: boolean) => void;
  /** Called when a move/trim gesture ends (the app resolves overlaps on drop). */
  onDragEnd?: (clipId: string) => void;
  /** End of the previous clip on this track (trims can't go past it) */
  prevEnd?: number;
  /** Start of the next clip on this track (trims can't go past it) */
  nextStart?: number;
}

const TimelineClipItemImpl: React.FC<TimelineClipItemProps> = ({
  clip,
  pixelsPerSecond,
  isSelected,
  snapToGrid,
  bpm,
  onSelectClip,
  onUpdateClip,
  onDragEnd,
  onDragMove,
  prevEnd = 0,
  nextStart = Infinity,
}) => {

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const buffer = audioEngine.getBuffer(clip.bufferId);

  const leftPx = clip.startTime * pixelsPerSecond;
  const widthPx = Math.max(22, clip.duration * pixelsPerSecond);

  const snapTime = (t: number) => {
    if (!snapToGrid) return Math.max(0, Number(t.toFixed(3)));
    const gridStep = 60 / bpm / 4; // 1/16th note grid
    return Math.max(0, Math.round(t / gridStep) * gridStep);
  };

  useEffect(() => {
    if (canvasRef.current && buffer) {
      // Dark waveform on the solid track-coloured clip body
      drawBufferWaveform(
        canvasRef.current,
        buffer,
        clip.offset,
        clip.duration,
        clip.playbackRate,
        clip.gain,
        clip.fadeIn,
        clip.fadeOut,
        '#000000',
        null
      );
    }
  }, [
    buffer,
    clip.offset,
    clip.duration,
    clip.playbackRate,
    clip.gain,
    clip.fadeIn,
    clip.fadeOut,
    widthPx,
  ]);

  const startDrag = (
    e: React.PointerEvent,
    onMove: (pe: PointerEvent) => void
  ) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    onSelectClip(clip.id, clip.trackId, additive ? 'toggle' : 'press');
    let moved = false;
    const move = (pe: PointerEvent) => {
      moved = true;
      onMove(pe);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', onUp);
      if (moved) onDragEnd?.(clip.id);
      // A plain click (no drag) on a multi-selection selects just this clip
      else if (!additive) onSelectClip(clip.id, clip.trackId, 'click');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', onUp);
  };

  const handleBodyPointerDown = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const origStart = clip.startTime;
    startDrag(e, (pe) => {
      const dt = (pe.clientX - startX) / pixelsPerSecond;
      if (onDragMove) onDragMove(clip.id, dt);
      else onUpdateClip(clip.id, { startTime: snapTime(origStart + dt) }, false);
    });
  };

  const handleLeftTrim = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const origStart = clip.startTime;
    const origOffset = clip.offset;
    const origDur = clip.duration;
    startDrag(e, (pe) => {
      const dt = (pe.clientX - startX) / pixelsPerSecond;
      const clampedDt = Math.max(
        -origOffset / clip.playbackRate,
        prevEnd - origStart,
        Math.min(origDur - 0.15, dt)
      );
      const nextStart = Math.max(prevEnd, snapTime(origStart + clampedDt));
      const actualDt = nextStart - origStart;
      onUpdateClip(
        clip.id,
        {
          startTime: nextStart,
          offset: Math.max(0, origOffset + actualDt * clip.playbackRate),
          duration: Math.max(0.15, origDur - actualDt),
        },
        false
      );
    });
  };

  const handleRightTrim = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const origDur = clip.duration;
    const maxAvailDur = buffer ? (buffer.duration - clip.offset) / clip.playbackRate : origDur;
    startDrag(e, (pe) => {
      const dt = (pe.clientX - startX) / pixelsPerSecond;
      const maxDur = Math.min(maxAvailDur, nextStart - clip.startTime);
      onUpdateClip(clip.id, { duration: Math.max(0.15, Math.min(maxDur, origDur + dt)) }, false);
    });
  };

  const gainDb = 20 * Math.log10(Math.max(0.001, clip.gain));
  const p = clip.processes;
  const badges = [
    clip.pitchSemitones !== 0
      ? `${clip.pitchSemitones > 0 ? '+' : ''}${clip.pitchSemitones}st`
      : null,
    clip.playbackRate !== 1 ? `${clip.playbackRate.toFixed(2)}x` : null,
    Math.abs(gainDb) >= 0.2 ? `${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)}dB` : null,
    p && p.autoPitch > 0 ? `Tune ${Math.round(p.autoPitch)}%` : null,
    p && p.harmony > 0 ? `Harm ${Math.round(p.harmony)}%` : null,
    p && p.voiceSoften > 0 ? `Soft ${Math.round(p.voiceSoften)}%` : null,
    p && p.denoise > 0 ? `NR ${Math.round(p.denoise)}%` : null,
    p && p.normalize > 0 ? `Norm ${Math.round(p.normalize)}%` : null,
    p && Math.abs(p.boostDb) >= 0.1
      ? `${p.boostDb > 0 ? '+' : ''}${p.boostDb.toFixed(0)}dB`
      : null,
    p && p.reverse ? 'Rev' : null,
  ].filter(Boolean);

  return (
    <div
      data-clip-id={clip.id}
      onPointerDown={handleBodyPointerDown}
      style={{ left: `${leftPx}px`, width: `${widthPx}px`, backgroundColor: clip.color }}
      className={`absolute top-2 bottom-2 rounded-lg overflow-hidden cursor-grab active:cursor-grabbing touch-none group ${
        isSelected ? 'ring-2 ring-white' : ''
      }`}
    >
      <div className="h-5 px-2.5 flex items-center justify-between gap-2 text-[11px] font-semibold text-black/80 select-none">
        <span className="truncate">{clip.name}</span>
        {badges.length > 0 && (
          <span className="font-mono text-[10px] text-black/60 shrink-0">{badges.join(' · ')}</span>
        )}
      </div>

      <div className="relative w-full h-[calc(100%-20px)]">
        <canvas ref={canvasRef} className="w-full h-full block pointer-events-none" />
      </div>

      <div
        onPointerDown={handleLeftTrim}
        className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize touch-none opacity-0 group-hover:opacity-100 bg-black/25 transition-opacity"
      />
      <div
        onPointerDown={handleRightTrim}
        className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize touch-none opacity-0 group-hover:opacity-100 bg-black/25 transition-opacity"
      />
    </div>
  );
};

/** Memoized: clips only re-render when their own props change. */
export const TimelineClipItem = React.memo(TimelineClipItemImpl);
