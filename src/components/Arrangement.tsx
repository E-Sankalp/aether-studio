import React from 'react';
import { Trash2 } from 'lucide-react';
import { AudioClip, AudioTrack, LoopRegion } from '../types/audio';
import { TimelineClipItem } from './TimelineClipItem';
import { RangeInput } from './ParamSlider';
import { meterStore, playheadStore, useLiveStore } from '../utils/liveStore';

/** Playhead line: subscribes to the playhead store so the arrangement doesn't re-render per frame. */
const PlayheadLine: React.FC<{ offsetPx: number; pps: number }> = ({ offsetPx, pps }) => {
  const t = useLiveStore(playheadStore);
  return (
    <div
      style={{ transform: `translateX(${offsetPx + t * pps}px)` }}
      className="absolute top-0 bottom-0 left-0 w-px bg-accent z-[26] pointer-events-none will-change-transform"
    />
  );
};

const RecordingBlock: React.FC<{ startTime: number; pps: number }> = ({ startTime, pps }) => {
  const t = useLiveStore(playheadStore);
  return (
    <div
      style={{ left: startTime * pps, width: Math.max(4, (t - startTime) * pps) }}
      className="absolute top-2 bottom-2 rounded-lg bg-accent/25 border border-accent overflow-hidden flex items-center px-2.5 text-[11px] font-semibold text-accent"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse mr-1.5 shrink-0" />
      <span className="truncate">Recording…</span>
    </div>
  );
};

/** Per-track level hairline (re-renders only when its own rounded level changes). */
export const TrackLevelBar: React.FC<{ trackId: string; color: string; className?: string }> = ({
  trackId,
  color,
  className = 'h-full',
}) => {
  const pct = useLiveStore(meterStore, (m) => Math.min(100, Math.round((m.trackLevels[trackId] || 0) * 100)));
  return (
    <div
      className={`${className} transition-[width] duration-75`}
      style={{ width: `${pct}%`, backgroundColor: color }}
    />
  );
};

interface ArrangementProps {
  tracks: AudioTrack[];
  clips: AudioClip[];
  selectedTrackId: string;
  selectedClipId: string;
  loop: LoopRegion;
  bpm: number;
  pixelsPerSecond: number;
  durationSec: number;
  snapToGrid: boolean;
  compact?: boolean;
  cornerSlot: React.ReactNode;
  onSelectTrack: (trackId: string) => void;
  onSelectClip: (clipId: string, trackId: string) => void;
  onUpdateTrack: (trackId: string, patch: Partial<AudioTrack>) => void;
  onUpdateClip: (clipId: string, patch: Partial<AudioClip>, commitHistory?: boolean) => void;
  onDeleteTrack: (trackId: string) => void;
  onSeek: (time: number) => void;
  /** Active take being recorded; drawn as a live block on its lane. */
  recording?: { trackId: string; startTime: number } | null;
}

