import React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  Bell,
  Check,
  Headphones,
  Home as HomeIcon,
  Layers,
  Magnet,
  Pause,
  Play,
  Plus,
  Redo2,
  Repeat,
  SkipBack,
  Timer,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AetherLogo, AetherMark } from './AetherLogo';
import { ExportMenu } from './ExportMenu';
import { VisualizerDock } from './VisualizerDock';
import { ExportFormatId } from '../audio/audioEncoders';
import { micLevelStore, playheadStore, useLiveStore } from '../utils/liveStore';

/* ------------------------------- primitives -------------------------------- */

const formatTimecode = (sec: number) => {
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

/** Timecode that subscribes to the playhead itself (no header re-render per frame). */
const Timecode: React.FC<{ className?: string }> = ({ className }) => {
  const t = useLiveStore(playheadStore, (v) => Math.floor(v * 100));
  return <span className={className}>{formatTimecode(t / 100)}</span>;
};

const MicLevel: React.FC = () => {
  const level = useLiveStore(micLevelStore, (v) => Math.round(v * 100));
  return (
    <span className="relative w-8 h-1.5 rounded-full bg-black/30 overflow-hidden">
      <span
        className="absolute inset-y-0 left-0 bg-white/90 rounded-full transition-[width] duration-75"
        style={{ width: `${level}%` }}
      />
    </span>
  );
};

type Tone = 'accent' | 'green';

const toneClass: Record<Tone, string> = {
  accent: 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/35',
  green: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/35',
};

/** Square icon button used everywhere in the header (36 px desktop, 34 px compact). */
const IconButton: React.FC<{
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  tone?: Tone;
  disabled?: boolean;
  compact?: boolean;
  badge?: string;
  className?: string;
}> = ({ icon: Icon, label, onClick, active = false, tone = 'accent', disabled, compact, badge, className = '' }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
    aria-pressed={active || undefined}
    className={`relative ${compact ? 'w-[34px] h-[34px]' : 'w-9 h-9'} shrink-0 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30 disabled:pointer-events-none ${
      active ? toneClass[tone] : 'text-mute hover:text-ink hover:bg-white/[0.06]'
    } ${className}`}
  >
    <Icon className="w-[17px] h-[17px]" />
    {badge && (
      <span className="absolute bottom-1 right-1 text-[8px] font-bold leading-none font-mono">
        {badge}
      </span>
    )}
  </button>
);

/** Rounded tray that visually groups related controls. */
const Group: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <div
    className={`flex items-center gap-0.5 p-[3px] rounded-[11px] bg-black/25 border border-white/[0.06] shrink-0 ${className}`}
  >
    {children}
  </div>
);

const Divider: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span className={`w-px h-6 bg-white/[0.08] shrink-0 ${className}`} />
);

/* ------------------------------ shared pieces ------------------------------ */

export interface TransportProps {
  isPlaying: boolean;
  isRecording: boolean;
  countInBeat: number | null;
  recordTargetName: string;
  onPlayPause: () => void;
  onRewind: () => void;
  onRecord: () => void;
  loopOn: boolean;
  onToggleLoop: () => void;
  metronomeOn: boolean;
  onToggleMetronome: () => void;
  countInOn: boolean;
  onToggleCountIn: () => void;
  monitorOn: boolean;
  onToggleMonitor: () => void;
}

const PlayButton: React.FC<{ playing: boolean; onClick: () => void; size: number }> = ({
  playing,
  onClick,
  size,
}) => (
  <button
    type="button"
    onClick={onClick}
    title="Play / Pause (Space)"
    aria-label={playing ? 'Pause' : 'Play'}
    style={{ width: size, height: size }}
    className="shrink-0 rounded-full brand-gradient text-white flex items-center justify-center shadow-md shadow-accent/30 ring-1 ring-inset ring-white/20 hover:brightness-110 active:scale-95 transition"
  >
    {playing ? (
      <Pause className="w-4 h-4 fill-current" />
    ) : (
      <Play className="w-4 h-4 fill-current translate-x-[1px]" />
    )}
  </button>
);

