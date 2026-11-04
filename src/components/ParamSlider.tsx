import React, { useEffect, useRef, useState } from 'react';

interface RangeInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  className?: string;
  onChange: (value: number) => void;
  /** Fired when the user finishes a gesture (pointer/touch release, key up, blur). */
  onRelease?: () => void;
}

/** Bare filled slider used in compact rows (track headers, mixer). */
export const RangeInput: React.FC<RangeInputProps> = ({
  value,
  min,
  max,
  step = 0.01,
  defaultValue,
  className = '',
  onChange,
  onRelease,
}) => {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      onPointerUp={onRelease}
      onTouchEnd={onRelease}
      onKeyUp={onRelease}
      onBlur={onRelease}
      onDoubleClick={() => {
        if (defaultValue === undefined) return;
        onChange(defaultValue);
        onRelease?.();
      }}
      onClick={(e) => e.stopPropagation()}
      className={`param-slider ${className}`}
      style={{
        background: `linear-gradient(to right, #f12c4c ${pct}%, #2a2a2f ${pct}%)`,
      }}
    />
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
}

/** Labelled slider row with live value read-out. Double-click resets. */
export const ParamSlider: React.FC<ParamSliderProps> = ({
  label,
  format,
  value,
  onChange,
  onCommit,
  ...rest
}) => {
  const [draft, setDraft] = useState<number | null>(null);
  // Ref mirrors the draft so a double-click reset (change + release in one tick) commits its value
  const draftRef = useRef<number | null>(null);
  const shown = draft ?? value;

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

  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-xs mb-2">
        <span className="text-mute">{label}</span>
        <span className="font-mono text-ink tabular-nums">
          {format ? format(shown) : String(Number(shown.toFixed(2)))}
        </span>
      </div>
      <RangeInput
        value={shown}
        className="w-full"
        onChange={handleChange}
        onRelease={onCommit ? handleRelease : undefined}
        {...rest}
      />
    </div>
  );
};