export const Arrangement: React.FC<ArrangementProps> = ({
  tracks,
  clips,
  selectedTrackId,
  selectedClipId,
  loop,
  bpm,
  pixelsPerSecond: pps,
  durationSec,
  snapToGrid,
  compact = false,
  cornerSlot,
  onSelectTrack,
  onSelectClip,
  onUpdateTrack,
  onUpdateClip,
  onDeleteTrack,
  onSeek,
  recording = null,
}) => {
  const headerW = compact ? 152 : 236;
  const rowH = compact ? 80 : 88;
  const widthPx = durationSec * pps;
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const bars = Math.ceil(durationSec / barSec);

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const left = e.currentTarget.getBoundingClientRect().left;
    const seek = (clientX: number) => onSeek(Math.max(0, (clientX - left) / pps));
    seek(e.clientX);
    const onMove = (pe: PointerEvent) => seek(pe.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Beat + bar guides drawn with two cheap repeating gradients
  const gridStyle: React.CSSProperties = {
    width: widthPx,
    backgroundImage:
      'linear-gradient(to right, rgba(255,255,255,0.09) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px)',
    backgroundSize: `${barSec * pps}px 100%, ${beatSec * pps}px 100%`,
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-app relative">
      <div style={{ width: headerW + widthPx, minHeight: '100%' }} className="relative">
        {/* Ruler row */}
        <div className="sticky top-0 z-30 flex h-9">
          <div
            style={{ width: headerW }}
            className="sticky left-0 z-40 shrink-0 bg-panel border-b border-r border-line flex items-center justify-between px-3"
          >
            {cornerSlot}
          </div>
          <div
            onPointerDown={handleRulerPointerDown}
            style={{ width: widthPx }}
            className="relative bg-panel border-b border-line touch-none cursor-pointer"
          >
            {loop.enabled && (
              <div
                style={{
                  left: loop.start * pps,
                  width: Math.max(0, (loop.end - loop.start) * pps),
                }}
                className="absolute inset-y-0 bg-accent/15 border-x border-accent/60 pointer-events-none"
              />
            )}
            {Array.from({ length: bars + 1 }).map((_, bar) => (
              <div
                key={bar}
                style={{ left: bar * barSec * pps }}
                className="absolute inset-y-0 flex items-end pointer-events-none"
              >
                <div className="w-px h-3 bg-mute/50" />
                <span className="text-[10px] font-mono text-mute pl-1.5 pb-1">{bar + 1}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Track rows */}
        <div className="relative">
          {tracks.map((track) => {
            const isSelected = track.id === selectedTrackId;
            return (
              <div
                key={track.id}
                style={{ height: rowH }}
                className={`flex border-b border-line ${
                  isSelected
                    ? 'sticky top-9 bottom-0 z-[24] bg-app shadow-lg shadow-black/60'
                    : ''
                }`}
              >
                {/* Sticky track header */}
                <div
                  onClick={() => onSelectTrack(track.id)}
                  style={{ width: headerW }}
                  className={`sticky left-0 z-20 shrink-0 border-r border-line px-3 flex flex-col justify-center gap-2 relative group cursor-pointer ${
                    isSelected ? 'bg-raised' : 'bg-panel'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-1.5 h-6 rounded-full shrink-0"
                      style={{ backgroundColor: track.color }}
                    />
                    <input
                      value={track.name}
                      onChange={(e) => onUpdateTrack(track.id, { name: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      className={`min-w-0 flex-1 bg-transparent font-semibold outline-none rounded px-1 focus:bg-app ${
                        compact ? 'text-[11px]' : 'text-[13px]'
                      }`}
                    />
                    {isSelected && (
                      <span
                        title="Recordings go to this track"
                        className="flex items-center gap-1 text-[9px] font-bold text-accent shrink-0"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                        {!compact && 'REC'}
                      </span>
                    )}
                    {tracks.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteTrack(track.id);
                        }}
                        title="Delete track"
                        className={`p-1 text-mute hover:text-accent transition-opacity ${
                          compact ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateTrack(track.id, { muted: !track.muted });
                      }}
                      title="Mute"
                      className={`${compact ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 text-[11px]'} rounded-md font-bold transition-colors flex items-center justify-center shrink-0 ${
                        track.muted ? 'bg-amber-400 text-black' : 'bg-app text-mute hover:text-ink'
                      }`}
                    >
                      M
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateTrack(track.id, { solo: !track.solo });
                      }}
                      title="Solo"
                      className={`${compact ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 text-[11px]'} rounded-md font-bold transition-colors flex items-center justify-center shrink-0 ${
                        track.solo ? 'bg-white text-black' : 'bg-app text-mute hover:text-ink'
                      }`}
                    >
                      S
                    </button>
                    <RangeInput
                      value={track.volume}
                      min={0}
                      max={1.4}
                      step={0.01}
                      defaultValue={0.85}
                      className="flex-1 min-w-0 ml-0.5"
                      onChange={(v) => onUpdateTrack(track.id, { volume: v })}
                    />
                  </div>

                  {/* Level meter hairline */}
                  <div className="absolute left-0 right-0 bottom-0 h-0.5 bg-transparent">
                    <TrackLevelBar trackId={track.id} color={track.color} />
                  </div>
                </div>

                {/* Clip lane */}
                <div
                  onClick={() => onSelectTrack(track.id)}
                  style={gridStyle}
                  className={`relative ${isSelected ? 'bg-[#141418]' : ''}`}
                >
                  {clips
                    .filter((c) => c.trackId === track.id)
                    .map((clip) => (
                      <TimelineClipItem
                        key={clip.id}
                        clip={clip}
                        pixelsPerSecond={pps}
                        isSelected={clip.id === selectedClipId}
                        snapToGrid={snapToGrid}
                        bpm={bpm}
                        onSelectClip={onSelectClip}
                        onUpdateClip={onUpdateClip}
                      />
                    ))}
                  {recording && recording.trackId === track.id && (
                    <RecordingBlock startTime={recording.startTime} pps={pps} />
                  )}
                </div>
              </div>
            );
          })}

          {/* Playhead */}
          <PlayheadLine offsetPx={headerW} pps={pps} />
        </div>
      </div>
    </div>
  );
};
