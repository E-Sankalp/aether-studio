import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AudioClip,
  AudioTrack,
  BufferOperationType,
  ClipProcessSettings,
  DEFAULT_CLIP_PROCESSES,
  LoopRegion,
  MeterLevels,
  TrackEffects,
  WaveformSelection,
} from './types/audio';
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
import { VisualizerDock } from './components/VisualizerDock';
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
  loadAllProjectsFromLibrary,
  loadProjectFromLocalStorage,
  PersistedProjectState,
  requestPersistentStorage,
  saveProjectToLocalStorage,
} from './utils/projectStorage';
import {
  Play,
  Pause,
  SkipBack,
  Repeat,
  Mic,
  Download,
  Plus,
  Undo2,
  Redo2,
  Magnet,
  ZoomIn,
  ZoomOut,
  Music2,
  Layers,
  Waves,
  Sparkles,
  SlidersHorizontal,
  Disc3,
  Scissors,
  Home as HomeIcon,
  Headphones,
  Timer,
  Bell,
  CheckCircle2,
} from 'lucide-react';

interface HistorySnapshot {
  tracks: AudioTrack[];
  clips: AudioClip[];
}

type MobileTab = 'home' | 'tracks' | InspectorTab | 'studio';

const MOBILE_BREAKPOINT = 900;

const emptyMeters: MeterLevels = {
  masterLeft: 0,
  masterRight: 0,
  masterPeakDb: -60,
  masterRmsDb: -60,
  phaseCorrelation: 1,
  trackLevels: {},
};

