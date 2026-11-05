import React, { useEffect } from 'react';
import { Keyboard, X } from 'lucide-react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

const GROUPS: { title: string; items: [string[], string][] }[] = [
  {
    title: 'Transport',
    items: [
      [['Space'], 'Play / pause'],
      [['R'], 'Record into the selected track'],
      [['L'], 'Loop on / off'],
      [['Home'], 'Back to start'],
    ],
  },
  {
    title: 'Editing',
    items: [
      [['Shift', 'Click'], 'Add/remove clip from selection'],
      [[MOD, 'A'], 'Select all clips'],
      [['S'], 'Split selected clips at playhead'],
      [[MOD, 'C'], 'Copy clips'],
      [[MOD, 'X'], 'Cut clips'],
      [[MOD, 'V'], 'Paste at playhead'],
      [[MOD, 'D'], 'Duplicate clips'],
      [['Delete'], 'Delete clips'],
      [[MOD, 'Z'], 'Undo'],
      [[MOD, 'Shift', 'Z'], 'Redo'],
      [[MOD, 'S'], 'Save now'],
    ],
  },
  {
    title: 'Timeline',
    items: [
      [['Double-click ruler'], 'Loop that bar'],
      [['Drag loop edges'], 'Resize the loop'],
      [['?'], 'Show this list'],
    ],
  },
];

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="min-w-[22px] h-[22px] px-1.5 inline-flex items-center justify-center rounded-md bg-raised border border-line border-b-2 text-[11px] font-semibold font-sans text-ink">
    {children}
  </kbd>
);

/** Keyboard shortcut reference (opened with "?" or the header keyboard button). */
export const ShortcutsDialog: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
        className="toast-in w-full max-w-[560px] max-h-[85dvh] overflow-y-auto rounded-2xl bg-panel border border-line shadow-2xl shadow-black/70"
      >
        <div className="flex items-center justify-between px-5 h-14 border-b border-line">
          <h2 id="shortcuts-title" className="text-[14px] font-semibold flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-accent" />
            Keyboard shortcuts
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-mute hover:text-ink hover:bg-white/5"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 grid gap-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title} className={g.title === 'Editing' ? 'sm:row-span-2' : ''}>
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-mute mb-2">
                {g.title}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {g.items.map(([keys, label]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-ink/90">{label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
