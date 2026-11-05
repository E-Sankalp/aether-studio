import { useEffect } from 'react';
import type { MutableRefObject } from 'react';

export interface ShortcutHandlers {
  /** Studio shortcuts only work in the studio with a project open */
  enabled: boolean;
  play: () => void;
  split: () => void;
  del: () => void;
  undo: () => void;
  redo: () => void;
  duplicate: () => void;
  record: () => void;
  loop: () => void;
  rewind: () => void;
  save: () => void;
  shortcuts: () => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  selectAll: () => void;
  clearSelection: () => void;
}

/**
 * Global keyboard shortcuts. Handlers are read through a ref (filled each render) so the listener
 * is installed once and always sees the latest state.
 */
export function useKeyboardShortcuts(ref: MutableRefObject<ShortcutHandlers | null>): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const h = ref.current;
      if (!h) return;
      const t = e.target as HTMLElement | null;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Ctrl+S always saves (and stops the browser's "Save page" dialog)
      if (mod && key === 's') {
        e.preventDefault();
        if (h.enabled) h.save();
        return;
      }
      const typing =
        (t instanceof HTMLInputElement && t.type !== 'range') ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        !!t?.isContentEditable;
      if (typing) return;
      if (e.key === '?') {
        e.preventDefault();
        h.shortcuts();
        return;
      }
      if (!h.enabled) return;

      if (e.code === 'Space') {
        e.preventDefault();
        // A focused button would also "click" on Space: drop focus so it fires only once
        if (t && t !== document.body) t.blur();
        h.play();
      } else if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) h.redo();
        else h.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        h.redo();
      } else if (mod && key === 'd') {
        e.preventDefault();
        h.duplicate();
      } else if (mod && key === 'c') {
        e.preventDefault();
        h.copy();
      } else if (mod && key === 'x') {
        e.preventDefault();
        h.cut();
      } else if (mod && key === 'v') {
        e.preventDefault();
        h.paste();
      } else if (mod && key === 'a') {
        e.preventDefault();
        h.selectAll();
      } else if (e.key === 'Escape') {
        h.clearSelection();
      } else if (mod || e.altKey) {
        return;
      } else if (key === 's') {
        e.preventDefault();
        h.split();
      } else if (key === 'r') {
        e.preventDefault();
        h.record();
      } else if (key === 'l') {
        e.preventDefault();
        h.loop();
      } else if (e.key === 'Home' || e.key === 'Enter') {
        e.preventDefault();
        h.rewind();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        h.del();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ref]);
}
