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
  Music2,
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
}[] = [
  {
    id: 'singing',
    title: 'Singing',
    desc: 'Record your voice with a studio vocal chain: reverb, echo and a smooth, airy tone.',
    includes: 'Studio singer preset · Backing lane',
    icon: Mic,
    color: '#f12c4c',
  },
  {
    id: 'podcast',
    title: 'Podcast',
    desc: 'Clear, present speech with background noise reduced for host and guest.',
    includes: 'Podcast preset · Host, Guest, Music',
    icon: Radio,
    color: '#ff8a1f',
  },
  {
    id: 'story',
    title: 'Storytelling',
    desc: 'Warm, intimate narration with a touch of room and gentle leveling.',
    includes: 'Storyteller preset · Ambience lane',
    icon: BookOpen,
    color: '#2ecc71',
  },
  {
    id: 'demo',
    title: 'Demo project',
    desc: 'Explore a ready-made four-track song to try every tool.',
    includes: 'Drums · Bass · Chords · Lead',
    icon: Headphones,
    color: '#1fb6ff',
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
      <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-accent flex items-center justify-center">
            <Music2 className="w-5 h-5 text-white" />
          </div>
          <span className="text-lg font-bold tracking-tight">Aether</span>
        </div>

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

      <h1 className="text-3xl md:text-4xl font-bold tracking-tight">What will you create?</h1>
      <p className="text-mute mt-2 mb-8 text-[15px]">
        Start from a blank canvas, pick a template, or open any of your permanently saved projects.
      </p>

      {/* Primary actions */}
      <div className="grid gap-3 md:grid-cols-3 mb-10">
        <button
          onClick={() => onStart('scratch')}
          className="md:col-span-1 text-left rounded-3xl bg-accent p-5 flex flex-col justify-between min-h-[150px] hover:brightness-110 transition"
        >
          <span className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center">
            <Plus className="w-5 h-5 text-white" />
          </span>
          <span>
            <span className="block text-lg font-bold text-white">Start from scratch</span>
            <span className="block text-sm text-white/80 mt-0.5">
              Creates a new blank project (keeps your old projects saved)
            </span>
          </span>
        </button>

        <button
          onClick={onImport}
          className="text-left rounded-3xl bg-panel border border-line p-5 flex flex-col justify-between min-h-[150px] hover:bg-raised transition-colors"
        >
          <span className="w-10 h-10 rounded-2xl bg-raised flex items-center justify-center">
            <Upload className="w-5 h-5" />
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
            className="text-left rounded-3xl bg-panel border border-line p-5 flex flex-col justify-between min-h-[150px] hover:bg-raised transition-colors"
          >
            <span className="w-10 h-10 rounded-2xl bg-raised flex items-center justify-center">
              <ArrowRight className="w-5 h-5" />
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
        {TEMPLATES.map(({ id, title, desc, includes, icon: Icon, color }) => (
          <button
            key={id}
            onClick={() => onStart(id)}
            className="text-left rounded-2xl bg-panel border border-line p-4 flex gap-4 hover:bg-raised transition-colors"
          >
            <span
              className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center"
              style={{ backgroundColor: `${color}26`, color }}
            >
              <Icon className="w-6 h-6" />
            </span>
            <span className="min-w-0">
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
