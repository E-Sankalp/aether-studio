import React, { useEffect, useRef, useState } from 'react';

/*
 * Precision slider (replaces the native range input).
 *
 * Touch: nothing changes until a clear sideways drag (6 px); vertical movement scrolls the page
 * instead, so scrolling a panel full of sliders never changes a value. Values move relative to
 * where they were (no jump to the finger). While dragging, moving the finger up/down away from
 * the slider gives finer control (3x / 10x), like iOS scrubbing.
 * Mouse: click the track to jump, drag for relative movement, hold Shift for 10x finer.
 * Both: values snap to the default as they pass it; double-click / double-tap resets.
 * Keyboard: arrows (Shift = x10), PageUp/PageDown, Home/End.
 */

interface RangeInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  className?: string;
  onChange: (value: number) => void;
  /** Fired when the user finishes a gesture (release, key up, reset). */
  onRelease?: () => void;
  /** Accessible name (ParamSlider passes its label) */
  ariaLabel?: string;
  /** Human-readable value for screen readers and the drag tooltip */
  format?: (value: number) => string;
  /** Fill from zero when the range spans it (default). Off for log-mapped values. */
  bipolar?: boolean;
}

const DRAG_START_PX = 6;
const SCROLL_INTENT_PX = 8;
const DOUBLE_TAP_MS = 300;

export const RangeInput: React.FC<RangeInputProps> = ({
  value,
  min,
  max,
  step = 0.01,
  defaultValue,
  className = '',
  onChange,
  onRelease,
  ariaLabel,
  format,
  bipolar: bipolarFill = true,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);
  const lastTapRef = useRef(0);
  const range = max - min || 1;
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const quantize = (v: number) => {
    const q = Math.round((v - min) / step) * step + min;
    return clamp(Number(q.toFixed(6)));
  };
  // Magnetic detent at the default value (exact 0 dB, centre pan, ...)
  const detent = (v: number) =>
    defaultValue !== undefined && Math.abs(v - defaultValue) < range * 0.012 ? defaultValue : v;

  const pct = Math.max(0, Math.min(1, (value - min) / range));
  const bipolar = bipolarFill && min < 0 && max > 0;
  const zeroPct = bipolar ? (0 - min) / range : 0;
  const fillLeft = bipolar ? Math.min(pct, zeroPct) : 0;
  const fillWidth = bipolar ? Math.abs(pct - zeroPct) : pct;

  const reset = () => {
    if (defaultValue === undefined) return;
    onChange(defaultValue);
    onRelease?.();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const isTouch = e.pointerType !== 'mouse';
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = startX;
    let acc = value; // unquantized accumulator so fine moves add up
    let emitted = value;
    let dragging = false;
    const pointerId = e.pointerId;

    const emit = (v: number) => {
      const nv = detent(quantize(v));
      if (nv !== emitted) {
        emitted = nv;
        onChange(nv);
      }
    };
    const begin = () => {
      dragging = true;
      setActive(true);
      try {
        el.setPointerCapture(pointerId);
      } catch {}
    };

    if (!isTouch) {
      e.preventDefault();
      el.focus({ preventScroll: true });
      // Clicking the track away from the thumb jumps there; grabbing the thumb doesn't move it
      const thumbX = rect.left + pct * rect.width;
      if (Math.abs(e.clientX - thumbX) > 9) {
        acc = clamp(min + ((e.clientX - rect.left) / rect.width) * range);
        emit(acc);
      }
      begin();
    }

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        const tx = ev.clientX - startX;
        const ty = ev.clientY - startY;
        if (Math.abs(ty) > SCROLL_INTENT_PX && Math.abs(ty) > Math.abs(tx)) {
          cleanup(); // the user is scrolling the page
          return;
        }
        if (Math.abs(tx) < DRAG_START_PX) return;
        begin();
        lastX = ev.clientX;
        return;
      }
      ev.preventDefault();
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      let scale = ev.shiftKey ? 0.1 : 1;
      if (isTouch) {
        const away = Math.abs(ev.clientY - (rect.top + rect.height / 2));
        scale = away > 120 ? 0.1 : away > 60 ? 0.3 : 1;
      }
      acc = clamp(acc + (dx / rect.width) * range * scale);
      emit(acc);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (dragging) {
        onRelease?.();
      } else if (isTouch) {
        // Taps never change the value; a double-tap resets it
        const now = performance.now();
        if (now - lastTapRef.current < DOUBLE_TAP_MS) {
          lastTapRef.current = 0;
          reset();
        } else {
          lastTapRef.current = now;
        }
      }
      cleanup();
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (dragging) onRelease?.();
      cleanup();
    };
    const cleanup = () => {
      setActive(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const big = Math.max(step * 10, range / 10);
    const delta: Record<string, number> = {
      ArrowRight: step,
      ArrowUp: step,
      ArrowLeft: -step,
      ArrowDown: -step,
      PageUp: big,
      PageDown: -big,
    };
    let next: number | null = null;
    if (e.key in delta) next = value + delta[e.key] * (e.shiftKey && !e.key.startsWith('Page') ? 10 : 1);
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation(); // don't trigger app shortcuts
    onChange(quantize(next));
  };

  const text = format ? format(value) : String(Number(value.toFixed(3)));

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(4))}
      aria-valuetext={text}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (/^(Arrow|Page|Home|End)/.test(e.key)) onRelease?.();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        reset();
      }}
      onClick={(e) => e.stopPropagation()}
      className={`precision-slider group relative h-6 flex items-center cursor-pointer select-none outline-none ${className}`}
    >
      <div className="relative w-full h-1 rounded-full bg-[#2a2a2f]">
        <div
          className="absolute inset-y-0 rounded-full bg-accent"
          style={{ left: `${fillLeft * 100}%`, width: `${fillWidth * 100}%` }}
        />
        {bipolar && (
          <span
            className="absolute top-1/2 -translate-y-1/2 w-px h-2.5 bg-white/25"
            style={{ left: `${zeroPct * 100}%` }}
          />
        )}
      </div>
      <span
        className={`absolute top-1/2 w-3.5 h-3.5 -ml-[7px] -mt-[7px] rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.6)] transition-transform duration-100 group-focus-visible:ring-2 group-focus-visible:ring-accent/70 ${
          active ? 'scale-[1.35]' : 'group-hover:scale-110'
        }`}
        style={{ left: `${pct * 100}%` }}
      />
      {active && (
        <span
          className="absolute bottom-full mb-1.5 -translate-x-1/2 px-1.5 py-0.5 rounded-md bg-black/90 text-[10px] font-mono text-white whitespace-nowrap pointer-events-none"
          style={{ left: `${pct * 100}%` }}
        >
          {text}
        </span>
      )}
    </div>
  );
};

