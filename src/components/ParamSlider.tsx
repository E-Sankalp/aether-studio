import React from 'react';

interface RangeInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  className?: string;
  onChange: (value: number) => void;
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
      onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
      onClick={(e) => e.stopPropagation()}
      className={`param-slider ${className}`}
      style={{
        background: `linear-gradient(to right, #f12c4c ${pct}%, #2a2a2f ${pct}%)`,
      }}
    />
  );
};

interface ParamSliderProps extends Omit<RangeInputProps, 'className'> {
  label: string;
  format?: (value: number) => string;
}

/** Labelled slider row with live value read-out. Double-click resets. */
export const ParamSlider: React.FC<ParamSliderProps> = ({
  label,
  format,
  value,
  ...rest
}) => (
  <div className="py-1.5">
    <div className="flex items-center justify-between text-xs mb-2">
      <span className="text-mute">{label}</span>
      <span className="font-mono text-ink tabular-nums">
        {format ? format(value) : String(Number(value.toFixed(2)))}
      </span>
    </div>
    <RangeInput value={value} className="w-full" {...rest} />
  </div>
);
