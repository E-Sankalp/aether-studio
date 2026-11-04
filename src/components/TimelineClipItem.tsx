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
  onSelect: (clipId: string) => void;
  onUpdateClip: (clipId: string, patch: Partial<AudioClip>, commitHistory?: boolean) => void;
}

export const TimelineClipItem: React.FC<TimelineClipItemProps> = ({
  clip,
  pixelsPerSecond,
  isSelected,
  snapToGrid,
  bpm,
  onSelect,
  onUpdateClip,
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
    onSelect(clip.id);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleBodyPointerDown = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const origStart = clip.startTime;
    startDrag(e, (pe) => {
      const dt = (pe.clientX - startX) / pixelsPerSecond;
      onUpdateClip(clip.id, { startTime: snapTime(origStart + dt) }, false);
    });
  };

  const handleLeftTrim = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const origStart = clip.startTime;
    const origOffset = clip.offset;
    const origDur = clip.duration;
    startDrag(e, (pe) => {
      const dt = (pe.clientX - startX) / pixelsPerSecond;
      const clampedDt = Math.max(-origOffset / clip.playbackRate, Math.min(origDur - 0.15, dt));
      const nextStart = snapTime(origStart + clampedDt);
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
      onUpdateClip(clip.id, { duration: Math.max(0.15, Math.min(maxAvailDur, origDur + dt)) }, false);
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