const RecordButton: React.FC<{
  isRecording: boolean;
  countInBeat: number | null;
  targetName: string;
  onClick: () => void;
  compact?: boolean;
}> = ({ isRecording, countInBeat, targetName, onClick, compact }) => {
  const counting = countInBeat !== null;
  const label = counting
    ? 'Cancel count-in'
    : isRecording
    ? 'Stop recording'
    : `Record into "${targetName}"`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`shrink-0 h-9 rounded-lg flex items-center justify-center gap-2 font-semibold text-xs transition-colors ${
        compact ? 'w-[34px] h-[34px]' : 'min-w-[78px] px-3'
      } ${
        counting
          ? 'bg-amber-400 text-black'
          : isRecording
          ? 'bg-accent text-white shadow-md shadow-accent/30'
          : compact
          ? 'bg-white/[0.05] ring-1 ring-inset ring-white/[0.07] text-ink'
          : 'text-ink hover:bg-white/[0.06]'
      }`}
    >
      {counting ? (
        <span className="font-mono tabular-nums">{compact ? countInBeat : `${countInBeat} / 4`}</span>
      ) : (
        <>
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              isRecording ? 'bg-white animate-pulse' : 'bg-accent shadow-[0_0_8px_rgba(241,44,76,0.7)]'
            }`}
          />
          {!compact && (isRecording ? <MicLevel /> : <span>Rec</span>)}
        </>
      )}
    </button>
  );
};

const TransportToggles: React.FC<TransportProps & { compact?: boolean; hideMonitorNarrow?: boolean }> = (p) => (
  <>
    <IconButton compact={p.compact} icon={Repeat} label="Loop region" active={p.loopOn} onClick={p.onToggleLoop} />
    <IconButton compact={p.compact} icon={Bell} label="Metronome" active={p.metronomeOn} onClick={p.onToggleMetronome} />
    <IconButton
      compact={p.compact}
      icon={Timer}
      label="4-beat count-in before recording"
      badge="4"
      active={p.countInOn}
      onClick={p.onToggleCountIn}
    />
    <IconButton
      compact={p.compact}
      icon={Headphones}
      label="Live mic monitoring with track effects (use headphones)"
      tone="green"
      active={p.monitorOn}
      onClick={p.onToggleMonitor}
      className={p.hideMonitorNarrow ? 'max-[379px]:hidden' : ''}
    />
  </>
);

/** Project name field with inline save status (click the status to save now). */
const ProjectField: React.FC<{
  name: string;
  onChange: (name: string) => void;
  savedFlash: boolean;
  onSave: () => void;
  className?: string;
  /** Container-query class that reveals the "Saved" label when there's room */
  savedLabelAt?: string;
}> = ({ name, onChange, savedFlash, onSave, className = '', savedLabelAt = '@min-[380px]:inline' }) => (
  <div
    className={`group flex items-center h-9 min-w-0 rounded-lg bg-black/25 border border-white/[0.06] focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20 transition ${className}`}
  >
    <input
      value={name}
      onChange={(e) => onChange(e.target.value)}
      title="Project name (auto-saved)"
      aria-label="Project name"
      spellCheck={false}
      className="flex-1 min-w-0 h-full bg-transparent pl-3 text-[13px] font-semibold text-ink outline-none truncate"
    />
    <button
      type="button"
      onClick={onSave}
      title="Saved on this device. Click to save now."
      aria-label="Save project now"
      className={`shrink-0 h-full pl-2 pr-2.5 flex items-center gap-1 text-[11px] font-medium transition-colors ${
        savedFlash ? 'text-emerald-400' : 'text-mute hover:text-ink'
      }`}
    >
      <Check className="w-3.5 h-3.5" />
      <span className={`hidden ${savedLabelAt}`}>Saved</span>
    </button>
  </div>
);

/* ------------------------------ desktop header ----------------------------- */

export interface StudioHeaderProps extends TransportProps {
  view: 'home' | 'studio';
  /** A project session is open (it has at least one track) */
  hasSession: boolean;
  onViewChange: (view: 'home' | 'studio') => void;
  projectName: string;
  onProjectNameChange: (name: string) => void;
  savedFlash: boolean;
  onSave: () => void;
  onNewProject: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  bpm: number;
  onBpmChange: (bpm: number) => void;
  snapToGrid: boolean;
  onToggleSnap: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  isExporting: boolean;
  onExport: (format: ExportFormatId) => void;
}

/** Home / Studio segmented switch. */
const ViewSwitch: React.FC<{
  view: 'home' | 'studio';
  onViewChange: (view: 'home' | 'studio') => void;
  labelsAt?: string;
}> = ({ view, onViewChange, labelsAt = '@min-[640px]:inline' }) => (
  <Group>
    {(['home', 'studio'] as const).map((v) => {
      const Icon = v === 'home' ? HomeIcon : Layers;
      const activeView = view === v;
      return (
        <button
          key={v}
          type="button"
          onClick={() => onViewChange(v)}
          aria-label={v === 'home' ? 'Home' : 'Studio'}
          aria-pressed={activeView}
          title={v === 'home' ? 'Projects & templates' : 'Studio'}
          className={`h-[30px] px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-semibold transition-colors ${
            activeView ? 'bg-white/[0.09] text-ink' : 'text-mute hover:text-ink'
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          <span className={`hidden ${labelsAt} capitalize`}>{v}</span>
        </button>
      );
    })}
  </Group>
);

