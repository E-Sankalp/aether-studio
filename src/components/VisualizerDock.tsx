import React, { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/audioEngine';
import { MeterLevels } from '../types/audio';

type VizMode = 'spectrum' | 'scope';

interface VisualizerDockProps {
  isPlaying: boolean;
  onMeterUpdate?: (levels: MeterLevels) => void;
}

/** Compact live spectrum / scope + loudness read-out. Tap to switch view. */
export const VisualizerDock: React.FC<VisualizerDockProps> = ({ isPlaying, onMeterUpdate }) => {
  const [mode, setMode] = useState<VizMode>('spectrum');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [lufs, setLufs] = useState('-∞');

  useEffect(() => {
    let animId = 0;
    let lastEmit = 0;
    const freqData = new Uint8Array(1024);
    const timeData = new Uint8Array(1024);

    const render = (now: number) => {
      // Meters feed React state; throttle to ~20 fps to keep the UI light
      if (now - lastEmit > 50) {
        lastEmit = now;
        const m = audioEngine.getMeterLevels();
        setLufs(m.masterRmsDb <= -59 ? '-∞' : (m.masterRmsDb - 0.7).toFixed(1));
        onMeterUpdate?.(m);
      }

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (width > 0 && height > 0) {
          if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
          }
          ctx.save();
          ctx.scale(dpr, dpr);
          ctx.clearRect(0, 0, width, height);

          if (mode === 'spectrum') {
            audioEngine.getFrequencyData(freqData);
            const bars = 28;
            const barW = width / bars;
            ctx.fillStyle = '#f12c4c';
            for (let i = 0; i < bars; i++) {
              const idx = Math.min(
                freqData.length - 1,
                Math.floor(Math.pow(i / bars, 1.8) * freqData.length * 0.65)
              );
              const h = Math.max(1.5, (freqData[idx] / 255) * (height - 2));
              ctx.fillRect(i * barW + 1, height - h, Math.max(1, barW - 2), h);
            }
          } else {
            audioEngine.getTimeDomainData(timeData);
            ctx.strokeStyle = '#f4f4f5';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const half = timeData.length / 2;
            for (let i = 0; i < half; i++) {
              const x = (i / half) * width;
              const y = (timeData[i] / 255) * height;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
          ctx.restore();
        }
      }
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [mode, isPlaying, onMeterUpdate]);

  return (
    <button
      onClick={() => setMode((m) => (m === 'spectrum' ? 'scope' : 'spectrum'))}
      title="Tap to switch spectrum / waveform view"
      className="flex items-center gap-2 h-9 pl-2 pr-3 rounded-xl bg-raised border border-line"
    >
      <canvas ref={canvasRef} className="w-16 h-5 block" />
      <span className="flex flex-col items-start leading-tight">
        <span className="font-mono text-[11px] text-ink tabular-nums">{lufs}</span>
        <span className="text-[9px] uppercase tracking-wider text-mute">LUFS</span>
      </span>
    </button>
  );
};
