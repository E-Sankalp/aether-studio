import React, { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRight,
  ChevronDown,
  Copy,
  Maximize2,
  RotateCcw,
  Scissors,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Trash2,
  Volume2,
  VolumeX,
  Wand2,
  Waves,
  Sparkles,
  SlidersHorizontal,
  Music2,
  Users,
} from 'lucide-react';
import {
  AudioClip,
  AudioTrack,
  BufferOperationType,
  ClipProcessSettings,
  DEFAULT_CLIP_PROCESSES,
  HarmonyMode,
  MeterLevels,
  TrackEffects,
  WaveformSelection,
} from '../types/audio';
import { audioEngine } from '../audio/audioEngine';
import { applyPresetValues, MUSIC_PRESETS, VOCAL_SCALES, VOICE_PRESETS } from '../audio/presets';
import { drawBufferWaveform } from '../utils/waveformDraw';
import { ParamSlider, RangeInput } from './ParamSlider';

export type InspectorTab = 'edit' | 'fx' | 'mixer';

/* ----------------------------- small primitives ---------------------------- */

const Section: React.FC<{
  title: string;
  defaultOpen?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, defaultOpen = false, right, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-2xl bg-panel border border-line overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen((o) => !o)}
        className="flex items-center justify-between px-4 h-12 cursor-pointer"
      >
        <span className="text-[13px] font-semibold">{title}</span>
        <div className="flex items-center gap-3">
          {right}
          <ChevronDown
            className={`w-4 h-4 text-mute transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </div>
      </div>
      {open && <div className="px-4 pb-3">{children}</div>}
    </section>
  );
};

const Switch: React.FC<{ on: boolean; onChange: (on: boolean) => void }> = ({ on, onChange }) => (
  <button
    role="switch"
    aria-checked={on}
    onClick={(e) => {
      e.stopPropagation();
      onChange(!on);
    }}
    className={`w-9 h-5 rounded-full p-0.5 transition-colors ${on ? 'bg-accent' : 'bg-raised'}`}
  >
    <span
      className={`block w-4 h-4 rounded-full bg-white transition-transform ${
        on ? 'translate-x-4' : ''
      }`}
    />
  </button>
);

const ActionButton: React.FC<{
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'accent' | 'danger';
  active?: boolean;
  badge?: string;
}> = ({ icon: Icon, label, onClick, tone = 'default', active = false, badge }) => (
  <button
    onClick={onClick}
    className={`flex items-center justify-between gap-1.5 h-9 px-2.5 rounded-lg text-xs font-medium transition-colors ${
      active
        ? 'bg-accent text-white shadow-sm shadow-accent/30'
        : tone === 'accent'
        ? 'bg-accent/15 text-accent hover:bg-accent/25'
        : tone === 'danger'
        ? 'bg-raised text-mute hover:text-accent'
        : 'bg-raised text-ink hover:bg-[#2b2b31]'
    }`}
  >
    <span className="flex items-center gap-1.5 truncate">
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
    {badge && (
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold shrink-0 ${
          active ? 'bg-black/25 text-white' : 'bg-app text-mute'
        }`}
      >
        {badge}
      </span>
    )}
  </button>
);

const EmptyState: React.FC<{ icon: LucideIcon; text: string }> = ({ icon: Icon, text }) => (
  <div className="flex flex-col items-center justify-center text-center gap-2 text-mute text-sm py-16 px-6">
    <Icon className="w-7 h-7" />
    <p>{text}</p>
  </div>
);

/* --------------------------------- tab bar --------------------------------- */

const TAB_META: { id: InspectorTab; label: string; icon: LucideIcon }[] = [
  { id: 'edit', label: 'Edit', icon: Waves },
  { id: 'fx', label: 'Effects', icon: Sparkles },
  { id: 'mixer', label: 'Mixer', icon: SlidersHorizontal },
];