/** "Continue · <project>" chip shown on Home when a session is open. */
const ContinueButton: React.FC<{ name: string; onClick: () => void; className?: string }> = ({
  name,
  onClick,
  className = '',
}) => (
  <button
    type="button"
    onClick={onClick}
    title={`Back to "${name}"`}
    className={`min-w-0 h-9 pl-3 pr-2.5 rounded-lg bg-black/25 border border-white/[0.06] hover:border-accent/50 flex items-center gap-2 text-[13px] transition-colors ${className}`}
  >
    <span className="text-mute shrink-0">Continue</span>
    <span className="font-semibold text-ink truncate">{name}</span>
    <ArrowRight className="w-4 h-4 text-accent shrink-0" />
  </button>
);

/**
 * Home view header: no project controls (there may be no project at all). Shows the brand, the
 * view switch and, when a session is open, a way back to it.
 */
const HomeHeader: React.FC<StudioHeaderProps> = (p) => (
  <header className="app-header shrink-0 relative z-50 h-14 px-4 flex items-center gap-3">
    <AetherLogo size={34} showCaption={false} />
    <Divider className="mx-1" />
    <ViewSwitch view={p.view} onViewChange={p.onViewChange} labelsAt="inline" />
    <div className="flex-1" />
    {p.hasSession && p.view === 'home' && (
      <ContinueButton
        name={p.projectName || 'Untitled project'}
        onClick={() => p.onViewChange('studio')}
        className="max-w-[320px]"
      />
    )}
  </header>
);

export const StudioHeader: React.FC<StudioHeaderProps> = (p) =>
  p.view === 'home' || !p.hasSession ? (
    <HomeHeader {...p} />
  ) : (
  <header className="studio-header app-header shrink-0 relative z-50">
    {/* Left: brand + project */}
    <div className="studio-header__left @container min-w-0 flex items-center gap-2.5 pl-4 pr-2 h-14">
      <span className="@min-[520px]:hidden">
        <AetherMark size={34} />
      </span>
      <span className="hidden @min-[520px]:block">
        <AetherLogo size={34} showCaption={false} />
      </span>
      <Divider className="mx-1" />

      <ViewSwitch view={p.view} onViewChange={p.onViewChange} />

      <ProjectField
        name={p.projectName}
        onChange={p.onProjectNameChange}
        savedFlash={p.savedFlash}
        onSave={p.onSave}
        className="flex-1 max-w-[300px] min-w-[120px]"
        savedLabelAt="@min-[600px]:inline"
      />

      <Group>
        <IconButton icon={Plus} label="New blank project (keeps your other projects)" onClick={p.onNewProject} />
        <IconButton icon={Undo2} label="Undo (Ctrl+Z)" onClick={p.onUndo} disabled={!p.canUndo} />
        <IconButton icon={Redo2} label="Redo (Ctrl+Y)" onClick={p.onRedo} disabled={!p.canRedo} />
      </Group>
    </div>

    {/* Center: transport */}
    <div className="studio-header__transport flex items-center justify-center gap-2 px-3">
      <Group>
        <IconButton icon={SkipBack} label="Return to start" onClick={p.onRewind} />
        <PlayButton playing={p.isPlaying && !p.isRecording} onClick={p.onPlayPause} size={38} />
        <RecordButton
          isRecording={p.isRecording}
          countInBeat={p.countInBeat}
          targetName={p.recordTargetName}
          onClick={p.onRecord}
        />
      </Group>

      <Group>
        <TransportToggles {...p} />
      </Group>

      <div className="flex items-center h-[42px] rounded-[11px] bg-black/40 border border-white/[0.06] shadow-inner shadow-black/40 shrink-0">
        <Timecode className="px-3.5 font-mono text-[15px] font-medium tabular-nums brand-text w-[106px] text-center" />
        <Divider />
        <label className="flex items-baseline gap-1.5 pl-3 pr-3.5 cursor-text" title="Tempo (BPM)">
          <input
            type="number"
            min={60}
            max={200}
            value={p.bpm}
            onChange={(e) => p.onBpmChange(Math.max(60, Math.min(200, Number(e.target.value) || 120)))}
            aria-label="Tempo in BPM"
            className="no-spinner w-[3.2ch] bg-transparent font-mono text-[15px] font-medium text-ink outline-none tabular-nums text-right"
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-mute">BPM</span>
        </label>
      </div>
    </div>

    {/* Right: output */}
    {/* Not a size container: it sits in an auto-width grid column, which a container would collapse */}
    <div className="studio-header__right flex items-center justify-end gap-2 pl-2 pr-4 h-14">
      <div className="hidden min-[1100px]:block">
        <VisualizerDock isPlaying={p.isPlaying} />
      </div>
      <Group>
        <IconButton icon={Magnet} label="Snap to grid" active={p.snapToGrid} onClick={p.onToggleSnap} />
        <IconButton icon={ZoomOut} label="Zoom out" onClick={p.onZoomOut} />
        <IconButton icon={ZoomIn} label="Zoom in" onClick={p.onZoomIn} />
      </Group>
      <ExportMenu isExporting={p.isExporting} onExport={p.onExport} />
    </div>
  </header>
);

