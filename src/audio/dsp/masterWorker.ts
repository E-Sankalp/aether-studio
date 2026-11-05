/// <reference lib="webworker" />
/** Web Worker that loudness-normalizes and limits a rendered mix off the UI thread. */
import type { MasterSettings } from '../../types/audio';
import { masterChannels } from '../mastering';

interface MasterRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  settings: MasterSettings;
}

self.onmessage = (e: MessageEvent<MasterRequest>) => {
  const { id, channels, sampleRate, settings } = e.data;
  try {
    const res = masterChannels(channels, sampleRate, settings);
    (self as unknown as Worker).postMessage(
      { id, channels: res.channels, report: res.report },
      res.channels.map((c) => c.buffer as ArrayBuffer)
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
