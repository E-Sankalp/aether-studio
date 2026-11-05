import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { createLiveStore, useLiveStore } from '../utils/liveStore';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const toastStore = createLiveStore<Toast[]>([]);
let nextId = 1;

/** Shows a non-blocking notification (replaces window.alert). */
export function notify(message: string, tone: ToastTone = 'info', durationMs?: number): void {
  const id = nextId++;
  // Same message already visible: don't stack duplicates
  if (toastStore.get().some((t) => t.message === message)) return;
  toastStore.set([...toastStore.get(), { id, message, tone }].slice(-4));
  const ms = durationMs ?? (tone === 'error' || tone === 'warn' ? 7000 : 3500);
  window.setTimeout(() => dismiss(id), ms);
}

function dismiss(id: number): void {
  toastStore.set(toastStore.get().filter((t) => t.id !== id));
}

const toneStyle: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: 'border-white/10 text-ink [&_svg]:text-sky-400' },
  success: { icon: CheckCircle2, cls: 'border-emerald-500/30 text-ink [&_svg]:text-emerald-400' },
  warn: { icon: AlertTriangle, cls: 'border-amber-400/40 text-amber-50 [&_svg]:text-amber-300' },
  error: { icon: AlertTriangle, cls: 'border-accent/50 text-ink [&_svg]:text-accent' },
};

/** Renders active toasts: above the transport on mobile, bottom-center of the timeline on desktop. */
export const Toaster: React.FC = () => {
  const toasts = useLiveStore(toastStore);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      // Mobile: centered above the transport. Desktop: bottom-center of the timeline area (left of
      // the 360 px Inspector), so a toast never covers the controls it tells you to use.
      className="fixed z-[120] bottom-[132px] left-1/2 -translate-x-1/2 md:bottom-5 md:left-[calc((100vw-360px)/2)] flex flex-col gap-2 w-[min(92vw,380px)] pointer-events-none"
    >
      {toasts.map((t) => {
        const { icon: Icon, cls } = toneStyle[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === 'error' || t.tone === 'warn' ? 'alert' : 'status'}
            className={`toast-in pointer-events-auto flex items-start gap-2.5 pl-3.5 pr-2 py-3 rounded-xl border bg-[#1b1b1f]/95 backdrop-blur shadow-2xl shadow-black/60 text-[13px] leading-snug ${cls}`}
          >
            <Icon className="w-4 h-4 shrink-0 mt-px" />
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 -mt-0.5 p-1 rounded-md text-mute hover:text-ink hover:bg-white/5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
