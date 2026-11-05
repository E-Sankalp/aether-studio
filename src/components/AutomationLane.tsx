import React, { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AudioTrack, AutomationPoint } from '../types/audio';
import { AUTOMATION_MAX, gainToDbLabel, normalizePoints, valueAt } from '../audio/automation';

const LANE_H = 56;
const PAD = 6;
const HIT_PX = 8;

interface AutomationLaneProps {
  track: AudioTrack;
  headerW: number;
  widthPx: number;
  pps: number;
  /** Snap step in seconds (0 = off) */
  snapSec: number;
  /** `gestureKey` identifies one pointer gesture, so each gesture is its own undo step */
  onChange: (points: AutomationPoint[], gestureKey: string) => void;
}

/**
 * Volume automation lane under a track. Click empty space to add a point, drag points to
 * shape the curve, double-click a point to remove it.
 */
export const AutomationLane: React.FC<AutomationLaneProps> = ({
  track,
  headerW,
  widthPx,
  pps,
  snapSec,
  onChange,
}) => {
  const points = track.automation?.volume ?? [];
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const gestureSeq = useRef(0);
  const nextGesture = () => `auto:${track.id}:${++gestureSeq.current}`;
  const innerH = LANE_H - PAD * 2;

  const yOf = (v: number) => PAD + (1 - v / AUTOMATION_MAX) * innerH;
  const vOf = (y: number) => Math.max(0, Math.min(AUTOMATION_MAX, (1 - (y - PAD) / innerH) * AUTOMATION_MAX));
  const snapT = (t: number) => Math.max(0, snapSec > 0 ? Math.round(t / snapSec) * snapSec : t);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitIndex = (x: number, y: number) =>
    points.findIndex((p) => Math.hypot(p.t * pps - x, yOf(p.v) - y) <= HIT_PX);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const gesture = nextGesture();
    const { x, y } = toLocal(e);
    let pts = points.map((p) => ({ ...p }));
    let idx = hitIndex(x, y);
    if (idx < 0) {
      // New point on the click position (snap time, keep the exact value)
      pts = normalizePoints([...pts, { t: snapT(x / pps), v: vOf(y) }]);
      idx = pts.findIndex((p) => Math.abs(p.t - snapT(x / pps)) < 1e-6);
      onChange(pts, gesture);
    }
    setActive(idx);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    const onMove = (pe: PointerEvent) => {
      const loc = toLocal(pe);
      // Time is kept between the neighbours so points never swap order mid-drag
      const lo = idx > 0 ? pts[idx - 1].t + 0.01 : 0;
      const hi = idx < pts.length - 1 ? pts[idx + 1].t - 0.01 : Infinity;
      const t = Math.max(lo, Math.min(hi, snapT(loc.x / pps)));
      pts = pts.map((p, i) => (i === idx ? { t, v: vOf(loc.y) } : p));
      onChange(pts, gesture);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setActive(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const { x, y } = toLocal(e);
    const idx = hitIndex(x, y);
    if (idx >= 0) onChange(points.filter((_, i) => i !== idx), nextGesture());
  };

  // Curve: flat before the first point and after the last, linear in between
  const line =
    points.length === 0
      ? `M0,${yOf(1)} L${widthPx},${yOf(1)}`
      : [
          `M0,${yOf(points[0].v)}`,
          ...points.map((p) => `L${p.t * pps},${yOf(p.v)}`),
          `L${widthPx},${yOf(points[points.length - 1].v)}`,
        ].join(' ');
  const shown = active !== null ? points[active] : null;

  return (
    <div style={{ height: LANE_H }} className="flex border-b border-line bg-black/20">
      <div
        style={{ width: headerW }}
        className="sticky left-0 z-20 shrink-0 border-r border-line bg-panel px-3 flex items-center justify-between gap-2"
      >
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink truncate">Volume automation</div>
          <div className="text-[10px] text-mute font-mono">
            {shown ? gainToDbLabel(shown.v) : points.length === 0 ? 'Click lane to add' : `${points.length} points`}
          </div>
        </div>
        {points.length > 0 && (
          <button
            onClick={() => onChange([], nextGesture())}
            title="Clear automation"
            aria-label="Clear automation"
            className="p-1 rounded text-mute hover:text-accent shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <svg
        ref={svgRef}
        width={widthPx}
        height={LANE_H}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        className="block cursor-crosshair touch-none"
        role="img"
        aria-label={`Volume automation for ${track.name}`}
      >
        {/* 0 dB reference */}
        <line x1={0} x2={widthPx} y1={yOf(1)} y2={yOf(1)} stroke="rgba(255,255,255,0.08)" strokeDasharray="3 4" />
        <path
          d={`${line} L${widthPx},${LANE_H} L0,${LANE_H} Z`}
          fill={track.color}
          fillOpacity={0.12}
        />
        <path d={line} fill="none" stroke={track.color} strokeWidth={1.75} strokeOpacity={points.length ? 1 : 0.4} />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.t * pps}
            cy={yOf(p.v)}
            r={active === i ? 5.5 : 4}
            fill={active === i ? '#fff' : track.color}
            stroke="#0d0d0f"
            strokeWidth={1.5}
          >
            <title>{`${p.t.toFixed(2)} s · ${gainToDbLabel(p.v)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
};

/** Current automation value for a track at `t` (used by tooltips/tests). */
export const automationValueAt = (track: AudioTrack, t: number) => valueAt(track.automation?.volume, t);
