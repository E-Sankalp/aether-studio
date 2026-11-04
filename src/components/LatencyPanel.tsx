import React, { useEffect, useState } from 'react';
import { Loader2, Timer } from 'lucide-react';
import { audioEngine, LatencySettings } from '../audio/audioEngine';
import { ParamSlider } from './ParamSlider';

/**
 * Recording latency compensation: keeps recorded vocals in time with the beat.
 * Settings are per device (stored in localStorage by the audio engine).
 */
export const LatencyPanel: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const [settings, setSettings] = useState<LatencySettings>(() => audioEngine.getLatencySettings());
  const [autoMs, setAutoMs] = useState(0);
  const [calibrating, setCalibrating] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setAutoMs(audioEngine.getAutoLatencyMs());
  }, []);

  const update = (next: LatencySettings) => {
    setSettings(next);
    audioEngine.setLatencySettings(next);
  };

  const calibrate = async () => {
    setCalibrating(true);
    setMessage(null);
    try {
      const ms = await audioEngine.calibrateLatency();
      update({ mode: 'manual', manualMs: ms });
      setMessage({ tone: 'ok', text: `Measured ${ms} ms. Recordings will be shifted by this amount.` });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Calibration failed. Please try again.',
      });
    } finally {
      setCalibrating(false);
      setAutoMs(audioEngine.getAutoLatencyMs());
    }
  };

  const effectiveMs = settings.mode === 'manual' ? settings.manualMs : autoMs;

  return (
    <div className="rounded-2xl bg-panel border border-line px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[13px] font-semibold flex items-center gap-1.5">
          <Timer className="w-4 h-4 text-accent" />
          Recording sync
        </span>
        <span className="font-mono text-xs text-mute">{effectiveMs} ms</span>
      </div>
      <p className="text-[11px] text-mute leading-relaxed">
        Shifts each recorded take earlier so your vocal lines up with the beat you heard.
      </p>

      <div className="grid grid-cols-2 gap-1 mt-2">
        {(['auto', 'manual'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => update({ ...settings, mode, manualMs: settings.manualMs || autoMs })}
            className={`h-8 rounded-lg text-[11px] font-semibold transition-colors ${
              settings.mode === mode ? 'bg-accent text-white' : 'bg-raised text-mute hover:text-ink'
            }`}
          >
            {mode === 'auto' ? `Auto (${autoMs} ms)` : 'Manual / calibrated'}
          </button>
        ))}
      </div>

      {settings.mode === 'manual' && (
        <div className="mt-1">
          <ParamSlider
            label="Offset"
            value={settings.manualMs}
            min={0}
            max={400}
            step={1}
            defaultValue={autoMs}
            format={(v) => `${Math.round(v)} ms`}
            onChange={(v) => update({ mode: 'manual', manualMs: v })}
          />
        </div>
      )}

      <button
        onClick={calibrate}
        disabled={calibrating || disabled}
        className="w-full mt-2 h-9 rounded-xl bg-raised border border-line hover:border-accent/50 text-xs font-semibold text-ink flex items-center justify-center gap-1.5 disabled:opacity-50"
      >
        {calibrating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {calibrating ? 'Listening for clicks…' : 'Calibrate with speakers'}
      </button>
      <p className="mt-1.5 text-[10px] text-mute leading-relaxed">
        Unplug headphones and turn speakers up. You'll hear 8 clicks (about 5 s).
      </p>

      {message && (
        <p
          className={`mt-2 text-[11px] leading-relaxed ${
            message.tone === 'ok' ? 'text-emerald-400' : 'text-amber-300'
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
};
