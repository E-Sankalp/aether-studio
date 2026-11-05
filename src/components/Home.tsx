import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  BookOpen,
  Download,
  FolderOpen,
  HardDrive,
  Headphones,
  Mic,
  MoreHorizontal,
  Plus,
  Radio,
  Search,
  Trash2,
  Upload,
  Scissors,
  Wand2,
  SlidersHorizontal,
  Gauge,
  ShieldCheck,
} from 'lucide-react';
import { TemplateId } from '../audio/projectTemplates';
import { PersistedProjectState } from '../utils/projectStorage';

interface HomeProps {
  trackCount: number;
  activeProjectId: string;
  savedProjects: PersistedProjectState[];
  storageInfo: { persisted: boolean; usedMb: number };
  onStart: (template: TemplateId) => void;
  onImport: () => void;
  onContinue: () => void;
  onOpenProject: (project: PersistedProjectState) => void;
  onDeleteProject: (projectId: string) => void;
  onExportProjectFile: (project: PersistedProjectState) => void;
  onImportProjectFile: () => void;
  onClearAllData: () => void;
}

const TEMPLATES: {
  id: TemplateId;
  title: string;
  desc: string;
  tags: string[];
  icon: LucideIcon;
  color: string;
  image: string;
}[] = [
  {
    id: 'singing',
    title: 'Singing',
    desc: 'Studio vocal chain with reverb, echo and a smooth, airy tone.',
    tags: ['Vocal preset', 'Backing lane'],
    icon: Mic,
    color: '#f12c4c',
    image: '/images/thumbs/singing.webp',
  },
  {
    id: 'podcast',
    title: 'Podcast',
    desc: 'Clear, present speech with background noise reduced.',
    tags: ['Host', 'Guest', 'Music'],
    icon: Radio,
    color: '#ff8a1f',
    image: '/images/thumbs/podcast.webp',
  },
  {
    id: 'story',
    title: 'Storytelling',
    desc: 'Warm, intimate narration with a touch of room.',
    tags: ['Narration', 'Ambience'],
    icon: BookOpen,
    color: '#2ecc71',
    image: '/images/thumbs/story.webp',
  },
  {
    id: 'demo',
    title: 'Demo song',
    desc: 'A ready-made four-track beat to explore every tool.',
    tags: ['Drums', 'Bass', 'Chords', 'Lead'],
    icon: Headphones,
    color: '#1fb6ff',
    image: '/images/thumbs/demo.webp',
  },
];

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Mic,
    title: 'Record with confidence',
    text: 'Record vocals, instruments or voice-overs with a 4-beat count-in and metronome. Takes are lined up with the beat automatically, and loop recording captures a fresh take on every pass.',
  },
  {
    icon: Scissors,
    title: 'Edit and comp takes',
    text: 'Split, trim, move and copy clips across tracks, then pick the best take for each part of a line. Every change can be undone.',
  },
  {
    icon: Wand2,
    title: 'Pro vocal tools',
    text: 'Pitch correction that keeps your natural voice, noise removal that learns your room, and a de-esser that only touches harsh “s” sounds.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Mix like a studio',
    text: 'EQ, compression and saturation on every track, a shared reverb and tempo-synced delay, plus volume automation to ride every word.',
  },
  {
    icon: Gauge,
    title: 'Master and export',
    text: 'One-click mastering to streaming loudness (−14 LUFS) with a true-peak limiter, then export WAV (16 or 24-bit) or MP3 ready for any platform.',
  },
  {
    icon: ShieldCheck,
    title: 'Private by design',
    text: 'No account and no uploads: your projects and recordings stay on this device. Aether works offline and can be installed like an app.',
  },
];

const STEPS: { title: string; text: string }[] = [
  {
    title: 'Start a project',
    text: 'Begin from scratch, import audio, or pick a template for singing, podcasts or storytelling.',
  },
  {
    title: 'Record and shape',
    text: 'Record your takes, tidy them up with the vocal tools, and balance the mix with effects.',
  },
  {
    title: 'Master and share',
    text: 'Master to streaming loudness in one click and export a finished WAV or MP3.',
  },
];

/* --------------------------------- helpers --------------------------------- */

const relativeTime = (ts: number) => {
  if (!ts) return 'On this device';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'Just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  if (sec < 172800) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Small deterministic hash so each project gets its own cover pattern. */
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * Project cover art: waveform-style bars in the project's track colours (generated, so every
 * project is recognisable at a glance without storing an image).
 */
