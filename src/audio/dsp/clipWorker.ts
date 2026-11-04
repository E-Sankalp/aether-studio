/// <reference lib="webworker" />
/** Web Worker that renders clip pitch + processes off the UI thread. */
import { ClipRenderRequest, renderClipChannels } from './clipDsp';

interface WorkerRequest {
  id: number;
  request: ClipRenderRequest;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, request } = e.data;
  try {
    const channels = renderClipChannels(request);
    (self as unknown as Worker).postMessage(
      { id, channels },
      channels.map((c) => c.buffer as ArrayBuffer)
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
