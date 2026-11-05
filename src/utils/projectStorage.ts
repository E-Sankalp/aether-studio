import { AudioClip, AudioTrack, FxReturns, LoopRegion, MasterSettings } from '../types/audio';
import { DEFAULT_EFFECTS } from '../audio/synthStems';

const STORAGE_KEY = 'aether_studio_project_v1';
const LIBRARY_KEY = 'aether_projects_library_v1';
const ACTIVE_PROJECT_KEY = 'aether_active_project_id_v2';
const IDB_NAME = 'aether_audio_db';
const IDB_VERSION = 2;
const IDB_STORE = 'buffers';
const IDB_PROJECT_STORE = 'projects';
const STORAGE_WARN_RATIO = 0.8;

type StorageErrorListener = (message: string) => void;
const errorListeners = new Set<StorageErrorListener>();

/** Subscribe to storage problems (quota full, write failures). Returns an unsubscribe function. */
export function subscribeStorageErrors(listener: StorageErrorListener): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

function reportStorageError(message: string): void {
  errorListeners.forEach((listener) => listener(message));
}

export interface PersistedProjectState {
  id?: string;
  name?: string;
  tracks: AudioTrack[];
  clips: AudioClip[];
  bpm: number;
  loop: LoopRegion;
  masterVolume: number;
  /** Mastering settings (missing in projects saved before mastering existed) */
  master?: MasterSettings;
  /** Shared reverb/delay return settings (missing in older projects) */
  returns?: FxReturns;
  selectedTrackId: string;
  selectedClipId: string;
  updatedAt: number;
}

interface SerializedAudioBuffer {
  id: string;
  sampleRate: number;
  channels: Float32Array[];
}

interface BundledBufferRecord {
  id: string;
  sampleRate: number;
  length: number;
  channelsBase64: string[];
}

interface AetherProjectFileBundle {
  format: 'aether-project-v1';
  project: PersistedProjectState;
  buffers: BundledBufferRecord[];
}

/**
 * Requests permanent non-evictable storage from the browser so the OS/browser
 * never auto-clears Aether projects or audio recordings until the user deletes them.
 */
export async function requestPersistentStorage(): Promise<{
  persisted: boolean;
  usedMb: number;
}> {
  let persisted = false;
  let usedMb = 0;
  try {
    if (navigator.storage && navigator.storage.persist) {
      persisted = await navigator.storage.persist();
    }
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.usage) {
        usedMb = Number((est.usage / (1024 * 1024)).toFixed(2));
      }
      if (est.usage && est.quota && !quotaWarned && est.usage / est.quota > STORAGE_WARN_RATIO) {
        quotaWarned = true;
        reportStorageError(
          'Device storage is almost full. Download .aether backups and delete old projects to free space.'
        );
      }
    }
  } catch {
    // Ignore if unavailable
  }
  return { persisted, usedMb };
}

let quotaWarned = false;

function openBufferDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_PROJECT_STORE)) {
        db.createObjectStore(IDB_PROJECT_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBufferToStorage(id: string, buffer: AudioBuffer): Promise<void> {
  try {
    const db = await openBufferDb();
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channels.push(new Float32Array(buffer.getChannelData(ch)));
    }
    const record: SerializedAudioBuffer = {
      id,
      sampleRate: buffer.sampleRate,
      channels,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    reportStorageError(
      'Could not save recorded audio to this device. Storage may be full - download a .aether backup.'
    );
  }
}

export async function deleteBufferFromStorage(id: string): Promise<void> {
  try {
    const db = await openBufferDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

export async function loadAllBuffersFromStorage(
  ctx: BaseAudioContext
): Promise<Map<string, AudioBuffer>> {
  const map = new Map<string, AudioBuffer>();
  try {
    const db = await openBufferDb();
    const records = await new Promise<SerializedAudioBuffer[]>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve((req.result as SerializedAudioBuffer[]) || []);
      req.onerror = () => reject(req.error);
    });

    for (const rec of records) {
      if (!rec.channels || rec.channels.length === 0) continue;
      const length = rec.channels[0].length;
      const audioBuf = ctx.createBuffer(rec.channels.length, length, rec.sampleRate);
      for (let ch = 0; ch < rec.channels.length; ch++) {
        audioBuf.copyToChannel(new Float32Array(rec.channels[ch]), ch);
      }
      map.set(rec.id, audioBuf);
    }
  } catch {
    // Ignore if IndexedDB is unavailable
  }
  return map;
}

export async function clearStoredBuffers(): Promise<void> {
  try {
    const db = await openBufferDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

function normalizeProject(p: PersistedProjectState): PersistedProjectState {
  return {
    ...p,
    id: p.id || 'prj_default',
    name: p.name || 'My Studio Session',
    tracks: (p.tracks || []).map((t) => ({
      ...t,
      effects: {
        ...DEFAULT_EFFECTS,
        ...t.effects,
      },
    })),
  };
}

/* ------------------- Project library (IndexedDB + in-memory cache) ------------------- */
/*
 * Project layouts live in IndexedDB (no 5 MB localStorage ceiling) next to the audio buffers.
 * An in-memory cache keeps the public API synchronous; every change is written through to
 * IndexedDB. Call `initProjectLibrary()` once on startup before reading the library.
 */

const projectCache = new Map<string, PersistedProjectState>();
let libraryReady = false;

function isValidProject(p: unknown): p is PersistedProjectState {
  const proj = p as PersistedProjectState | null;
  return Boolean(proj && Array.isArray(proj.tracks) && proj.tracks.length > 0);
}

async function putProjectRecord(project: PersistedProjectState): Promise<boolean> {
  try {
    const db = await openBufferDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_PROJECT_STORE, 'readwrite');
      tx.objectStore(IDB_PROJECT_STORE).put(project);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch {
    reportStorageError(
      'Could not save your project to this device. Storage may be full - download a .aether backup.'
    );
    return false;
  }
}

async function deleteProjectRecord(projectId: string): Promise<void> {
  try {
    const db = await openBufferDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_PROJECT_STORE, 'readwrite');
      tx.objectStore(IDB_PROJECT_STORE).delete(projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

async function clearProjectRecords(): Promise<void> {
  try {
    const db = await openBufferDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_PROJECT_STORE, 'readwrite');
      tx.objectStore(IDB_PROJECT_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

/** Reads projects saved by earlier versions (localStorage) so nothing is lost on upgrade. */
function readLegacyProjects(): { projects: PersistedProjectState[]; activeId?: string } {
  const projects: PersistedProjectState[] = [];
  let activeId: string | undefined;
  try {
    const rawLib = localStorage.getItem(LIBRARY_KEY);
    if (rawLib) {
      const parsed = JSON.parse(rawLib);
      if (Array.isArray(parsed)) projects.push(...parsed.filter(isValidProject));
    }
    const rawSingle = localStorage.getItem(STORAGE_KEY);
    if (rawSingle) {
      const single = JSON.parse(rawSingle);
      if (isValidProject(single)) {
        activeId = single.id;
        if (!projects.some((p) => p.id === single.id)) projects.push(single);
      }
    }
  } catch {
    // Ignore corrupt legacy data
  }
  return { projects, activeId };
}

/** Loads the project library from IndexedDB (and migrates old localStorage data once). */
export async function initProjectLibrary(): Promise<void> {
  if (libraryReady) return;
  try {
    const db = await openBufferDb();
    const records = await new Promise<PersistedProjectState[]>((resolve, reject) => {
      const tx = db.transaction(IDB_PROJECT_STORE, 'readonly');
      const req = tx.objectStore(IDB_PROJECT_STORE).getAll();
      req.onsuccess = () => resolve((req.result as PersistedProjectState[]) || []);
      req.onerror = () => reject(req.error);
    });
    records.filter(isValidProject).forEach((p) => {
      const normalized = normalizeProject(p);
      projectCache.set(normalized.id as string, normalized);
    });
  } catch {
    reportStorageError('Could not open on-device storage. Projects will not be saved.');
  }

  // One-time migration from the old localStorage library
  const legacy = readLegacyProjects();
  if (legacy.projects.length > 0) {
    let migrated = true;
    for (const p of legacy.projects) {
      const normalized = normalizeProject(p);
      if (projectCache.has(normalized.id as string)) continue;
      projectCache.set(normalized.id as string, normalized);
      migrated = (await putProjectRecord(normalized)) && migrated;
    }
    if (legacy.activeId) {
      try {
        localStorage.setItem(ACTIVE_PROJECT_KEY, legacy.activeId);
      } catch {
        // Ignore
      }
    }
    if (migrated) {
      try {
        localStorage.removeItem(LIBRARY_KEY);
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore
      }
    }
  }
  libraryReady = true;
}

/**
 * Loads all saved projects from the permanent on-device library (newest first).
 */
export function loadAllProjectsFromLibrary(): PersistedProjectState[] {
  return Array.from(projectCache.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Saves the active project AND upserts it into the permanent on-device projects library
 * so starting a new project never overwrites previous projects.
 */
export function saveProjectToLocalStorage(state: PersistedProjectState): void {
  const normalized = normalizeProject(state);
  projectCache.set(normalized.id as string, normalized);
  try {
    localStorage.setItem(ACTIVE_PROJECT_KEY, normalized.id as string);
  } catch {
    // Tiny key; ignore failures
  }
  void putProjectRecord(normalized);
}

/** Returns the project that was open last, or null when none is saved. */
export function loadProjectFromLocalStorage(): PersistedProjectState | null {
  try {
    const activeId = localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (activeId && projectCache.has(activeId)) return projectCache.get(activeId) || null;
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Deletes a single project from the on-device library only when requested by the user.
 */
export function deleteProjectFromLibrary(projectId: string): PersistedProjectState[] {
  projectCache.delete(projectId);
  void deleteProjectRecord(projectId);
  const remaining = loadAllProjectsFromLibrary();
  try {
    if (localStorage.getItem(ACTIVE_PROJECT_KEY) === projectId) {
      if (remaining.length > 0) {
        localStorage.setItem(ACTIVE_PROJECT_KEY, remaining[0].id as string);
      } else {
        localStorage.removeItem(ACTIVE_PROJECT_KEY);
      }
    }
  } catch {
    // Ignore
  }
  return remaining;
}

export function clearProjectLocalStorage(): void {
  projectCache.clear();
  void clearProjectRecords();
  try {
    localStorage.removeItem(ACTIVE_PROJECT_KEY);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LIBRARY_KEY);
  } catch {
    // Ignore
  }
}

/* ---------------- .aether Single-File Project Export / Import ---------------- */

function float32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function int16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000;
  }
  return float32;
}

/**
 * Exports a project and all of its custom audio buffers into a single `.aether` file
 * that the user can keep forever on their computer or phone.
 */
export function exportProjectBundleFile(
  project: PersistedProjectState,
  getBuffer: (bufferId: string) => AudioBuffer | undefined
): void {
  const builtinIds = new Set(['stem_drums', 'stem_bass', 'stem_chords', 'stem_lead']);
  const neededIds = new Set<string>();
  for (const clip of project.clips) {
    if (clip.bufferId && !builtinIds.has(clip.bufferId)) {
      neededIds.add(clip.bufferId);
    }
    for (const take of clip.takes ?? []) {
      if (!builtinIds.has(take.bufferId)) neededIds.add(take.bufferId);
    }
    if (clip.sourceBufferId && !builtinIds.has(clip.sourceBufferId)) {
      neededIds.add(clip.sourceBufferId);
    }
  }

  const buffers: BundledBufferRecord[] = [];
  neededIds.forEach((id) => {
    const buf = getBuffer(id);
    if (!buf) return;
    const channelsBase64: string[] = [];
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      channelsBase64.push(float32ToInt16Base64(buf.getChannelData(ch)));
    }
    buffers.push({
      id,
      sampleRate: buf.sampleRate,
      length: buf.length,
      channelsBase64,
    });
  });

  const bundle: AetherProjectFileBundle = {
    format: 'aether-project-v1',
    project: normalizeProject(project),
    buffers,
  };

  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName = (project.name || 'Aether_Project').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.aether`;
  // Attach to the DOM and revoke later so Firefox/Safari complete the download.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Removes stored audio buffers that no saved project references any more
 * (e.g. after a project is deleted) so on-device storage does not leak.
 */
export async function pruneUnusedBuffers(referencedIds: Set<string>): Promise<void> {
  try {
    const db = await openBufferDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result) {
          if (typeof key === 'string' && !referencedIds.has(key)) store.delete(key);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

/** Collects every custom buffer id referenced by the given projects' clips. */
export function collectReferencedBufferIds(
  projects: Pick<PersistedProjectState, 'clips'>[],
  extraClips: AudioClip[] = []
): Set<string> {
  const ids = new Set<string>();
  const add = (clips: AudioClip[]) => {
    for (const c of clips) {
      if (c.bufferId) ids.add(c.bufferId);
      if (c.sourceBufferId) ids.add(c.sourceBufferId);
      for (const take of c.takes ?? []) ids.add(take.bufferId);
    }
  };
  projects.forEach((p) => add(p.clips || []));
  add(extraClips);
  return ids;
}

/**
 * Imports a `.aether` project file, registers its audio buffers into memory and on-device storage,
 * and saves the project into the permanent library.
 */
export async function importProjectBundleFile(
  file: File,
  ctx: BaseAudioContext,
  registerBuffer: (id: string, buf: AudioBuffer, persist?: boolean) => void
): Promise<PersistedProjectState> {
  const text = await file.text();
  const parsed = JSON.parse(text) as AetherProjectFileBundle;
  if (
    !parsed ||
    parsed.format !== 'aether-project-v1' ||
    !parsed.project ||
    !Array.isArray(parsed.project.tracks) ||
    parsed.project.tracks.length === 0
  ) {
    throw new Error('Invalid .aether project file');
  }

  for (const rec of parsed.buffers || []) {
    if (!rec.channelsBase64 || rec.channelsBase64.length === 0) continue;
    const decodedChannels = rec.channelsBase64.map(int16Base64ToFloat32);
    const length = decodedChannels[0].length;
    const audioBuf = ctx.createBuffer(decodedChannels.length, length, rec.sampleRate);
    for (let ch = 0; ch < decodedChannels.length; ch++) {
      audioBuf.copyToChannel(
        new Float32Array(decodedChannels[ch].buffer as ArrayBuffer),
        ch
      );
    }
    registerBuffer(rec.id, audioBuf, true);
  }

  // Never overwrite an existing project that shares this id (e.g. restoring an older backup).
  const existingIds = new Set(loadAllProjectsFromLibrary().map((p) => p.id));
  const collides = Boolean(parsed.project.id && existingIds.has(parsed.project.id));
  const restored: PersistedProjectState = normalizeProject({
    ...parsed.project,
    clips: Array.isArray(parsed.project.clips) ? parsed.project.clips : [],
    id: collides ? `prj_${Date.now()}` : parsed.project.id,
    name: collides
      ? `${parsed.project.name || 'My Studio Session'} (imported)`
      : parsed.project.name,
    updatedAt: Date.now(),
  });
  saveProjectToLocalStorage(restored);
  return restored;
}