export const InspectorTabs: React.FC<{
  tab: InspectorTab;
  onChange: (tab: InspectorTab) => void;
}> = ({ tab, onChange }) => (
  <div className="flex p-1 rounded-xl bg-raised">
    {TAB_META.map(({ id, label, icon: Icon }) => (
      <button
        key={id}
        onClick={() => onChange(id)}
        className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-semibold transition-colors ${
          tab === id ? 'bg-app text-ink' : 'text-mute hover:text-ink'
        }`}
      >
        <Icon className="w-3.5 h-3.5" />
        {label}
      </button>
    ))}
  </div>
);

/* -------------------------------- edit panel ------------------------------- */

interface EditPanelProps {
  selectedTrack?: AudioTrack;
  selectedClip?: AudioClip;
  selection: WaveformSelection | null;
  onSelectionChange: (sel: WaveformSelection | null) => void;
  onUpdateClip: (clipId: string, patch: Partial<AudioClip>) => void;
  onUpdateClipProcesses: (patch: Partial<ClipProcessSettings>) => void;
  onSplit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onApplyBufferOp: (op: BufferOperationType) => void;
}

const EditPanel: React.FC<EditPanelProps> = ({
  selectedTrack,
  selectedClip,
  selection,
  onSelectionChange,
  onUpdateClip,
  onUpdateClipProcesses,
  onSplit,
  onDuplicate,
  onDelete,
  onApplyBufferOp,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const buffer = selectedClip ? audioEngine.getBuffer(selectedClip.bufferId) : undefined;

  useEffect(() => {
    if (!canvasRef.current || !selectedClip || !buffer) return;
    const sel =
      selection && selection.clipId === selectedClip.id
        ? { startOffset: selection.startOffset, endOffset: selection.endOffset }
        : null;
    drawBufferWaveform(
      canvasRef.current,
      buffer,
      selectedClip.offset,
      selectedClip.duration,
      selectedClip.playbackRate,
      selectedClip.gain,
      selectedClip.fadeIn,
      selectedClip.fadeOut,
      selectedClip.color,
      sel
    );
  }, [selectedClip, buffer, selection]);

  if (!selectedClip) {
    return <EmptyState icon={Waves} text="Select a clip on the timeline to edit it." />;
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const toSec = (x: number) =>
      Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * selectedClip.duration;
    const anchor = toSec(e.clientX);
    onSelectionChange({ clipId: selectedClip.id, startOffset: anchor, endOffset: anchor });

    const onMove = (pe: PointerEvent) => {
      const cur = toSec(pe.clientX);
      onSelectionChange({
        clipId: selectedClip.id,
        startOffset: Math.min(anchor, cur),
        endOffset: Math.max(anchor, cur),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const hasSelection =
    selection &&
    selection.clipId === selectedClip.id &&
    selection.endOffset - selection.startOffset > 0.02;

  const patch = (p: Partial<AudioClip>) => onUpdateClip(selectedClip.id, p);
  const proc: ClipProcessSettings = { ...DEFAULT_CLIP_PROCESSES, ...selectedClip.processes };
  const gainDb = 20 * Math.log10(selectedClip.gain);

  // Build active process badges so the user always sees what settings are applied
  const appliedProcessItems: {
    key: string;
    label: string;
    value: string;
    onClear: () => void;
  }[] = [];

  if (proc.autoPitch > 0) {
    appliedProcessItems.push({
      key: 'autoPitch',
      label: 'Auto-Pitch',
      value: `${Math.round(proc.autoPitch)}%`,
      onClear: () => onUpdateClipProcesses({ autoPitch: 0 }),
    });
  }
  if (proc.harmony > 0) {
    appliedProcessItems.push({
      key: 'harmony',
      label: '3-Part Harmony',
      value: `${Math.round(proc.harmony)}%`,
      onClear: () => onUpdateClipProcesses({ harmony: 0 }),
    });
  }
  if (proc.voiceSoften > 0) {
    appliedProcessItems.push({
      key: 'voiceSoften',
      label: 'Voice Soften',
      value: `${Math.round(proc.voiceSoften)}%`,
      onClear: () => onUpdateClipProcesses({ voiceSoften: 0 }),
    });
  }
  if (proc.denoise > 0) {
    appliedProcessItems.push({
      key: 'denoise',
      label: 'Noise Removal',
      value: `${Math.round(proc.denoise)}%`,
      onClear: () => onUpdateClipProcesses({ denoise: 0 }),
    });
  }
  if (proc.normalize > 0) {
    appliedProcessItems.push({
      key: 'normalize',
      label: 'Normalize',
      value: `${Math.round(proc.normalize)}%`,
      onClear: () => onUpdateClipProcesses({ normalize: 0 }),
    });
  }
  if (Math.abs(proc.boostDb) >= 0.1) {
    appliedProcessItems.push({
      key: 'boostDb',
      label: 'Boost',
      value: `${proc.boostDb > 0 ? '+' : ''}${proc.boostDb.toFixed(1)} dB`,
      onClear: () => onUpdateClipProcesses({ boostDb: 0 }),
    });
  }
  if (proc.fadeInShape > 0) {
    appliedProcessItems.push({
      key: 'fadeInShape',
      label: 'Env Fade In',
      value: `${Math.round(proc.fadeInShape)}%`,
      onClear: () => onUpdateClipProcesses({ fadeInShape: 0 }),
    });
  }
  if (proc.fadeOutShape > 0) {
    appliedProcessItems.push({
      key: 'fadeOutShape',
      label: 'Env Fade Out',
      value: `${Math.round(proc.fadeOutShape)}%`,
      onClear: () => onUpdateClipProcesses({ fadeOutShape: 0 }),
    });
  }
  if (proc.reverse) {
    appliedProcessItems.push({
      key: 'reverse',
      label: 'Reversed',
      value: 'ON',
      onClear: () => onUpdateClipProcesses({ reverse: false }),
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Sticky Top Track & Clip Waveform Preview so user always sees changes while scrolling */}
      <div className="sticky top-0 z-20 bg-app pt-0.5 pb-2.5 -mx-1 px-1 border-b border-line shadow-lg shadow-black/50 flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: selectedClip.color }}
              />
              {selectedTrack && (
                <span className="text-[11px] font-medium text-mute truncate">
                  {selectedTrack.name} ·
                </span>
              )}
              <span className="text-[13px] font-semibold truncate">{selectedClip.name}</span>
            </div>
            <div className="text-[11px] text-mute font-mono mt-0.5">
              {selectedClip.duration.toFixed(2)}s · starts {selectedClip.startTime.toFixed(2)}s
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1 shrink-0 max-w-[175px]">
            {selectedClip.pitchSemitones !== 0 && (
              <span className="px-1.5 py-0.5 rounded bg-accent/20 text-accent text-[10px] font-mono font-semibold">
                {selectedClip.pitchSemitones > 0 ? '+' : ''}
                {selectedClip.pitchSemitones} st
              </span>
            )}
            {Math.abs(selectedClip.playbackRate - 1) > 0.01 && (
              <span className="px-1.5 py-0.5 rounded bg-raised text-ink text-[10px] font-mono">
                {selectedClip.playbackRate.toFixed(2)}x
              </span>
            )}
            {Math.abs(gainDb) > 0.2 && (
              <span className="px-1.5 py-0.5 rounded bg-raised text-ink text-[10px] font-mono">
                {gainDb > 0 ? '+' : ''}
                {gainDb.toFixed(1)} dB
              </span>
            )}
            {appliedProcessItems.length > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-accent/20 text-accent text-[10px] font-mono font-semibold">
                {appliedProcessItems.length} FX
              </span>
            )}
          </div>
        </div>

        {/* Waveform with region selection */}
        <div className="relative h-28 rounded-2xl bg-panel border border-line overflow-hidden touch-none cursor-crosshair">
          <canvas ref={canvasRef} onPointerDown={handlePointerDown} className="w-full h-full block" />
          <div className="absolute bottom-1.5 left-3 right-3 flex items-center justify-between text-[10px] font-mono text-mute pointer-events-none">
            <span>{hasSelection ? 'Region selected' : 'Drag waveform to select a region'}</span>
            {hasSelection && selection && (
              <span className="text-ink">
                {selection.startOffset.toFixed(2)}s – {selection.endOffset.toFixed(2)}s
              </span>
            )}
          </div>
        </div>
      </div>

      <Section title="Clip" defaultOpen>
        <div className="grid grid-cols-3 gap-2 pb-2">
          <ActionButton icon={Scissors} label="Split" onClick={onSplit} />
          <ActionButton icon={Copy} label="Duplicate" onClick={onDuplicate} />
          <ActionButton icon={Trash2} label="Delete" onClick={onDelete} tone="danger" />
        </div>
        <ParamSlider
          label="Pitch"
          value={selectedClip.pitchSemitones}
          min={-12}
          max={12}
          step={1}
          defaultValue={0}
          format={(v) => `${v > 0 ? '+' : ''}${v} st`}
          onChange={(v) => patch({ pitchSemitones: v })}
        />
        <ParamSlider
          label="Speed"
          value={selectedClip.playbackRate}
          min={0.5}
          max={2}
          step={0.05}
          defaultValue={1}
          format={(v) => `${v.toFixed(2)}x`}
          onChange={(v) => patch({ playbackRate: v })}
        />
        <ParamSlider
          label="Gain"
          value={selectedClip.gain}
          min={0.1}
          max={2}
          step={0.05}
          defaultValue={1}
          format={(v) => `${(20 * Math.log10(v)).toFixed(1)} dB`}
          onChange={(v) => patch({ gain: v })}
        />
        <ParamSlider
          label="Fade in"
          value={selectedClip.fadeIn}
          min={0}
          max={Math.max(0.1, Math.min(4, selectedClip.duration * 0.5))}
          step={0.05}
          defaultValue={0}
          format={(v) => `${v.toFixed(2)} s`}
          onChange={(v) => patch({ fadeIn: v })}
        />
        <ParamSlider
          label="Fade out"
          value={selectedClip.fadeOut}
          min={0}
          max={Math.max(0.1, Math.min(4, selectedClip.duration * 0.5))}
          step={0.05}
          defaultValue={0}
          format={(v) => `${v.toFixed(2)} s`}
          onChange={(v) => patch({ fadeOut: v })}
        />
        <button
          onClick={() => patch({ pitchSemitones: 0, playbackRate: 1, gain: 1, fadeIn: 0, fadeOut: 0 })}
          className="mt-1 flex items-center gap-1.5 text-xs text-mute hover:text-ink"
        >
          <RotateCcw className="w-3 h-3" />
          Reset clip
        </button>
      </Section>

      <Section
        title="Process audio"
        defaultOpen
        right={
          appliedProcessItems.length > 0 ? (
            <span className="px-2 py-0.5 rounded-full bg-accent/20 text-accent text-[10px] font-semibold">
              {appliedProcessItems.length} Applied
            </span>
          ) : undefined
        }
      >
        {/* Applied Settings Summary Strip */}
        <div className="mb-3 p-2.5 rounded-xl bg-app border border-line">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-ink">Applied settings</span>
            {appliedProcessItems.length > 0 && (
              <button
                onClick={() => onUpdateClipProcesses({ ...DEFAULT_CLIP_PROCESSES })}
                className="flex items-center gap-1 text-[11px] text-accent hover:underline font-medium"
              >
                <RotateCcw className="w-3 h-3" />
                Reset all
              </button>
            )}
          </div>
          {appliedProcessItems.length === 0 ? (
            <p className="text-[11px] text-mute">
              None applied yet — tap any processor or adjust the sliders below.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {appliedProcessItems.map((item) => (
                <button
                  key={item.key}
                  onClick={item.onClear}
                  title={`Click to remove ${item.label}`}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-accent/15 hover:bg-accent/25 text-accent text-[11px] font-medium transition-colors"
                >
                  <span>{item.label}:</span>
                  <span className="font-mono font-semibold">{item.value}</span>
                  <span className="text-accent/70 hover:text-white ml-0.5">×</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Quick Toggle Buttons with Active Status & Value Badges */}
        <div className="grid grid-cols-2 gap-2 pb-3">
          <ActionButton
            icon={Music2}
            label="Auto-Pitch"
            tone="accent"
            active={proc.autoPitch > 0}
            badge={proc.autoPitch > 0 ? `${Math.round(proc.autoPitch)}%` : undefined}
            onClick={() => onApplyBufferOp('autoPitch')}
          />
          <ActionButton
            icon={Users}
            label="3-Part harmony"
            tone="accent"
            active={proc.harmony > 0}
            badge={proc.harmony > 0 ? `${Math.round(proc.harmony)}%` : undefined}
            onClick={() => onApplyBufferOp('harmony')}
          />
          <ActionButton
            icon={Wand2}
            label="Voice soften"
            tone="accent"
            active={proc.voiceSoften > 0}
            badge={proc.voiceSoften > 0 ? `${Math.round(proc.voiceSoften)}%` : undefined}
            onClick={() => onApplyBufferOp('voiceSoften')}
          />
          <ActionButton
            icon={ShieldCheck}
            label="Noise removal"
            tone="accent"
            active={proc.denoise > 0}
            badge={proc.denoise > 0 ? `${Math.round(proc.denoise)}%` : undefined}
            onClick={() => onApplyBufferOp('denoise')}
          />
          <ActionButton
            icon={Maximize2}
            label="Normalize"
            active={proc.normalize > 0}
            badge={proc.normalize > 0 ? `${Math.round(proc.normalize)}%` : undefined}
            onClick={() => onApplyBufferOp('normalize')}
          />
          <ActionButton
            icon={ArrowLeftRight}
            label="Reverse"
            active={proc.reverse}
            badge={proc.reverse ? 'ON' : undefined}
            onClick={() => onApplyBufferOp('reverse')}
          />
          <ActionButton
            icon={TrendingUp}
            label="Fade in"
            active={proc.fadeInShape > 0}
            badge={proc.fadeInShape > 0 ? `${Math.round(proc.fadeInShape)}%` : undefined}
            onClick={() => onApplyBufferOp('fadeIn')}
          />
          <ActionButton
            icon={TrendingDown}
            label="Fade out"
            active={proc.fadeOutShape > 0}
            badge={proc.fadeOutShape > 0 ? `${Math.round(proc.fadeOutShape)}%` : undefined}
            onClick={() => onApplyBufferOp('fadeOut')}
          />
          <ActionButton
            icon={Volume2}
            label="Boost +3 dB"
            active={proc.boostDb > 0}
            badge={
              Math.abs(proc.boostDb) >= 0.1
                ? `${proc.boostDb > 0 ? '+' : ''}${proc.boostDb.toFixed(0)}dB`
                : undefined
            }
            onClick={() => onApplyBufferOp('boost')}
          />
          <ActionButton icon={VolumeX} label="Silence region" onClick={() => onApplyBufferOp('silence')} />
        </div>

        {/* Fine-Tune Process Sliders */}
        <div className="pt-2 border-t border-line">
          <div className="text-[11px] font-semibold text-mute uppercase tracking-wider mb-1">
            Fine-tune process intensity
          </div>
          <ParamSlider
            label="Auto-Pitch tune"
            value={proc.autoPitch}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => onUpdateClipProcesses({ autoPitch: v })}
          />
          <ParamSlider
            label="3-Part harmony"
            value={proc.harmony}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => onUpdateClipProcesses({ harmony: v })}
          />
          <ParamSlider
            label="Voice soften"
            value={proc.voiceSoften}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => onUpdateClipProcesses({ voiceSoften: v })}
          />
          <ParamSlider
            label="Noise removal"
            value={proc.denoise}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => onUpdateClipProcesses({ denoise: v })}
          />
          <ParamSlider
            label="Normalize peak"
            value={proc.normalize}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => onUpdateClipProcesses({ normalize: v })}
          />
          <ParamSlider
            label="Gain boost / cut"
            value={proc.boostDb}
            min={-12}
            max={12}
            step={0.5}
            defaultValue={0}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
            onChange={(v) => onUpdateClipProcesses({ boostDb: v })}
          />
          <ParamSlider
            label="Envelope fade in"
            value={proc.fadeInShape}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => onUpdateClipProcesses({ fadeInShape: v })}
          />
          <ParamSlider
            label="Envelope fade out"
            value={proc.fadeOutShape}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => onUpdateClipProcesses({ fadeOutShape: v })}
          />
        </div>
      </Section>
    </div>
  );
};

/* ------------------------------- effects panel ----------------------------- */

const HARMONY_MODES: { id: HarmonyMode; label: string; desc: string }[] = [
  { id: 'doubler', label: 'Doubler', desc: 'Thick stereo double' },
  { id: 'thirds', label: '3rd & 5th', desc: 'Musical triad intervals' },
  { id: 'octave', label: 'Octave', desc: 'Wide high/low stack' },
  { id: 'choir', label: 'Choir', desc: 'Lush ensemble voices' },
];

const REVERB_SPACES: { label: string; mix: number; decay: number; delayMix: number }[] = [
  { label: 'Dry / Off', mix: 0, decay: 1.0, delayMix: 0 },
  { label: 'Warm Room', mix: 0.14, decay: 1.1, delayMix: 0 },
  { label: 'Vocal Plate', mix: 0.25, decay: 1.9, delayMix: 0.1 },
  { label: 'Concert Hall', mix: 0.42, decay: 3.2, delayMix: 0.2 },
  { label: 'Cathedral', mix: 0.58, decay: 4.5, delayMix: 0.28 },
];

const pct = (v: number) => `${Math.round(v)}%`;
const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

interface EffectsPanelProps {
  selectedTrack?: AudioTrack;
  selectedClip?: AudioClip;
  onUpdateTrackEffects: (trackId: string, fxPatch: Partial<TrackEffects>) => void;
  onApplyBufferOp: (op: BufferOperationType) => void;
}

const EffectsPanel: React.FC<EffectsPanelProps> = ({
  selectedTrack,
  selectedClip,
  onUpdateTrackEffects,
  onApplyBufferOp,
}) => {
  const eqCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Frequency response preview (EQ + voice softener + noise filters)
  useEffect(() => {
    const canvas = eqCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !selectedTrack) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const midY = height / 2;

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    ctx.fillStyle = '#6b6b73';
    ctx.font = '9px JetBrains Mono, monospace';
    [100, 1000, 10000].forEach((f) => {
      const x = (Math.log10(f / 20) / Math.log10(1000)) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, height - 4);
    });

    const fx = selectedTrack.effects;
    const nr = (fx.noiseRemoval ?? 0) / 100;
    const soft = (fx.voiceSoftener ?? 0) / 100;
    const hpCut = 20 + nr * 135;
    const lpCut = 20000 - Math.pow(nr, 0.85) * 14500;

    ctx.beginPath();
    for (let px = 0; px <= width; px += 2) {
      const freq = 20 * Math.pow(1000, px / width);
      const low = fx.eqLowGain / (1 + Math.pow(freq / 130, 2.2));
      const oct = Math.log2(freq / fx.eqMidFreq);
      const bw = 1.2 / Math.max(0.3, fx.eqMidQ);
      const mid = fx.eqMidGain * Math.exp(-(oct * oct) / (2 * bw * bw));
      const high = (fx.eqHighGain - soft * 2.5) / (1 + Math.pow(5500 / freq, 2.2));
      const warm = soft * 4.5 * Math.exp(-Math.pow(Math.log2(freq / 240), 2) / 0.8);
      const deEss = -soft * 11 * Math.exp(-Math.pow(Math.log2(freq / 4600), 2) / 0.25);
      const hp = nr > 0.01 && freq < hpCut ? -18 * Math.pow(1 - freq / hpCut, 1.6) : 0;
      const lp =
        nr > 0.01 && freq > lpCut ? -18 * Math.pow((freq - lpCut) / (20000 - lpCut), 1.4) : 0;
      const total = Math.max(-18, Math.min(18, low + mid + high + warm + deEss + hp + lp));
      const py = midY - (total / 20) * (height * 0.45);
      if (px === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#f12c4c';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(width, midY);
    ctx.lineTo(0, midY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(241,44,76,0.12)';
    ctx.fill();
    ctx.restore();
  }, [selectedTrack]);

  if (!selectedTrack) {
    return <EmptyState icon={Sparkles} text="Select a track to shape its sound." />;
  }

  const fx = selectedTrack.effects;
  const set = (p: Partial<TrackEffects>) => onUpdateTrackEffects(selectedTrack.id, p);

  return (
    <div className="flex flex-col gap-3">
      {/* Sticky Top Track & Live Sound Curve Header so user always sees changes while scrolling */}
      <div className="sticky top-0 z-20 bg-app pt-0.5 pb-2.5 -mx-1 px-1 border-b border-line shadow-lg shadow-black/50 flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: selectedTrack.color }}
            />
            <span className="text-[13px] font-semibold truncate">{selectedTrack.name}</span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
            {(fx.autoPitchAmount ?? 0) > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-accent/20 text-accent text-[10px] font-mono font-semibold">
                Tune {Math.round(fx.autoPitchAmount ?? 0)}%
              </span>
            )}
            {(fx.harmonyAmount ?? 0) > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-raised text-ink text-[10px] font-mono">
                Harm {Math.round(fx.harmonyAmount ?? 0)}%
              </span>
            )}
            {fx.reverbMix > 0.01 && (
              <span className="px-1.5 py-0.5 rounded bg-raised text-ink text-[10px] font-mono">
                Rev {Math.round(fx.reverbMix * 100)}%
              </span>
            )}
          </div>
        </div>

        <div className="relative h-20 rounded-xl bg-panel border border-line overflow-hidden">
          <canvas ref={eqCanvasRef} className="w-full h-full block" />
          <div className="absolute top-1.5 left-2.5 right-2.5 flex items-center justify-between text-[10px] font-mono text-mute pointer-events-none">
            <span>Live Tone & Vocal Filter Curve</span>
            <span>
              Soften {Math.round(fx.voiceSoftener ?? 0)}% · Denoise {Math.round(fx.noiseRemoval ?? 0)}%
            </span>
          </div>
        </div>
      </div>

      {/* Voice & Singing Presets (Singing, Podcast, Storytelling, Broadcast) */}
      <Section title="Voice & Singing Presets" defaultOpen>
        <div className="grid grid-cols-2 gap-2 pt-0.5">
          {VOICE_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => set(applyPresetValues(p))}
              className="text-left p-2.5 rounded-xl bg-raised hover:bg-[#2b2b31] border border-transparent hover:border-accent/40 transition-colors"
            >
              <span className="block text-xs font-semibold text-ink">{p.label}</span>
              <span className="block text-[11px] text-mute leading-tight mt-0.5">{p.desc}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pt-2.5">
          {MUSIC_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => set(applyPresetValues(p))}
              className="shrink-0 h-7 px-2.5 rounded-full bg-raised text-[11px] font-medium text-ink hover:bg-[#2b2b31]"
            >
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      {/* Auto-Pitch (Vocal Tuner) & Vocal Harmony / Choir */}
      <Section title="Pitch & Vocal Harmony" defaultOpen>
        <div className="text-[11px] font-medium text-mute mb-1.5">Musical Key / Scale</div>
        <div className="flex flex-wrap gap-1.5 pb-2">
          {VOCAL_SCALES.map((sc) => {
            const active = (fx.autoPitchScale ?? 'C_major') === sc.id;
            return (
              <button
                key={sc.id}
                onClick={() => set({ autoPitchScale: sc.id })}
                className={`h-7 px-2.5 rounded-lg text-[11px] font-medium transition-colors ${
                  active ? 'bg-accent text-white' : 'bg-raised text-ink hover:bg-[#2b2b31]'
                }`}
              >
                {sc.label}
              </button>
            );
          })}
        </div>
        <ParamSlider
          label="Auto-Pitch retune"
          value={fx.autoPitchAmount ?? 0}
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          format={pct}
          onChange={(v) => set({ autoPitchAmount: v })}
        />
        {selectedClip && (
          <div className="pb-2">
            <button
              onClick={() => onApplyBufferOp('autoPitch')}
              className="w-full h-8 rounded-lg bg-accent/15 hover:bg-accent/25 text-accent text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
            >
              <Music2 className="w-3.5 h-3.5" />
              Bake Auto-Pitch to clip ({selectedClip.name})
            </button>
          </div>
        )}

        <div className="text-[11px] font-medium text-mute mt-1 mb-1.5">Harmony / Choir Voicing</div>
        <div className="grid grid-cols-2 gap-1.5 pb-2">
          {HARMONY_MODES.map((hm) => {
            const active = (fx.harmonyMode ?? 'doubler') === hm.id;
            return (
              <button
                key={hm.id}
                onClick={() => set({ harmonyMode: hm.id })}
                className={`text-left px-2.5 py-1.5 rounded-lg transition-colors ${
                  active
                    ? 'bg-accent text-white'
                    : 'bg-raised text-ink hover:bg-[#2b2b31]'
                }`}
              >
                <span className="block text-xs font-semibold">{hm.label}</span>
                <span
                  className={`block text-[10px] ${active ? 'text-white/80' : 'text-mute'}`}
                >
                  {hm.desc}
                </span>
              </button>
            );
          })}
        </div>
        <ParamSlider
          label="Harmony blend"
          value={fx.harmonyAmount ?? 0}
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          format={pct}
          onChange={(v) => set({ harmonyAmount: v })}
        />
        {selectedClip && (
          <div className="pt-1">
            <button
              onClick={() => onApplyBufferOp('harmony')}
              className="w-full h-8 rounded-lg bg-raised hover:bg-[#2b2b31] text-ink text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
            >
              <Users className="w-3.5 h-3.5 text-accent" />
              Render 3-Part Harmony onto clip
            </button>
          </div>
        )}
      </Section>

      {/* Reverb & Room Space Quick Selector */}
      <Section title="Reverb & Space" defaultOpen>
        <div className="flex flex-wrap gap-1.5 pb-2">
          {REVERB_SPACES.map((sp) => {
            const isCurrent = Math.abs(fx.reverbMix - sp.mix) < 0.04;
            return (
              <button
                key={sp.label}
                onClick={() =>
                  set({ reverbMix: sp.mix, reverbDecay: sp.decay, delayMix: sp.delayMix })
                }
                className={`h-7 px-2.5 rounded-lg text-[11px] font-medium transition-colors ${
                  isCurrent
                    ? 'bg-accent text-white'
                    : 'bg-raised text-ink hover:bg-[#2b2b31]'
                }`}
              >
                {sp.label}
              </button>
            );
          })}
        </div>
        <ParamSlider
          label="Reverb amount"
          value={Math.round(fx.reverbMix * 100)}
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          format={pct}
          onChange={(v) => set({ reverbMix: v / 100 })}
        />
        <ParamSlider
          label="Room decay"
          value={fx.reverbDecay}
          min={0.4}
          max={4.8}
          step={0.1}
          defaultValue={1.8}
          format={(v) => `${v.toFixed(1)} s`}
          onChange={(v) => set({ reverbDecay: v })}
        />
        <ParamSlider
          label="Echo / Delay"
          value={Math.round(fx.delayMix * 100)}
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          format={pct}
          onChange={(v) => set({ delayMix: v / 100 })}
        />
      </Section>

      <Section title="Voice cleanup" defaultOpen>
        <ParamSlider
          label="Voice softener"
          value={fx.voiceSoftener ?? 0}
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          format={pct}
          onChange={(v) => set({ voiceSoftener: v })}
        />
        <ParamSlider
          label="Noise removal"
          value={fx.noiseRemoval ?? 0}
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          format={pct}
          onChange={(v) => set({ noiseRemoval: v })}
        />
      </Section>

      <Section title="Dry / Wet" defaultOpen>
        <ParamSlider
          label="Dry signal"
          value={fx.dryLevel ?? 100}
          min={0}
          max={150}
          step={1}
          defaultValue={100}
          format={pct}
          onChange={(v) => set({ dryLevel: v })}
        />
        <ParamSlider
          label="Wet effects"
          value={fx.wetLevel ?? 100}
          min={0}
          max={150}
          step={1}
          defaultValue={100}
          format={pct}
          onChange={(v) => set({ wetLevel: v })}
        />
      </Section>

      <Section title="Equalizer">
        <ParamSlider label="Low · 110 Hz" value={fx.eqLowGain} min={-18} max={18} step={0.5} defaultValue={0} format={db} onChange={(v) => set({ eqLowGain: v })} />
        <ParamSlider label="Mid gain" value={fx.eqMidGain} min={-18} max={18} step={0.5} defaultValue={0} format={db} onChange={(v) => set({ eqMidGain: v })} />
        <ParamSlider label="Mid frequency" value={fx.eqMidFreq} min={250} max={5000} step={50} defaultValue={1200} format={(v) => `${Math.round(v)} Hz`} onChange={(v) => set({ eqMidFreq: v })} />
        <ParamSlider label="Mid Q" value={fx.eqMidQ} min={0.3} max={8} step={0.1} defaultValue={1.2} format={(v) => v.toFixed(1)} onChange={(v) => set({ eqMidQ: v })} />
        <ParamSlider label="High · 7.5 kHz" value={fx.eqHighGain} min={-18} max={18} step={0.5} defaultValue={0} format={db} onChange={(v) => set({ eqHighGain: v })} />
      </Section>

      <Section
        title="Compressor"
        right={<Switch on={fx.compEnabled} onChange={(on) => set({ compEnabled: on })} />}
      >
        <ParamSlider label="Threshold" value={fx.compThreshold} min={-50} max={0} step={1} defaultValue={-24} format={(v) => `${v} dB`} onChange={(v) => set({ compThreshold: v })} />
        <ParamSlider label="Ratio" value={fx.compRatio} min={1} max={20} step={0.5} defaultValue={4} format={(v) => `${v.toFixed(1)}:1`} onChange={(v) => set({ compRatio: v })} />
        <ParamSlider label="Attack" value={fx.compAttack * 1000} min={1} max={150} step={1} defaultValue={10} format={(v) => `${Math.round(v)} ms`} onChange={(v) => set({ compAttack: v / 1000 })} />
        <ParamSlider label="Release" value={fx.compRelease * 1000} min={20} max={800} step={10} defaultValue={150} format={(v) => `${Math.round(v)} ms`} onChange={(v) => set({ compRelease: v / 1000 })} />
        <ParamSlider label="Tube drive" value={fx.drive} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={(v) => set({ drive: v })} />
      </Section>

      <Section title="Delay & Echo Timing">
        <ParamSlider label="Mix" value={Math.round(fx.delayMix * 100)} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={(v) => set({ delayMix: v / 100 })} />
        <ParamSlider label="Time" value={Math.round(fx.delayTime * 1000)} min={60} max={900} step={5} defaultValue={375} format={(v) => `${Math.round(v)} ms`} onChange={(v) => set({ delayTime: v / 1000 })} />
        <ParamSlider label="Feedback" value={Math.round(fx.delayFeedback * 100)} min={0} max={85} step={1} defaultValue={35} format={pct} onChange={(v) => set({ delayFeedback: v / 100 })} />
      </Section>
    </div>
  );
};

/* -------------------------------- mixer panel ------------------------------ */

interface MixerPanelProps {
  tracks: AudioTrack[];
  selectedTrack?: AudioTrack;
  meterLevels: MeterLevels;
  masterVolume: number;
  onMasterVolume: (v: number) => void;
  onUpdateTrack: (trackId: string, patch: Partial<AudioTrack>) => void;
}

const MixerPanel: React.FC<MixerPanelProps> = ({
  tracks,
  selectedTrack,
  meterLevels,
  masterVolume,
  onMasterVolume,
  onUpdateTrack,
}) => {
  const volText = (v: number) => (v <= 0.001 ? '-∞' : `${(20 * Math.log10(v)).toFixed(1)} dB`);
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl bg-panel border border-line px-4 py-3">
        <div className="flex items-center justify-between text-[13px] font-semibold mb-1">
          <span>Master</span>
          <span className="font-mono text-xs text-mute">{volText(masterVolume)}</span>
        </div>
        <RangeInput
          value={masterVolume}
          min={0}
          max={1.4}
          step={0.01}
          defaultValue={1}
          className="w-full mt-2"
          onChange={onMasterVolume}
        />
      </div>

      {tracks.map((track) => {
        const level = meterLevels.trackLevels[track.id] || 0;
        return (
          <div
            key={track.id}
            onClick={() => onUpdateTrack(track.id, {})}
            className={`rounded-2xl bg-panel border px-4 py-3 ${
              selectedTrack?.id === track.id ? 'border-white/30' : 'border-line'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-5 rounded-full shrink-0" style={{ backgroundColor: track.color }} />
                <span className="text-[13px] font-semibold truncate">{track.name}</span>
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateTrack(track.id, { muted: !track.muted });
                  }}
                  className={`w-7 h-7 rounded-md text-[11px] font-bold ${
                    track.muted ? 'bg-amber-400 text-black' : 'bg-app text-mute'
                  }`}
                >
                  M
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateTrack(track.id, { solo: !track.solo });
                  }}
                  className={`w-7 h-7 rounded-md text-[11px] font-bold ${
                    track.solo ? 'bg-white text-black' : 'bg-app text-mute'
                  }`}
                >
                  S
                </button>
              </div>
            </div>

            <div className="h-1 rounded-full bg-app overflow-hidden mb-3">
              <div
                className="h-full transition-[width] duration-75"
                style={{ width: `${Math.min(100, level * 100)}%`, backgroundColor: track.color }}
              />
            </div>

            <ParamSlider
              label="Volume"
              value={track.volume}
              min={0}
              max={1.4}
              step={0.01}
              defaultValue={0.85}
              format={volText}
              onChange={(v) => onUpdateTrack(track.id, { volume: v })}
            />
            <ParamSlider
              label="Pan"
              value={track.pan}
              min={-1}
              max={1}
              step={0.05}
              defaultValue={0}
              format={(v) =>
                Math.abs(v) < 0.04 ? 'Center' : v < 0 ? `${Math.round(-v * 100)}% L` : `${Math.round(v * 100)}% R`
              }
              onChange={(v) => onUpdateTrack(track.id, { pan: v })}
            />
          </div>
        );
      })}
    </div>
  );
};

/* --------------------------------- inspector ------------------------------- */

interface InspectorProps extends EditPanelProps, EffectsPanelProps, MixerPanelProps {
  tab: InspectorTab;
}

export const Inspector: React.FC<InspectorProps> = ({ tab, ...props }) => {
  if (tab === 'edit') return <EditPanel {...props} />;
  if (tab === 'fx') return <EffectsPanel {...props} />;
  return <MixerPanel {...props} />;
};