const formatTimecode = (sec: number) => {
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

const iconBtn =
  'w-9 h-9 rounded-xl flex items-center justify-center text-ink bg-raised hover:bg-[#2b2b31] disabled:opacity-30 disabled:hover:bg-raised transition-colors';

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
  const [micLevel, setMicLevel] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [bpm, setBpm] = useState(120);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(88);
  const [masterVolume, setMasterVolume] = useState(1.0);
  const [isExporting, setIsExporting] = useState(false);
  const [loop, setLoop] = useState<LoopRegion>({ enabled: false, start: 0, end: 8 });
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [countInEnabled, setCountInEnabled] = useState(true);
  const [countInBeat, setCountInBeat] = useState<number | null>(null);
  const [micMonitorOn, setMicMonitorOn] = useState(false);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const [selection, setSelection] = useState<WaveformSelection | null>(null);
  const [meterLevels, setMeterLevels] = useState<MeterLevels>(emptyMeters);

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

  const pushHistory = useCallback(
    (nextTracks: AudioTrack[], nextClips: AudioClip[]) => {
      setPast((prev) => [...prev.slice(-24), { tracks, clips }]);
      setFuture([]);
      setTracks(nextTracks);
      setClips(nextClips);
    },
    [tracks, clips]
  );

  const loadTemplate = useCallback((templateId: TemplateId, clearAllStorage = false) => {
    audioEngine.stop();
    setIsPlaying(false);
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
  }, []);

  // Hydrate saved project + custom AudioBuffers from LocalStorage & IndexedDB on startup
  useEffect(() => {
    let cancelled = false;
    const initProject = async () => {
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
        setSelectedTrackId(saved.selectedTrackId || saved.tracks[0].id);
        setSelectedClipId(saved.selectedClipId || validClips[0]?.id || '');
        audioEngine.syncTracks(saved.tracks);
      } else {
        loadTemplate('demo');
      }
      setStorageHydrated(true);
    };
    void initProject();
    return () => {
      cancelled = true;
    };
  }, [loadTemplate]);

  // Auto-save project state to LocalStorage library whenever tracks, clips, name, BPM, or loop change
  useEffect(() => {
    if (!storageHydrated || tracks.length === 0) return;
    saveProjectToLocalStorage({
      id: projectId,
      name: projectName,
      tracks,
      clips,
      bpm,
      loop,
      masterVolume,
      selectedTrackId,
      selectedClipId,
      updatedAt: Date.now(),
    });
    setSavedProjects(loadAllProjectsFromLibrary());
    void requestPersistentStorage().then(setStorageInfo);
    setSavedNotice(true);
    const t = window.setTimeout(() => setSavedNotice(false), 1400);
    return () => window.clearTimeout(t);
  }, [
    storageHydrated,
    projectId,
    projectName,
    tracks,
    clips,
    bpm,
    loop,
    masterVolume,
    selectedTrackId,
    selectedClipId,
  ]);

  useEffect(() => {
    audioEngine.setMetronome(metronomeOn, bpm);
  }, [metronomeOn, bpm]);

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

  // Playhead + mic level loop
  useEffect(() => {
    let rafId = 0;
    const maxClipEnd = clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const totalEnd = Math.max(maxClipEnd > 0 ? maxClipEnd + 0.2 : 8, loop.enabled ? loop.end : 0);
    const tick = () => {
      if (isRecording && recordingSession) {
        setMicLevel(audioEngine.getMicInputLevel());
        const elapsedSec = (performance.now() - recordingSession.startedAtMs) / 1000;
        setPlayhead(recordingSession.startTime + elapsedSec);
      } else if (isPlaying) {
        const status = audioEngine.getCurrentPlayhead(loop, tracks, clips, totalEnd);
        setPlayhead(status.time);
        if (status.ended) setIsPlaying(false);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, isRecording, recordingSession, loop, tracks, clips]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      audioEngine.stop();
      setIsPlaying(false);
    } else {
      const maxClipEnd = clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
      const startFrom =
        maxClipEnd > 0 && playhead >= maxClipEnd - 0.05
          ? loop.enabled
            ? loop.start
            : 0
          : playhead;
      setPlayhead(startFrom);
      audioEngine.play(
        tracks,
        clips,
        startFrom,
        loop.enabled && startFrom < loop.end ? loop.end : undefined
      );
      setIsPlaying(true);
    }
  }, [isPlaying, loop, playhead, tracks, clips]);

  const handleRewind = useCallback(() => {
    setPlayhead(0);
    if (isPlaying) audioEngine.play(tracks, clips, 0, loop.enabled ? loop.end : undefined);
  }, [isPlaying, tracks, clips, loop]);

  const handleSeek = useCallback(
    (time: number) => {
      setPlayhead(time);
      if (isPlaying) {
        audioEngine.play(
          tracks,
          clips,
          time,
          loop.enabled && time < loop.end ? loop.end : undefined
        );
      }
    },
    [isPlaying, tracks, clips, loop]
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
  }, [clips, selectedClipId, playhead, tracks, pushHistory]);

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

  const handleUpdateClipProcesses = useCallback(
    (patch: Partial<ClipProcessSettings>) => {
      const clip = clips.find((c) => c.id === selectedClipId);
      if (!clip) return;
      const trackForClip = tracks.find((t) => t.id === clip.trackId);
      const sourceBufferId = clip.sourceBufferId || clip.bufferId;
      const nextProcesses: ClipProcessSettings = {
        ...DEFAULT_CLIP_PROCESSES,
        ...clip.processes,
        ...patch,
      };

      const hasSel =
        selection &&
        selection.clipId === clip.id &&
        selection.endOffset - selection.startOffset > 0.03;
      const selStart = hasSel ? selection.startOffset : 0;
      const selEnd = hasSel ? selection.endOffset : clip.duration;

      const newBufId = audioEngine.renderClipProcesses(
        clip.id,
        sourceBufferId,
        clip.offset,
        selStart * clip.playbackRate,
        selEnd * clip.playbackRate,
        nextProcesses,
        trackForClip?.effects.autoPitchScale || 'C_major'
      );

      if (newBufId) {
        pushHistory(
          tracks,
          clips.map((c) =>
            c.id === clip.id
              ? { ...c, sourceBufferId, processes: nextProcesses, bufferId: newBufId }
              : c
          )
        );
      }
    },
    [clips, selectedClipId, selection, tracks, pushHistory]
  );

  const handleApplyBufferOp = useCallback(
    (op: BufferOperationType) => {
      const clip = clips.find((c) => c.id === selectedClipId);
      if (!clip) return;
      const cur: ClipProcessSettings = { ...DEFAULT_CLIP_PROCESSES, ...clip.processes };

      if (op === 'autoPitch') {
        handleUpdateClipProcesses({ autoPitch: cur.autoPitch > 0 ? 0 : 80 });
        return;
      }
      if (op === 'harmony') {
        handleUpdateClipProcesses({ harmony: cur.harmony > 0 ? 0 : 65 });
        return;
      }
      if (op === 'voiceSoften') {
        handleUpdateClipProcesses({ voiceSoften: cur.voiceSoften > 0 ? 0 : 70 });
        return;
      }
      if (op === 'denoise') {
        handleUpdateClipProcesses({ denoise: cur.denoise > 0 ? 0 : 65 });
        return;
      }
      if (op === 'normalize') {
        handleUpdateClipProcesses({ normalize: cur.normalize > 0 ? 0 : 100 });
        return;
      }
      if (op === 'boost') {
        handleUpdateClipProcesses({ boostDb: Math.min(12, cur.boostDb + 3) });
        return;
      }
      if (op === 'attenuate') {
        handleUpdateClipProcesses({ boostDb: Math.max(-12, cur.boostDb - 3) });
        return;
      }
      if (op === 'fadeIn') {
        handleUpdateClipProcesses({ fadeInShape: cur.fadeInShape > 0 ? 0 : 35 });
        return;
      }
      if (op === 'fadeOut') {
        handleUpdateClipProcesses({ fadeOutShape: cur.fadeOutShape > 0 ? 0 : 35 });
        return;
      }
      if (op === 'reverse') {
        handleUpdateClipProcesses({ reverse: !cur.reverse });
        return;
      }

      const trackForClip = tracks.find((t) => t.id === clip.trackId);
      const hasSel =
        selection &&
        selection.clipId === clip.id &&
        selection.endOffset - selection.startOffset > 0.03;
      const selStart = hasSel ? selection.startOffset : 0;
      const selEnd = hasSel ? selection.endOffset : clip.duration;

      const newBufId = audioEngine.applyBufferOperation(
        clip.bufferId,
        clip.offset,
        clip.duration,
        selStart * clip.playbackRate,
        selEnd * clip.playbackRate,
        op,
        trackForClip?.effects.autoPitchScale || 'C_major',
        Math.max(50, trackForClip?.effects.autoPitchAmount || 85)
      );
      if (newBufId) {
        pushHistory(
          tracks,
          clips.map((c) =>
            c.id === clip.id ? { ...c, sourceBufferId: newBufId, bufferId: newBufId } : c
          )
        );
      }
    },
    [clips, selectedClipId, selection, tracks, pushHistory, handleUpdateClipProcesses]
  );

  const handleUndo = useCallback(() => {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [{ tracks, clips }, ...prev]);
    setTracks(previous.tracks);
    setClips(previous.clips);
  }, [past, tracks, clips]);

  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((prev) => prev.slice(1));
    setPast((prev) => [...prev, { tracks, clips }]);
    setTracks(next.tracks);
    setClips(next.clips);
  }, [future, tracks, clips]);

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
    if (countInBeat !== null) {
      if (countInTimerRef.current) {
        window.clearInterval(countInTimerRef.current);
        countInTimerRef.current = null;
      }
      setCountInBeat(null);
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

      const beginActualRecording = async () => {
        try {
          await audioEngine.startMicRecording(target.id);
          setPlayhead(safeStart);
          setRecordingSession({
            trackId: target.id,
            startTime: safeStart,
            startedAtMs: performance.now(),
          });
          setIsRecording(true);

          // Play backing tracks (excluding clips on the track being recorded if at the same time)
          const backingClips = clips.filter(
            (c) => c.trackId !== target.id || c.startTime + c.duration <= safeStart
          );
          audioEngine.play(tracks, backingClips, safeStart);
          setIsPlaying(true);
        } catch {
          alert('Microphone access could not be started. Please check your browser permissions.');
        }
      };

      if (countInEnabled) {
        audioEngine.stop();
        setIsPlaying(false);
        const beatMs = (60 / Math.max(40, Math.min(240, bpm))) * 1000;
        let beat = 1;
        setCountInBeat(1);
        audioEngine.playClickSound(true);
        countInTimerRef.current = window.setInterval(() => {
          beat += 1;
          if (beat <= 4) {
            setCountInBeat(beat);
            audioEngine.playClickSound(false);
          } else {
            if (countInTimerRef.current) {
              window.clearInterval(countInTimerRef.current);
              countInTimerRef.current = null;
            }
            setCountInBeat(null);
            void beginActualRecording();
          }
        }, beatMs);
      } else {
        await beginActualRecording();
      }
    }
  };

  const handleExportWav = async () => {
    setIsExporting(true);
    try {
      const blob = await audioEngine.exportMixdownWav(tracks, clips, masterVolume);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `AETHER_Mixdown_${bpm}BPM.wav`;
      a.click();
      URL.revokeObjectURL(url);
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
    playhead + 4
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
    onSplit: handleSplitSelectedClip,
    onDuplicate: handleDuplicateSelectedClip,
    onDelete: handleDeleteSelectedClip,
    onApplyBufferOp: handleApplyBufferOp,
    meterLevels,
    masterVolume,
    onMasterVolume: handleMasterVolume,
  };

  const arrangementProps = {
    tracks,
    clips,
    selectedTrackId: selectedTrack?.id ?? '',
    selectedClipId,
    playhead,
    loop,
    bpm,
    pixelsPerSecond,
    durationSec,
    snapToGrid,
    trackLevels: meterLevels.trackLevels,
    recording: recordingSession
      ? { trackId: recordingSession.trackId, startTime: recordingSession.startTime }
      : null,
    onSelectTrack: setSelectedTrackId,
    onSelectClip: (clipId: string, trackId: string) => {
      setSelectedClipId(clipId);
      setSelectedTrackId(trackId);
    },
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

  const logo = (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center">
        <Music2 className="w-4 h-4 text-white" />
      </div>
      <span className="text-[15px] font-bold tracking-tight">Aether</span>
    </div>
  );

  const playButton = (size: string) => (
    <button
      onClick={handlePlayPause}
      title="Play / Pause (Space)"
      className={`${size} rounded-full bg-accent text-white flex items-center justify-center hover:brightness-110 transition`}
    >
      {isPlaying && !isRecording ? (
        <Pause className="w-4 h-4 fill-current" />
      ) : (
        <Play className="w-4 h-4 fill-current ml-0.5" />
      )}
    </button>
  );

  const recordButton = (
    <button
      onClick={handleToggleRecording}
      title={`Record into "${selectedTrack?.name || 'selected track'}"`}
      className={`h-9 rounded-xl flex items-center justify-center gap-1.5 px-3 text-xs font-semibold transition-colors ${
        countInBeat !== null
          ? 'bg-amber-500 text-black animate-pulse'
          : isRecording
          ? 'bg-accent text-white animate-pulse'
          : 'bg-raised text-ink hover:bg-[#2b2b31]'
      }`}
    >
      <Mic
        className={`w-4 h-4 ${
          countInBeat !== null ? 'text-black' : isRecording ? 'text-white' : 'text-accent'
        }`}
      />
      {countInBeat !== null ? (
        <span className="font-mono font-bold tabular-nums">Count-in {countInBeat}/4</span>
      ) : isRecording ? (
        <span className="font-mono tabular-nums">Stop · {Math.round(micLevel * 100)}%</span>
      ) : (
        <span className="hidden sm:inline truncate max-w-[110px]">
          Rec · {selectedTrack?.name || 'Track'}
        </span>
      )}
    </button>
  );

  const loopButton = (
    <button
      onClick={() => setLoop((l) => ({ ...l, enabled: !l.enabled }))}
      title="Loop"
      className={`${iconBtn} ${loop.enabled ? '!bg-accent/20 !text-accent' : ''}`}
    >
      <Repeat className="w-4 h-4" />
    </button>
  );

  const metronomeButton = (
    <button
      onClick={() => setMetronomeOn((m) => !m)}
      title="Metronome click track"
      className={`${iconBtn} ${metronomeOn ? '!bg-accent/20 !text-accent' : ''}`}
    >
      <Bell className="w-4 h-4" />
    </button>
  );

  const countInButton = (
    <button
      onClick={() => setCountInEnabled((c) => !c)}
      title="4-beat count-in (1 - 2 - 3 - 4) before recording"
      className={`h-9 px-2.5 rounded-xl flex items-center gap-1 text-xs font-semibold transition-colors ${
        countInEnabled
          ? 'bg-accent/20 text-accent'
          : 'bg-raised text-mute hover:text-ink'
      }`}
    >
      <Timer className="w-3.5 h-3.5" />
      <span>4B</span>
    </button>
  );

  const monitorButton = (
    <button
      onClick={() => setMicMonitorOn((m) => !m)}
      title="Live Mic Monitoring with track effects (use headphones)"
      className={`h-9 px-2.5 rounded-xl flex items-center gap-1 text-xs font-semibold transition-colors ${
        micMonitorOn
          ? 'bg-emerald-500/20 text-emerald-400'
          : 'bg-raised text-mute hover:text-ink'
      }`}
    >
      <Headphones className="w-3.5 h-3.5" />
      <span className="hidden xl:inline">Mon</span>
    </button>
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
    setSelectedTrackId(proj.selectedTrackId || proj.tracks[0]?.id || '');
    setSelectedClipId(proj.selectedClipId || validClips[0]?.id || '');
    setPast([]);
    setFuture([]);
    audioEngine.syncTracks(proj.tracks);
    setView('studio');
    setMobileTab('tracks');
  }, []);

  const handleDeleteSavedProject = useCallback(
    (targetId: string) => {
      const remaining = deleteProjectFromLibrary(targetId);
      setSavedProjects(remaining);
      if (targetId === projectId) {
        if (remaining.length > 0) {
          handleOpenSavedProject(remaining[0]);
        } else {
          loadTemplate('scratch', false);
        }
      }
    },
    [projectId, handleOpenSavedProject, loadTemplate]
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
    loadTemplate('scratch', true);
  }, [loadTemplate]);

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

  const saveBadgeButton = (
    <button
      onClick={handleManualSave}
      title="Project and recorded audio are saved permanently on this device (tap to save now)"
      className={`h-8 px-2.5 rounded-lg flex items-center gap-1 text-[11px] font-semibold transition-colors ${
        savedNotice
          ? 'bg-emerald-500/20 text-emerald-400'
          : 'bg-raised text-mute hover:text-ink'
      }`}
    >
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
      <span>Saved</span>
    </button>
  );

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

        <header className="h-14 px-3 flex items-center justify-between shrink-0 border-b border-line bg-panel">
          <div className="flex items-center gap-2 min-w-0">
            {logo}
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              title="Project name (auto-saved)"
              className="w-24 sm:w-36 h-7 px-2 rounded-lg bg-app border border-line text-xs font-medium text-ink outline-none focus:border-accent truncate"
            />
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {saveBadgeButton}
            <button
              onClick={() => loadTemplate('scratch', false)}
              className="h-8 px-2.5 rounded-lg bg-raised text-xs font-medium text-ink"
            >
              New
            </button>
            <VisualizerDock isPlaying={isPlaying} onMeterUpdate={setMeterLevels} />
            <button onClick={handleUndo} disabled={past.length === 0} className={iconBtn}>
              <Undo2 className="w-4 h-4" />
            </button>
            <button onClick={handleRedo} disabled={future.length === 0} className={iconBtn}>
              <Redo2 className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 flex flex-col">
          {mobileTab === 'home' && <Home {...homeProps} />}

          {mobileTab === 'tracks' && (
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

          {(mobileTab === 'edit' || mobileTab === 'fx' || mobileTab === 'mixer') && (
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
              <button
                onClick={handleExportWav}
                disabled={isExporting}
                className="h-12 rounded-2xl bg-accent text-white text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                {isExporting ? 'Rendering…' : 'Export WAV'}
              </button>
            </div>
          )}
        </div>

        {/* Transport */}
        {mobileTab !== 'home' && (
          <div className="h-16 px-3 shrink-0 flex items-center justify-between border-t border-line bg-panel">
            <div className="flex items-center gap-1.5">
              <button onClick={handleRewind} className={iconBtn}>
                <SkipBack className="w-4 h-4" />
              </button>
              {playButton('w-10 h-10')}
              {recordButton}
            </div>
            <div className="font-mono text-xs tabular-nums">{formatTimecode(playhead)}</div>
            <div className="flex items-center gap-1.5">
              {metronomeButton}
              {countInButton}
              {monitorButton}
              <button
                onClick={handleSplitSelectedClip}
                className={iconBtn}
                title="Split at playhead"
              >
                <Scissors className="w-4 h-4" />
              </button>
              {loopButton}
            </div>
          </div>
        )}

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

      {/* Top bar */}
      <header className="h-16 px-4 shrink-0 grid grid-cols-[1fr_auto_1fr] items-center border-b border-line bg-panel relative z-50">
        <div className="flex items-center gap-2.5 min-w-0">
          {logo}

          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            title="Project name (auto-saved)"
            className="w-32 xl:w-40 h-8 px-2.5 rounded-xl bg-app border border-line text-xs font-semibold text-ink outline-none focus:border-accent truncate"
          />

          {/* Home / Studio Switcher + Start From Scratch */}
          <div className="flex items-center p-1 rounded-xl bg-app border border-line">
            <button
              onClick={() => setView('home')}
              className={`flex items-center gap-1.5 h-7 px-3 rounded-lg text-xs font-semibold transition-colors ${
                view === 'home' ? 'bg-raised text-ink' : 'text-mute hover:text-ink'
              }`}
            >
              <HomeIcon className="w-3.5 h-3.5" />
              Home
            </button>
            <button
              onClick={() => setView('studio')}
              className={`flex items-center gap-1.5 h-7 px-3 rounded-lg text-xs font-semibold transition-colors ${
                view === 'studio' ? 'bg-raised text-ink' : 'text-mute hover:text-ink'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Studio
            </button>
          </div>

          <button
            onClick={() => loadTemplate('scratch', false)}
            title="Create a new blank project (keeps your previous projects saved)"
            className="h-9 px-3 rounded-xl bg-raised hover:bg-[#2b2b31] text-xs font-semibold text-ink transition-colors shrink-0"
          >
            New Blank
          </button>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleUndo}
              disabled={past.length === 0}
              title="Undo (Ctrl+Z)"
              className={iconBtn}
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleRedo}
              disabled={future.length === 0}
              title="Redo (Ctrl+Y)"
              className={iconBtn}
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>

          {saveBadgeButton}
        </div>

        {/* Transport */}
        <div className="flex items-center gap-1.5">
          <button onClick={handleRewind} title="Return to start" className={iconBtn}>
            <SkipBack className="w-4 h-4" />
          </button>
          {playButton('w-11 h-11')}
          {recordButton}
          {countInButton}
          {monitorButton}
          {metronomeButton}
          {loopButton}
          <div className="ml-1 h-10 px-3.5 rounded-xl bg-app border border-line flex items-center gap-3">
            <span className="font-mono text-[15px] font-medium tabular-nums">
              {formatTimecode(playhead)}
            </span>
            <span className="w-px h-5 bg-line" />
            <label className="flex items-center gap-1.5 text-xs text-mute">
              <input
                type="number"
                min={60}
                max={200}
                value={bpm}
                onChange={(e) =>
                  setBpm(Math.max(60, Math.min(200, Number(e.target.value) || 120)))
                }
                className="w-10 bg-transparent font-mono text-[15px] font-medium text-ink outline-none tabular-nums"
              />
              BPM
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <VisualizerDock isPlaying={isPlaying} onMeterUpdate={setMeterLevels} />
          <button
            onClick={() => setSnapToGrid((s) => !s)}
            title="Snap to grid"
            className={`${iconBtn} ${snapToGrid ? '!bg-white/10' : ''}`}
          >
            <Magnet className="w-4 h-4" />
          </button>
          <button
            onClick={() => setPixelsPerSecond((p) => Math.max(35, p - 12))}
            title="Zoom out"
            className={iconBtn}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setPixelsPerSecond((p) => Math.min(200, p + 12))}
            title="Zoom in"
            className={iconBtn}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={handleExportWav}
            disabled={isExporting}
            className="h-9 px-4 rounded-xl bg-accent text-white text-[13px] font-semibold flex items-center gap-2 hover:brightness-110 disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            {isExporting ? 'Rendering…' : 'Export'}
          </button>
        </div>
      </header>

      {view === 'home' ? (
        <div className="flex-1 min-h-0">
          <Home {...homeProps} />
        </div>
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
