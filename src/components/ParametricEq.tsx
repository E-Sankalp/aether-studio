/**
 * Parametric EQ editor: frequency-response graph with draggable band handles, a live spectrum
 * analyzer while playing, and precise sliders for the selected band.
 *
 * Touch: the graph itself scrolls the page like any other area; only the handles (28 px targets)
 * grab the finger, and nothing changes until the finger has moved a few pixels - a tap just
 * selects the band. Mouse: drag a handle (Shift = fine), double-click it to reset its gain.
 * Keyboard: focus a handle, arrows move frequency/gain (Shift = fine), Enter toggles the band.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { EqBand } from '../types/audio';
import {
  bandResponseDb,
  clampFreq,
  clampGain,
  clampQ,
  EQ_BAND_COLORS,
  EQ_BAND_NAMES,
  EQ_BAND_SHORT,
  EQ_MAX_FREQ,
  EQ_MAX_GAIN,
  EQ_MIN_FREQ,
  eqResponseDb,
  formatFreq,
  hasGain,
  hasQ,
  parseFreq,
} from '../audio/eq';
import { audioEngine } from '../audio/audioEngine';
import { ParamSlider } from './ParamSlider';

const DECADES = Math.log10(EQ_MAX_FREQ / EQ_MIN_FREQ);
const DRAG_START_PX = 4;
const PAD_Y = 10;

const freqToX = (f: number, w: number) => (Math.log10(f / EQ_MIN_FREQ) / DECADES) * w;
const xToFreq = (x: number, w: number) => EQ_MIN_FREQ * Math.pow(10, (x / w) * DECADES);
const gainToY = (g: number, h: number) => h / 2 - (g / EQ_MAX_GAIN) * (h / 2 - PAD_Y);

interface Props {
  trackId: string;
  bands: EqBand[];
  onChange: (bands: EqBand[]) => void;
}

export const ParametricEq: React.FC<Props> = ({ trackId, bands, onChange }) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState(3);
  const [dragging, setDragging] = useState<number | null>(null);
  const bandsRef = useRef(bands);
  bandsRef.current = bands;

  const update = useCallback(
    (i: number, patch: Partial<EqBand>) => {
      const next = bandsRef.current.map((b, j) => (j === i ? { ...b, ...patch } : b));
      bandsRef.current = next;
      onChange(next);
    },
    [onChange]
  );

  // Track the graph size (handles are positioned in CSS pixels)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Draw: grid + curve on every change; the analyzer animates only while audio is playing
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const { w, h } = size;
    let sr = 48000;
    try {
      sr = audioEngine.getContext().sampleRate;
    } catch {}

    // Curve points are computed once per change, not per frame
    const total: number[] = [];
    const sel: number[] = [];
    for (let x = 0; x <= w; x += 2) {
      const f = xToFreq(x, w);
      total.push(eqResponseDb(bands, f, sr));
      sel.push(bandResponseDb(bands[selected], f, sr));
    }

    const draw = (spectrum: { data: Float32Array; sampleRate: number } | null) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // grid
      ctx.lineWidth = 1;
      ctx.font = '9px JetBrains Mono, monospace';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = Math.round(freqToX(f, w)) + 0.5;
        const major = f === 100 || f === 1000 || f === 10000;
        ctx.strokeStyle = major ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.045)';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        if (major) {
          ctx.fillStyle = '#6b6b73';
          ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 4);
        }
      }
      for (const g of [-12, -6, 0, 6, 12]) {
        const y = Math.round(gainToY(g, h)) + 0.5;
        ctx.strokeStyle = g === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.045)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        if (g !== 0) {
          ctx.fillStyle = '#55555c';
          ctx.fillText(`${g > 0 ? '+' : ''}${g}`, 3, y - 2);
        }
      }

      // analyzer (post-effects spectrum of this track)
      if (spectrum) {
        const { data, sampleRate } = spectrum;
        const binHz = sampleRate / 2 / data.length;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 2) {
          const f0 = xToFreq(x, w);
          const f1 = xToFreq(x + 2, w);
          // max over the bins under this pixel column (keeps the high end from looking jagged)
          let db = -100;
          const b0 = Math.max(1, Math.floor(f0 / binHz));
          const b1 = Math.max(b0, Math.min(data.length - 1, Math.floor(f1 / binHz)));
          for (let b = b0; b <= b1; b++) db = Math.max(db, data[b]);
          // tilt +3 dB/octave so a mix reads roughly flat, like most analyzers
          db += 3 * Math.log2(f0 / 1000);
          const y = h - Math.max(0, Math.min(1, (db + 90) / 80)) * h;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = 'rgba(148,163,184,0.22)';
        ctx.fill();
      }

      // selected band's own contribution
      ctx.beginPath();
      sel.forEach((db, i) => {
        const y = gainToY(Math.max(-EQ_MAX_GAIN - 2, Math.min(EQ_MAX_GAIN + 2, db)), h);
        if (i === 0) ctx.moveTo(i * 2, y);
        else ctx.lineTo(i * 2, y);
      });
      ctx.strokeStyle = `${EQ_BAND_COLORS[selected]}88`;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      // total curve
      ctx.beginPath();
      total.forEach((db, i) => {
        const y = gainToY(Math.max(-EQ_MAX_GAIN - 2, Math.min(EQ_MAX_GAIN + 2, db)), h);
        if (i === 0) ctx.moveTo(i * 2, y);
        else ctx.lineTo(i * 2, y);
      });
      ctx.strokeStyle = '#f12c4c';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineTo(w, gainToY(0, h));
      ctx.lineTo(0, gainToY(0, h));
      ctx.closePath();
      ctx.fillStyle = 'rgba(241,44,76,0.10)';
      ctx.fill();
    };

    draw(null);
    let raf = 0;
    let wasLive = false;
    const loop = () => {
      const spectrum = audioEngine.getTrackSpectrum(trackId);
      if (spectrum || wasLive) draw(spectrum);
      wasLive = !!spectrum;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [bands, selected, size, trackId]);

  useEffect(() => () => audioEngine.releaseSpectrum(), []);

  /* ------------------------------ handle gestures ----------------------------- */

  const startDrag = (i: number, e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    setSelected(i);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, band: bandsRef.current[i] };
    let moved = false;
    let lastX = e.clientX;
    let lastY = e.clientY;
    let freq = start.band.freq;
    let gain = start.band.gain;
    const move = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_START_PX) return;
        moved = true;
        lastX = ev.clientX;
        lastY = ev.clientY;
        setDragging(i);
        if (!start.band.on) update(i, { on: true });
        return;
      }
      // Relative movement, so Shift (fine) can be pressed mid-drag without a jump
      const fine = ev.shiftKey ? 0.2 : 1;
      const dx = (ev.clientX - lastX) * fine;
      const dy = (ev.clientY - lastY) * fine;
      lastX = ev.clientX;
      lastY = ev.clientY;
      freq = clampFreq(freq * Math.pow(10, (dx / size.w) * DECADES));
      const patch: Partial<EqBand> = { freq: Math.round(freq) };
      if (hasGain(start.band.type)) {
        gain = clampGain(gain - (dy / (size.h / 2 - PAD_Y)) * EQ_MAX_GAIN);
        patch.gain = Math.round(gain * 10) / 10;
      }
      update(i, patch);
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      setDragging(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  const onHandleKey = (i: number, e: React.KeyboardEvent<HTMLButtonElement>) => {
    const b = bandsRef.current[i];
    const fine = e.shiftKey;
    let patch: Partial<EqBand> | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const semis = (e.key === 'ArrowRight' ? 1 : -1) * (fine ? 0.25 : 1);
      patch = { freq: Math.round(clampFreq(b.freq * Math.pow(2, semis / 12))) };
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && hasGain(b.type)) {
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (fine ? 0.1 : 0.5);
      patch = { gain: Math.round(clampGain(b.gain + d) * 10) / 10 };
    } else if (e.key === 'Enter') {
      patch = { on: !b.on };
    }
    if (!patch) return;
    e.preventDefault();
    e.stopPropagation(); // arrows/Enter must not reach the timeline shortcuts
    update(i, patch);
  };

  const band = bands[selected];
  const handleLabel = (b: EqBand, i: number) =>
    `${EQ_BAND_NAMES[i]}: ${formatFreq(b.freq)}${hasGain(b.type) ? `, ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB` : ''}${b.on ? '' : ' (off)'}`;

  return (
    <div className="flex flex-col gap-2.5">
      <div
        ref={wrapRef}
        className="precision-slider relative h-44 rounded-xl bg-app border border-line overflow-hidden select-none"
        aria-label="EQ curve"
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
        {size.w > 0 &&
          bands.map((b, i) => {
            const x = freqToX(b.freq, size.w);
            const y = gainToY(hasGain(b.type) ? b.gain : 0, size.h);
            const active = selected === i;
            return (
              <button
                key={i}
                type="button"
                data-eq-band={i}
                aria-label={handleLabel(b, i)}
                aria-pressed={active}
                onPointerDown={(e) => startDrag(i, e)}
                onDoubleClick={() => hasGain(b.type) && update(i, { gain: 0 })}
                onKeyDown={(e) => onHandleKey(i, e)}
                onFocus={() => setSelected(i)}
                className="absolute w-7 h-7 -ml-3.5 -mt-3.5 grid place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                style={{ left: x, top: y, touchAction: 'none', zIndex: active ? 2 : 1 }}
              >
                <span
                  className={`grid place-items-center rounded-full text-[9px] font-bold text-black transition-transform ${
                    dragging === i ? 'scale-125' : ''
                  } ${active ? 'w-[18px] h-[18px] ring-2 ring-white' : 'w-4 h-4'}`}
                  style={{ backgroundColor: EQ_BAND_COLORS[i], opacity: b.on ? 1 : 0.35 }}
                >
                  {i + 1}
                </span>
              </button>
            );
          })}
        {dragging !== null && (
          <div className="absolute top-1.5 right-2 px-1.5 py-0.5 rounded bg-black/70 text-[10px] font-mono text-white pointer-events-none">
            {formatFreq(bands[dragging].freq)}
            {hasGain(bands[dragging].type) && ` · ${bands[dragging].gain > 0 ? '+' : ''}${bands[dragging].gain.toFixed(1)} dB`}
          </div>
        )}
      </div>

      <div className="grid grid-cols-6 gap-1" role="tablist" aria-label="EQ bands">
        {bands.map((b, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={selected === i}
            title={EQ_BAND_NAMES[i]}
            onClick={() => setSelected(i)}
            className={`h-7 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1 ${
              selected === i ? 'bg-raised text-white' : 'bg-app text-mute'
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: EQ_BAND_COLORS[i], opacity: b.on ? 1 : 0.3 }} />
            {EQ_BAND_SHORT[i]}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold">{EQ_BAND_NAMES[selected]}</span>
        <button
          type="button"
          role="switch"
          aria-checked={band.on}
          aria-label={`${EQ_BAND_NAMES[selected]} on`}
          onClick={() => update(selected, { on: !band.on })}
          className={`h-6 px-2.5 rounded-md text-[11px] font-semibold ${band.on ? 'bg-accent text-white' : 'bg-app text-mute'}`}
        >
          {band.on ? 'On' : 'Off'}
        </button>
      </div>
      <div>
        <ParamSlider
          label="Frequency"
          value={Math.log10(band.freq)}
          min={Math.log10(EQ_MIN_FREQ)}
          max={Math.log10(EQ_MAX_FREQ)}
          step={0.001}
          defaultValue={Math.log10(resetFreq(selected))}
          format={(v) => formatFreq(Math.pow(10, v))}
          parse={(t) => {
            const f = parseFreq(t);
            return f === null ? null : Math.log10(f);
          }}
          onChange={(v) => update(selected, { freq: Math.round(Math.pow(10, v)), on: true })}
        />
        {hasGain(band.type) && (
          <ParamSlider
            label="Gain"
            value={band.gain}
            min={-EQ_MAX_GAIN}
            max={EQ_MAX_GAIN}
            step={0.1}
            defaultValue={0}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
            onChange={(v) => update(selected, { gain: Math.round(v * 10) / 10, on: true })}
          />
        )}
        {hasQ(band.type) && (
          <ParamSlider
            label={band.type === 'peaking' ? 'Width (Q)' : 'Resonance (Q)'}
            // log scale: 0.3 to 10 spread evenly, so narrow and wide settings are equally precise
            value={Math.log10(band.q)}
            min={Math.log10(0.3)}
            max={1}
            step={0.001}
            bipolar={false}
            defaultValue={Math.log10(band.type === 'peaking' ? 1 : 0.71)}
            format={(v) => Math.pow(10, v).toFixed(2)}
            parse={(t) => {
              const q = parseFloat(t);
              return Number.isFinite(q) && q > 0 ? Math.log10(clampQ(q)) : null;
            }}
            onChange={(v) => update(selected, { q: clampQ(Math.round(Math.pow(10, v) * 100) / 100), on: true })}
          />
        )}
      </div>
    </div>
  );
};

/** Frequency a band returns to on double-click / double-tap of its frequency slider. */
const resetFreq = (i: number) => [30, 110, 300, 1200, 7500, 18000][i];
