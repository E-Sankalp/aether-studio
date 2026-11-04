import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AudioClip,
  AudioTrack,
  BufferOperationType,
  ClipProcessSettings,
  DEFAULT_CLIP_PROCESSES,
  LoopRegion,
  LoudnessReport,
  MasterSettings,
  TrackEffects,
  WaveformSelection,
} from './types/audio';
import { DEFAULT_MASTER } from './audio/mastering';
import { MasteringPanel } from './components/MasteringPanel';
import { LatencyPanel } from './components/LatencyPanel';
import { MobileHeader, MobileTransport, StudioHeader, TransportProps } from './components/StudioHeader';
import { meterStore, micLevelStore, playheadStore, useLiveStore } from './utils/liveStore';
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

interface HistorySnapshot {
  tracks: AudioTrack[];
  clips: AudioClip[];
}

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
  const [view, setView] = useState<'home' | 'studio'>('studio');
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
  const [selectedClipId, setSelectedClipId] = useState('');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('fx');
  const [mobileTab, setMobileTab] = useState<MobileTab>('tracks');
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
  const [loudnessReport, setLoudnessReport] = useState<LoudnessReport | null>(null);
  const [reportStale, setReportStale] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [loop, setLoop] = useState<LoopRegion>({ enabled: false, start: 0, end: 8 });
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [countInEnabled, setCountInEnabled] = useState(true);
  const [countInBeat, setCountInBeat] = useState<number | null>(null);
  const [micMonitorOn, setMicMonitorOn] = useState(false);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  // Surface storage problems (quota full / failed writes) instead of failing silently
  useEffect(() => subscribeStorageErrors(setStorageWarning), []);

  const [selection, setSelection] = useState<WaveformSelection | null>(null);

  const [past, setPast] = useState<HistorySnapshot[]>([]);
  const [future, setFuture] = useState<HistorySnapshot[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectFileInputRef = useRef<HTMLInputElement | null>(null);
  const countInTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Latest tracks/clips for async work (background renders finish after the closure is stale)
  const liveRef = useRef({ tracks, clips });
  liveRef.current = { tracks, clips };

  const pushHistory = useCallback((nextTracks: AudioTrack[], nextClips: AudioClip[]) => {
    const current = liveRef.current;
    setPast((prev) => [...prev.slice(-24), { tracks: current.tracks, clips: current.clips }]);
    setFuture([]);
    liveRef.current = { tracks: nextTracks, clips: nextClips };
    setTracks(nextTracks);
    setClips(nextClips);
  }, []);

  /** Applies a project's mastering settings and drops the previous loudness analysis. */
  const resetMastering = useCallback((next?: Partial<MasterSettings>) => {
    const settings = { ...DEFAULT_MASTER, ...next };
    setMaster(settings);
    setLoudnessReport(null);
    setReportStale(false);
    audioEngine.setMasterSettings(settings, 0);
  }, []);

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
    setPast([]);
    setFuture([]);
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
    setPast([]);
    setFuture([]);
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
        resetMastering(saved.master);
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
    selectedTrackId,
    selectedClipId,
  ]);

  // Feed master + per-track meters at ~20 fps for every meter in the UI
  useEffect(() => {
    let id = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 50) {
        last = now;
        meterStore.set(audioEngine.getMeterLevels());
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    audioEngine.setMetronome(metronomeOn, bpm);
  }, [metronomeOn, bpm]);

  // Any change to the mix makes the last loudness analysis out of date
  useEffect(() => {
    setReportStale(true);
  }, [tracks, clips, masterVolume, master]);

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
      alert('Could not analyze the mix. Please try again.');
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

  // Loop region edits apply to running playback seamlessly (the engine schedules iterations)
  useEffect(() => {
    if (isPlaying && !isRecording) {
      audioEngine.updateLoop(loop.enabled ? { start: loop.start, end: loop.end } : null);
    }
  }, [loop, isPlaying, isRecording]);

  // Playhead + mic level loop (position comes from the audio clock)
  useEffect(() => {
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

  const handleUpdateTrack = useCallback((trackId: string, patch: Partial<AudioTrack>) => {
    setSelectedTrackId(trackId);
    setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, ...patch } : t)));
  }, []);

  const handleUpdateTrackEffects = useCallback((trackId: string, fxPatch: Partial<TrackEffects>) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, effects: { ...t.effects, ...fxPatch } } : t))
    );
  }, []);

  const handleUpdateClip = useCallback((clipId: string, patch: Partial<AudioClip>) => {
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, ...patch } : c)));
  }, []);

  const handleSplitSelectedClip = useCallback(() => {
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) return;
    const playhead = playheadStore.get();
    if (playhead <= clip.startTime + 0.08 || playhead >= clip.startTime + clip.duration - 0.08)
      return;

    const firstDur = playhead - clip.startTime;
    const leftClip: AudioClip = { ...clip, duration: firstDur, fadeOut: 0.02 };
    const rightClip: AudioClip = {
      ...clip,
      id: `clp_${Date.now()}`,
      name: `${clip.name} (2)`,
      startTime: playhead,
      offset: clip.offset + firstDur * clip.playbackRate,
      duration: clip.duration - firstDur,
      fadeIn: 0.02,
    };
    pushHistory(tracks, clips.map((c) => (c.id === clip.id ? leftClip : c)).concat(rightClip));
    setSelectedClipId(rightClip.id);
  }, [clips, selectedClipId, tracks, pushHistory]);

  const handleDuplicateSelectedClip = useCallback(() => {
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) return;
    // Place duplicate right after the furthest clip on the same track so it never overlaps
    const trackEnd = clips
      .filter((c) => c.trackId === clip.trackId)
      .reduce((max, c) => Math.max(max, c.startTime + c.duration), clip.startTime + clip.duration);
    const dup: AudioClip = {
      ...clip,
      id: `clp_${Date.now()}`,
      startTime: trackEnd,
    };
    pushHistory(tracks, [...clips, dup]);
    setSelectedClipId(dup.id);
  }, [clips, selectedClipId, tracks, pushHistory]);

  const handleDeleteSelectedClip = useCallback(() => {
    if (!selectedClipId) return;
    const nextClips = clips.filter((c) => c.id !== selectedClipId);
    pushHistory(tracks, nextClips);
    setSelectedClipId(nextClips[0]?.id || '');
  }, [clips, selectedClipId, tracks, pushHistory]);

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

  /*
   * Background clip rendering. Each commit (slider release / button) bumps a per-clip sequence
   * number; only the newest render for a clip is applied, so fast successive edits never land out
   * of order. `pendingClipState` holds the latest *requested* settings so edits made while a render
   * is still running build on each other instead of on the last finished render.
   */
  const renderSeqRef = useRef(new Map<string, number>());
  const pendingClipStateRef = useRef(
    new Map<
      string,
      { processes: ClipProcessSettings; pitchSemitones: number; sourceBufferId: string }
    >()
  );
  const [renderingClipIds, setRenderingClipIds] = useState<ReadonlySet<string>>(new Set());
  const setClipRendering = (clipId: string, on: boolean) =>
    setRenderingClipIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(clipId);
      else next.delete(clipId);
      return next;
    });

  /** Invalidates in-flight renders (e.g. on undo/redo) so they can't overwrite restored state. */
  const cancelPendingRenders = useCallback(() => {
    renderSeqRef.current.forEach((seq, id) => renderSeqRef.current.set(id, seq + 1));
    pendingClipStateRef.current.clear();
    setRenderingClipIds(new Set());
  }, []);

  const commitClipRender = useCallback(
    async (
      clipId: string,
      change: {
        processes?: Partial<ClipProcessSettings>;
        pitchSemitones?: number;
        sourceBufferId?: string;
      }
    ) => {
      const clip = liveRef.current.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const base = pendingClipStateRef.current.get(clipId) ?? {
        processes: { ...DEFAULT_CLIP_PROCESSES, ...clip.processes },
        pitchSemitones: clip.pitchSemitones,
        sourceBufferId: clip.sourceBufferId || clip.bufferId,
      };
      const next = {
        processes: { ...base.processes, ...change.processes },
        pitchSemitones: change.pitchSemitones ?? base.pitchSemitones,
        sourceBufferId: change.sourceBufferId ?? base.sourceBufferId,
      };
      pendingClipStateRef.current.set(clipId, next);
      const seq = (renderSeqRef.current.get(clipId) ?? 0) + 1;
      renderSeqRef.current.set(clipId, seq);
      setClipRendering(clipId, true);

      const hasSel =
        selection && selection.clipId === clip.id && selection.endOffset - selection.startOffset > 0.03;
      const selStart = hasSel ? selection.startOffset : 0;
      const selEnd = hasSel ? selection.endOffset : clip.duration;
      const track = liveRef.current.tracks.find((t) => t.id === clip.trackId);

      try {
        const newBufId = await audioEngine.renderClip({
          clipId,
          sourceBufferId: next.sourceBufferId,
          regionStartSec: clip.offset + selStart * clip.playbackRate,
          regionEndSec: clip.offset + selEnd * clip.playbackRate,
          processes: next.processes,
          scaleId: track?.effects.autoPitchScale || 'C_major',
          pitchSemitones: next.pitchSemitones,
        });
        if (renderSeqRef.current.get(clipId) !== seq) return; // superseded by a newer edit
        pendingClipStateRef.current.delete(clipId);
        const latest = liveRef.current;
        if (!newBufId || !latest.clips.some((c) => c.id === clipId)) return;
        pushHistory(
          latest.tracks,
          latest.clips.map((c) =>
            c.id === clipId
              ? {
                  ...c,
                  sourceBufferId: next.sourceBufferId,
                  processes: next.processes,
                  pitchSemitones: next.pitchSemitones,
                  renderedPitch: next.pitchSemitones,
                  bufferId: newBufId,
                }
              : c
          )
        );
      } catch (err) {
        console.error('Clip render failed:', err);
        if (renderSeqRef.current.get(clipId) === seq) {
          pendingClipStateRef.current.delete(clipId);
          setStorageWarning('Could not process this clip. Please try again.');
        }
      } finally {
        if (renderSeqRef.current.get(clipId) === seq) setClipRendering(clipId, false);
      }
    },
    [selection, pushHistory]
  );

  const handleUpdateClipProcesses = useCallback(
    (patch: Partial<ClipProcessSettings>) => {
      if (selectedClipId) void commitClipRender(selectedClipId, { processes: patch });
    },
    [selectedClipId, commitClipRender]
  );

  const handleCommitClipPitch = useCallback(
    (semitones: number) => {
      if (selectedClipId) void commitClipRender(selectedClipId, { pitchSemitones: semitones });
    },
    [selectedClipId, commitClipRender]
  );

  const handleApplyBufferOp = useCallback(
    (op: BufferOperationType) => {
      const clip = clips.find((c) => c.id === selectedClipId);
      if (!clip) return;
      // Toggles build on the latest requested settings (a render may still be running)
      const pending = pendingClipStateRef.current.get(clip.id);
      const cur: ClipProcessSettings = pending?.processes ?? {
        ...DEFAULT_CLIP_PROCESSES,
        ...clip.processes,
      };

      const toggles: Partial<Record<BufferOperationType, Partial<ClipProcessSettings>>> = {
        autoPitch: { autoPitch: cur.autoPitch > 0 ? 0 : 80 },
        harmony: { harmony: cur.harmony > 0 ? 0 : 65 },
        voiceSoften: { voiceSoften: cur.voiceSoften > 0 ? 0 : 70 },
        denoise: { denoise: cur.denoise > 0 ? 0 : 65 },
        normalize: { normalize: cur.normalize > 0 ? 0 : 100 },
        boost: { boostDb: Math.min(12, cur.boostDb + 3) },
        attenuate: { boostDb: Math.max(-12, cur.boostDb - 3) },
        fadeIn: { fadeInShape: cur.fadeInShape > 0 ? 0 : 35 },
        fadeOut: { fadeOutShape: cur.fadeOutShape > 0 ? 0 : 35 },
        reverse: { reverse: !cur.reverse },
      };
      const toggle = toggles[op];
      if (toggle) {
        handleUpdateClipProcesses(toggle);
        return;
      }

      if (op === 'silence') {
        // Destructive edit on the untouched source, then re-render pitch + processes on top
        const hasSel =
          selection &&
          selection.clipId === clip.id &&
          selection.endOffset - selection.startOffset > 0.03;
        const selStart = hasSel ? selection.startOffset : 0;
        const selEnd = hasSel ? selection.endOffset : clip.duration;
        const source = pending?.sourceBufferId ?? clip.sourceBufferId ?? clip.bufferId;
        const newSrc = audioEngine.silenceRegion(
          source,
          clip.offset + selStart * clip.playbackRate,
          clip.offset + selEnd * clip.playbackRate
        );
        if (newSrc) void commitClipRender(clip.id, { sourceBufferId: newSrc });
      }
    },
    [clips, selectedClipId, selection, handleUpdateClipProcesses, commitClipRender]
  );

  const handleUndo = useCallback(() => {
    if (past.length === 0) return;
    cancelPendingRenders();
    const previous = past[past.length - 1];
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [{ tracks, clips }, ...prev]);
    setTracks(previous.tracks);
    setClips(previous.clips);
  }, [past, tracks, clips, cancelPendingRenders]);

  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    cancelPendingRenders();
    const next = future[0];
    setFuture((prev) => prev.slice(1));
    setPast((prev) => [...prev, { tracks, clips }]);
    setTracks(next.tracks);
    setClips(next.clips);
  }, [future, tracks, clips, cancelPendingRenders]);

  /*
   * Storage cleanup: delete stored audio no longer referenced by any saved project, the open
   * project, the undo/redo history, or a just-created buffer whose clip isn't committed yet.
   */
  useEffect(() => {
    if (!storageHydrated) return;
    const timer = window.setTimeout(() => {
      const referenced = collectReferencedBufferIds(loadAllProjectsFromLibrary(), [
        ...clips,
        ...past.flatMap((s) => s.clips),
        ...future.flatMap((s) => s.clips),
      ]);
      audioEngine.getRecentBufferIds().forEach((id) => referenced.add(id));
      pendingClipStateRef.current.forEach((p) => referenced.add(p.sourceBufferId));
      void pruneUnusedBuffers(referenced);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [storageHydrated, clips, past, future]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type !== 'range') return;
      if (t instanceof HTMLTextAreaElement) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPause();
      } else if (!mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        handleSplitSelectedClip();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        handleDeleteSelectedClip();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        handleDuplicateSelectedClip();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handlePlayPause,
    handleSplitSelectedClip,
    handleDeleteSelectedClip,
    handleUndo,
    handleRedo,
    handleDuplicateSelectedClip,
  ]);

  const handleAddTrack = (stemType?: StemType) => {
    const color = TRACK_COLORS[tracks.length % TRACK_COLORS.length];
    const newTrackId = `trk_${Date.now()}`;
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
        id: `clp_${Date.now()}`,
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
          targetTrackId = `trk_${Date.now()}_${i}`;
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
          id: `clp_${Date.now()}_${i}`,
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
        alert(
          `Could not read "${file.name}". Please use a valid audio file (WAV, MP3, OGG, FLAC).`
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

      const startAt = session ? session.startTime : findNonOverlappingStart(target.id, playhead);
      const newClip: AudioClip = {
        id: `clp_rec_${Date.now()}`,
        trackId: target.id,
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
        color: target.color,
      };
      pushHistory(tracks, [...clips, newClip]);
      setSelectedClipId(newClip.id);
      setSelectedTrackId(target.id);
      // Rewind playhead to the start of the newly recorded take so pressing Play plays it immediately
      setPlayhead(startAt);
      if (isMobile) setMobileTab('tracks');
    } else {
      const target = tracks.find((t) => t.id === selectedTrackId) || tracks[0];
      if (!target) return;

      // Ensure we never overlap an existing clip on the chosen track
      const safeStart = findNonOverlappingStart(target.id, playhead);
      setShowAddMenu(false);

      // Open the mic first so its start-up delay never eats into the count-in or the downbeat
      audioEngine.stop();
      setIsPlaying(false);
      try {
        await audioEngine.startMicRecording(target.id);
      } catch {
        alert('Microphone access could not be started. Please check your browser permissions.');
        return;
      }

      setPlayhead(safeStart);
      setRecordingSession({ trackId: target.id, startTime: safeStart, startedAtMs: performance.now() });
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
        (c) => c.trackId !== target.id || c.startTime + c.duration <= safeStart
      );
      audioEngine.play(tracks, backingClips, safeStart, null, { bpm, startAtCtx });
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
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed. Please try again.');
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

  const handleSelectClip = useCallback((clipId: string, trackId: string) => {
    setSelectedClipId(clipId);
    setSelectedTrackId(trackId);
  }, []);

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
    isRenderingClip: Boolean(selectedClip && renderingClipIds.has(selectedClip.id)),
    onSplit: handleSplitSelectedClip,
    onDuplicate: handleDuplicateSelectedClip,
    onDelete: handleDeleteSelectedClip,
    onApplyBufferOp: handleApplyBufferOp,
    masterVolume,
    onMasterVolume: handleMasterVolume,
    masterSection: (
      <>
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
    selectedClipId,
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
    onDeleteTrack: handleDeleteTrack,
    onSeek: handleSeek,
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
    resetMastering(proj.master);
    setSelectedTrackId(proj.selectedTrackId || proj.tracks[0]?.id || '');
    setSelectedClipId(proj.selectedClipId || validClips[0]?.id || '');
    setPast([]);
    setFuture([]);
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
      alert('Could not open .aether project file. Please choose a valid .aether backup file.');
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

  const storageBanner = storageWarning ? (
    <div
      role="alert"
      className="fixed bottom-20 md:bottom-4 left-1/2 -translate-x-1/2 z-[100] max-w-[92vw] w-[460px] flex items-start gap-3 px-4 py-3 rounded-2xl border border-amber-400/40 bg-[#2a2210]/95 text-amber-100 text-xs shadow-2xl backdrop-blur"
    >
      <span className="flex-1 leading-relaxed">{storageWarning}</span>
      <button
        onClick={() => setStorageWarning(null)}
        className="shrink-0 font-semibold text-amber-300 hover:text-white"
      >
        Dismiss
      </button>
    </div>
  ) : null;

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
        {storageBanner}
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
      {storageBanner}
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
      />

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
