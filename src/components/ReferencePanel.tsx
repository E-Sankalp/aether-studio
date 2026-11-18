/**
 * Reference track A/B: load a released song, hear it in sync with the timeline instead of the
 * mix, at the same loudness (so "louder" never wins the comparison). The reference never goes
 * into exports and is not saved with the project.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Headphones, Loader2, X } from 'lucide-react';
import type { LoudnessReport } from '../types/audio';
import { audioEngine } from '../audio/audioEngine';
import { createLiveStore, useLiveStore } from '../utils/liveStore';

export interface ReferenceState {
  info: { name: string; duration: number; lufs: number } | null;
  /** true = hearing the reference (B) */
  active: boolean;
  /** level-match the reference to the mix */
  match: boolean;
  /** gain applied to the reference (dB) */
  gainDb: number;
  /** playback loudness of the mix used for matching (LUFS) */
  mixLufs: number | null;
}

/** Lives outside React so the A/B state survives switching panels. */
export const referenceStore = createLiveStore<ReferenceState>({
  info: null,
  active: false,
  match: true,
  gainDb: 0,
  mixLufs: null,
});

const patchRef = (p: Partial<ReferenceState>) => referenceStore.set({ ...referenceStore.get(), ...p });

export const setReferenceActive = (active: boolean) => {
  if (!referenceStore.get().info) return;
  audioEngine.setReferenceActive(active);
  patchRef({ active });
};

const applyGain = (s: ReferenceState) => {
  const gainDb =
    s.match && s.info && s.mixLufs !== null && Number.isFinite(s.info.lufs) && Number.isFinite(s.mixLufs)
      ? s.mixLufs - s.info.lufs
      : 0;
  audioEngine.setReferenceGain(gainDb);
  if (gainDb !== s.gainDb) patchRef({ gainDb });
};

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

interface Props {
  report: LoudnessReport | null;
  reportStale: boolean;
  masterOff: boolean;
  /** Measures the mix (renders it); resolves to the fresh report, or null on failure. */
  onMeasureMix: () => Promise<LoudnessReport | null>;
}

export const ReferencePanel: React.FC<Props> = ({ report, reportStale, masterOff, onMeasureMix }) => {
  const state = useLiveStore(referenceStore);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // What the mix plays at: the mastered loudness when mastering is on, else the raw mix
  const mixLufs = report && !reportStale ? (masterOff ? report.inputLufs : report.outputLufs) : null;
  useEffect(() => {
    if (mixLufs !== null && mixLufs !== referenceStore.get().mixLufs) patchRef({ mixLufs });
  }, [mixLufs]);
  useEffect(() => {
    applyGain(state);
  }, [state.match, state.info, state.mixLufs]); // eslint-disable-line react-hooks/exhaustive-deps

  const measure = async () => {
    setBusy('Measuring your mix…');
    try {
      const r = await onMeasureMix();
      if (r) patchRef({ mixLufs: masterOff ? r.inputLufs : r.outputLufs });
    } finally {
      setBusy(null);
    }
  };

  const load = async (file: File) => {
    setError(null);
    setBusy('Loading reference…');
    try {
      const info = await audioEngine.loadReference(await file.arrayBuffer());
      patchRef({ info: { name: file.name.replace(/\.[^.]+$/, ''), duration: info.duration, lufs: info.lufs } });
      if (mixLufs === null) await measure();
    } catch {
      setError('This file could not be read. Try a WAV, MP3, M4A or OGG file.');
    } finally {
      setBusy(null);
    }
  };

  const remove = () => {
    audioEngine.clearReference();
    referenceStore.set({ ...referenceStore.get(), info: null, active: false, gainDb: 0 });
  };

  const { info, active, match, gainDb } = state;
  return (
    <div className="rounded-2xl bg-panel border border-line px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[13px] font-semibold flex items-center gap-1.5">
          <Headphones className="w-4 h-4 text-accent" />
          Reference A/B
        </span>
        {info && (
          <button
            type="button"
            onClick={remove}
            aria-label="Remove reference"
            className="w-7 h-7 grid place-items-center rounded-md text-mute hover:text-white hover:bg-raised"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"
        className="hidden"
        aria-label="Reference audio file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void load(f);
        }}
      />

      {!info ? (
        <>
          <p className="text-[12px] text-mute leading-relaxed mb-3">
            Load a released song you like and flip between it and your mix while playing. It follows
            your timeline and is played at the same loudness, so you compare tone and balance - not
            volume. It is never exported or saved.
          </p>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => fileRef.current?.click()}
            className="w-full h-10 rounded-xl bg-raised hover:bg-white/10 text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {busy ?? 'Load a reference song…'}
          </button>
        </>
      ) : (
        <>
          <div className="text-[12px] text-mute mb-3 truncate" title={info.name}>
            <span className="text-white font-medium">{info.name}</span> · {fmtTime(info.duration)} ·{' '}
            {Number.isFinite(info.lufs) ? `${info.lufs.toFixed(1)} LUFS` : 'silent'}
          </div>
          <div role="radiogroup" aria-label="Monitor" className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-app mb-3">
            {[
              { on: false, label: 'A · Your mix' },
              { on: true, label: 'B · Reference' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={active === o.on}
                onClick={() => setReferenceActive(o.on)}
                className={`h-9 rounded-lg text-[12px] font-semibold transition-colors ${
                  active === o.on ? (o.on ? 'bg-amber-400 text-black' : 'bg-accent text-white') : 'text-mute hover:text-white'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <label className="flex items-center justify-between gap-3 text-[12px] cursor-pointer">
            <span>Match loudness</span>
            <input
              type="checkbox"
              checked={match}
              onChange={(e) => patchRef({ match: e.target.checked })}
              className="accent-[#f12c4c] w-4 h-4"
            />
          </label>
          <p className="text-[11px] text-mute mt-1.5 leading-relaxed" aria-live="polite">
            {busy
              ? busy
              : !match
                ? 'Playing the reference at its own level.'
                : state.mixLufs === null || reportStale
                  ? 'Your mix changed since it was measured.'
                  : `Reference ${gainDb <= 0 ? 'turned down' : 'turned up'} ${Math.abs(gainDb).toFixed(1)} dB to match your mix (${state.mixLufs.toFixed(1)} LUFS).`}
          </p>
          {match && (state.mixLufs === null || reportStale) && !busy && (
            <button
              type="button"
              onClick={() => void measure()}
              className="mt-2 h-8 px-3 rounded-lg bg-raised hover:bg-white/10 text-[12px] font-semibold"
            >
              Measure mix again
            </button>
          )}
        </>
      )}
      {error && <p className="text-[12px] text-amber-400 mt-2">{error}</p>}
    </div>
  );
};

/** Floating reminder while the reference is playing instead of the mix. */
export const ReferencePill: React.FC = () => {
  const { info, active } = useLiveStore(referenceStore);
  if (!info || !active) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 pl-3 pr-1 py-1 rounded-full bg-amber-400 text-black shadow-lg shadow-black/40 text-[12px] font-semibold">
      <Headphones className="w-4 h-4" />
      Hearing reference
      <button
        type="button"
        onClick={() => setReferenceActive(false)}
        className="h-7 px-3 rounded-full bg-black/85 text-white text-[12px] font-semibold"
      >
        Back to mix
      </button>
    </div>
  );
};
