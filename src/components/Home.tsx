import React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  BookOpen,
  Download,
  FolderOpen,
  HardDrive,
  Headphones,
  Mic,
  Plus,
  Radio,
  Trash2,
  Upload,
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
  includes: string;
  icon: LucideIcon;
  color: string;
  image: string;
}[] = [
  {
    id: 'singing',
    title: 'Singing',
    desc: 'Record your voice with a studio vocal chain: reverb, echo and a smooth, airy tone.',
    includes: 'Studio singer preset · Backing lane',
    icon: Mic,
    color: '#f12c4c',
    image: '/images/singing.jpg',
  },
  {
    id: 'podcast',
    title: 'Podcast',
    desc: 'Clear, present speech with background noise reduced for host and guest.',
    includes: 'Podcast preset · Host, Guest, Music',
    icon: Radio,
    color: '#ff8a1f',
    image: '/images/podcast.jpg',
  },
  {
    id: 'story',
    title: 'Storytelling',
    desc: 'Warm, intimate narration with a touch of room and gentle leveling.',
    includes: 'Storyteller preset · Ambience lane',
    icon: BookOpen,
    color: '#2ecc71',
    image: '/images/story.jpg',
  },
  {
    id: 'demo',
    title: 'Demo project',
    desc: 'Explore a ready-made four-track song to try every tool.',
    includes: 'Drums · Bass · Chords · Lead',
    icon: Headphones,
    color: '#1fb6ff',
    image: '/images/demo.jpg',
  },
];