interface ParamSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  format?: (value: number) => string;
  /** Live updates while dragging (cheap parameters). */
  onChange?: (value: number) => void;
  /**
   * Called once when the gesture ends with the final value. Use for expensive work (rendering,
   * undo history): while dragging, the slider only shows a local draft value.
   */
  onCommit?: (value: number) => void;
  /** Typed entry for non-linear readouts: text -> value (null = invalid) */
  parse?: (text: string) => number | null;
  /** See RangeInput */
  bipolar?: boolean;
}

const firstNumber = (s: string): number | null => {
  const m = /[-+−]?\d+(?:\.\d+)?/.exec(s.replace('−', '-'));
  return m ? parseFloat(m[0]) : null;
};

/**
 * Display <-> value mapping for typed entry, derived from `format` when it is linear
 * (e.g. 0..1 shown as 0..100 %). Non-linear readouts (dB of a gain, "-∞") disable typing.
 */
function linearMapping(min: number, max: number, format?: (v: number) => string) {
  if (!format) return { toValue: (d: number) => d };
  const d0 = firstNumber(format(min));
  const d1 = firstNumber(format(max));
  const dm = firstNumber(format((min + max) / 2));
  if (d0 === null || d1 === null || dm === null || d1 === d0) return null;
  if (Math.abs(dm - (d0 + d1) / 2) > Math.abs(d1 - d0) * 0.01) return null;
  return { toValue: (d: number) => min + ((d - d0) / (d1 - d0)) * (max - min) };
}

/** Labelled slider row with live value read-out. Click the value to type it; double-click resets. */
export const ParamSlider: React.FC<ParamSliderProps> = ({
  label,
  format,
  value,
  onChange,
  onCommit,
  parse,
  ...rest
}) => {
  const [draft, setDraft] = useState<number | null>(null);
  // Ref mirrors the draft so a reset (change + release in one tick) commits its value
  const draftRef = useRef<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const shown = draft ?? value;
  const linear = linearMapping(rest.min, rest.max, format);
  const mapping = parse ? { toValue: (n: number) => n } : linear;

  const handleChange = (v: number) => {
    if (onCommit) {
      draftRef.current = v;
      setDraft(v);
    }
    onChange?.(v);
  };

  const handleRelease = () => {
    if (!onCommit) return;
    const d = draftRef.current;
    draftRef.current = null;
    if (d !== null && d !== value) {
      // Keep showing the committed value until the (possibly async) update arrives via `value`
      onCommit(d);
    } else {
      setDraft(null);
    }
  };

  // The committed value arrived (or another item was selected): drop the draft
  useEffect(() => {
    if (draftRef.current === null) setDraft(null);
  }, [value]);

  // Safety net if a commit never lands (e.g. render failed)
  useEffect(() => {
    if (draft === null || draftRef.current !== null) return;
    const t = window.setTimeout(() => setDraft(null), 15000);
    return () => window.clearTimeout(t);
  }, [draft]);

  const readout = format ? format(shown) : String(Number(shown.toFixed(2)));

  const commitTyped = () => {
    if (editing === null) return;
    const n = parse ? parse(editing) : firstNumber(editing);
    setEditing(null);
    if (n === null || !Number.isFinite(n) || !mapping) return;
    const step = rest.step ?? 0.01;
    const v = Math.max(rest.min, Math.min(rest.max, mapping.toValue(n)));
    const q = Number((Math.round((v - rest.min) / step) * step + rest.min).toFixed(6));
    handleChange(q);
    handleRelease();
  };

  return (
    <div className="py-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-mute">{label}</span>
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={commitTyped}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTyped();
              else if (e.key === 'Escape') setEditing(null);
              e.stopPropagation();
            }}
            inputMode="decimal"
            aria-label={`${label} value`}
            className="w-20 h-6 px-1.5 rounded-md bg-app border border-accent/60 text-right font-mono text-ink outline-none"
          />
        ) : (
          <button
            type="button"
            disabled={!mapping}
            onClick={() => setEditing(parse ? readout : String(firstNumber(readout) ?? ''))}
            title={mapping ? 'Click to type an exact value' : undefined}
            className="h-6 px-1.5 -mr-1.5 rounded-md font-mono text-ink tabular-nums enabled:hover:bg-white/[0.06] disabled:cursor-default"
          >
            {readout}
          </button>
        )}
      </div>
      <RangeInput
        value={shown}
        className="w-full"
        onChange={handleChange}
        onRelease={onCommit ? handleRelease : undefined}
        ariaLabel={label}
        format={format}
        {...rest}
      />
    </div>
  );
};
