import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AudioClip,
  AudioTrack,
  LoopRegion,
  LoudnessReport,
  MasterSettings,
  TrackEffects,
  WaveformSelection,
} from './types/audio';
import { DEFAULT_MASTER } from './audio/mastering';
import { DEFAULT_RETURNS, FxReturns } from './types/audio';
import { FxReturnsPanel } from './components/FxReturnsPanel';
import { MasteringPanel } from './components/MasteringPanel';
import { LatencyPanel } from './components/LatencyPanel';
import { notify, Toaster } from './components/Toaster';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { useUndoHistory } from './hooks/useUndoHistory';
import { useClipRendering } from './hooks/useClipRendering';
import { ShortcutHandlers, useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useStorageCleanup } from './hooks/useStorageCleanup';
import {
  clipboard,
  copyClips,
  duplicateClips,
  makeId,
  pasteClips,
  resolveGroupOverlap,
  splitClipsAt,
} from './utils/clipOps';

import { MobileHeader, MobileTransport, StudioHeader, TransportProps } from './components/StudioHeader';
import { EMPTY_METERS, meterStore, micLevelStore, playheadStore, useLiveStore } from './utils/liveStore';
import { audioEngine } from './audio/audioEngine';
import {
  DEFAULT_EFFECTS,
  generateBassStem,
  generateChordsStem,
  generateDrumsStem,
  generateLeadStem,
  generateVocalStem,
} from './audio/synthStems';
import { buildTemplate, TemplateId, TRACK_COLORS } from './audio/projectTemplates';
import { ExportMenu } from './components/ExportMenu';
import { ExportFormatId, encodeAudioBuffer, getExportFormat } from './audio/audioEncoders';
import { Arrangement } from './components/Arrangement';
import { AddTrackMenu, STEM_LABELS, StemType } from './components/AddTrackMenu';
import { Inspector, InspectorTabs, InspectorTab } from './components/Inspector';
import { Home } from './components/Home';
import {
  clearProjectLocalStorage,
  clearStoredBuffers,
  deleteProjectFromLibrary,
  exportProjectBundleFile,
  importProjectBundleFile,
  loadAllBuffersFromStorage,
  initProjectLibrary,
  subscribeStorageErrors,
  pruneUnusedBuffers,
  collectReferencedBufferIds,
  loadAllProjectsFromLibrary,
  loadProjectFromLocalStorage,
  PersistedProjectState,
  requestPersistentStorage,
  saveProjectToLocalStorage,
} from './utils/projectStorage';
import {
  Plus,
  Layers,
  Waves,
  Sparkles,
  SlidersHorizontal,
  Disc3,
  Home as HomeIcon,
} from 'lucide-react';


type MobileTab = 'home' | 'tracks' | InspectorTab | 'studio';

const MOBILE_BREAKPOINT = 900;

const TEMPLATE_TITLES: Record<TemplateId, string> = {
  scratch: 'Blank Project',
  singing: 'Singing Session',
  podcast: 'Podcast Episode',
  story: 'Storytelling Session',
  demo: 'Demo Song',
};

