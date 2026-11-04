import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { EXPORT_FORMATS, ExportFormatId } from '../audio/audioEncoders';

interface ExportMenuProps {
  isExporting: boolean;
  onExport: (format: ExportFormatId) => void;
  /** Mobile layout: full-width button with the format list expanding in the page flow. */
  inline?: boolean;
}

/** Export button that lets the user choose the output audio format. */
export const ExportMenu: React.FC<ExportMenuProps> = ({ isExporting, onExport, inline = false }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (id: ExportFormatId) => {
    setOpen(false);
    onExport(id);
  };

  const list = (
    <div
      role="menu"
      className={
        inline
          ? 'mt-2 rounded-2xl bg-panel border border-line overflow-hidden'
          : 'absolute right-0 top-full mt-2 w-64 rounded-2xl bg-panel/95 backdrop-blur border border-line shadow-2xl shadow-black/60 overflow-hidden z-[60]'
      }
    >
      <div className="px-3.5 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-mute">
        Export format
      </div>
      {EXPORT_FORMATS.map((f) => (
        <button
          key={f.id}
          role="menuitem"
          onClick={() => choose(f.id)}
          className="w-full text-left px-3.5 py-2.5 hover:bg-raised transition-colors flex flex-col gap-0.5"
        >
          <span className="text-[13px] font-semibold text-ink">{f.label}</span>
          <span className="text-[11px] text-mute">{f.description}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div ref={rootRef} className={inline ? 'w-full' : 'relative'}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={isExporting}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Export audio"
        className={
          inline
            ? 'w-full h-12 rounded-2xl brand-gradient text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-lg shadow-accent/30 disabled:opacity-50'
            : 'h-10 px-4 rounded-xl brand-gradient text-white text-[13px] font-semibold flex items-center gap-2 shadow-lg shadow-accent/30 ring-1 ring-white/15 hover:brightness-110 active:scale-95 transition disabled:opacity-50'
        }
      >
        <Download className="w-4 h-4" />
        <span className={inline ? '' : 'hidden sm:inline'}>
          {isExporting ? 'Rendering…' : 'Export'}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && list}
    </div>
  );
};