const ProjectCover: React.FC<{ project: PersistedProjectState; className?: string; bars?: number }> = ({
  project,
  className = '',
  bars = 28,
}) => {
  const colors = project.tracks.map((t) => t.color);
  const palette = colors.length ? colors : ['#f12c4c'];
  let seed = hash(project.id || project.name || 'x');
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return (
    <div
      className={`relative overflow-hidden flex items-center justify-center gap-[3px] px-3 ${className}`}
      style={{ background: `linear-gradient(135deg, ${palette[0]}33, #121215 70%)` }}
      aria-hidden
    >
      {Array.from({ length: bars }).map((_, i) => {
        const h = 18 + rand() * 64 * (0.55 + 0.45 * Math.sin((i / bars) * Math.PI));
        return (
          <span
            key={i}
            className="w-[3px] rounded-full opacity-90"
            style={{ height: `${h}%`, backgroundColor: palette[i % palette.length] }}
          />
        );
      })}
    </div>
  );
};

/** "⋯" menu with project actions. */
const ProjectMenu: React.FC<{
  onExport: () => void;
  onDelete: () => void;
  label: string;
}> = ({ onExport, onDelete, label }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`More actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-mute hover:text-ink hover:bg-white/[0.06] transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 w-56 rounded-xl bg-[#1c1c20] border border-line shadow-2xl shadow-black/60 p-1"
        >
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onExport();
            }}
            className="w-full h-9 px-3 rounded-lg flex items-center gap-2.5 text-[13px] text-ink hover:bg-white/[0.06]"
          >
            <Download className="w-4 h-4 text-mute" />
            Download backup (.aether)
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="w-full h-9 px-3 rounded-lg flex items-center gap-2.5 text-[13px] text-accent hover:bg-accent/10"
          >
            <Trash2 className="w-4 h-4" />
            Delete project
          </button>
        </div>
      )}
    </div>
  );
};

/** What Aether does: feature overview + how it works (explains the app to new visitors). */
const AboutAether: React.FC = () => (
  <>
    <section aria-labelledby="features-title" className="mb-10">
      <div className="max-w-2xl mb-5">
        <h2 id="features-title" className="text-lg md:text-xl font-bold tracking-tight">
          Everything from first take to finished song
        </h2>
        <p className="text-[14px] text-mute mt-1.5 leading-relaxed">
          Aether brings the tools of a recording studio to your browser, arranged so you can go from
          an idea to a release-ready track without switching apps.
        </p>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <article
            key={title}
            className="rounded-2xl bg-panel border border-white/[0.07] p-5 flex gap-4 sm:flex-col sm:gap-3"
          >
            <span className="w-10 h-10 shrink-0 rounded-xl bg-accent/10 text-accent flex items-center justify-center">
              <Icon className="w-5 h-5" />
            </span>
            <span>
              <h3 className="text-[15px] font-semibold">{title}</h3>
              <p className="text-[13px] text-mute mt-1 leading-relaxed">{text}</p>
            </span>
          </article>
        ))}
      </div>
    </section>

    <section aria-labelledby="steps-title" className="mb-10">
      <h2 id="steps-title" className="text-lg md:text-xl font-bold tracking-tight mb-4">
        How it works
      </h2>
      <ol className="grid md:grid-cols-3 gap-3 md:gap-4">
        {STEPS.map(({ title, text }, i) => (
          <li
            key={title}
            className="relative rounded-2xl border border-white/[0.07] bg-gradient-to-b from-white/[0.03] to-transparent p-5"
          >
            <span className="w-8 h-8 rounded-full brand-gradient text-white text-[13px] font-bold flex items-center justify-center shadow-md shadow-accent/30">
              {i + 1}
            </span>
            <h3 className="text-[15px] font-semibold mt-3">{title}</h3>
            <p className="text-[13px] text-mute mt-1 leading-relaxed">{text}</p>
          </li>
        ))}
      </ol>
    </section>
  </>
);

const SectionTitle: React.FC<{ title: string; right?: React.ReactNode }> = ({ title, right }) => (
  <div className="flex items-end justify-between gap-3 mb-3">
    <h2 className="text-[15px] md:text-base font-semibold tracking-tight">{title}</h2>
    {right}
  </div>
);

/* ----------------------------------- hero ---------------------------------- */

/** Pseudo-random but stable bar heights for the decorative studio preview. */
const bars = (seed: number, n: number) => {
  let x = seed;
  return Array.from({ length: n }, (_, i) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const env = 0.45 + 0.55 * Math.abs(Math.sin((i / n) * Math.PI * 2.3 + seed));
    return 18 + (x / 4294967296) * 70 * env;
  });
};

const PREVIEW_LANES = [
  { name: 'Lead vocal', color: '#f12c4c', seed: 7, from: 0.08, to: 0.92 },
  { name: 'Drums', color: '#ff8a1f', seed: 3, from: 0, to: 1 },
  { name: 'Keys', color: '#1fb6ff', seed: 11, from: 0.18, to: 0.82 },
];

/** Decorative "live studio" card for first-time visitors (pure CSS animation). */
const StudioPreview: React.FC = () => (
  <div
    aria-hidden
    className="relative rounded-2xl bg-black/45 border border-white/10 shadow-2xl shadow-black/60 overflow-hidden"
  >
    <div className="flex items-center justify-between px-4 h-11 border-b border-white/[0.07]">
      <span className="flex items-center gap-2 text-[11px] font-semibold text-white/80">
        <span className="w-2 h-2 rounded-full bg-accent shadow-[0_0_10px_rgba(241,44,76,0.9)]" />
        REC · 120 BPM
      </span>
      <span className="hero-eq flex items-end gap-[2px] h-4">
        {[0, 0.15, 0.3, 0.1, 0.25, 0.05].map((d, i) => (
          <span key={i} className="w-[3px] h-full rounded-full bg-emerald-400/80" style={{ animationDelay: `${d}s` }} />
        ))}
      </span>
    </div>
    <div className="relative px-4 py-4 flex flex-col gap-3">
      {PREVIEW_LANES.map((lane) => (
        <div key={lane.name} className="flex items-center gap-3">
          <span className="w-[74px] shrink-0 text-[10px] font-semibold text-white/60 truncate">{lane.name}</span>
          <div className="relative flex-1 h-10 rounded-lg bg-white/[0.03]">
            <div
              className="absolute inset-y-1 rounded-md flex items-center gap-[2px] px-1.5 overflow-hidden"
              style={{
                left: `${lane.from * 100}%`,
                right: `${(1 - lane.to) * 100}%`,
                backgroundColor: `${lane.color}26`,
                boxShadow: `inset 0 0 0 1px ${lane.color}55`,
              }}
            >
              {bars(lane.seed, 40).map((h, i) => (
                <span key={i} className="flex-1 rounded-full" style={{ height: `${h}%`, backgroundColor: lane.color }} />
              ))}
            </div>
          </div>
        </div>
      ))}
      {/* Playhead sweeping across the lanes */}
      <div className="absolute inset-y-2 left-[106px] right-4 pointer-events-none">
        <div className="hero-playhead absolute inset-0">
          <span className="absolute top-0 bottom-0 left-0 w-[2px] bg-white shadow-[0_0_12px_rgba(255,255,255,0.8)]" />
        </div>
      </div>
    </div>
    <div className="flex items-center justify-between px-4 h-12 border-t border-white/[0.07] bg-white/[0.02]">
      <span className="text-[11px] text-white/60">
        Master<span className="hidden sm:inline"> · Streaming preset</span>
      </span>
      <span className="flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px] font-semibold">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        −14.0 LUFS · Mastered
      </span>
    </div>
  </div>
);

/** Continue card inside the hero for returning users. */
const HeroContinue: React.FC<{
  project: PersistedProjectState;
  onContinue: () => void;
  onBackup: () => void;
}> = ({ project, onContinue, onBackup }) => (
  <section
    aria-label="Continue where you left off"
    className="rounded-2xl bg-black/45 border border-white/10 shadow-2xl shadow-black/60 overflow-hidden"
  >
    <button type="button" onClick={onContinue} className="block w-full" aria-label={`Continue ${project.name || 'project'}`}>
      <ProjectCover project={project} className="h-32 md:h-36" bars={44} />
    </button>
    <div className="p-5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
        Continue where you left off
      </span>
      <h2 className="mt-1 text-xl font-bold tracking-tight truncate">{project.name || 'Untitled project'}</h2>
      <p className="mt-1 text-[13px] text-white/60">
        {plural(project.tracks.length, 'track')} · {plural(project.clips.length, 'clip')} · {project.bpm} BPM ·
        Edited {relativeTime(project.updatedAt).toLowerCase()}
      </p>
      <div className="flex gap-2 mt-4">
        <button
          type="button"
          onClick={onContinue}
          className="flex-1 sm:flex-none justify-center whitespace-nowrap h-11 px-5 rounded-xl brand-gradient text-white text-sm font-semibold flex items-center gap-2 shadow-lg shadow-accent/30 hover:brightness-110 active:scale-[0.98] transition"
        >
          Open in studio
          <ArrowRight className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onBackup}
          aria-label="Backup project (.aether file)"
          title="Download a .aether backup"
          className="shrink-0 h-11 px-3.5 sm:px-4 rounded-xl bg-white/[0.06] border border-white/10 text-sm font-semibold text-white hover:bg-white/[0.1] transition-colors flex items-center gap-2"
        >
          <Download className="w-4 h-4 text-white/60" />
          <span className="hidden sm:inline">Backup</span>
        </button>
      </div>
    </div>
  </section>
);

const TRUST = ['No account needed', 'Works offline', 'Saved on your device', 'WAV & MP3 export'];

const Hero: React.FC<{
  current?: PersistedProjectState;
  storageInfo: { persisted: boolean; usedMb: number };
  onNewProject: () => void;
  onDemo: () => void;
  onContinue: () => void;
  onBackup: (p: PersistedProjectState) => void;
}> = ({ current, storageInfo, onNewProject, onDemo, onContinue, onBackup }) => (
  <section className="relative overflow-hidden rounded-3xl border border-white/10 mb-8 isolate">
    {/* Backdrop: studio photo, colour glows, grid texture */}
    <img
      src="/images/thumbs/hero.webp"
      alt=""
      decoding="async"
      className="absolute inset-0 -z-10 w-full h-full object-cover opacity-40"
    />
    <div className="absolute inset-0 -z-10 bg-gradient-to-r from-app via-app/90 to-app/50" />
    <div className="absolute inset-0 -z-10 bg-gradient-to-t from-app/90 via-transparent to-transparent" />
    <div className="hero-glow absolute -z-10 -top-48 -left-32 w-[560px] h-[560px] rounded-full bg-accent/25 blur-3xl" />
    <div className="hero-glow-2 absolute -z-10 -bottom-56 right-[-120px] w-[520px] h-[520px] rounded-full bg-[#ff6b3d]/15 blur-3xl" />
    <div className="hero-grid absolute inset-0 -z-10 opacity-[0.05]" />

    <div className="grid lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-8 lg:gap-10 items-center p-6 sm:p-8 lg:p-12">
      <div className="hero-in">
        <span className="inline-flex items-center gap-2 h-7 px-3 rounded-full bg-white/[0.06] border border-white/10 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/80">
          <span className="w-1.5 h-1.5 rounded-full bg-accent" />
          <span className="hidden sm:inline">{greeting()} · </span>Studio in your browser
        </span>
        <h1 className="mt-5 text-[36px] sm:text-[46px] lg:text-[48px] xl:text-[54px] leading-[1.05] font-extrabold tracking-[-0.03em]">
          Record, mix & master
          <br />
          <span className="brand-text-accent">studio-quality</span> songs.
        </h1>
        <p className="mt-4 max-w-xl text-[15px] md:text-[16px] text-white/70 leading-relaxed">
          Aether is a complete recording studio in your browser. Record vocals and podcasts, edit and tune
          your takes, mix with studio effects, and export a mastered song, all saved privately on your
          device and ready to use even offline.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onNewProject}
            className="w-full sm:w-auto justify-center h-12 px-6 rounded-xl brand-gradient text-white text-[15px] font-semibold flex items-center gap-2 shadow-xl shadow-accent/30 ring-1 ring-white/15 hover:brightness-110 active:scale-[0.98] transition"
          >
            <Plus className="w-4 h-4" />
            Start a new project
          </button>
          <button
            type="button"
            onClick={onDemo}
            className="w-full sm:w-auto justify-center h-12 px-6 rounded-xl bg-white/[0.07] border border-white/15 text-white text-[15px] font-semibold flex items-center gap-2 hover:bg-white/[0.12] active:scale-[0.98] transition"
          >
            <Headphones className="w-4 h-4" />
            Try the demo song
          </button>
        </div>
        <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-white/60">
          {TRUST.map((t) => (
            <li key={t} className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              {t}
            </li>
          ))}
          {storageInfo.usedMb > 0 && (
            <li className="flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
              {storageInfo.usedMb} MB stored
            </li>
          )}
        </ul>
      </div>

      <div className="hero-in [animation-delay:120ms]">
        {current ? (
          <HeroContinue project={current} onContinue={onContinue} onBackup={() => onBackup(current)} />
        ) : (
          <StudioPreview />
        )}
      </div>
    </div>
  </section>
);

/* ----------------------------------- page ---------------------------------- */

export const Home: React.FC<HomeProps> = ({
  trackCount,
  activeProjectId,
  savedProjects,
  storageInfo,
  onStart,
  onImport,
  onContinue,
  onOpenProject,
  onDeleteProject,
  onExportProjectFile,
  onImportProjectFile,
  onClearAllData,
}) => {
  const [query, setQuery] = useState('');
  const current = trackCount > 0 ? savedProjects.find((p) => p.id === activeProjectId) : undefined;
  const others = useMemo(() => {
    const q = query.trim().toLowerCase();
    return savedProjects
      .filter((p) => !current || p.id !== current.id)
      .filter((p) => !q || (p.name || '').toLowerCase().includes(q));
  }, [savedProjects, current, query]);

  const quickActions: { label: string; hint: string; icon: LucideIcon; onClick: () => void; primary?: boolean }[] = [
    { label: 'New project', hint: 'Start from a blank session', icon: Plus, onClick: () => onStart('scratch'), primary: true },
    { label: 'Record vocals', hint: 'Singing session, ready to record', icon: Mic, onClick: () => onStart('singing') },
    { label: 'Import audio', hint: 'WAV, MP3, OGG or FLAC', icon: Upload, onClick: onImport },
    { label: 'Open file', hint: 'A .aether project backup', icon: FolderOpen, onClick: onImportProjectFile },
  ];

  return (
    <div className="h-full overflow-y-auto bg-app text-ink">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 md:pt-10 pb-12">
        <Hero
          current={current}
          storageInfo={storageInfo}
          onNewProject={() => onStart('scratch')}
          onDemo={() => onStart('demo')}
          onContinue={onContinue}
          onBackup={onExportProjectFile}
        />

        {/* Quick actions */}
        <section aria-label="Start something new" className="mb-10">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 md:gap-3">
            {quickActions.map(({ label, hint, icon: Icon, onClick, primary }) => (
              <button
                key={label}
                type="button"
                onClick={onClick}
                className={`group text-left rounded-2xl p-4 md:p-5 flex flex-col gap-3 md:gap-4 min-h-[112px] border transition-all active:scale-[0.98] ${
                  primary
                    ? 'brand-gradient border-transparent text-white shadow-lg shadow-accent/20 hover:brightness-110'
                    : 'bg-panel border-white/[0.07] hover:border-white/[0.16] hover:bg-[#1a1a1d]'
                }`}
              >
                <span
                  className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    primary ? 'bg-white/20' : 'bg-raised text-accent'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </span>
                <span>
                  <span className="block text-[15px] font-semibold">{label}</span>
                  <span className={`block text-[12px] mt-0.5 ${primary ? 'text-white/80' : 'text-mute'}`}>
                    {hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* New visitors: explain the app before the (empty) project list */}
        {savedProjects.length === 0 && <AboutAether />}

        {/* Recent projects */}
        <section aria-label="Your projects" className="mb-10">
          <SectionTitle
            title={current ? 'Other projects' : 'Your projects'}
            right={
              savedProjects.length > 4 && (
                <label className="relative">
                  <Search className="w-3.5 h-3.5 text-mute absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search projects"
                    aria-label="Search projects"
                    className="h-9 w-44 md:w-56 pl-8 pr-3 rounded-lg bg-panel border border-line text-[13px] text-ink placeholder:text-mute outline-none focus:border-accent/60"
                  />
                </label>
              )
            }
          />
          {others.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 px-6 py-8 text-center">
              <p className="text-[14px] font-medium">
                {query ? 'No projects match your search' : current ? 'No other projects yet' : 'No projects yet'}
              </p>
              <p className="text-[13px] text-mute mt-1">
                {query
                  ? 'Try a different name.'
                  : 'Everything you create is saved automatically on this device.'}
              </p>
            </div>
          ) : (
            <>
              {/* Mobile: app-style list */}
              <ul className="md:hidden rounded-2xl border border-white/[0.07] bg-panel divide-y divide-white/[0.06] overflow-hidden">
                {others.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 pl-3 pr-1.5 py-2.5">
                    <button
                      type="button"
                      onClick={() => onOpenProject(p)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <ProjectCover project={p} className="w-12 h-12 rounded-xl shrink-0 !px-1.5 !gap-[2px]" bars={8} />
                      <span className="min-w-0">
                        <span className="block text-[14px] font-semibold truncate">{p.name || 'Untitled project'}</span>
                        <span className="block text-[12px] text-mute truncate">
                          {plural(p.tracks.length, 'track')} · {relativeTime(p.updatedAt)}
                        </span>
                      </span>
                    </button>
                    <ProjectMenu
                      label={p.name || 'project'}
                      onExport={() => onExportProjectFile(p)}
                      onDelete={() => onDeleteProject(p.id || 'prj_default')}
                    />
                  </li>
                ))}
              </ul>
              {/* Desktop: card grid */}
              <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {others.map((p) => (
                  <article
                    key={p.id}
                    className="group rounded-2xl border border-white/[0.07] bg-panel overflow-hidden hover:border-white/[0.16] transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenProject(p)}
                      className="block w-full text-left"
                      aria-label={`Open ${p.name || 'project'}`}
                    >
                      <ProjectCover project={p} className="h-28" />
                    </button>
                    <div className="flex items-center gap-2 pl-4 pr-2 py-3">
                      <button type="button" onClick={() => onOpenProject(p)} className="flex-1 min-w-0 text-left">
                        <span className="block text-[14px] font-semibold truncate">{p.name || 'Untitled project'}</span>
                        <span className="block text-[12px] text-mute truncate">
                          {plural(p.tracks.length, 'track')} · {p.bpm} BPM · {relativeTime(p.updatedAt)}
                        </span>
                      </button>
                      <ProjectMenu
                        label={p.name || 'project'}
                        onExport={() => onExportProjectFile(p)}
                        onDelete={() => onDeleteProject(p.id || 'prj_default')}
                      />
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>

        {/* Templates */}
        <section aria-label="Templates" className="mb-10">
          <SectionTitle title="Start from a template" />
          <div className="-mx-4 px-4 sm:mx-0 sm:px-0 flex sm:grid sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 overflow-x-auto sm:overflow-visible snap-x snap-mandatory pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TEMPLATES.map(({ id, title, desc, tags, icon: Icon, color, image }) => (
              <button
                key={id}
                type="button"
                onClick={() => onStart(id)}
                className="group snap-start shrink-0 w-[72%] sm:w-auto text-left rounded-2xl bg-panel border border-white/[0.07] overflow-hidden hover:border-white/[0.16] transition-colors"
              >
                <span className="relative block h-32 md:h-36 overflow-hidden">
                  <img
                    src={image}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                  />
                  <span className="absolute inset-0 bg-gradient-to-t from-panel via-panel/10 to-transparent" />
                  <span
                    className="absolute left-3 bottom-3 w-9 h-9 rounded-xl flex items-center justify-center ring-1 ring-white/15 text-white"
                    style={{ backgroundColor: `${color}cc` }}
                  >
                    <Icon className="w-[18px] h-[18px]" />
                  </span>
                </span>
                <span className="block p-4 pt-3">
                  <span className="block text-[15px] font-semibold">{title}</span>
                  <span className="block text-[13px] text-mute mt-0.5 leading-snug">{desc}</span>
                  <span className="flex flex-wrap gap-1 mt-3">
                    {tags.map((t) => (
                      <span key={t} className="px-2 py-0.5 rounded-md bg-white/[0.05] text-[11px] text-mute">
                        {t}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Returning users: the overview sits below their work */}
        {savedProjects.length > 0 && <AboutAether />}

        {/* Footer */}
        <footer className="pt-6 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-[12px] text-mute">
          <span className="inline-flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5" />
            {storageInfo.persisted ? 'Persistent storage on' : 'Stored in this browser'}
            {storageInfo.usedMb > 0 ? ` · ${storageInfo.usedMb} MB used` : ''} · Tip: use headphones when
            recording
          </span>
          {savedProjects.length > 0 && (
            <button type="button" onClick={onClearAllData} className="hover:text-accent transition-colors">
              Delete all saved data
            </button>
          )}
        </footer>
      </div>
    </div>
  );
};
