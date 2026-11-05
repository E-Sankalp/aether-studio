import React from 'react';
import { Spline, Trash2 } from 'lucide-react';
import { AudioClip, AudioTrack, LoopRegion } from '../types/audio';
import { TimelineClipItem } from './TimelineClipItem';
import { AutomationLane } from './AutomationLane';
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

/** Draggable loop region in the ruler: drag the body to move it, the edges to resize it. */
const LoopRegionBar: React.FC<{
  loop: LoopRegion;
  pps: number;
  /** Snap step in seconds (0 = no snapping) */
  snapSec: number;
  onChange?: (loop: LoopRegion) => void;
}> = ({ loop, pps, snapSec, onChange }) => {
  const snap = (t: number) => (snapSec > 0 ? Math.round(t / snapSec) * snapSec : t);
  const minLen = snapSec > 0 ? snapSec : 0.25;

  const drag = (e: React.PointerEvent, mode: 'move' | 'start' | 'end') => {
    if (!onChange) return;
    e.stopPropagation(); // don't seek
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const { start: s0, end: e0 } = loop;
    const onMove = (pe: PointerEvent) => {
      const dt = (pe.clientX - x0) / pps;
      if (mode === 'move') {
        const start = Math.max(0, snap(s0 + dt));
        onChange({ ...loop, start, end: start + (e0 - s0) });
      } else if (mode === 'start') {
        onChange({ ...loop, start: Math.max(0, Math.min(e0 - minLen, snap(s0 + dt))) });
      } else {
        onChange({ ...loop, end: Math.max(s0 + minLen, snap(e0 + dt)) });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      style={{ left: loop.start * pps, width: Math.max(0, (loop.end - loop.start) * pps) }}
      className="absolute top-0 bottom-0 z-10"
    >
      <div
        onPointerDown={(e) => drag(e, 'move')}
        title="Drag to move the loop"
        className={`absolute inset-x-0 top-0 h-2.5 bg-accent/70 rounded-b-sm ${onChange ? 'cursor-grab active:cursor-grabbing' : ''}`}
      />
      <div className="absolute inset-0 bg-accent/12 border-x border-accent/70 pointer-events-none" />
      {onChange && (
        <>
          <div
            onPointerDown={(e) => drag(e, 'start')}
            title="Drag to set loop start"
            className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-ew-resize"
          />
          <div
            onPointerDown={(e) => drag(e, 'end')}
            title="Drag to set loop end"
            className="absolute -right-1.5 top-0 bottom-0 w-3 cursor-ew-resize"
          />
        </>
      )}
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
  /** All selected clips (multi-selection) */
  selectedClipIds: string[];
  loop: LoopRegion;
  bpm: number;
  pixelsPerSecond: number;
  durationSec: number;
  snapToGrid: boolean;
  compact?: boolean;
  cornerSlot: React.ReactNode;
  onSelectTrack: (trackId: string) => void;
  onSelectClip: (clipId: string, trackId: string, mode?: 'toggle' | 'press' | 'click') => void;
  /** `undoKey` groups edits into one undo step (e.g. one automation gesture) */
  onUpdateTrack: (trackId: string, patch: Partial<AudioTrack>, undoKey?: string) => void;
  onUpdateClip: (clipId: string, patch: Partial<AudioClip>, commitHistory?: boolean) => void;
  /** A clip move/trim gesture ended (resolve overlaps) */
  onClipDragEnd?: (clipId: string) => void;
  /** Body drag of a clip by `dtSec` seconds (moves the whole selection) */
  onClipDragMove?: (clipId: string, dtSec: number) => void;
  onDeleteTrack: (trackId: string) => void;
  onSeek: (time: number) => void;
  /** Move/resize the loop region (drag in the ruler). Double-click a bar to loop it. */
  onLoopChange?: (loop: LoopRegion) => void;
  /** Active take being recorded; drawn as a live block on its lane. */
  recording?: { trackId: string; startTime: number } | null;
}

export const Arrangement: React.FC<ArrangementProps> = ({
  tracks,
  clips,
  selectedTrackId,
  selectedClipIds,
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
  onClipDragEnd,
  onClipDragMove,
  onDeleteTrack,
  onSeek,
  onLoopChange,
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
            onDoubleClick={(e) => {
              if (!onLoopChange) return;
              // Double-click a bar to loop it
              const left = e.currentTarget.getBoundingClientRect().left;
              const t = Math.max(0, (e.clientX - left) / pps);
              const start = Math.floor(t / barSec) * barSec;
              onLoopChange({ enabled: true, start, end: start + barSec });
            }}
            title="Click to move the playhead · double-click a bar to loop it"
            style={{ width: widthPx }}
            className="relative bg-panel border-b border-line touch-none cursor-pointer"
          >
            {loop.enabled && (
              <LoopRegionBar
                loop={loop}
                pps={pps}
                snapSec={snapToGrid ? beatSec : 0}
                onChange={onLoopChange}
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
              <React.Fragment key={track.id}>
              <div
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
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateTrack(track.id, { showAutomation: !track.showAutomation });
                      }}
                      title="Show volume automation"
                      aria-label="Show volume automation"
                      aria-pressed={!!track.showAutomation}
                      className={`${compact ? 'w-6 h-6' : 'w-7 h-7'} rounded-md transition-colors flex items-center justify-center shrink-0 ${
                        track.showAutomation
                          ? 'bg-accent/20 text-accent'
                          : (track.automation?.volume?.length ?? 0) > 0
                          ? 'bg-app text-accent/80 hover:text-accent'
                          : 'bg-app text-mute hover:text-ink'
                      }`}
                    >
                      <Spline className="w-3.5 h-3.5" />
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
                    .sort((a, b) => a.startTime - b.startTime)
                    .map((clip, i, lane) => (
                      <TimelineClipItem
                        key={clip.id}
                        clip={clip}
                        prevEnd={i > 0 ? lane[i - 1].startTime + lane[i - 1].duration : 0}
                        nextStart={i < lane.length - 1 ? lane[i + 1].startTime : Infinity}
                        onDragEnd={onClipDragEnd}
                        pixelsPerSecond={pps}
                        isSelected={selectedClipIds.includes(clip.id)}
                        onDragMove={onClipDragMove}
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
              {track.showAutomation && (
                <AutomationLane
                  track={track}
                  headerW={headerW}
                  widthPx={widthPx}
                  pps={pps}
                  snapSec={snapToGrid ? beatSec / 4 : 0}
                  onChange={(points, gesture) =>
                    onUpdateTrack(track.id, { automation: { ...track.automation, volume: points } }, gesture)
                  }
                />
              )}
              </React.Fragment>
            );
          })}

          {/* Playhead */}
          <PlayheadLine offsetPx={headerW} pps={pps} />
        </div>
      </div>
    </div>
  );
};
