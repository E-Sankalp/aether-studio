export function drawBufferWaveform(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  offsetSec: number,
  durationSec: number,
  playbackRate: number,
  gain: number,
  fadeInSec: number,
  fadeOutSec: number,
  color: string,
  selection?: { startOffset: number; endOffset: number } | null
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;

  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const midY = height / 2;
  const chan0 = buffer.getChannelData(0);
  const chan1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : chan0;

  const startSample = Math.max(0, Math.floor(offsetSec * buffer.sampleRate));
  const totalSamples = Math.floor(durationSec * playbackRate * buffer.sampleRate);
  const samplesPerPixel = Math.max(1, Math.floor(totalSamples / width));

  // Center zero line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();

  // Flat fill keeps the waveform crisp and clean
  ctx.fillStyle = `${color}d9`;

  for (let x = 0; x < width; x++) {
    const sampleStart = startSample + Math.floor((x / width) * totalSamples);
    if (sampleStart >= buffer.length) break;

    let min = 0;
    let max = 0;
    const step = Math.max(1, Math.floor(samplesPerPixel / 16));
    const end = Math.min(buffer.length, sampleStart + samplesPerPixel);

    for (let s = sampleStart; s < end; s += step) {
      const val = (chan0[s] + chan1[s]) * 0.5;
      if (val < min) min = val;
      if (val > max) max = val;
    }

    // Apply clip gain + fade-in/out visual scaling
    const timeInClip = (x / width) * durationSec;
    let envMult = gain;
    if (fadeInSec > 0.01 && timeInClip < fadeInSec) {
      envMult *= timeInClip / fadeInSec;
    }
    if (fadeOutSec > 0.01 && timeInClip > durationSec - fadeOutSec) {
      envMult *= Math.max(0, (durationSec - timeInClip) / fadeOutSec);
    }

    const scaledMin = Math.max(-1, min * envMult);
    const scaledMax = Math.min(1, max * envMult);

    const yTop = midY - scaledMax * (midY * 0.9);
    const yBot = midY - scaledMin * (midY * 0.9);
    const barH = Math.max(1.5, yBot - yTop);

    ctx.fillRect(x, yTop, 1, barH);
  }

  // Draw Fade In / Fade Out envelope curves
  if (fadeInSec > 0.01 || fadeOutSec > 0.01) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1.5;

    if (fadeInSec > 0.01) {
      const fadeW = Math.min(width, (fadeInSec / durationSec) * width);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(fadeW, 0);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(fadeW, 0);
      ctx.stroke();
    }

    if (fadeOutSec > 0.01) {
      const fadeW = Math.min(width, (fadeOutSec / durationSec) * width);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.moveTo(width, 0);
      ctx.lineTo(width - fadeW, 0);
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(width - fadeW, 0);
      ctx.lineTo(width, height);
      ctx.stroke();
    }
  }

  // Draw selection overlay if provided
  if (selection && selection.endOffset > selection.startOffset) {
    const selStartX = (selection.startOffset / durationSec) * width;
    const selEndX = (selection.endOffset / durationSec) * width;
    const selW = Math.max(2, selEndX - selStartX);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fillRect(selStartX, 0, selW, height);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(selStartX, 0);
    ctx.lineTo(selStartX, height);
    ctx.moveTo(selEndX, 0);
    ctx.lineTo(selEndX, height);
    ctx.stroke();
  }

  ctx.restore();
}
