import React from 'react';
import { Waves } from 'lucide-react';
import { DelayDivision, FxReturns } from '../types/audio';
import { delaySeconds } from '../audio/fxReturns';
import { ParamSlider } from './ParamSlider';

const DIVISIONS: { id: DelayDivision; label: string }[] = [
  { id: '1/2', label: '1/2' },
  { id: '1/4', label: '1/4' },
  { id: '1/4d', label: '1/4·' },
  { id: '1/8', label: '1/8' },
  { id: '1/8d', label: '1/8·' },
  { id: '1/16', label: '1/16' },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Shared Reverb + Delay return buses. Each track feeds them with its own "send" amount
 * (Mixer track cards), so the whole song shares one space.
 */
export const FxReturnsPanel: React.FC<{
  returns: FxReturns;
  bpm: number;
  onChange: (patch: Partial<FxReturns>) => void;
}> = ({ returns: r, bpm, onChange }) => (
  <div className="rounded-2xl bg-panel border border-line px-4 py-3">
    <div className="flex items-center justify-between mb-1">
      <span className="text-[13px] font-semibold flex items-center gap-1.5">
        <Waves className="w-4 h-4 text-accent" />
        FX returns
      </span>
      <span className="text-[11px] text-mute">Shared by all tracks</span>
    </div>
    <p className="text-[11px] text-mute leading-relaxed">
      Turn up a track's Reverb/Delay send below to place it in this space.
    </p>

    <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">Reverb</div>
    <ParamSlider
      label="Size (decay)"
      value={r.reverbSize}
      min={0.4}
      max={6}
      step={0.1}
      defaultValue={2.2}
      format={(v) => `${v.toFixed(1)} s`}
      onCommit={(v) => onChange({ reverbSize: v })}
    />
    <ParamSlider
      label="Pre-delay"
      value={r.reverbPreDelayMs}
      min={0}
      max={150}
      step={1}
      defaultValue={20}
      format={(v) => `${Math.round(v)} ms`}
      onChange={(v) => onChange({ reverbPreDelayMs: v })}
    />
    <ParamSlider
      label="Brightness"
      value={r.reverbTone}
      min={0}
      max={100}
      step={1}
      defaultValue={60}
      format={(v) => `${Math.round(v)}%`}
      onChange={(v) => onChange({ reverbTone: v })}
    />
    <ParamSlider
      label="Return level"
      value={r.reverbLevel}
      min={0}
      max={1.5}
      step={0.01}
      defaultValue={1}
      format={pct}
      onChange={(v) => onChange({ reverbLevel: v })}
    />

    <div className="mt-3 flex items-center justify-between">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">Delay</span>
      <span className="text-[11px] font-mono text-mute">
        {Math.round(delaySeconds(r.delayDivision, bpm) * 1000)} ms @ {bpm} BPM
      </span>
    </div>
    <div className="grid grid-cols-6 gap-1 mt-2" role="radiogroup" aria-label="Delay note value">
      {DIVISIONS.map((d) => (
        <button
          key={d.id}
          role="radio"
          aria-checked={r.delayDivision === d.id}
          onClick={() => onChange({ delayDivision: d.id })}
          title={d.id.endsWith('d') ? `Dotted ${d.id.slice(0, -1)} note` : `${d.id} note`}
          className={`h-8 rounded-lg text-[11px] font-semibold font-mono transition-colors ${
            r.delayDivision === d.id ? 'bg-accent text-white' : 'bg-raised text-mute hover:text-ink'
          }`}
        >
          {d.label}
        </button>
      ))}
    </div>
    <ParamSlider
      label="Feedback"
      value={r.delayFeedback}
      min={0}
      max={0.85}
      step={0.01}
      defaultValue={0.32}
      format={pct}
      onChange={(v) => onChange({ delayFeedback: v })}
    />
    <ParamSlider
      label="Brightness"
      value={r.delayTone}
      min={0}
      max={100}
      step={1}
      defaultValue={55}
      format={(v) => `${Math.round(v)}%`}
      onChange={(v) => onChange({ delayTone: v })}
    />
    <ParamSlider
      label="Return level"
      value={r.delayLevel}
      min={0}
      max={1.5}
      step={0.01}
      defaultValue={1}
      format={pct}
      onChange={(v) => onChange({ delayLevel: v })}
    />
    <label className="flex items-center justify-between py-1.5 text-xs cursor-pointer">
      <span className="text-mute">Ping-pong (left/right repeats)</span>
      <input
        type="checkbox"
        checked={r.delayPingPong}
        onChange={(e) => onChange({ delayPingPong: e.target.checked })}
        className="accent-[#f12c4c] w-4 h-4"
      />
    </label>
  </div>
);
