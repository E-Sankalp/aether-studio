/**
 * Tiny external stores for values that change every animation frame (playhead, meters, mic level).
 * Keeping them out of React state means only the few components that display them re-render,
 * instead of the whole app 20-60 times per second.
 */
import { useSyncExternalStore } from 'react';
import type { MeterLevels } from '../types/audio';

export interface LiveStore<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createLiveStore<T>(initial: T): LiveStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Subscribes to a store, optionally to a derived slice (re-renders only when the slice changes). */
export function useLiveStore<T, S = T>(store: LiveStore<T>, select?: (value: T) => S): S {
  const getSnapshot = () => (select ? select(store.get()) : (store.get() as unknown as S));
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export const EMPTY_METERS: MeterLevels = {
  masterLeft: 0,
  masterRight: 0,
  masterPeakDb: -60,
  masterRmsDb: -60,
  phaseCorrelation: 1,
  trackLevels: {},
};

/** Timeline playhead in seconds. */
export const playheadStore = createLiveStore(0);
/** Master + per-track meter levels (updated ~20 fps by the visualizer). */
export const meterStore = createLiveStore<MeterLevels>(EMPTY_METERS);
/** Microphone input peak level 0..1 while recording. */
export const micLevelStore = createLiveStore(0);
