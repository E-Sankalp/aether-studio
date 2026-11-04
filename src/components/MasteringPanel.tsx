import React from 'react';
import { Gauge, Loader2 } from 'lucide-react';
import { LoudnessReport, MasterSettings } from '../types/audio';
import { MASTER_PRESETS, masterFromPreset } from '../audio/mastering';
import { ParamSlider } from './ParamSlider';

interface MasteringPanelProps {
  settings: MasterSettings;
  onChange: (settings: MasterSettings) => void;
  report: LoudnessReport | null;
  reportStale: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
}

const fmtLufs = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} LUFS` : 'silent');
const fmtDb = (v: number) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` : '–');

/** Master bus mastering: presets, tone/glue/width, loudness target and analysis. */
export const MasteringPanel: React.FC<MasteringPanelProps> = ({
  settings,
  onChange,
  report,
  reportStale,
  analyzing,
  onAnalyze,
}) => {
  const off = settings.preset === 'off';
  const tweak = (patch: Partial<MasterSettings>) =>
    onChange({ ...settings, ...patch, preset: 'custom' });
  const activeHint =
    MASTER_PRESETS.find((p) => p.id === settings.preset)?.hint ??
    `Custom · ${settings.targetLufs} LUFS`;

  return (
    <div className="rounded-2xl bg-panel border border-line px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[13px] font-semibold flex items-center gap-1.5">
          <Gauge className="w-4 h-4 text-accent" />
          Mastering
        </span>
        <span className="text-[11px] text-mute truncate ml-2">{activeHint}</span>
      </div>

      <div className="grid grid-cols-5 gap-1 mt-2">
        {MASTER_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onChange(masterFromPreset(p.id))}
            title={p.hint}
            className={`h-8 rounded-lg text-[11px] font-semibold transition-colors ${
              settings.preset === p.id
                ? 'bg-accent text-white'
                : 'bg-raised text-mute hover:text-ink'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {!off && (
        <div className="mt-2">
          <ParamSlider
            label="Loudness target"
            value={settings.targetLufs}
            min={-20}
            max={-7}
            step={0.5}
            defaultValue={-14}
            format={(v) => `${v.toFixed(1)} LUFS`}
            onChange={(v) => tweak({ targetLufs: v })}
          />
          <ParamSlider
            label="Glue compression"
            value={settings.glue}
            min={0}
            max={100}
            step={1}
            defaultValue={35}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => tweak({ glue: v })}
          />
          <ParamSlider
            label="Low-end warmth"
            value={settings.lowDb}
            min={-6}
            max={6}
            step={0.5}
            defaultValue={0}
            format={fmtDb}
            onChange={(v) => tweak({ lowDb: v })}
          />
          <ParamSlider
            label="Air (10 kHz)"
            value={settings.airDb}
            min={-3}
            max={6}
            step={0.5}
            defaultValue={0}
            format={fmtDb}
            onChange={(v) => tweak({ airDb: v })}
          />
          <ParamSlider
            label="Stereo width"
            value={settings.width}
            min={0}
            max={1.5}
            step={0.05}
            defaultValue={1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => tweak({ width: v })}
          />
          <ParamSlider
            label="True-peak ceiling"
            value={settings.ceilingDb}
            min={-3}
            max={-0.1}
            step={0.1}
            defaultValue={-1}
            format={(v) => `${v.toFixed(1)} dBTP`}
            onChange={(v) => tweak({ ceilingDb: v })}
          />
        </div>
      )}

      <button
        onClick={onAnalyze}
        disabled={analyzing}
        className="w-full mt-2 h-9 rounded-xl bg-raised border border-line hover:border-accent/50 text-xs font-semibold text-ink flex items-center justify-center gap-1.5 disabled:opacity-50"
      >
        {analyzing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {analyzing ? 'Analyzing mix…' : 'Analyze loudness & match playback'}
      </button>

      {report && (
        <div
          className={`mt-2 rounded-xl bg-app/70 border border-line px-3 py-2 text-[11px] font-mono grid grid-cols-2 gap-x-3 gap-y-1 ${
            reportStale ? 'opacity-50' : ''
          }`}
        >
          <span className="text-mute">Raw mix</span>
          <span className="text-right">{fmtLufs(report.inputLufs)}</span>
          <span className="text-mute">Mastered</span>
          <span className="text-right text-emerald-400">{fmtLufs(report.outputLufs)}</span>
          <span className="text-mute">True peak</span>
          <span className="text-right">
            {Number.isFinite(report.truePeakDb) ? `${report.truePeakDb.toFixed(1)} dBTP` : '–'}
          </span>
          <span className="text-mute">Gain applied</span>
          <span className="text-right">{fmtDb(report.gainDb)}</span>
          {reportStale && (
            <span className="col-span-2 font-sans text-amber-300/90 pt-1">
              Mix changed since analysis. Re-analyze to update playback loudness.
            </span>
          )}
        </div>
      )}
      {!report && !off && (
        <p className="mt-2 text-[11px] text-mute leading-relaxed">
          Export is always mastered to the target. Analyze to hear the mastered loudness during
          playback.
        </p>
      )}
    </div>
  );
};