export const App: React.FC = () => {
  const [view, setView] = useState<'home' | 'studio'>('home');
  const [projectId, setProjectId] = useState<string>('prj_default');
  const [projectName, setProjectName] = useState<string>('My Studio Session');
  const [savedProjects, setSavedProjects] = useState<PersistedProjectState[]>([]);
  const [storageInfo, setStorageInfo] = useState<{ persisted: boolean; usedMb: number }>({
    persisted: false,
    usedMb: 0,
  });

  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [clips, setClips] = useState<AudioClip[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState('');
  // `selectedClipId` is the primary clip (shown in the Inspector); `selectedClipIds` is the full
  // multi-selection (Shift/Ctrl-click). Setting the primary clip resets the selection to it.
  const [selectedClipId, setPrimaryClipId] = useState('');
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const setSelectedClipId = useCallback((id: string) => {
    setPrimaryClipId(id);
    setSelectedClipIds(id ? [id] : []);
  }, []);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('fx');
  const [mobileTab, setMobileTab] = useState<MobileTab>('home');
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
  );
  const [showAddMenu, setShowAddMenu] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSession, setRecordingSession] = useState<{
    trackId: string;
    startTime: number;
    startedAtMs: number;
    /** Loop recording: each pass of this region becomes a take */
    loop?: { start: number; end: number } | null;
  } | null>(null);
  const setMicLevel = micLevelStore.set;
  const setPlayhead = playheadStore.set;
  // Coarse playhead (4 s steps) only to grow the timeline while playing past its end
  const playheadCoarse = useLiveStore(playheadStore, (v) => Math.floor(v / 4) * 4);
  const [bpm, setBpm] = useState(120);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(88);
  const [masterVolume, setMasterVolume] = useState(1.0);
  const [master, setMaster] = useState<MasterSettings>(DEFAULT_MASTER);
  // Shared reverb/delay return buses (saved per project)
  const [returns, setReturns] = useState<FxReturns>(DEFAULT_RETURNS);
  const [loudnessReport, setLoudnessReport] = useState<LoudnessReport | null>(null);
  const [reportStale, setReportStale] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [loop, setLoop] = useState<LoopRegion>({ enabled: false, start: 0, end: 8 });
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [countInEnabled, setCountInEnabled] = useState(true);
  const [countInBeat, setCountInBeat] = useState<number | null>(null);
  const [micMonitorOn, setMicMonitorOn] = useState(false);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  // Surface storage problems (quota full / failed writes) instead of failing silently
  useEffect(() => subscribeStorageErrors((msg) => notify(msg, 'warn')), []);

  const [selection, setSelection] = useState<WaveformSelection | null>(null);


  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectFileInputRef = useRef<HTMLInputElement | null>(null);
  const countInTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Undo/redo + the live tracks/clips ref used by async work (see hooks/useUndoHistory)
  const { past, future, liveRef, recordUndoPoint, pushHistory, undo, redo, resetHistory } =
    useUndoHistory(tracks, clips, setTracks, setClips);

  /** Applies a project's mastering settings and drops the previous loudness analysis. */
  const resetMastering = useCallback(
    (next?: Partial<MasterSettings>, nextReturns?: Partial<FxReturns>) => {
    setReturns({ ...DEFAULT_RETURNS, ...nextReturns });
    const settings = { ...DEFAULT_MASTER, ...next };
    setMaster(settings);
    setLoudnessReport(null);
    setReportStale(false);
    audioEngine.setMasterSettings(settings, 0);
  },
    []
  );

  const loadTemplate = useCallback((templateId: TemplateId, clearAllStorage = false) => {
    audioEngine.stop();
    setIsPlaying(false);
    resetMastering();
    if (clearAllStorage) {
      clearProjectLocalStorage();
      void clearStoredBuffers();
    }
    const ctx = audioEngine.getContext();
    const seed = buildTemplate(templateId, ctx);
    const newId = `prj_${Date.now()}`;
    setProjectId(newId);
    setProjectName(TEMPLATE_TITLES[templateId] || 'My Studio Session');
    setTracks(seed.tracks);
    setClips(seed.clips);
    setBpm(seed.bpm);
    setPlayhead(0);
    setLoop({ enabled: templateId === 'demo', start: 0, end: 8 });
    setSelectedTrackId(seed.tracks[0]?.id || '');
    setSelectedClipId(seed.clips[0]?.id || '');
    resetHistory();
    audioEngine.syncTracks(seed.tracks);
    setView('studio');
    setMobileTab('tracks');
  }, [resetMastering]);

  /**
   * Leaves the app with no project open (fresh install, last project deleted, all data cleared).
   * Nothing is auto-created or auto-saved until the user starts or opens a project.
   */
  const closeSession = useCallback(() => {
    audioEngine.stop();
    setIsPlaying(false);
    resetMastering();
    setProjectId(`prj_${Date.now()}`);
    setProjectName('Untitled Project');
    setTracks([]);
    setClips([]);
    setSelectedTrackId('');
    setSelectedClipId('');
    setPlayhead(0);
    resetHistory();
    audioEngine.syncTracks([]);
    setView('home');
    setMobileTab('home');
  }, [resetMastering, setPlayhead]);

  // Hydrate saved project + custom AudioBuffers from LocalStorage & IndexedDB on startup
  useEffect(() => {
    let cancelled = false;
    const initProject = async () => {
      await initProjectLibrary();
      const pInfo = await requestPersistentStorage();
      if (!cancelled) setStorageInfo(pInfo);

      const ctx = audioEngine.getContext();
      // Live DSP worklets (dynamic de-esser) before any track chain is built
      await audioEngine.prepareDsp();
      // Register default synth stems so template clips always have their buffers ready
      buildTemplate('demo', ctx);
      // Restore any recorded/imported/processed buffers from IndexedDB
      const storedBuffers = await loadAllBuffersFromStorage(ctx);
      storedBuffers.forEach((buf, id) => {
        audioEngine.registerBuffer(id, buf, false);
      });
      if (cancelled) return;

      const allProjects = loadAllProjectsFromLibrary();
      setSavedProjects(allProjects);

      const saved = loadProjectFromLocalStorage() || allProjects[0];
      if (saved && saved.tracks.length > 0) {
        const validClips = saved.clips.filter((c) => Boolean(audioEngine.getBuffer(c.bufferId)));
        setProjectId(saved.id || 'prj_default');
        setProjectName(saved.name || 'My Studio Session');
        setTracks(saved.tracks);
        setClips(validClips);
        setBpm(saved.bpm || 120);
        setLoop(saved.loop || { enabled: false, start: 0, end: 8 });
        setMasterVolume(saved.masterVolume ?? 1.0);
        audioEngine.setMasterVolume(saved.masterVolume ?? 1.0);
        resetMastering(saved.master, saved.returns);
        setSelectedTrackId(saved.selectedTrackId || saved.tracks[0].id);
        setSelectedClipId(saved.selectedClipId || validClips[0]?.id || '');
        audioEngine.syncTracks(saved.tracks);
      } else {
        // Nothing saved yet: start on Home with no project (the Demo Song is a template there)
        closeSession();
      }
      setStorageHydrated(true);
    };
    void initProject();
    return () => {
      cancelled = true;
    };
  }, [closeSession, resetMastering]);

  // Flush the autosave when the tab is hidden or closed (the debounce could otherwise drop
  // the last edit)
  const saveNowRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const flush = () => saveNowRef.current?.();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Auto-save (debounced) to the LocalStorage library whenever tracks, clips, name, BPM, or loop change
  useEffect(() => {
    if (!storageHydrated || tracks.length === 0) return;
    const saveTimer = window.setTimeout(() => {
      saveProjectToLocalStorage({
        id: projectId,
        name: projectName,
        tracks,
        clips,
        bpm,
        loop,
        masterVolume,
        master,
        returns,
        selectedTrackId,
        selectedClipId,
        updatedAt: Date.now(),
      });
      setSavedProjects(loadAllProjectsFromLibrary());
      void requestPersistentStorage().then(setStorageInfo);
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 1400);
    }, 600);
    return () => window.clearTimeout(saveTimer);
  }, [
    storageHydrated,
    projectId,
    projectName,
    tracks,
    clips,
    bpm,
    loop,
    masterVolume,
    master,
    returns,
    selectedTrackId,
    selectedClipId,
  ]);

  // Feed master + per-track meters at ~20 fps while audio is active, then ~1.5 s more so the
  // meters fall back smoothly, then stop (no idle animation loop).
  const audioActive = isPlaying || isRecording || micMonitorOn;
  useEffect(() => {
    let id = 0;
    let last = 0;
    const stopAt = audioActive ? Infinity : performance.now() + 1500;
    const tick = (now: number) => {
      if (now - last > 50) {
        last = now;
        meterStore.set(audioEngine.getMeterLevels());
      }
      if (now < stopAt) id = requestAnimationFrame(tick);
      else meterStore.set(EMPTY_METERS);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [audioActive]);

  useEffect(() => {
    audioEngine.setMetronome(metronomeOn, bpm);
  }, [metronomeOn, bpm]);

  // Any change to the mix makes the last loudness analysis out of date
  useEffect(() => {
    setReportStale(true);
  }, [tracks, clips, masterVolume, master, returns]);

  // FX return buses follow the project settings and tempo (tempo-synced delay)
  useEffect(() => {
    audioEngine.setReturns(returns, bpm);
  }, [returns, bpm]);

  const handleMasterChange = useCallback((next: MasterSettings) => {
    setMaster(next);
    audioEngine.setMasterSettings(next);
  }, []);

  const handleAnalyzeLoudness = async () => {
    setIsAnalyzing(true);
    try {
      const { report } = await audioEngine.renderMasteredMixdown(tracks, clips, masterVolume, master);
      setLoudnessReport(report);
      setReportStale(false);
      // Match playback loudness to what the export will sound like
      audioEngine.setMasterSettings(master, report.gainDb);
    } catch (err) {
      console.error('Loudness analysis failed:', err);
      notify('Could not analyze the mix. Please try again.', 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  useEffect(() => {
    audioEngine.setMicMonitorEnabled(micMonitorOn, selectedTrackId);
  }, [micMonitorOn, selectedTrackId]);

  useEffect(() => {
    if (tracks.length > 0) audioEngine.syncTracks(tracks);
  }, [tracks]);

  // Keep playing audio in sync when clips or clip parameters (Pitch, Speed, Gain, Buffer ops) change
  useEffect(() => {
    if (isPlaying && !isRecording) {
      audioEngine.syncClipsLive(tracks, clips);
    }
  }, [clips, isPlaying, isRecording, tracks]);

  // Loop region edits apply to running playback. While the loop is being dragged this
  // re-arms on every move, so audio is re-scheduled once, ~200 ms after the drag stops.
  useEffect(() => {
    if (!isPlaying || isRecording) return;
    const timer = window.setTimeout(
      () => audioEngine.updateLoop(loop.enabled ? { start: loop.start, end: loop.end } : null),
      200
    );
    return () => window.clearTimeout(timer);
  }, [loop, isPlaying, isRecording]);

  // Playhead + mic level loop (position comes from the audio clock). Runs only while audio is
  // moving: an always-on 60 fps loop kept the main thread busy and made every click feel slower.
  useEffect(() => {
    if (!isPlaying && !isRecording) return;
    let rafId = 0;
    const maxClipEnd = clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const totalEnd = Math.max(maxClipEnd > 0 ? maxClipEnd + 0.2 : 8, loop.enabled ? loop.end : 0);
    const tick = () => {
      if (isRecording && recordingSession) {
        setMicLevel(audioEngine.getMicInputLevel());
        setPlayhead(audioEngine.getTimelinePosition());
      } else if (isPlaying) {
        const status = audioEngine.getCurrentPlayhead(totalEnd);
        setPlayhead(status.time);
        if (status.ended) setIsPlaying(false);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, isRecording, recordingSession, loop, clips]);

  /** Loop region to hand to the engine when playback starts at `from`. */
  const loopFor = useCallback(
    (from: number) =>
      loop.enabled && from < loop.end ? { start: loop.start, end: loop.end } : null,
    [loop]
  );

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      audioEngine.stop();
      setIsPlaying(false);
    } else {
      const playhead = playheadStore.get();
      const maxClipEnd = clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
      const startFrom =
        maxClipEnd > 0 && playhead >= maxClipEnd - 0.05
          ? loop.enabled
            ? loop.start
            : 0
          : playhead;
      setPlayhead(startFrom);
      audioEngine.play(tracks, clips, startFrom, loopFor(startFrom), { bpm });
      setIsPlaying(true);
    }
  }, [isPlaying, loop, loopFor, tracks, clips, bpm, setPlayhead]);

  const handleRewind = useCallback(() => {
    setPlayhead(0);
    if (isPlaying) audioEngine.play(tracks, clips, 0, loopFor(0), { bpm });
  }, [isPlaying, tracks, clips, loopFor, bpm]);

  const handleSeek = useCallback(
    (time: number) => {
      setPlayhead(time);
      if (isPlaying) audioEngine.play(tracks, clips, time, loopFor(time), { bpm });
    },
    [isPlaying, tracks, clips, loopFor, bpm]
  );

  const handleUpdateTrack = useCallback(
    (trackId: string, patch: Partial<AudioTrack>, undoKey?: string) => {
      setSelectedTrackId(trackId);
      const keys = Object.keys(patch);
      if (keys.length === 0) return; // selection only
      // Showing/hiding a lane is a view change, not an edit: no undo step
      if (!(keys.length === 1 && keys[0] === 'showAutomation')) {
        recordUndoPoint(undoKey ?? `track:${trackId}:${keys.sort().join(',')}`);
      }
      setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, ...patch } : t)));
    },
    [recordUndoPoint]
  );

  const handleUpdateTrackEffects = useCallback(
    (trackId: string, fxPatch: Partial<TrackEffects>) => {
      recordUndoPoint(`fx:${trackId}:${Object.keys(fxPatch).sort().join(',')}`);
      setTracks((prev) =>
        prev.map((t) => (t.id === trackId ? { ...t, effects: { ...t.effects, ...fxPatch } } : t))
      );
    },
    [recordUndoPoint]
  );

  const handleUpdateClip = useCallback(
    (clipId: string, patch: Partial<AudioClip>) => {
      recordUndoPoint(`clip:${clipId}:${Object.keys(patch).sort().join(',')}`);
      setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, ...patch } : c)));
    },
    [recordUndoPoint]
  );

  /** The clips an edit applies to: the multi-selection, or just the primary clip. */
  const activeSelection = useCallback((): Set<string> => {
    const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    return new Set(ids.filter((id) => liveRef.current.clips.some((c) => c.id === id)));
  }, [selectedClipIds, selectedClipId]);

  /** Selects multiple clips; the last one becomes the primary (Inspector) clip. */
  const selectClips = useCallback((ids: string[]) => {
    setSelectedClipIds(ids);
    setPrimaryClipId(ids[ids.length - 1] ?? '');
  }, []);

  /*
   * Clip dragging moves the whole selection as a unit. Origins are captured at the first move;
   * on drop, overlaps with other clips are resolved by shifting the group to the nearest fit.
   */
  const dragOriginsRef = useRef<Map<string, number> | null>(null);
  const handleClipDragMove = useCallback(
    (anchorId: string, dtSec: number) => {
      if (!dragOriginsRef.current) {
        const sel = activeSelection();
        const ids = sel.has(anchorId) ? sel : new Set([anchorId]);
        dragOriginsRef.current = new Map(
          liveRef.current.clips.filter((c) => ids.has(c.id)).map((c) => [c.id, c.startTime])
        );
      }
      const origins = dragOriginsRef.current;
      const anchorStart = origins.get(anchorId);
      if (anchorStart === undefined) return;
      const grid = 60 / bpm / 4; // 1/16 note
      const target = anchorStart + dtSec;
      const snapped = snapToGrid ? Math.round(target / grid) * grid : Number(target.toFixed(3));
      let delta = snapped - anchorStart;
      const minStart = Math.min(...origins.values());
      if (minStart + delta < 0) delta = -minStart;
      recordUndoPoint(`move:${[...origins.keys()].sort().join(',')}`);
      setClips((prev) =>
        prev.map((c) => (origins.has(c.id) ? { ...c, startTime: origins.get(c.id)! + delta } : c))
      );
    },
    [activeSelection, bpm, snapToGrid, recordUndoPoint]
  );

  const handleClipDragEnd = useCallback((clipId: string) => {
    const moved = dragOriginsRef.current ? new Set(dragOriginsRef.current.keys()) : new Set([clipId]);
    dragOriginsRef.current = null;
    setClips((prev) => resolveGroupOverlap(prev, moved));
  }, []);

  const handleSplitSelectedClip = useCallback(() => {
    const ids = activeSelection();
    if (ids.size === 0) return;
    const res = splitClipsAt(clips, ids, playheadStore.get());
    if (res.rightIds.length === 0) return;
    pushHistory(tracks, res.clips);
    selectClips(res.rightIds);
  }, [activeSelection, clips, tracks, pushHistory, selectClips]);

  const handleDuplicateSelectedClip = useCallback(() => {
    const ids = activeSelection();
    if (ids.size === 0) return;
    const res = duplicateClips(clips, ids);
    pushHistory(tracks, res.clips);
    selectClips(res.newIds);
  }, [activeSelection, clips, tracks, pushHistory, selectClips]);

  const handleDeleteSelectedClip = useCallback(() => {
    const ids = activeSelection();
    if (ids.size === 0) return;
    const nextClips = clips.filter((c) => !ids.has(c.id));
    pushHistory(tracks, nextClips);
    setSelectedClipId('');
  }, [activeSelection, clips, tracks, pushHistory, setSelectedClipId]);

  const handleCopyClips = useCallback(
    (cut = false) => {
      const ids = activeSelection();
      const board = copyClips(clips, ids);
      if (!board) return;
      clipboard.set(board);
      if (cut) {
        pushHistory(tracks, clips.filter((c) => !ids.has(c.id)));
        setSelectedClipId('');
      }
      notify(
        `${cut ? 'Cut' : 'Copied'} ${board.clips.length} clip${board.clips.length === 1 ? '' : 's'}`,
        'info',
        1800
      );
    },
    [activeSelection, clips, tracks, pushHistory, setSelectedClipId]
  );

  const handlePasteClips = useCallback(() => {
    const board = clipboard.get();
    if (!board || tracks.length === 0) return;
    const fallback = selectedTrackId || tracks[0].id;
    const res = pasteClips(
      clips,
      board,
      playheadStore.get(),
      new Set(tracks.map((t) => t.id)),
      fallback,
      (id) => tracks.find((t) => t.id === id)?.color
    );
    pushHistory(tracks, res.clips);
    selectClips(res.newIds);
  }, [clips, tracks, selectedTrackId, pushHistory, selectClips]);

  const handleDeleteTrack = useCallback(
    (trackId: string) => {
      const nextTracks = tracks.filter((t) => t.id !== trackId);
      if (nextTracks.length === 0) return;
      pushHistory(
        nextTracks,
        clips.filter((c) => c.trackId !== trackId)
      );
      if (selectedTrackId === trackId) setSelectedTrackId(nextTracks[0].id);
    },
    [tracks, clips, selectedTrackId, pushHistory]
  );

  // Background clip rendering in a Web Worker (see hooks/useClipRendering)
  const {
    renderingClipIds,
    pendingClipStateRef,
    cancelPendingRenders,
    updateClipProcesses: handleUpdateClipProcesses,
    commitClipPitch: handleCommitClipPitch,
    selectTake: handleSelectTake,
    applyBufferOp: handleApplyBufferOp,
  } = useClipRendering({ liveRef, pushHistory, selection, selectedClipId });

  const handleUndo = useCallback(() => {
    if (past.length === 0) return;
    cancelPendingRenders(); // a late render must not overwrite the restored state
    undo();
  }, [past.length, cancelPendingRenders, undo]);

  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    cancelPendingRenders();
    redo();
  }, [future.length, cancelPendingRenders, redo]);

  useStorageCleanup(storageHydrated, clips, past, future, pendingClipStateRef);

  // Keyboard shortcuts: handlers are filled in at the end of render (see shortcutsRef.current)
  const shortcutsRef = useRef<ShortcutHandlers | null>(null);
  useKeyboardShortcuts(shortcutsRef);

  const handleAddTrack = (stemType?: StemType) => {
    const color = TRACK_COLORS[tracks.length % TRACK_COLORS.length];
    const newTrackId = makeId('trk');
    const newTrack: AudioTrack = {
      id: newTrackId,
      name: stemType ? STEM_LABELS[stemType] : `Track ${tracks.length + 1}`,
      color,
      volume: 0.85,
      pan: 0,
      muted: false,
      solo: false,
      armed: false,
      effects:
        stemType === 'vocal'
          ? {
              ...DEFAULT_EFFECTS,
              voiceSoftener: 60,
              noiseRemoval: 45,
              wetLevel: 85,
              reverbMix: 0.22,
            }
          : { ...DEFAULT_EFFECTS },
      // Vocals start with a touch of the shared reverb and delay
      sends: stemType === 'vocal' ? { reverb: 0.18, delay: 0.08 } : { reverb: 0, delay: 0 },
    };

    let nextClips = [...clips];
    if (stemType) {
      const ctx = audioEngine.getContext();
      const generators: Record<StemType, () => AudioBuffer> = {
        vocal: () => generateVocalStem(ctx, 8),
        drums: () => generateDrumsStem(ctx, 8),
        bass: () => generateBassStem(ctx, 8),
        chords: () => generateChordsStem(ctx, 8),
        lead: () => generateLeadStem(ctx, 8),
      };
      const buf = generators[stemType]();
      const bufId = `stem_${stemType}_${Date.now()}`;
      audioEngine.registerBuffer(bufId, buf);
      const newClip: AudioClip = {
        id: makeId('clp'),
        trackId: newTrackId,
        name: STEM_LABELS[stemType],
        bufferId: bufId,
        startTime: 0,
        offset: 0,
        duration: buf.duration,
        gain: 1,
        fadeIn: 0.05,
        fadeOut: 0.1,
        pitchSemitones: 0,
        playbackRate: 1,
        color,
      };
      nextClips = [...nextClips, newClip];
      setSelectedClipId(newClip.id);
    }

    pushHistory([...tracks, newTrack], nextClips);
    setSelectedTrackId(newTrackId);
    setShowAddMenu(false);
    setView('studio');
    if (isMobile) setMobileTab('tracks');
  };

  /**
   * Finds a non-overlapping start time on a track at or after `desiredStart`.
   * If `desiredStart` collides with an existing clip on `trackId`, returns the end of the last clip on that track.
   */
  const findNonOverlappingStart = useCallback(
    (trackId: string, desiredStart: number): number => {
      const trackClips = clips.filter((c) => c.trackId === trackId);
      const overlaps = trackClips.some(
        (c) => desiredStart < c.startTime + c.duration - 0.02 && desiredStart >= c.startTime - 0.02
      );
      if (!overlaps) return desiredStart;
      return trackClips.reduce((maxEnd, c) => Math.max(maxEnd, c.startTime + c.duration), 0);
    },
    [clips]
  );

  const handleImportAudioFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const ctx = audioEngine.getContext();
    const nextTracks = [...tracks];
    const nextClips = [...clips];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());
        const bufId = `import_${Date.now()}_${i}`;
        audioEngine.registerBuffer(bufId, audioBuffer);
        const baseName = file.name.replace(/\.[^/.]+$/, '');

        // Always create a dedicated track if the selected track already has clips, or if importing multiple files
        const selectedHasClips = nextClips.some((c) => c.trackId === selectedTrackId);
        let targetTrackId = selectedTrackId;

        if (!targetTrackId || selectedHasClips || i > 0) {
          targetTrackId = makeId('trk');
          nextTracks.push({
            id: targetTrackId,
            name: baseName,
            color: TRACK_COLORS[nextTracks.length % TRACK_COLORS.length],
            volume: 0.9,
            pan: 0,
            muted: false,
            solo: false,
            armed: false,
            effects: { ...DEFAULT_EFFECTS },
          });
          setSelectedTrackId(targetTrackId);
        }

        const trackObj = nextTracks.find((t) => t.id === targetTrackId);
        const newClip: AudioClip = {
          id: makeId('clp'),
          trackId: targetTrackId,
          name: baseName,
          bufferId: bufId,
          startTime: 0,
          offset: 0,
          duration: audioBuffer.duration,
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          pitchSemitones: 0,
          playbackRate: 1,
          color: trackObj?.color || TRACK_COLORS[0],
        };
        nextClips.push(newClip);
        setSelectedClipId(newClip.id);
      } catch (err) {
        console.error('Failed to decode audio file:', err);
        notify(
          `Could not read "${file.name}". Use a WAV, MP3, OGG or FLAC file.`,
          'error'
        );
      }
    }

    pushHistory(nextTracks, nextClips);
    setShowAddMenu(false);
    setView('studio');
    if (isMobile) setMobileTab('tracks');
  };

  /**
   * Smart Non-Overlapping Recording:
   * - Supports optional 4-beat count-in (`1 - 2 - 3 - 4`) synced to BPM before recording starts.
   * - Records onto the user's currently selected track (`selectedTrackId`).
   * - If the selected track already has a clip at `playhead`, automatically starts the recording
   *   right after the existing clip on that track so clips never overlap on the same track.
   * - Plays the other tracks in the background for monitoring while recording, and routes live mic
   *   input through the track's FX chain if Live Mic Monitoring is enabled.
   */
  const handleToggleRecording = async () => {
    const playhead = playheadStore.get();
    if (countInBeat !== null) {
      // Cancel during the count-in: discard the (not yet started) take
      if (countInTimerRef.current) {
        window.clearInterval(countInTimerRef.current);
        countInTimerRef.current = null;
      }
      setCountInBeat(null);
      audioEngine.stop();
      await audioEngine.cancelMicRecording();
      setIsPlaying(false);
      setIsRecording(false);
      setRecordingSession(null);
      setMicLevel(0);
      return;
    }

    if (isRecording) {
      const session = recordingSession;
      const res = await audioEngine.stopMicRecording();
      audioEngine.stop();
      setIsPlaying(false);
      setIsRecording(false);
      setRecordingSession(null);
      setMicLevel(0);
      if (!res) return;

      const targetId = session?.trackId || selectedTrackId || tracks[0]?.id;
      const target = tracks.find((t) => t.id === targetId) || tracks[0];
      if (!target) return;

      /**
       * Track for a new take covering [start, end): the target track, or, if that would overlap
       * existing clips there, a new "takes" lane right below it (recording never covers clips).
       */
      const laneFor = (start: number, end: number) => {
        const occupied = clips.some(
          (c) =>
            c.trackId === target.id &&
            c.startTime < end - 0.001 &&
            c.startTime + c.duration > start + 0.001
        );
        if (!occupied) return { nextTracks: tracks, laneTrack: target };
        const laneTrack: AudioTrack = {
          ...target,
          id: makeId('trk'),
          // Recording onto a takes lane again: keep the name ("Vocal takes", not "... takes takes")
          name: / takes$/.test(target.name) ? target.name : `${target.name} takes`,
          solo: false,
          automation: undefined,
          showAutomation: false,
        };
        const idx = tracks.findIndex((t) => t.id === target.id);
        return {
          nextTracks: [...tracks.slice(0, idx + 1), laneTrack, ...tracks.slice(idx + 1)],
          laneTrack,
        };
      };

      // Loop recording: one take per pass, in a single comp clip covering the loop
      const loopRec = session?.loop;
      if (loopRec) {
        const passSec = loopRec.end - loopRec.start;
        const slices = audioEngine.sliceIntoTakes(res.bufferId, passSec);
        if (slices.length >= 1) {
          const takes = slices.map((sl, i) => ({ bufferId: sl.bufferId, label: `Take ${i + 1}` }));
          let active = slices.length - 1;
          while (active > 0 && !slices[active].complete) active--;
          const { nextTracks, laneTrack } = laneFor(loopRec.start, loopRec.end);
          const comp: AudioClip = {
            id: makeId('clp_rec'),
            trackId: laneTrack.id,
            name: `${target.name} comp`,
            bufferId: takes[active].bufferId,
            sourceBufferId: takes[active].bufferId,
            takes,
            activeTake: active,
            startTime: loopRec.start,
            offset: 0,
            duration: passSec,
            gain: 1,
            fadeIn: 0.01,
            fadeOut: 0.02,
            pitchSemitones: 0,
            playbackRate: 1,
            color: laneTrack.color,
          };
          pushHistory(nextTracks, [...clips, comp]);
          setSelectedClipId(comp.id);
          setSelectedTrackId(laneTrack.id);
          setPlayhead(loopRec.start);
          notify(
            `Recorded ${takes.length} take${takes.length === 1 ? '' : 's'}. Pick one in the Edit tab, or split the clip to comp the best parts.`,
            'success',
            6000
          );
          if (isMobile) setMobileTab('edit');
          else setInspectorTab('edit');
          return;
        }
        // Stopped before the first pass finished: fall through to a normal take
      }

      const startAt = session ? session.startTime : findNonOverlappingStart(target.id, playhead);
      // The take's length is only known now: if it runs into a later clip, use a takes lane
      const { nextTracks, laneTrack } = laneFor(startAt, startAt + res.buffer.duration);
      const newClip: AudioClip = {
        id: makeId('clp_rec'),
        trackId: laneTrack.id,
        name: `${target.name} Take`,
        bufferId: res.bufferId,
        startTime: startAt,
        offset: 0,
        duration: res.buffer.duration,
        gain: 1,
        fadeIn: 0.02,
        fadeOut: 0.05,
        pitchSemitones: 0,
        playbackRate: 1,
        color: laneTrack.color,
      };
      pushHistory(nextTracks, [...clips, newClip]);
      setSelectedClipId(newClip.id);
      setSelectedTrackId(laneTrack.id);
      // Rewind playhead to the start of the newly recorded take so pressing Play plays it immediately
      setPlayhead(startAt);
      if (isMobile) setMobileTab('tracks');
    } else {
      const target = tracks.find((t) => t.id === selectedTrackId) || tracks[0];
      if (!target) return;

      // Loop on: record pass after pass of the loop region (each pass becomes a take).
      // Otherwise never overlap an existing clip on the chosen track.
      const loopRec =
        loop.enabled && loop.end - loop.start >= 0.5 ? { start: loop.start, end: loop.end } : null;
      const safeStart = loopRec ? loopRec.start : findNonOverlappingStart(target.id, playhead);
      setShowAddMenu(false);

      // Open the mic first so its start-up delay never eats into the count-in or the downbeat
      audioEngine.stop();
      setIsPlaying(false);
      try {
        await audioEngine.startMicRecording(target.id);
      } catch {
        notify(
          'Microphone access was blocked. Allow the microphone in your browser settings and try again.',
          'error'
        );
        return;
      }

      setPlayhead(safeStart);
      setRecordingSession({
        trackId: target.id,
        startTime: safeStart,
        startedAtMs: performance.now(),
        loop: loopRec,
      });
      setIsRecording(true);

      // Count-in clicks and the playback start are both scheduled on the audio clock, so the
      // backing track starts exactly on the beat after "4"
      let startAtCtx: number | undefined;
      if (countInEnabled) {
        const beatLen = 60 / Math.max(40, Math.min(240, bpm));
        startAtCtx = audioEngine.scheduleCountIn(bpm, 4);
        const firstBeat = startAtCtx - 4 * beatLen;
        const ctx = audioEngine.getContext();
        setCountInBeat(1);
        countInTimerRef.current = window.setInterval(() => {
          const beat = Math.floor((ctx.currentTime - firstBeat) / beatLen) + 1;
          if (beat > 4) {
            if (countInTimerRef.current) window.clearInterval(countInTimerRef.current);
            countInTimerRef.current = null;
            setCountInBeat(null);
          } else {
            setCountInBeat(Math.max(1, beat));
          }
        }, 30);
      }

      // Play backing tracks (excluding clips on the track being recorded if at the same time)
      const backingClips = clips.filter(
        (c) =>
          c.trackId !== target.id ||
          c.startTime + c.duration <= safeStart ||
          (loopRec !== null && c.startTime >= loopRec.end)
      );
      audioEngine.play(tracks, backingClips, safeStart, loopRec, { bpm, startAtCtx });
      setIsPlaying(true);
    }
  };

  const handleExport = async (formatId: ExportFormatId) => {
    setIsExporting(true);
    try {
      const format = getExportFormat(formatId);
      const { buffer: rendered, report } = await audioEngine.renderMasteredMixdown(
        tracks,
        clips,
        masterVolume,
        master
      );
      setLoudnessReport(report);
      setReportStale(false);
      audioEngine.setMasterSettings(master, report.gainDb);
      const blob = await encodeAudioBuffer(rendered, formatId);
      const safeName = (projectName || 'AETHER_Mixdown').replace(/[^a-zA-Z0-9_-]+/g, '_');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}_${bpm}BPM.${format.extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      notify(`Exported ${a.download}`, 'success');
      if (report.truePeakDb > 0) {
        // Only possible with mastering off: the file is clipped
        notify(
          `The mix clips (peak +${report.truePeakDb.toFixed(1)} dB), so the export will distort. ` +
            'Turn the master down or pick a mastering preset in the Mixer tab.',
          'warn',
          12000
        );
      }
    } catch (err) {
      console.error('Export failed:', err);
      notify('Export failed. Please try again.', 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleMasterVolume = (v: number) => {
    setMasterVolume(v);
    audioEngine.setMasterVolume(v);
  };

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId) || tracks[0];
  const selectedClip = clips.find((c) => c.id === selectedClipId);
  const durationSec = Math.max(
    18,
    clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 12) + 6,
    playheadCoarse + 8
  );

  /**
   * Clip selection from the timeline:
   *  - 'toggle' (Shift/Ctrl/Cmd + click): add/remove from the multi-selection
   *  - 'press'  (pointer down): keep an existing multi-selection so it can be dragged as a group
   *  - 'click'  (pointer up without dragging): select only this clip
   */
  const handleSelectClip = useCallback(
    (clipId: string, trackId: string, mode: 'toggle' | 'press' | 'click' = 'click') => {
      setSelectedTrackId(trackId);
      if (mode === 'toggle') {
        setSelectedClipIds((prev) => {
          const next = prev.includes(clipId) ? prev.filter((id) => id !== clipId) : [...prev, clipId];
          setPrimaryClipId(next[next.length - 1] ?? '');
          return next;
        });
        return;
      }
      if (mode === 'press') {
        setSelectedClipIds((prev) => {
          if (prev.includes(clipId) && prev.length > 1) {
            setPrimaryClipId(clipId);
            return prev;
          }
          setPrimaryClipId(clipId);
          return [clipId];
        });
        return;
      }
      setSelectedClipId(clipId);
    },
    [setSelectedClipId]
  );

  const inspectorProps = {
    selectedTrack,
    selectedClip,
    tracks,
    selection,
    onSelectionChange: setSelection,
    onUpdateTrack: handleUpdateTrack,
    onUpdateTrackEffects: handleUpdateTrackEffects,
    onUpdateClip: handleUpdateClip,
    onUpdateClipProcesses: handleUpdateClipProcesses,
    onCommitClipPitch: handleCommitClipPitch,
    onSelectTake: handleSelectTake,
    isRenderingClip: Boolean(selectedClip && renderingClipIds.has(selectedClip.id)),
    onSplit: handleSplitSelectedClip,
    onDuplicate: handleDuplicateSelectedClip,
    onDelete: handleDeleteSelectedClip,
    onApplyBufferOp: handleApplyBufferOp,
    masterVolume,
    onMasterVolume: handleMasterVolume,
    masterSection: (
      <>
        <FxReturnsPanel
          returns={returns}
          bpm={bpm}
          onChange={(patch) => setReturns((r) => ({ ...r, ...patch }))}
        />
        <MasteringPanel
          settings={master}
          onChange={handleMasterChange}
          report={loudnessReport}
          reportStale={reportStale}
          analyzing={isAnalyzing}
          onAnalyze={handleAnalyzeLoudness}
        />
        <LatencyPanel disabled={isRecording || countInBeat !== null} />
      </>
    ),
  };

  const arrangementProps = {
    tracks,
    clips,
    selectedTrackId: selectedTrack?.id ?? '',
    selectedClipIds,
    loop,
    bpm,
    pixelsPerSecond,
    durationSec,
    snapToGrid,
    recording: recordingSession
      ? { trackId: recordingSession.trackId, startTime: recordingSession.startTime }
      : null,
    onSelectTrack: setSelectedTrackId,
    onSelectClip: handleSelectClip,
    onUpdateTrack: handleUpdateTrack,
    onUpdateClip: handleUpdateClip,
    onClipDragEnd: handleClipDragEnd,
    onClipDragMove: handleClipDragMove,
    onDeleteTrack: handleDeleteTrack,
    onSeek: handleSeek,
    onLoopChange: setLoop,
  };

  const addTrackMenu = (
    <AddTrackMenu
      isRecording={isRecording}
      onPick={(type) => handleAddTrack(type === 'empty' ? undefined : type)}
      onImport={() => fileInputRef.current?.click()}
      onRecord={handleToggleRecording}
    />
  );

  const handleManualSave = () => {
    saveProjectToLocalStorage({
      id: projectId,
      name: projectName,
      tracks,
      clips,
      bpm,
      loop,
      masterVolume,
      master,
      returns,
      selectedTrackId,
      selectedClipId,
      updatedAt: Date.now(),
    });
    setSavedProjects(loadAllProjectsFromLibrary());
    void requestPersistentStorage().then(setStorageInfo);
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 1600);
  };

  const handleOpenSavedProject = useCallback((proj: PersistedProjectState) => {
    audioEngine.stop();
    setIsPlaying(false);
    const validClips = proj.clips.filter((c) => Boolean(audioEngine.getBuffer(c.bufferId)));
    setProjectId(proj.id || `prj_${Date.now()}`);
    setProjectName(proj.name || 'My Studio Session');
    setTracks(proj.tracks);
    setClips(validClips);
    setBpm(proj.bpm || 120);
    setLoop(proj.loop || { enabled: false, start: 0, end: 8 });
    setMasterVolume(proj.masterVolume ?? 1.0);
    audioEngine.setMasterVolume(proj.masterVolume ?? 1.0);
    resetMastering(proj.master, proj.returns);
    setSelectedTrackId(proj.selectedTrackId || proj.tracks[0]?.id || '');
    setSelectedClipId(proj.selectedClipId || validClips[0]?.id || '');
    resetHistory();
    audioEngine.syncTracks(proj.tracks);
    setView('studio');
    setMobileTab('tracks');
  }, [resetMastering]);

  const handleDeleteSavedProject = useCallback(
    (targetId: string) => {
      const target = savedProjects.find((p) => p.id === targetId);
      if (
        !window.confirm(
          `Delete "${target?.name || 'this project'}" from this device? This cannot be undone.`
        )
      ) {
        return;
      }
      const remaining = deleteProjectFromLibrary(targetId);
      setSavedProjects(remaining);
      // Free recorded audio that no remaining project (or the open project) still uses
      void pruneUnusedBuffers(
        collectReferencedBufferIds(remaining, targetId === projectId ? [] : clips)
      );
      if (targetId === projectId) {
        if (remaining.length > 0) {
          handleOpenSavedProject(remaining[0]);
        } else {
          closeSession();
        }
      }
    },
    [projectId, clips, savedProjects, handleOpenSavedProject, closeSession]
  );

  const handleClearAllSavedData = useCallback(() => {
    if (
      !window.confirm(
        'Are you sure you want to delete ALL saved projects and recorded audio from this device?'
      )
    ) {
      return;
    }
    clearProjectLocalStorage();
    void clearStoredBuffers();
    setSavedProjects([]);
    closeSession();
  }, [closeSession]);

  const handleExportProjectFile = useCallback((proj: PersistedProjectState) => {
    exportProjectBundleFile(proj, (bufId) => audioEngine.getBuffer(bufId));
  }, []);

  const handleImportProjectFileChange = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    try {
      const ctx = audioEngine.getContext();
      const restored = await importProjectBundleFile(files[0], ctx, (id, buf, persist) =>
        audioEngine.registerBuffer(id, buf, persist)
      );
      setSavedProjects(loadAllProjectsFromLibrary());
      handleOpenSavedProject(restored);
    } catch {
      notify('That file is not a valid .aether project backup.', 'error');
    }
  };

  const homeProps = {
    trackCount: tracks.length,
    activeProjectId: projectId,
    savedProjects,
    storageInfo,
    onStart: (tmpl: TemplateId) => loadTemplate(tmpl, false),
    onImport: () => fileInputRef.current?.click(),
    onContinue: () => {
      setView('studio');
      setMobileTab('tracks');
    },
    onOpenProject: handleOpenSavedProject,
    onDeleteProject: handleDeleteSavedProject,
    onExportProjectFile: handleExportProjectFile,
    onImportProjectFile: () => projectFileInputRef.current?.click(),
    onClearAllData: handleClearAllSavedData,
  };


  const transportProps: TransportProps = {
    isPlaying,
    isRecording,
    countInBeat,
    recordTargetName: selectedTrack?.name || 'selected track',
    onPlayPause: handlePlayPause,
    onRewind: handleRewind,
    onRecord: handleToggleRecording,
    loopOn: loop.enabled,
    onToggleLoop: () => setLoop((l) => ({ ...l, enabled: !l.enabled })),
    metronomeOn,
    onToggleMetronome: () => setMetronomeOn((m) => !m),
    countInOn: countInEnabled,
    onToggleCountIn: () => setCountInEnabled((c) => !c),
    monitorOn: micMonitorOn,
    onToggleMonitor: () => setMicMonitorOn((m) => !m),
  };

  const hasSession = tracks.length > 0;

  // Shown only after storage has loaded, so a saved project never flashes "No project open"
  const noProjectState = !storageHydrated ? (
    <div className="flex-1" />
  ) : (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-raised border border-line flex items-center justify-center mb-4">
          <Layers className="w-5 h-5 text-mute" />
        </div>
        <h2 className="text-[15px] font-semibold">No project open</h2>
        <p className="text-[13px] text-mute mt-1.5 leading-relaxed">
          Start a blank project, or pick a template or saved project on Home.
        </p>
        <div className="flex flex-wrap justify-center gap-2 mt-5">
          <button
            onClick={() => loadTemplate('scratch', false)}
            className="h-9 px-4 rounded-lg brand-gradient text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-accent/25 hover:brightness-110"
          >
            <Plus className="w-3.5 h-3.5" />
            New blank project
          </button>
          <button
            onClick={() => {
              setView('home');
              setMobileTab('home');
            }}
            className="h-9 px-4 rounded-lg bg-raised border border-line hover:border-accent/50 text-xs font-semibold text-ink flex items-center gap-1.5"
          >
            <HomeIcon className="w-3.5 h-3.5" />
            Go to Home
          </button>
        </div>
      </div>
    </div>
  );

  const projectChromeProps = {
    // A session exists once a project with at least one track is loaded
    hasSession,
    projectName,
    onProjectNameChange: setProjectName,
    savedFlash: savedNotice,
    onSave: handleManualSave,
    onNewProject: () => loadTemplate('scratch', false),
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    onUndo: handleUndo,
    onRedo: handleRedo,
  };

  shortcutsRef.current = {
    // Only in the studio with a project open (never act invisibly from Home)
    enabled: hasSession && (isMobile ? mobileTab !== 'home' : view === 'studio'),
    play: handlePlayPause,
    split: handleSplitSelectedClip,
    del: handleDeleteSelectedClip,
    undo: handleUndo,
    redo: handleRedo,
    duplicate: handleDuplicateSelectedClip,
    record: () => void handleToggleRecording(),
    loop: transportProps.onToggleLoop,
    rewind: handleRewind,
    save: handleManualSave,
    shortcuts: () => setShowShortcuts(true),
    copy: () => handleCopyClips(false),
    cut: () => handleCopyClips(true),
    paste: handlePasteClips,
    selectAll: () => selectClips(clips.map((c) => c.id)),
    clearSelection: () => setSelectedClipIds(selectedClipId ? [selectedClipId] : []),
  };
  saveNowRef.current = hasSession && storageHydrated ? handleManualSave : null;

  /* ------------------------------ mobile layout ----------------------------- */
  if (isMobile) {
    const navItems: { id: MobileTab; label: string; icon: typeof Layers }[] = [
      { id: 'home', label: 'Home', icon: HomeIcon },
      { id: 'tracks', label: 'Tracks', icon: Layers },
      { id: 'edit', label: 'Edit', icon: Waves },
      { id: 'fx', label: 'Effects', icon: Sparkles },
      { id: 'mixer', label: 'Mixer', icon: SlidersHorizontal },
      { id: 'studio', label: 'Add', icon: Disc3 },
    ];

    return (
      <div className="h-[100dvh] flex flex-col bg-app text-ink overflow-hidden">
        <Toaster />
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={(e) => handleImportAudioFiles(e.target.files)}
        />
        <input
          ref={projectFileInputRef}
          type="file"
          accept=".aether,application/json"
          className="hidden"
          onChange={(e) => handleImportProjectFileChange(e.target.files)}
        />

        <MobileHeader
          {...projectChromeProps}
          onHome={mobileTab === 'home' || !hasSession}
          onContinue={() => setMobileTab('tracks')}
        />

        <div className="flex-1 min-h-0 flex flex-col">
          {mobileTab === 'home' && <Home {...homeProps} />}

          {!hasSession && mobileTab !== 'home' && mobileTab !== 'studio' && noProjectState}

          {hasSession && mobileTab === 'tracks' && (
            <Arrangement
              {...arrangementProps}
              pixelsPerSecond={Math.min(pixelsPerSecond, 70)}
              compact
              cornerSlot={
                <>
                  <span className="text-[11px] font-semibold text-mute uppercase tracking-wider">
                    {tracks.length} tracks
                  </span>
                  <button
                    onClick={() => setMobileTab('studio')}
                    className="w-7 h-7 rounded-lg bg-accent text-white flex items-center justify-center"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </>
              }
            />
          )}

          {hasSession && (mobileTab === 'edit' || mobileTab === 'fx' || mobileTab === 'mixer') && (
            <>
              {selectedTrack && (
                <div className="h-[112px] shrink-0 flex flex-col border-b border-line">
                  <Arrangement
                    {...arrangementProps}
                    tracks={[selectedTrack]}
                    pixelsPerSecond={Math.min(pixelsPerSecond, 70)}
                    compact
                    cornerSlot={
                      <span className="text-[10px] font-semibold text-accent uppercase tracking-wider truncate">
                        Pinned Track
                      </span>
                    }
                  />
                </div>
              )}
              <div className="flex-1 overflow-y-auto px-3 pb-3">
                <Inspector tab={mobileTab} {...inspectorProps} />
              </div>
            </>
          )}

          {mobileTab === 'studio' && (
            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
              <div className="rounded-2xl bg-panel border border-line p-3">
                <h2 className="text-[13px] font-semibold px-1 pb-2">Add a track</h2>
                {addTrackMenu}
              </div>
              <ExportMenu isExporting={isExporting} onExport={handleExport} inline />
            </div>
          )}
        </div>

        {hasSession && mobileTab !== 'home' && <MobileTransport {...transportProps} />}

        <nav className="h-14 shrink-0 grid grid-cols-6 border-t border-line bg-app pb-[env(safe-area-inset-bottom)]">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setMobileTab(id)}
              className={`flex flex-col items-center justify-center gap-0.5 ${
                mobileTab === id ? 'text-accent' : 'text-mute'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </nav>
      </div>
    );
  }

  /* ------------------------------ desktop layout ---------------------------- */
  return (
    <div
      className="h-screen flex flex-col bg-app text-ink overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handleImportAudioFiles(e.dataTransfer.files);
      }}
    >
      <Toaster />
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(e) => handleImportAudioFiles(e.target.files)}
      />
      <input
        ref={projectFileInputRef}
        type="file"
        accept=".aether,application/json"
        className="hidden"
        onChange={(e) => handleImportProjectFileChange(e.target.files)}
      />

      <StudioHeader
        {...transportProps}
        {...projectChromeProps}
        view={view}
        onViewChange={setView}
        bpm={bpm}
        onBpmChange={setBpm}
        snapToGrid={snapToGrid}
        onToggleSnap={() => setSnapToGrid((v) => !v)}
        onZoomIn={() => setPixelsPerSecond((v) => Math.min(200, v + 12))}
        onZoomOut={() => setPixelsPerSecond((v) => Math.max(35, v - 12))}
        isExporting={isExporting}
        onExport={handleExport}
        onShowShortcuts={() => setShowShortcuts(true)}
      />
      <ShortcutsDialog open={showShortcuts} onClose={() => setShowShortcuts(false)} />

      {view === 'home' ? (
        <div className="flex-1 min-h-0">
          <Home {...homeProps} />
        </div>
      ) : !hasSession ? (
        noProjectState
      ) : (
        <div className="flex-1 min-h-0 flex">
          {/* Timeline */}
          <main className="flex-1 min-w-0 flex flex-col relative">
            <Arrangement
              {...arrangementProps}
              cornerSlot={
                <>
                  <span className="text-[11px] font-semibold text-mute uppercase tracking-wider">
                    Tracks
                  </span>
                  <div className="relative">
                    <button
                      onClick={() => setShowAddMenu((s) => !s)}
                      className="h-7 px-2.5 rounded-lg bg-accent text-white text-xs font-semibold flex items-center gap-1 hover:brightness-110"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add
                    </button>
                  </div>
                </>
              }
            />

            {showAddMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowAddMenu(false)} />
                <div className="absolute top-10 left-2 z-50 w-72 rounded-2xl bg-panel border border-line shadow-2xl shadow-black/60 p-2">
                  {addTrackMenu}
                </div>
              </>
            )}
          </main>

          {/* Inspector */}
          <aside className="w-[360px] shrink-0 border-l border-line bg-app flex flex-col">
            <div className="p-3 shrink-0">
              <InspectorTabs tab={inspectorTab} onChange={setInspectorTab} />
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-3">
              <Inspector tab={inspectorTab} {...inspectorProps} />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
};

export default App;
