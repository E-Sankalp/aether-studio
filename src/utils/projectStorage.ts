import { AudioClip, AudioTrack, LoopRegion } from '../types/audio';
import { DEFAULT_EFFECTS } from '../audio/synthStems';

const STORAGE_KEY = 'aether_studio_project_v1';
const LIBRARY_KEY = 'aether_projects_library_v1';
const IDB_NAME = 'aether_audio_db';
const IDB_STORE = 'buffers';

export interface PersistedProjectState {
  id?: string;
  name?: string;
  tracks: AudioTrack[];
  clips: AudioClip[];
  bpm: number;
  loop: LoopRegion;
  masterVolume: number;
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
    }
  } catch {
    // Ignore if unavailable
  }
  return { persisted, usedMb };
}

function openBufferDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
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
    // Ignore storage quota errors gracefully
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

/**
 * Loads all saved projects from the permanent on-device library.
 */
export function loadAllProjectsFromLibrary(): PersistedProjectState[] {
  try {
    const rawLib = localStorage.getItem(LIBRARY_KEY);
    let list: PersistedProjectState[] = [];
    if (rawLib) {
      const parsed = JSON.parse(rawLib);
      if (Array.isArray(parsed)) {
        list = parsed
          .filter((p) => p && Array.isArray(p.tracks) && p.tracks.length > 0)
          .map(normalizeProject);
      }
    }
    // Migrate single active project if library was empty
    if (list.length === 0) {
      const single = loadProjectFromLocalStorage();
      if (single) {
        list = [single];
        localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
      }
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * Saves the active project AND upserts it into the permanent on-device projects library
 * so starting a new project never overwrites previous projects.
 */
export function saveProjectToLocalStorage(state: PersistedProjectState): void {
  try {
    const normalized = normalizeProject(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));

    const existing = loadAllProjectsFromLibrary();
    const idx = existing.findIndex((p) => p.id === normalized.id);
    if (idx >= 0) {
      existing[idx] = normalized;
    } else {
      existing.unshift(normalized);
    }
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(existing));
  } catch {
    // Ignore localStorage quota errors
  }
}

export function loadProjectFromLocalStorage(): PersistedProjectState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedProjectState;
    if (!parsed || !Array.isArray(parsed.tracks) || parsed.tracks.length === 0) {
      return null;
    }
    return normalizeProject(parsed);
  } catch {
    return null;
  }
}

/**
 * Deletes a single project from the on-device library only when requested by the user.
 */
export function deleteProjectFromLibrary(projectId: string): PersistedProjectState[] {
  try {
    const remaining = loadAllProjectsFromLibrary().filter((p) => p.id !== projectId);
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(remaining));

    const currentActive = loadProjectFromLocalStorage();
    if (currentActive && currentActive.id === projectId) {
      if (remaining.length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining[0]));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    return remaining;
  } catch {
    return [];
  }
}

export function clearProjectLocalStorage(): void {
  try {
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
  a.click();
  URL.revokeObjectURL(url);
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
  if (!parsed || parsed.format !== 'aether-project-v1' || !parsed.project) {
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

  const restored: PersistedProjectState = normalizeProject({
    ...parsed.project,
    updatedAt: Date.now(),
  });
  saveProjectToLocalStorage(restored);
  return restored;
}