const formatSavedTime = (ts: number) => {
  if (!ts) return 'Saved locally';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'Saved just now';
  if (diffSec < 3600) return `Saved ${Math.floor(diffSec / 60)}m ago`;
  const d = new Date(ts);
  return `Saved ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
};

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
}) => (
  <div className="h-full overflow-y-auto bg-app text-ink">
    <div className="max-w-4xl mx-auto px-5 py-8 md:py-12">
      <div className="flex flex-wrap items-center justify-end gap-3 mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <span
            title="All tracks, settings, and recordings stay saved on your device until you delete them"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-emerald-500/15 text-emerald-400 text-xs font-medium"
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>
              On-Device Storage {storageInfo.usedMb > 0 ? `· ${storageInfo.usedMb} MB` : 'Active'}
            </span>
          </span>
          <button
            onClick={onImportProjectFile}
            className="h-8 px-3 rounded-xl bg-raised hover:bg-[#2b2b31] text-xs font-semibold text-ink flex items-center gap-1.5 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-accent" />
            Open .aether File
          </button>
        </div>
      </div>

      {/* Hero banner */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 mb-8 min-h-[220px] md:min-h-[300px] flex items-end md:items-center shadow-2xl shadow-black/50">
        <img
          src="/images/hero.jpg"
          alt=""
          className="absolute inset-0 w-full h-full object-cover object-right"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-app via-app/80 to-transparent md:via-app/60" />
        <div className="absolute inset-0 bg-gradient-to-t from-app/80 via-transparent to-transparent" />
        <div className="relative p-6 md:p-10 max-w-xl">
          <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full glass text-[11px] font-semibold uppercase tracking-[0.16em] text-white/80 mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            Your pocket studio
          </span>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight leading-[1.05]">
            What will you <span className="brand-text-accent">create</span>?
          </h1>
          <p className="text-white/70 mt-3 text-[15px]">
            Record vocals, build beats and mix songs. Start from scratch, pick a template, or open
            a saved project.
          </p>
        </div>
      </div>

      {/* Primary actions */}
      <div className="grid gap-3 md:grid-cols-3 mb-10">
        <button
          onClick={() => onStart('scratch')}
          className="card-hover relative overflow-hidden md:col-span-1 text-left rounded-3xl brand-gradient p-5 flex flex-col justify-between min-h-[150px] shadow-xl shadow-accent/25"
        >
          <span className="pointer-events-none absolute -right-8 -top-10 w-40 h-40 rounded-full bg-white/15 blur-2xl" />
          <span className="relative w-10 h-10 rounded-2xl bg-white/20 ring-1 ring-white/25 flex items-center justify-center">
            <Plus className="w-5 h-5 text-white" />
          </span>
          <span className="relative">
            <span className="block text-lg font-bold text-white">Start from scratch</span>
            <span className="block text-sm text-white/80 mt-0.5">
              Creates a new blank project (keeps your old projects saved)
            </span>
          </span>
        </button>

        <button
          onClick={onImport}
          className="card-hover text-left rounded-3xl glass p-5 flex flex-col justify-between min-h-[150px]"
        >
          <span className="w-10 h-10 rounded-2xl bg-raised flex items-center justify-center">
            <Upload className="w-5 h-5 text-accent" />
          </span>
          <span>
            <span className="block text-lg font-bold">Import audio</span>
            <span className="block text-sm text-mute mt-0.5">
              Start with a WAV, MP3, OGG or FLAC file
            </span>
          </span>
        </button>

        {trackCount > 0 ? (
          <button
            onClick={onContinue}
            className="card-hover text-left rounded-3xl glass p-5 flex flex-col justify-between min-h-[150px]"
          >
            <span className="w-10 h-10 rounded-2xl bg-raised flex items-center justify-center">
              <ArrowRight className="w-5 h-5 text-accent" />
            </span>
            <span>
              <span className="block text-lg font-bold">Continue current session</span>
              <span className="block text-sm text-mute mt-0.5">
                Back to your {trackCount} {trackCount === 1 ? 'track' : 'tracks'}
              </span>
            </span>
          </button>
        ) : (
          <div className="rounded-3xl border border-dashed border-line p-5 flex items-center text-sm text-mute min-h-[150px]">
            Tip: click a track to choose where your recording goes.
          </div>
        )}
      </div>

      {/* Saved Projects Library (Permanent On-Device Storage until user deletes) */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-mute">
              Saved Projects ({savedProjects.length})
            </h2>
            <p className="text-xs text-mute mt-0.5">
              Stored permanently on this device until you choose to delete them.
            </p>
          </div>
          {savedProjects.length > 0 && (
            <button
              onClick={onClearAllData}
              className="h-8 px-3 rounded-xl bg-raised hover:bg-accent/20 text-mute hover:text-accent text-xs font-medium flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete All Saved Data
            </button>
          )}
        </div>

        {savedProjects.length === 0 ? (
          <div className="rounded-2xl bg-panel border border-line p-6 text-center text-sm text-mute">
            No saved projects yet. Anything you record or edit is automatically saved here.
          </div>
        ) : (
          <div className="grid gap-2.5">
            {savedProjects.map((proj) => {
              const id = proj.id || 'prj_default';
              const isCurrent = id === activeProjectId;
              return (
                <div
                  key={id}
                  onClick={() => onOpenProject(proj)}
                  className={`rounded-2xl bg-panel border p-4 flex flex-wrap items-center justify-between gap-3 cursor-pointer hover:bg-raised transition-colors ${
                    isCurrent ? 'border-accent/60' : 'border-line'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold truncate">
                        {proj.name || 'Untitled Project'}
                      </span>
                      {isCurrent && (
                        <span className="px-2 py-0.5 rounded-full bg-accent/20 text-accent text-[10px] font-semibold">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-mute font-mono mt-1">
                      {proj.tracks.length} {proj.tracks.length === 1 ? 'track' : 'tracks'} ·{' '}
                      {proj.clips.length} {proj.clips.length === 1 ? 'clip' : 'clips'} · {proj.bpm}{' '}
                      BPM · {formatSavedTime(proj.updatedAt)}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenProject(proj);
                      }}
                      className="h-8 px-3 rounded-lg bg-accent text-white text-xs font-semibold hover:brightness-110"
                    >
                      Open
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onExportProjectFile(proj);
                      }}
                      title="Download a permanent .aether backup file to your device"
                      className="h-8 px-2.5 rounded-lg bg-raised hover:bg-[#2b2b31] text-ink text-xs font-medium flex items-center gap-1"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">.aether</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteProject(id);
                      }}
                      title="Delete this saved project"
                      className="h-8 w-8 rounded-lg bg-raised hover:bg-accent/20 text-mute hover:text-accent flex items-center justify-center transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Templates */}
      <h2 className="text-sm font-semibold uppercase tracking-wider text-mute mb-3">Templates</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {TEMPLATES.map(({ id, title, desc, includes, icon: Icon, color, image }) => (
          <button
            key={id}
            onClick={() => onStart(id)}
            className="card-hover group text-left rounded-2xl bg-panel border border-line overflow-hidden flex flex-col"
          >
            <span className="relative block h-36 overflow-hidden">
              <img
                src={image}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-panel via-panel/20 to-transparent" />
              <span
                className="absolute left-4 bottom-3 w-10 h-10 rounded-xl flex items-center justify-center backdrop-blur-md ring-1 ring-white/15"
                style={{ backgroundColor: `${color}55`, color: '#fff' }}
              >
                <Icon className="w-5 h-5" />
              </span>
            </span>
            <span className="block p-4 pt-3">
              <span className="block text-[15px] font-semibold">{title}</span>
              <span className="block text-[13px] text-mute mt-0.5 leading-snug">{desc}</span>
              <span className="block text-[11px] text-mute/80 font-mono mt-2">{includes}</span>
            </span>
          </button>
        ))}
      </div>

      <p className="text-xs text-mute mt-8">
        Recording tip: use headphones so the backing tracks you hear don't leak into your microphone.
      </p>
    </div>
  </div>
);