/* ------------------------------- mobile pieces ------------------------------ */

export const MobileHeader: React.FC<
  Pick<
    StudioHeaderProps,
    | 'projectName'
    | 'onProjectNameChange'
    | 'savedFlash'
    | 'onSave'
    | 'onNewProject'
    | 'canUndo'
    | 'canRedo'
    | 'onUndo'
    | 'onRedo'
    | 'hasSession'
  > & {
    /** Home tab: brand only, plus a way back to the open session */
    onHome: boolean;
    onContinue: () => void;
  }
> = (p) =>
  p.onHome ? (
    <header className="app-header shrink-0 relative z-40 h-[52px] px-3 flex items-center gap-2">
      <AetherLogo size={30} showCaption={false} />
      <div className="flex-1" />
      {p.hasSession && (
        <ContinueButton
          name={p.projectName || 'Untitled project'}
          onClick={p.onContinue}
          className="max-w-[60%]"
        />
      )}
    </header>
  ) : (
  <header className="app-header @container shrink-0 relative z-40 h-[52px] px-3 flex items-center gap-2">
    <AetherMark size={30} />
    <ProjectField
      name={p.projectName}
      onChange={p.onProjectNameChange}
      savedFlash={p.savedFlash}
      onSave={p.onSave}
      className="flex-1"
    />
    <Group>
      <IconButton compact icon={Plus} label="New blank project" onClick={p.onNewProject} />
      <IconButton compact icon={Undo2} label="Undo" onClick={p.onUndo} disabled={!p.canUndo} />
      <IconButton compact icon={Redo2} label="Redo" onClick={p.onRedo} disabled={!p.canRedo} />
    </Group>
  </header>
);

export const MobileTransport: React.FC<TransportProps> = (p) => (
  <div className="h-[60px] px-2.5 shrink-0 flex items-center justify-between gap-1.5 border-t border-line bg-panel">
    <div className="flex items-center gap-1">
      <IconButton compact icon={SkipBack} label="Return to start" onClick={p.onRewind} />
      <PlayButton playing={p.isPlaying && !p.isRecording} onClick={p.onPlayPause} size={42} />
      <RecordButton
        compact
        isRecording={p.isRecording}
        countInBeat={p.countInBeat}
        targetName={p.recordTargetName}
        onClick={p.onRecord}
      />
    </div>
    <Timecode className="font-mono text-[13px] font-medium tabular-nums brand-text" />
    <div className="flex items-center">
      <TransportToggles {...p} compact hideMonitorNarrow />
    </div>
  </div>
);
