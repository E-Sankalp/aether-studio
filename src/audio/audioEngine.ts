import {
  AudioClip,
  AudioTrack,
  BufferOperationType,
  ClipProcessSettings,
  LoopRegion,
  LoudnessReport,
  MasterSettings,
  MeterLevels,
  TrackEffects,
  VocalScale,
} from '../types/audio';
import { VOCAL_SCALES } from './presets';
import { saveBufferToStorage } from '../utils/projectStorage';
import {
  applyMasterChain,
  createMasterChain,
  DEFAULT_MASTER,
  MasterChainNodes,
  masterBuffer,
} from './mastering';
import { ClipRenderRequest, isDefaultProcesses, renderClipChannels } from './dsp/clipDsp';

interface TrackGraphNodes {
  input: GainNode;
  rawDryGain: GainNode;
  rumbleHighpass: BiquadFilterNode;
  hissLowpass: BiquadFilterNode;
  deEsserFilter: BiquadFilterNode;
  harshCutFilter: BiquadFilterNode;
  vocalWarmthFilter: BiquadFilterNode;
  autoPitchFormant: BiquadFilterNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  driveShaper: WaveShaperNode;
  compressor: DynamicsCompressorNode;
  processedDryGain: GainNode;
  wetMasterGain: GainNode;
  // Vocal Harmony / Choir Stereo Engine
  harmonyDelayL: DelayNode;
  harmonyDelayR: DelayNode;
  harmonyLfoL: OscillatorNode;
  harmonyLfoR: OscillatorNode;
  harmonyLfoGainL: GainNode;
  harmonyLfoGainR: GainNode;
  harmonyPanL: StereoPannerNode;
  harmonyPanR: StereoPannerNode;
  harmonyWetGain: GainNode;
  // Spatial Delay & Reverb
  delayNode: DelayNode;
  delayFeedback: GainNode;
  delayWet: GainNode;
  convolver: ConvolverNode;
  reverbWet: GainNode;
  sumNode: GainNode;
  volumeNode: GainNode;
  pannerNode: StereoPannerNode;
  analyser: AnalyserNode;
  currentReverbDecay: number;
}

interface ActiveClipNode {
  source: AudioBufferSourceNode;
  clipGainNode: GainNode;
  clip: AudioClip;
}

const BUILTIN_BUFFER_IDS = new Set([
  'stem_drums',
  'stem_bass',
  'stem_chords',
  'stem_lead',
]);

/**
 * AudioWorklet that captures its input as raw Float32 PCM, reporting the AudioContext time of the
 * first captured frame so recordings can be placed on the timeline sample-accurately.
 */
const CAPTURE_WORKLET_SOURCE = `
class AetherCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.len = 0;
    this.started = false;
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.stopped = true;
        this.port.postMessage({ type: 'done' });
      }
    };
  }
  flush() {
    if (!this.len) return;
    const out = new Float32Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    this.chunks = [];
    this.len = 0;
    this.port.postMessage({ type: 'data', data: out }, [out.buffer]);
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (input && input.length > 0) {
      if (!this.started) {
        this.started = true;
        this.port.postMessage({ type: 'start', time: currentTime });
      }
      this.chunks.push(input[0].slice(0));
      this.len += input[0].length;
      if (this.len >= 16384) this.flush();
    }
    return true;
  }
}
registerProcessor('aether-capture', AetherCapture);
`;

interface CaptureSession {
  /** Resolves with the AudioContext time of the first captured frame. */
  started: Promise<number>;
  stop: () => Promise<{ startTime: number; data: Float32Array }>;
}

export interface LatencySettings {
  /** 'auto' uses browser-reported latency; 'manual' uses `manualMs` (from calibration or by hand). */
  mode: 'auto' | 'manual';
  manualMs: number;
}

const LATENCY_STORAGE_KEY = 'aether_recording_latency_v1';

export class StudioAudioEngine {
  private ctx: AudioContext | null = null;
  private buffers: Map<string, AudioBuffer> = new Map();
  private trackNodes: Map<string, TrackGraphNodes> = new Map();
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private activeClipNodes: Map<string, ActiveClipNode[]> = new Map();
  private scheduledClicks: Set<OscillatorNode> = new Set();
  /** Count-in clicks survive play()/stop(); cancelled via cancelCountIn() */
  private countInClicks: Set<OscillatorNode> = new Set();
  private schedulerTimer: number | null = null;
  private transport: {
    tracks: AudioTrack[];
    clips: AudioClip[];
    /** Timeline position (s) that plays at `startCtx` */
    fromTime: number;
    startCtx: number;
    loop: { start: number; end: number } | null;
    /** Index of the next segment (loop iteration) to schedule */
    nextSegment: number;
    /** Context time up to which metronome clicks are scheduled */
    metroUntil: number;
  } | null = null;

  private masterGain: GainNode | null = null;
  private masterChain: MasterChainNodes | null = null;
  private masterSettings: MasterSettings = DEFAULT_MASTER;
  private masterPreviewMakeupDb = 0;
  private masterAnalyser: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private leftAnalyser: AnalyserNode | null = null;
  private rightAnalyser: AnalyserNode | null = null;

  private isPlaying = false;

  // Metronome state
  private metronomeEnabled = false;
  private currentBpm = 120;

  // Microphone recording & live FX monitoring state
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private micAnalyser: AnalyserNode | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micMonitorGain: GainNode | null = null;
  private micMonitorEnabled = false;

  // Sample-accurate capture + recording latency compensation
  private captureModule: Promise<void> | null = null;
  private capture: CaptureSession | null = null;
  private recordingAnchorCtxTime: number | null = null;
  private lastInputLatencySec = 0;
  private latencySettings: LatencySettings = StudioAudioEngine.loadLatencySettings();

  // Off-thread clip rendering (undefined = not created yet, null = unavailable)
  private clipWorker: Worker | null | undefined = undefined;
  private clipJobs = new Map<
    number,
    { resolve: (c: Float32Array[]) => void; reject: (e: Error) => void }
  >();
  private clipJobSeq = 0;
  private bufferRegisteredAt = new Map<string, number>();

  public getContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1.0;

      this.masterChain = createMasterChain(this.ctx, true);
      applyMasterChain(
        this.ctx,
        this.masterChain,
        this.masterSettings,
        this.masterPreviewMakeupDb,
        true
      );

      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 2048;
      this.masterAnalyser.smoothingTimeConstant = 0.82;

      this.splitter = this.ctx.createChannelSplitter(2);
      this.leftAnalyser = this.ctx.createAnalyser();
      this.leftAnalyser.fftSize = 512;
      this.rightAnalyser = this.ctx.createAnalyser();
      this.rightAnalyser.fftSize = 512;

      this.masterGain.connect(this.masterChain.input);
      this.masterChain.output.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);

      this.masterChain.output.connect(this.splitter);
      this.splitter.connect(this.leftAnalyser, 0);
      this.splitter.connect(this.rightAnalyser, 1);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public registerBuffer(id: string, buffer: AudioBuffer, persist = true): void {
    this.buffers.set(id, buffer);
    this.bufferRegisteredAt.set(id, Date.now());
    if (persist && !BUILTIN_BUFFER_IDS.has(id)) {
      saveBufferToStorage(id, buffer);
    }
  }

  public getBuffer(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  public setMasterVolume(val: number): void {
    const ctx = this.getContext();
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, val)), ctx.currentTime, 0.015);
    }
  }

  /**
   * Applies mastering settings to the live master bus. `previewMakeupDb` is the loudness gain the
   * export would apply (from the last analysis), so playback roughly matches the exported master.
   */
  public setMasterSettings(
    settings: MasterSettings,
    previewMakeupDb = this.masterPreviewMakeupDb
  ): void {
    this.masterSettings = settings;
    this.masterPreviewMakeupDb = previewMakeupDb;
    if (this.ctx && this.masterChain) {
      applyMasterChain(this.ctx, this.masterChain, settings, previewMakeupDb);
    }
  }

  /* ----------------------- recording latency compensation ---------------------- */

  private static loadLatencySettings(): LatencySettings {
    try {
      const raw = localStorage.getItem(LATENCY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LatencySettings>;
        return {
          mode: parsed.mode === 'manual' ? 'manual' : 'auto',
          manualMs: Math.max(0, Math.min(1000, Number(parsed.manualMs) || 0)),
        };
      }
    } catch {
      // Ignore
    }
    return { mode: 'auto', manualMs: 0 };
  }

  public getLatencySettings(): LatencySettings {
    return { ...this.latencySettings };
  }

  public setLatencySettings(settings: LatencySettings): void {
    this.latencySettings = {
      mode: settings.mode,
      manualMs: Math.max(0, Math.min(1000, Math.round(settings.manualMs))),
    };
    try {
      localStorage.setItem(LATENCY_STORAGE_KEY, JSON.stringify(this.latencySettings));
    } catch {
      // Ignore
    }
  }

  /** Round-trip latency (speaker output + mic input) as reported by the browser, in ms. */
  public getAutoLatencyMs(): number {
    const ctx = this.getContext();
    const out = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    // Browsers that don't report input latency: assume a typical ~10 ms
    const input = this.lastInputLatencySec > 0 ? this.lastInputLatencySec : 0.01;
    return Math.round((out + input) * 1000);
  }

  /** Latency (seconds) trimmed from the start of each recorded take. */
  public getRecordingLatencySec(): number {
    return this.latencySettings.mode === 'manual'
      ? this.latencySettings.manualMs / 1000
      : this.getAutoLatencyMs() / 1000;
  }

  private ensureCaptureModule(ctx: AudioContext): Promise<void> {
    if (!this.captureModule) {
      const url = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' })
      );
      this.captureModule = ctx.audioWorklet.addModule(url).catch((err) => {
        this.captureModule = null;
        throw err;
      });
    }
    return this.captureModule;
  }

  /** Starts capturing raw mono PCM from `source` inside the audio graph. */
  private async startCapture(ctx: AudioContext, source: AudioNode): Promise<CaptureSession> {
    await this.ensureCaptureModule(ctx);
    const node = new AudioWorkletNode(ctx, 'aether-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    // Keep the node pulled by the graph without making it audible
    const silent = ctx.createGain();
    silent.gain.value = 0;
    node.connect(silent);
    silent.connect(ctx.destination);
    source.connect(node);

    const chunks: Float32Array[] = [];
    let startTime = ctx.currentTime;
    let resolveStart: (t: number) => void = () => {};
    let resolveDone: () => void = () => {};
    const started = new Promise<number>((r) => (resolveStart = r));
    const done = new Promise<void>((r) => (resolveDone = r));

    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; time?: number; data?: Float32Array };
      if (msg.type === 'start') {
        startTime = msg.time ?? ctx.currentTime;
        resolveStart(startTime);
      } else if (msg.type === 'data' && msg.data) {
        chunks.push(msg.data);
      } else if (msg.type === 'done') {
        resolveDone();
      }
    };

    const stop = async () => {
      node.port.postMessage('stop');
      await Promise.race([done, new Promise((r) => window.setTimeout(r, 1500))]);
      try {
        source.disconnect(node);
      } catch {}
      node.disconnect();
      silent.disconnect();
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const data = new Float32Array(total);
      let o = 0;
      for (const c of chunks) {
        data.set(c, o);
        o += c.length;
      }
      return { startTime, data };
    };

    return { started, stop };
  }

  /**
   * Measures the true round-trip latency: plays clicks through the speakers and listens for them
   * with the microphone. Needs speakers (not headphones). Returns latency in ms.
   */
  public async calibrateLatency(): Promise<number> {
    if (this.capture || this.mediaRecorder) throw new Error('Stop recording before calibrating.');
    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = ctx.createMediaStreamSource(stream);
    try {
      const session = await this.startCapture(ctx, src);
      await session.started;

      // Short, sharp broadband click
      const click = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.004), ctx.sampleRate);
      const cd = click.getChannelData(0);
      for (let i = 0; i < cd.length; i++) {
        cd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (cd.length / 4));
      }

      const count = 8;
      const interval = 0.45;
      const t0 = ctx.currentTime + 0.6;
      for (let i = 0; i < count; i++) {
        const s = ctx.createBufferSource();
        s.buffer = click;
        const g = ctx.createGain();
        g.gain.value = 0.9;
        s.connect(g);
        g.connect(ctx.destination);
        s.start(t0 + i * interval);
      }
      await new Promise((r) =>
        window.setTimeout(r, (t0 - ctx.currentTime + count * interval + 0.4) * 1000)
      );
      const { startTime, data } = await session.stop();

      const sr = ctx.sampleRate;
      const idxOf = (t: number) => Math.round((t - startTime) * sr);
      // Noise floor from the quiet lead-in before the first click
      const floorEnd = Math.max(0, Math.min(data.length, idxOf(t0) - Math.round(0.05 * sr)));
      let floorSum = 0;
      for (let i = 0; i < floorEnd; i++) floorSum += data[i] * data[i];
      const noiseRms = floorEnd > 0 ? Math.sqrt(floorSum / floorEnd) : 0.001;

      const latencies: number[] = [];
      for (let i = 0; i < count; i++) {
        const sched = t0 + i * interval;
        const a = Math.max(0, idxOf(sched));
        const b = Math.min(data.length, a + Math.round(0.4 * sr));
        let peak = 0;
        for (let k = a; k < b; k++) peak = Math.max(peak, Math.abs(data[k]));
        if (peak < 0.01 || peak < noiseRms * 8) continue;
        const thresh = Math.max(noiseRms * 6, peak * 0.35);
        for (let k = a; k < b; k++) {
          if (Math.abs(data[k]) >= thresh) {
            latencies.push(startTime + k / sr - sched);
            break;
          }
        }
      }

      if (latencies.length < 5) {
        throw new Error(
          'Could not hear the test clicks. Unplug headphones, turn the speakers up and try again.'
        );
      }
      latencies.sort((x, y) => x - y);
      const median = latencies[Math.floor(latencies.length / 2)];
      const deviations = latencies.map((l) => Math.abs(l - median)).sort((x, y) => x - y);
      if (deviations[Math.floor(deviations.length / 2)] > 0.004) {
        throw new Error('Measurements were inconsistent (noisy room?). Please try again.');
      }
      return Math.max(0, Math.round(median * 1000));
    } finally {
      try {
        src.disconnect();
      } catch {}
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  public setMetronome(enabled: boolean, bpm?: number): void {
    const bpmChanged = typeof bpm === 'number' && bpm > 0 && bpm !== this.currentBpm;
    const wasEnabled = this.metronomeEnabled;
    this.metronomeEnabled = enabled;
    if (typeof bpm === 'number' && bpm > 0) this.currentBpm = bpm;

    if (!enabled || bpmChanged) {
      // Drop clicks already scheduled with the old setting; the scheduler re-fills the window
      this.stopScheduledClicks();
      if (this.transport && this.ctx) this.transport.metroUntil = this.ctx.currentTime;
    } else if (!wasEnabled && this.transport && this.ctx) {
      this.transport.metroUntil = Math.max(this.transport.metroUntil, this.ctx.currentTime);
    }
    if (enabled && this.isPlaying) this.schedulerTick();
  }

  private stopScheduledClicks(): void {
    for (const osc of this.scheduledClicks) {
      try {
        osc.stop();
        osc.disconnect();
      } catch {}
    }
    this.scheduledClicks.clear();
  }

  /**
   * Schedules a 4-beat (or `beats`) count-in on the audio clock and returns the context time of
   * the following downbeat, so recording/playback can start exactly on it.
   */
  public scheduleCountIn(bpm: number, beats = 4): number {
    const ctx = this.getContext();
    const beatLen = 60 / Math.max(40, Math.min(240, bpm));
    const t0 = ctx.currentTime + 0.08;
    for (let i = 0; i < beats; i++) this.playClickSound(i === 0, t0 + i * beatLen, true);
    return t0 + beats * beatLen;
  }

  public cancelCountIn(): void {
    for (const osc of this.countInClicks) {
      try {
        osc.stop();
        osc.disconnect();
      } catch {}
    }
    this.countInClicks.clear();
  }

  /**
   * Plays a crisp studio woodblock/metronome click at context time `when` (default: now).
   */
  public playClickSound(isDownbeat: boolean, when?: number, isCountIn = false): void {
    const ctx = this.getContext();
    if (!this.masterGain) return;
    const now = Math.max(ctx.currentTime, when ?? ctx.currentTime);

    const osc = ctx.createOscillator();
    const clickGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isDownbeat ? 1320 : 880, now);
    osc.frequency.exponentialRampToValueAtTime(isDownbeat ? 660 : 440, now + 0.045);

    clickGain.gain.setValueAtTime(isDownbeat ? 0.35 : 0.22, now);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

    osc.connect(clickGain);
    clickGain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.055);
    const set = isCountIn ? this.countInClicks : this.scheduledClicks;
    set.add(osc);
    osc.onended = () => {
      set.delete(osc);
      clickGain.disconnect();
    };
  }

  public setMicMonitorEnabled(enabled: boolean, targetTrackId?: string): void {
    this.micMonitorEnabled = enabled;
    if (this.micMonitorGain && this.ctx) {
      if (enabled && targetTrackId) {
        const nodes = this.trackNodes.get(targetTrackId);
        if (nodes) {
          try {
            this.micMonitorGain.disconnect();
          } catch {}
          this.micMonitorGain.connect(nodes.input);
          this.micMonitorGain.gain.setTargetAtTime(0.95, this.ctx.currentTime, 0.015);
          return;
        }
      }
      this.micMonitorGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
    }
  }

  private createDistortionCurve(drivePercent: number): Float32Array {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const k = (drivePercent / 100) * 65;
    if (k <= 0.1) {
      for (let i = 0; i < samples; i++) {
        curve[i] = (i * 2) / samples - 1;
      }
      return curve;
    }
    const deg = Math.PI / 180;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  private createImpulseResponse(ctx: BaseAudioContext, decaySeconds: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const duration = Math.max(0.3, Math.min(5.0, decaySeconds));
    const length = Math.floor(rate * duration);
    const impulse = ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, 2.4);
      const earlyBoost = i < rate * 0.04 && i % 180 === 0 ? 1.6 : 1.0;
      left[i] = (Math.random() * 2 - 1) * env * earlyBoost * 0.65;
      right[i] = (Math.random() * 2 - 1) * env * earlyBoost * 0.65;
    }
    return impulse;
  }

  private buildTrackChain(
    ctx: BaseAudioContext,
    destination: AudioNode,
    track: AudioTrack,
    isOffline = false
  ): TrackGraphNodes {
    const input = ctx.createGain();

    const rawDryGain = ctx.createGain();
    rawDryGain.gain.value = 0;

    // Stage 1: Noise Removal
    const rumbleHighpass = ctx.createBiquadFilter();
    rumbleHighpass.type = 'highpass';
    rumbleHighpass.frequency.value = 20;
    rumbleHighpass.Q.value = 0.707;

    const hissLowpass = ctx.createBiquadFilter();
    hissLowpass.type = 'lowpass';
    hissLowpass.frequency.value = 20000;
    hissLowpass.Q.value = 0.707;

    // Stage 2: Voice Softener & Auto-Pitch Formant Focus
    const deEsserFilter = ctx.createBiquadFilter();
    deEsserFilter.type = 'peaking';
    deEsserFilter.frequency.value = 4600;
    deEsserFilter.Q.value = 2.0;
    deEsserFilter.gain.value = 0;

    const harshCutFilter = ctx.createBiquadFilter();
    harshCutFilter.type = 'peaking';
    harshCutFilter.frequency.value = 2900;
    harshCutFilter.Q.value = 1.6;
    harshCutFilter.gain.value = 0;

    const vocalWarmthFilter = ctx.createBiquadFilter();
    vocalWarmthFilter.type = 'peaking';
    vocalWarmthFilter.frequency.value = 230;
    vocalWarmthFilter.Q.value = 1.0;
    vocalWarmthFilter.gain.value = 0;

    const autoPitchFormant = ctx.createBiquadFilter();
    autoPitchFormant.type = 'peaking';
    autoPitchFormant.frequency.value = 2150;
    autoPitchFormant.Q.value = 1.8;
    autoPitchFormant.gain.value = 0;

    // Stage 3: 3-Band Parametric EQ
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = 110;

    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking';

    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf';
    eqHigh.frequency.value = 7500;

    // Stage 4: Tube Saturation & Dynamics Compressor
    const driveShaper = ctx.createWaveShaper();
    driveShaper.oversample = '2x';

    const compressor = ctx.createDynamicsCompressor();

    // Stage 5: Dry & Wet Mix Routing
    const processedDryGain = ctx.createGain();
    processedDryGain.gain.value = 1.0;

    const wetMasterGain = ctx.createGain();
    wetMasterGain.gain.value = 1.0;

    // Stage 6: Stereo Vocal Harmony / Choir Synthesizer
    const harmonyDelayL = ctx.createDelay(0.15);
    harmonyDelayL.delayTime.value = 0.018;
    const harmonyDelayR = ctx.createDelay(0.15);
    harmonyDelayR.delayTime.value = 0.027;

    const harmonyLfoL = ctx.createOscillator();
    harmonyLfoL.type = 'sine';
    harmonyLfoL.frequency.value = 3.2;
    const harmonyLfoGainL = ctx.createGain();
    harmonyLfoGainL.gain.value = 0.002;

    const harmonyLfoR = ctx.createOscillator();
    harmonyLfoR.type = 'sine';
    harmonyLfoR.frequency.value = 4.1;
    const harmonyLfoGainR = ctx.createGain();
    harmonyLfoGainR.gain.value = 0.0025;

    harmonyLfoL.connect(harmonyLfoGainL);
    harmonyLfoGainL.connect(harmonyDelayL.delayTime);
    harmonyLfoR.connect(harmonyLfoGainR);
    harmonyLfoGainR.connect(harmonyDelayR.delayTime);
    harmonyLfoL.start();
    harmonyLfoR.start();

    const harmonyPanL = ctx.createStereoPanner();
    harmonyPanL.pan.value = -0.65;
    const harmonyPanR = ctx.createStereoPanner();
    harmonyPanR.pan.value = 0.65;
    const harmonyWetGain = ctx.createGain();
    harmonyWetGain.gain.value = 0;

    // Stage 7: Stereo Delay & Convolver Reverb
    const delayNode = ctx.createDelay(2.0);
    const delayFeedback = ctx.createGain();
    const delayWet = ctx.createGain();

    const convolver = ctx.createConvolver();
    convolver.buffer = this.createImpulseResponse(ctx, track.effects.reverbDecay);
    const reverbWet = ctx.createGain();

    const sumNode = ctx.createGain();
    const volumeNode = ctx.createGain();
    const pannerNode = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    // Pure raw dry bypass
    input.connect(rawDryGain);
    rawDryGain.connect(sumNode);

    // Core serial chain
    input.connect(rumbleHighpass);
    rumbleHighpass.connect(hissLowpass);
    hissLowpass.connect(deEsserFilter);
    deEsserFilter.connect(harshCutFilter);
    harshCutFilter.connect(vocalWarmthFilter);
    vocalWarmthFilter.connect(autoPitchFormant);
    autoPitchFormant.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(driveShaper);
    driveShaper.connect(compressor);

    // Processed core path
    compressor.connect(processedDryGain);
    processedDryGain.connect(sumNode);

    // Vocal Harmony / Choir path
    compressor.connect(harmonyDelayL);
    compressor.connect(harmonyDelayR);
    harmonyDelayL.connect(harmonyPanL);
    harmonyDelayR.connect(harmonyPanR);
    harmonyPanL.connect(harmonyWetGain);
    harmonyPanR.connect(harmonyWetGain);
    harmonyWetGain.connect(wetMasterGain);

    // Stereo Delay loop -> Wet Master
    compressor.connect(delayNode);
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayNode.connect(delayWet);
    delayWet.connect(wetMasterGain);

    // Reverb send -> Wet Master
    compressor.connect(convolver);
    convolver.connect(reverbWet);
    reverbWet.connect(wetMasterGain);

    wetMasterGain.connect(sumNode);

    // Output strip
    sumNode.connect(volumeNode);
    volumeNode.connect(pannerNode);
    if (!isOffline) {
      pannerNode.connect(analyser);
      analyser.connect(destination);
    } else {
      pannerNode.connect(destination);
    }

    const nodes: TrackGraphNodes = {
      input,
      rawDryGain,
      rumbleHighpass,
      hissLowpass,
      deEsserFilter,
      harshCutFilter,
      vocalWarmthFilter,
      autoPitchFormant,
      eqLow,
      eqMid,
      eqHigh,
      driveShaper,
      compressor,
      processedDryGain,
      wetMasterGain,
      harmonyDelayL,
      harmonyDelayR,
      harmonyLfoL,
      harmonyLfoR,
      harmonyLfoGainL,
      harmonyLfoGainR,
      harmonyPanL,
      harmonyPanR,
      harmonyWetGain,
      delayNode,
      delayFeedback,
      delayWet,
      convolver,
      reverbWet,
      sumNode,
      volumeNode,
      pannerNode,
      analyser,
      currentReverbDecay: track.effects.reverbDecay,
    };

    this.applyEffectsToNodes(ctx, nodes, track.effects);
    return nodes;
  }

  private applyEffectsToNodes(ctx: BaseAudioContext, nodes: TrackGraphNodes, fx: TrackEffects): void {
    const now = ctx.currentTime;

    // Noise Removal
    const nrRatio = Math.max(0, Math.min(1, (fx.noiseRemoval ?? 0) / 100));
    const hpFreq = 20 + nrRatio * 165;
    const lpFreq = 20000 - Math.pow(nrRatio, 0.8) * 15400;
    nodes.rumbleHighpass.frequency.setTargetAtTime(hpFreq, now, 0.015);
    nodes.hissLowpass.frequency.setTargetAtTime(lpFreq, now, 0.015);

    // Voice Softener
    const softRatio = Math.max(0, Math.min(1, (fx.voiceSoftener ?? 0) / 100));
    nodes.deEsserFilter.gain.setTargetAtTime(-softRatio * 14.0, now, 0.015);
    nodes.harshCutFilter.gain.setTargetAtTime(-softRatio * 6.0, now, 0.015);
    nodes.vocalWarmthFilter.gain.setTargetAtTime(softRatio * 5.5, now, 0.015);

    // Auto-Pitch Formant Presence & Sheen
    const pitchRatio = Math.max(0, Math.min(1, (fx.autoPitchAmount ?? 0) / 100));
    nodes.autoPitchFormant.gain.setTargetAtTime(pitchRatio * 5.5, now, 0.015);

    // 3-Band EQ
    nodes.eqLow.gain.setTargetAtTime(fx.eqLowGain, now, 0.015);
    nodes.eqMid.frequency.setTargetAtTime(fx.eqMidFreq, now, 0.015);
    nodes.eqMid.Q.setTargetAtTime(fx.eqMidQ, now, 0.015);
    nodes.eqMid.gain.setTargetAtTime(fx.eqMidGain, now, 0.015);
    nodes.eqHigh.gain.setTargetAtTime(fx.eqHighGain - softRatio * 3.0 + pitchRatio * 2.0, now, 0.015);

    nodes.driveShaper.curve = this.createDistortionCurve(fx.drive);

    if (fx.compEnabled || softRatio > 0.2 || pitchRatio > 0.3) {
      const thresh = fx.compEnabled ? fx.compThreshold : -22 * Math.max(softRatio, pitchRatio);
      const ratio = fx.compEnabled ? fx.compRatio : 1 + Math.max(softRatio, pitchRatio) * 3.5;
      nodes.compressor.threshold.setTargetAtTime(thresh, now, 0.015);
      nodes.compressor.ratio.setTargetAtTime(ratio, now, 0.015);
      nodes.compressor.attack.setTargetAtTime(fx.compAttack, now, 0.015);
      nodes.compressor.release.setTargetAtTime(fx.compRelease, now, 0.015);
    } else {
      nodes.compressor.threshold.setTargetAtTime(0, now, 0.015);
      nodes.compressor.ratio.setTargetAtTime(1, now, 0.015);
    }

    // Dry & Wet Levels
    const dryNorm = Math.max(0, Math.min(1.5, (fx.dryLevel ?? 100) / 100));
    const wetNorm = Math.max(0, Math.min(1.5, (fx.wetLevel ?? 100) / 100));

    const insertBlend = Math.min(1, wetNorm);
    nodes.rawDryGain.gain.setTargetAtTime(dryNorm * (1 - insertBlend), now, 0.015);
    nodes.processedDryGain.gain.setTargetAtTime(dryNorm * insertBlend, now, 0.015);
    nodes.wetMasterGain.gain.setTargetAtTime(wetNorm, now, 0.015);

    // Vocal Harmony / Choir Engine configuration
    const harmRatio = Math.max(0, Math.min(1, (fx.harmonyAmount ?? 0) / 100));
    const mode = fx.harmonyMode || 'choir';
    if (mode === 'doubler') {
      nodes.harmonyDelayL.delayTime.setTargetAtTime(0.014, now, 0.02);
      nodes.harmonyDelayR.delayTime.setTargetAtTime(0.022, now, 0.02);
      nodes.harmonyLfoL.frequency.setTargetAtTime(2.5, now, 0.02);
      nodes.harmonyLfoR.frequency.setTargetAtTime(3.1, now, 0.02);
      nodes.harmonyLfoGainL.gain.setTargetAtTime(0.0012, now, 0.02);
      nodes.harmonyLfoGainR.gain.setTargetAtTime(0.0015, now, 0.02);
    } else if (mode === 'thirds') {
      nodes.harmonyDelayL.delayTime.setTargetAtTime(0.024, now, 0.02);
      nodes.harmonyDelayR.delayTime.setTargetAtTime(0.035, now, 0.02);
      nodes.harmonyLfoL.frequency.setTargetAtTime(5.2, now, 0.02);
      nodes.harmonyLfoR.frequency.setTargetAtTime(6.4, now, 0.02);
      nodes.harmonyLfoGainL.gain.setTargetAtTime(0.0035, now, 0.02);
      nodes.harmonyLfoGainR.gain.setTargetAtTime(0.0042, now, 0.02);
    } else if (mode === 'octave') {
      nodes.harmonyDelayL.delayTime.setTargetAtTime(0.012, now, 0.02);
      nodes.harmonyDelayR.delayTime.setTargetAtTime(0.038, now, 0.02);
      nodes.harmonyLfoL.frequency.setTargetAtTime(6.8, now, 0.02);
      nodes.harmonyLfoR.frequency.setTargetAtTime(7.5, now, 0.02);
      nodes.harmonyLfoGainL.gain.setTargetAtTime(0.0045, now, 0.02);
      nodes.harmonyLfoGainR.gain.setTargetAtTime(0.005, now, 0.02);
    } else {
      // Choir (Lush multi-voice shimmer)
      nodes.harmonyDelayL.delayTime.setTargetAtTime(0.021, now, 0.02);
      nodes.harmonyDelayR.delayTime.setTargetAtTime(0.033, now, 0.02);
      nodes.harmonyLfoL.frequency.setTargetAtTime(3.8, now, 0.02);
      nodes.harmonyLfoR.frequency.setTargetAtTime(4.7, now, 0.02);
      nodes.harmonyLfoGainL.gain.setTargetAtTime(0.0028, now, 0.02);
      nodes.harmonyLfoGainR.gain.setTargetAtTime(0.0034, now, 0.02);
    }

    const totalHarmonyWet = harmRatio * 0.85 + softRatio * 0.12 + Math.max(0, wetNorm - 1) * 0.25;
    nodes.harmonyWetGain.gain.setTargetAtTime(totalHarmonyWet, now, 0.02);

    nodes.delayNode.delayTime.setTargetAtTime(fx.delayTime, now, 0.02);
    nodes.delayFeedback.gain.setTargetAtTime(Math.min(0.88, fx.delayFeedback), now, 0.02);
    nodes.delayWet.gain.setTargetAtTime(fx.delayMix, now, 0.02);

    if (Math.abs(nodes.currentReverbDecay - fx.reverbDecay) > 0.15) {
      nodes.convolver.buffer = this.createImpulseResponse(ctx, fx.reverbDecay);
      nodes.currentReverbDecay = fx.reverbDecay;
    }
    nodes.reverbWet.gain.setTargetAtTime(fx.reverbMix * 1.4, now, 0.02);
  }

  public syncTracks(tracks: AudioTrack[]): void {
    const ctx = this.getContext();
    if (!this.masterGain) return;

    const anySolo = tracks.some((t) => t.solo);
    const activeTrackIds = new Set(tracks.map((t) => t.id));

    for (const [id, nodes] of this.trackNodes.entries()) {
      if (!activeTrackIds.has(id)) {
        nodes.pannerNode.disconnect();
        this.trackNodes.delete(id);
      }
    }

    for (const track of tracks) {
      let nodes = this.trackNodes.get(track.id);
      if (!nodes) {
        nodes = this.buildTrackChain(ctx, this.masterGain, track, false);
        this.trackNodes.set(track.id, nodes);
      }

      const isAudible = anySolo ? track.solo : !track.muted;
      const targetGain = isAudible ? track.volume : 0;

      nodes.volumeNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
      nodes.pannerNode.pan.setTargetAtTime(track.pan, ctx.currentTime, 0.015);
      this.applyEffectsToNodes(ctx, nodes, track.effects);
    }
  }

  /* --------------------------------- transport -------------------------------- */
  /*
   * Lookahead scheduler: a 25 ms timer schedules loop iterations and metronome clicks on the
   * AudioContext clock slightly ahead of time, so loops are seamless and clicks sample-accurate
   * (instead of restarting playback from a requestAnimationFrame callback).
   */

  /** Segment k of the current playback: timeline [from, to) starting at context time ctxStart. */
  private segmentAt(k: number): { ctxStart: number; from: number; to: number } | null {
    const t = this.transport;
    if (!t) return null;
    if (!t.loop) {
      return k === 0 ? { ctxStart: t.startCtx, from: t.fromTime, to: Infinity } : null;
    }
    const len = t.loop.end - t.loop.start;
    if (k === 0) return { ctxStart: t.startCtx, from: t.fromTime, to: t.loop.end };
    return {
      ctxStart: t.startCtx + (t.loop.end - t.fromTime) + (k - 1) * len,
      from: t.loop.start,
      to: t.loop.end,
    };
  }

  private lookaheadSec(): number {
    // Background tabs throttle timers to ~1 s: schedule further ahead there
    return typeof document !== 'undefined' && document.hidden ? 1.6 : 0.3;
  }

  /** Effective buffer read rate (speed x any legacy, not-yet-rendered detune). */
  private clipRate(clip: AudioClip): number {
    const residual = clip.pitchSemitones - (clip.renderedPitch ?? 0);
    return clip.playbackRate * Math.pow(2, residual / 12);
  }

  private scheduleSegment(seg: { ctxStart: number; from: number; to: number }): void {
    const t = this.transport;
    const ctx = this.ctx;
    if (!t || !ctx) return;
    const MICRO_FADE = 0.004;
    const toCtx = (tl: number) => seg.ctxStart + (tl - seg.from);

    for (const clip of t.clips) {
      const buffer = this.buffers.get(clip.bufferId);
      const trackGraph = this.trackNodes.get(clip.trackId);
      if (!buffer || !trackGraph) continue;

      const clipEnd = clip.startTime + clip.duration;
      const a = Math.max(clip.startTime, seg.from);
      const b = Math.min(clipEnd, seg.to);
      if (b - a <= 0.002) continue;

      const rate = this.clipRate(clip);
      const bufferOffset = clip.offset + (a - clip.startTime) * rate;
      if (bufferOffset >= buffer.duration) continue;
      const bufferDuration = (b - a) * rate;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      const gainNode = ctx.createGain();
      source.connect(gainNode);
      gainNode.connect(trackGraph.input);

      const when = toCtx(a);
      const endAt = toCtx(b);
      const g = gainNode.gain;
      const base = clip.gain;
      const fadeInEnd = clip.startTime + clip.fadeIn;
      const fadeOutStart = clipEnd - clip.fadeOut;

      // Start: clip fade-in, or a micro fade when entering mid-clip (loop restart / seek)
      if (clip.fadeIn > 0.01 && a < fadeInEnd) {
        g.setValueAtTime(Math.max(0.0001, base * ((a - clip.startTime) / clip.fadeIn)), when);
        g.linearRampToValueAtTime(base, toCtx(Math.min(fadeInEnd, b)));
      } else if (a > clip.startTime + 0.001) {
        g.setValueAtTime(0.0001, when);
        g.linearRampToValueAtTime(base, when + MICRO_FADE);
      } else {
        g.setValueAtTime(base, when);
      }

      // End: clip fade-out, or a micro fade when the segment cuts the clip (loop end)
      if (clip.fadeOut > 0.01 && b > fadeOutStart) {
        const fadeStartTl = Math.max(a, fadeOutStart);
        g.setValueAtTime(base, toCtx(fadeStartTl));
        const endGain = b >= clipEnd - 0.001 ? 0.0001 : base * ((clipEnd - b) / clip.fadeOut);
        g.linearRampToValueAtTime(Math.max(0.0001, endGain), endAt);
      } else if (b < clipEnd - 0.001 && endAt - MICRO_FADE > when) {
        g.setValueAtTime(base, endAt - MICRO_FADE);
        g.linearRampToValueAtTime(0.0001, endAt);
      }

      source.start(when, bufferOffset, bufferDuration);
      this.activeSources.add(source);
      const list = this.activeClipNodes.get(clip.id) ?? [];
      const node: ActiveClipNode = { source, clipGainNode: gainNode, clip };
      list.push(node);
      this.activeClipNodes.set(clip.id, list);
      source.onended = () => {
        this.activeSources.delete(source);
        const l = this.activeClipNodes.get(clip.id);
        if (l) {
          const idx = l.indexOf(node);
          if (idx >= 0) l.splice(idx, 1);
          if (l.length === 0) this.activeClipNodes.delete(clip.id);
        }
      };
    }
  }

  private scheduleMetronome(fromCtx: number, toCtx: number): void {
    const t = this.transport;
    if (!t || !this.metronomeEnabled || toCtx <= fromCtx) return;
    const beatLen = 60 / Math.max(40, Math.min(240, this.currentBpm));
    // Jump straight to the loop iteration containing `fromCtx` (no scan from the start)
    let firstK = 0;
    if (t.loop) {
      const first = t.loop.end - t.fromTime;
      const elapsed = fromCtx - t.startCtx;
      if (elapsed > first) {
        firstK = 1 + Math.floor((elapsed - first) / (t.loop.end - t.loop.start));
      }
    }
    for (let k = firstK; ; k++) {
      const seg = this.segmentAt(k);
      if (!seg || seg.ctxStart >= toCtx) break;
      const segEndCtx = seg.ctxStart + (seg.to - seg.from);
      if (segEndCtx <= fromCtx) continue;
      const tl0 = seg.from + Math.max(0, fromCtx - seg.ctxStart);
      const tl1 = Math.min(seg.to, seg.from + (toCtx - seg.ctxStart));
      for (let beat = Math.ceil(tl0 / beatLen - 1e-6); beat * beatLen < tl1; beat++) {
        this.playClickSound(beat % 4 === 0, seg.ctxStart + (beat * beatLen - seg.from));
      }
    }
  }

  private schedulerTick = (): void => {
    const t = this.transport;
    const ctx = this.ctx;
    if (!t || !ctx || !this.isPlaying) return;
    const horizon = ctx.currentTime + this.lookaheadSec();

    for (;;) {
      const seg = this.segmentAt(t.nextSegment);
      if (!seg || seg.ctxStart >= horizon) break;
      this.scheduleSegment(seg);
      t.nextSegment++;
    }

    const metroFrom = Math.max(t.metroUntil, ctx.currentTime);
    this.scheduleMetronome(metroFrom, horizon);
    t.metroUntil = Math.max(t.metroUntil, horizon);
  };

  /**
   * Starts playback at timeline `fromTime`. With `loop`, the region repeats seamlessly.
   * `startAtCtx` schedules the start on the context clock (used after a count-in).
   */
  public play(
    tracks: AudioTrack[],
    clips: AudioClip[],
    fromTime: number,
    loop?: { start: number; end: number } | null,
    options: { bpm?: number; startAtCtx?: number } = {}
  ): void {
    this.stop();
    if (options.bpm) this.currentBpm = options.bpm;
    const ctx = this.getContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    this.syncTracks(tracks);

    const loopActive =
      loop && loop.end - loop.start > 0.1 && fromTime < loop.end ? { ...loop } : null;
    // Small headroom so the first notes are never scheduled in the past
    const startCtx = Math.max(options.startAtCtx ?? 0, ctx.currentTime + 0.03);

    this.transport = {
      tracks,
      clips,
      fromTime,
      startCtx,
      loop: loopActive,
      nextSegment: 0,
      metroUntil: startCtx - 0.001,
    };
    this.isPlaying = true;
    if (this.capture && this.recordingAnchorCtxTime === null) {
      // Timeline position `fromTime` of the take being recorded plays at this context time
      this.recordingAnchorCtxTime = startCtx;
    }

    this.schedulerTick();
    this.schedulerTimer = window.setInterval(this.schedulerTick, 25);
  }

  public stop(): void {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {}
    }
    this.activeSources.clear();
    this.activeClipNodes.clear();
    this.stopScheduledClicks();
    if (this.transport) {
      this.transport.fromTime = this.getTimelinePosition();
    }
    this.isPlaying = false;
  }

  /** Current timeline position in seconds (sample-accurate, wraps inside the loop). */
  public getTimelinePosition(): number {
    const t = this.transport;
    if (!t) return 0;
    if (!this.isPlaying || !this.ctx) return t.fromTime;
    const elapsed = this.ctx.currentTime - t.startCtx;
    if (elapsed <= 0) return t.fromTime;
    if (!t.loop) return t.fromTime + elapsed;
    const first = t.loop.end - t.fromTime;
    if (elapsed < first) return t.fromTime + elapsed;
    return t.loop.start + ((elapsed - first) % (t.loop.end - t.loop.start));
  }

  /** Playhead for the UI; stops at `totalDuration` when not looping. */
  public getCurrentPlayhead(totalDuration: number): { time: number; ended: boolean } {
    const time = this.getTimelinePosition();
    if (this.isPlaying && this.transport && !this.transport.loop && time >= totalDuration) {
      this.stop();
      return { time: 0, ended: true };
    }
    return { time, ended: false };
  }

  /** Changes the loop region during playback without interrupting audio already playing. */
  public updateLoop(loop: { start: number; end: number } | null): void {
    const t = this.transport;
    if (!t || !this.isPlaying) return;
    let next = loop && loop.end - loop.start > 0.1 ? loop : null;
    // Playing past the loop end: the loop only applies after the next seek/restart
    if (next && !t.loop && this.getTimelinePosition() >= next.end) next = null;
    const same =
      (next === null && t.loop === null) ||
      (next !== null && t.loop !== null && next.start === t.loop.start && next.end === t.loop.end);
    if (same) return;
    this.play(t.tracks, t.clips, this.getTimelinePosition(), next);
  }

  /** Pushes edited clips into running playback (reschedules only when timing/audio changed). */
  public syncClipsLive(tracks: AudioTrack[], clips: AudioClip[]): void {
    const t = this.transport;
    if (!this.isPlaying || !t || !this.ctx) return;

    const prevById = new Map(t.clips.map((c) => [c.id, c]));
    let needsReschedule = prevById.size !== clips.length;
    if (!needsReschedule) {
      for (const clip of clips) {
        const prev = prevById.get(clip.id);
        if (
          !prev ||
          prev.bufferId !== clip.bufferId ||
          prev.trackId !== clip.trackId ||
          prev.pitchSemitones !== clip.pitchSemitones ||
          (prev.renderedPitch ?? 0) !== (clip.renderedPitch ?? 0) ||
          Math.abs(prev.startTime - clip.startTime) > 0.001 ||
          Math.abs(prev.offset - clip.offset) > 0.001 ||
          Math.abs(prev.duration - clip.duration) > 0.001 ||
          Math.abs(prev.playbackRate - clip.playbackRate) > 0.001 ||
          Math.abs(prev.fadeIn - clip.fadeIn) > 0.001 ||
          Math.abs(prev.fadeOut - clip.fadeOut) > 0.001
        ) {
          needsReschedule = true;
          break;
        }
      }
    }

    if (needsReschedule) {
      this.play(tracks, clips, this.getTimelinePosition(), t.loop);
      return;
    }

    // Gain-only edits: glide sounding sources, future segments pick up the new clip values
    const now = this.ctx.currentTime;
    for (const clip of clips) {
      for (const active of this.activeClipNodes.get(clip.id) ?? []) {
        active.clipGainNode.gain.cancelScheduledValues(now);
        active.clipGainNode.gain.setTargetAtTime(clip.gain, now, 0.015);
        active.clip = clip;
      }
    }
    t.clips = clips;
    t.tracks = tracks;
  }

  public getFrequencyData(targetArray: Uint8Array): void {
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteFrequencyData(targetArray);
    }
  }

  public getTimeDomainData(targetArray: Uint8Array): void {
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteTimeDomainData(targetArray);
    }
  }

  public getMeterLevels(): MeterLevels {
    if (!this.leftAnalyser || !this.rightAnalyser) {
      return {
        masterLeft: 0,
        masterRight: 0,
        masterPeakDb: -60,
        masterRmsDb: -60,
        phaseCorrelation: 1,
        trackLevels: {},
      };
    }

    const leftBuf = new Float32Array(this.leftAnalyser.fftSize);
    const rightBuf = new Float32Array(this.rightAnalyser.fftSize);
    this.leftAnalyser.getFloatTimeDomainData(leftBuf);
    this.rightAnalyser.getFloatTimeDomainData(rightBuf);

    let peakL = 0;
    let peakR = 0;
    let sumSq = 0;
    let dotLR = 0;
    let magL = 0;
    let magR = 0;

    for (let i = 0; i < leftBuf.length; i++) {
      const l = leftBuf[i];
      const r = rightBuf[i];
      const absL = Math.abs(l);
      const absR = Math.abs(r);
      if (absL > peakL) peakL = absL;
      if (absR > peakR) peakR = absR;
      sumSq += (l * l + r * r) * 0.5;
      dotLR += l * r;
      magL += l * l;
      magR += r * r;
    }

    const rms = Math.sqrt(sumSq / leftBuf.length);
    const maxPeak = Math.max(peakL, peakR, 0.0001);
    const masterPeakDb = Math.max(-60, 20 * Math.log10(maxPeak));
    const masterRmsDb = Math.max(-60, 20 * Math.log10(Math.max(rms, 0.0001)));

    const denom = Math.sqrt(magL * magR);
    const phaseCorrelation = denom > 0.00001 ? Math.max(-1, Math.min(1, dotLR / denom)) : 1;

    const trackLevels: Record<string, number> = {};
    const tempBuf = new Float32Array(256);
    for (const [trackId, nodes] of this.trackNodes.entries()) {
      nodes.analyser.getFloatTimeDomainData(tempBuf);
      let pk = 0;
      for (let i = 0; i < tempBuf.length; i++) {
        const a = Math.abs(tempBuf[i]);
        if (a > pk) pk = a;
      }
      trackLevels[trackId] = Math.min(1, pk);
    }

    return {
      masterLeft: Math.min(1, peakL),
      masterRight: Math.min(1, peakR),
      masterPeakDb,
      masterRmsDb,
      phaseCorrelation,
      trackLevels,
    };
  }

  /**
   * Detects the fundamental frequency (f0) of a short mono vocal window via autocorrelation
   */
  /* ------------------------------ clip rendering ------------------------------ */

  private getClipWorker(): Worker | null {
    if (this.clipWorker === undefined) {
      try {
        this.clipWorker = new Worker(new URL('./dsp/clipWorker.ts', import.meta.url), {
          type: 'module',
        });
        this.clipWorker.onmessage = (e: MessageEvent) => {
          const msg = e.data as { id: number; channels?: Float32Array[]; error?: string };
          const pending = this.clipJobs.get(msg.id);
          if (!pending) return;
          this.clipJobs.delete(msg.id);
          if (msg.channels) pending.resolve(msg.channels);
          else pending.reject(new Error(msg.error || 'Clip render failed'));
        };
        this.clipWorker.onerror = () => {
          // Worker crashed / unsupported: fail pending jobs and fall back to inline rendering
          this.clipJobs.forEach((j) => j.reject(new Error('Clip worker failed')));
          this.clipJobs.clear();
          this.clipWorker?.terminate();
          this.clipWorker = null;
        };
      } catch {
        this.clipWorker = null;
      }
    }
    return this.clipWorker;
  }

  private runClipJob(request: ClipRenderRequest): Promise<Float32Array[]> {
    const worker = this.getClipWorker();
    if (!worker) return Promise.resolve(renderClipChannels(request));
    const id = ++this.clipJobSeq;
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.clipJobs.set(id, { resolve, reject });
      worker.postMessage(
        { id, request },
        request.channels.map((c) => c.buffer as ArrayBuffer)
      );
    }).catch(() => renderClipChannels(request));
  }

  /**
   * Non-destructive clip render: starts from the clip's untouched source buffer, applies the
   * duration-preserving pitch shift and all clip processes (within the selected region) in a Web
   * Worker, and registers the result. Returns the new buffer id, or the source id when nothing
   * needs processing.
   */
  public async renderClip(params: {
    clipId: string;
    sourceBufferId: string;
    /** Region the processes apply to, in source-buffer seconds */
    regionStartSec: number;
    regionEndSec: number;
    processes: ClipProcessSettings;
    scaleId: VocalScale;
    pitchSemitones: number;
  }): Promise<string | null> {
    const src = this.buffers.get(params.sourceBufferId);
    if (!src) return null;
    if (isDefaultProcesses(params.processes) && Math.abs(params.pitchSemitones) < 0.01) {
      return params.sourceBufferId;
    }

    const scale = VOCAL_SCALES.find((s) => s.id === params.scaleId) || VOCAL_SCALES[0];
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      channels.push(new Float32Array(src.getChannelData(ch)));
    }

    const out = await this.runClipJob({
      channels,
      sampleRate: src.sampleRate,
      startSample: Math.floor(params.regionStartSec * src.sampleRate),
      endSample: Math.floor(params.regionEndSec * src.sampleRate),
      processes: params.processes,
      scaleSemitones: scale.semitones,
      pitchSemitones: params.pitchSemitones,
    });

    const ctx = this.getContext();
    const rendered = ctx.createBuffer(out.length, out[0].length, src.sampleRate);
    out.forEach((d, ch) => rendered.copyToChannel(d, ch));
    const procBufferId = `proc_${params.clipId}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    this.registerBuffer(procBufferId, rendered, true);
    return procBufferId;
  }

  /** Destructively silences a region of a buffer (in buffer seconds). Returns the new buffer id. */
  public silenceRegion(bufferId: string, startSec: number, endSec: number): string | null {
    const src = this.buffers.get(bufferId);
    if (!src) return null;
    const startSample = Math.max(0, Math.floor(startSec * src.sampleRate));
    const endSample = Math.min(src.length, Math.floor(endSec * src.sampleRate));
    if (endSample - startSample <= 1) return null;

    const ctx = this.getContext();
    const clone = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      const data = new Float32Array(src.getChannelData(ch));
      data.fill(0, startSample, endSample);
      clone.copyToChannel(data, ch);
    }
    const newBufferId = `buf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.registerBuffer(newBufferId, clone, true);
    return newBufferId;
  }

  /** Buffer ids registered in the last `withinMs` (may not be referenced by saved state yet). */
  public getRecentBufferIds(withinMs = 120_000): string[] {
    const cutoff = Date.now() - withinMs;
    const ids: string[] = [];
    this.bufferRegisteredAt.forEach((t, id) => {
      if (t >= cutoff) ids.push(id);
    });
    return ids;
  }

  public async startMicRecording(monitorTrackId?: string): Promise<void> {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const inputLatency = (
      this.mediaStream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number }
    )?.latency;
    this.lastInputLatencySec = typeof inputLatency === 'number' ? inputLatency : 0;

    this.micSourceNode = ctx.createMediaStreamSource(this.mediaStream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 256;
    this.micSourceNode.connect(this.micAnalyser);

    // Live Mic Monitoring through the selected track's FX chain if enabled
    this.micMonitorGain = ctx.createGain();
    this.micMonitorGain.gain.value = 0;
    this.micSourceNode.connect(this.micMonitorGain);
    if (this.micMonitorEnabled && monitorTrackId) {
      this.setMicMonitorEnabled(true, monitorTrackId);
    }

    this.recordingAnchorCtxTime = null;

    // Preferred: lossless, sample-accurate capture inside the audio graph
    if (typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet) {
      try {
        this.capture = await this.startCapture(ctx, this.micSourceNode);
        await Promise.race([this.capture.started, new Promise((r) => window.setTimeout(r, 500))]);
        return;
      } catch (err) {
        console.warn('AudioWorklet capture unavailable, falling back to MediaRecorder', err);
        this.capture = null;
      }
    }

    this.recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : '';
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.mediaStream, { mimeType })
      : new MediaRecorder(this.mediaStream);

    this.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) {
        this.recordedChunks.push(ev.data);
      }
    };
    this.mediaRecorder.start(80);
  }

  public getMicInputLevel(): number {
    if (!this.micAnalyser) return 0;
    const buf = new Float32Array(this.micAnalyser.fftSize);
    this.micAnalyser.getFloatTimeDomainData(buf);
    let max = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > max) max = a;
    }
    return Math.min(1, max);
  }

  private releaseMic(): void {
    if (this.micMonitorGain) {
      try {
        this.micMonitorGain.disconnect();
      } catch {}
      this.micMonitorGain = null;
    }
    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch {}
      this.micSourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.micAnalyser = null;
    this.mediaRecorder = null;
    this.capture = null;
    this.recordingAnchorCtxTime = null;
  }

  /** Gentle auto-gain so quiet takes land at a usable level (in place). */
  private autoLevelTake(audioBuffer: AudioBuffer): void {
    let maxPeak = 0.001;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const d = audioBuffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > maxPeak) maxPeak = a;
      }
    }
    if (maxPeak > 0.01 && maxPeak < 0.5) {
      const boost = Math.min(4.0, 0.75 / maxPeak);
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const d = audioBuffer.getChannelData(ch);
        for (let i = 0; i < d.length; i++) d[i] *= boost;
      }
    }
  }

  /**
   * Builds a take buffer aligned to the timeline: drops the samples captured before the backing
   * track started plus the round-trip latency, so what the singer heard and sang line up.
   */
  private buildAlignedTake(
    ctx: AudioContext,
    data: Float32Array,
    trimSec: number
  ): AudioBuffer | null {
    const trim = Math.round(trimSec * ctx.sampleRate);
    const length = data.length - trim;
    if (length < ctx.sampleRate * 0.05) return null;
    const buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const out = buf.getChannelData(0);
    if (trim >= 0) {
      out.set(data.subarray(trim));
    } else {
      out.set(data, -trim); // capture started after the anchor: pad the front with silence
    }
    return buf;
  }

  /** Stops the microphone and discards the take (e.g. count-in cancelled). */
  public async cancelMicRecording(): Promise<void> {
    this.cancelCountIn();
    try {
      if (this.capture) await this.capture.stop();
      else if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.onstop = null;
        this.mediaRecorder.stop();
      }
    } catch {
      // Ignore
    } finally {
      this.releaseMic();
    }
  }

  public async stopMicRecording(): Promise<{ bufferId: string; buffer: AudioBuffer } | null> {
    const ctx = this.getContext();
    const latencySec = this.getRecordingLatencySec();

    if (this.capture) {
      const session = this.capture;
      const anchor = this.recordingAnchorCtxTime;
      try {
        const { startTime, data } = await session.stop();
        const trimSec = (anchor ?? startTime) - startTime + latencySec;
        const audioBuffer = this.buildAlignedTake(ctx, data, trimSec);
        if (!audioBuffer) return null;
        this.autoLevelTake(audioBuffer);
        const bufferId = `mic_${Date.now()}`;
        this.registerBuffer(bufferId, audioBuffer, true);
        return { bufferId, buffer: audioBuffer };
      } catch {
        return null;
      } finally {
        this.releaseMic();
      }
    }

    if (!this.mediaRecorder) return null;

    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        resolve(null);
        return;
      }
      const recMime = this.mediaRecorder.mimeType || 'audio/webm';
      this.mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(this.recordedChunks, { type: recMime });
          const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
          // MediaRecorder has no timestamps; compensate the round-trip latency only
          const audioBuffer =
            this.buildAlignedTake(ctx, decoded.getChannelData(0), latencySec) ?? decoded;
          this.autoLevelTake(audioBuffer);
          const bufferId = `mic_${Date.now()}`;
          this.registerBuffer(bufferId, audioBuffer, true);
          resolve({ bufferId, buffer: audioBuffer });
        } catch {
          resolve(null);
        } finally {
          this.releaseMic();
        }
      };
      this.mediaRecorder.stop();
    });
  }

  public async exportMixdownWav(
    tracks: AudioTrack[],
    clips: AudioClip[],
    masterVolume: number
  ): Promise<Blob> {
    return this.encodeWavFromAudioBuffer(await this.renderMixdown(tracks, clips, masterVolume));
  }

  /**
   * Renders the project through the master chain, then normalizes it to the target loudness and
   * true-peak limits it. Used for export and for the "Analyze loudness" preview.
   */
  public async renderMasteredMixdown(
    tracks: AudioTrack[],
    clips: AudioClip[],
    masterVolume: number,
    master: MasterSettings
  ): Promise<{ buffer: AudioBuffer; report: LoudnessReport }> {
    const raw = await this.renderMixdown(tracks, clips, masterVolume, master);
    return masterBuffer(raw, master);
  }

  /** Renders the whole project offline and returns the mixed stereo AudioBuffer. */
  public async renderMixdown(
    tracks: AudioTrack[],
    clips: AudioClip[],
    masterVolume: number,
    master?: MasterSettings
  ): Promise<AudioBuffer> {
    const maxEnd =
      clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 4.0) + 1.5;
    const sampleRate = 44100;
    const offlineCtx = new OfflineAudioContext(2, Math.ceil(maxEnd * sampleRate), sampleRate);

    const masterOut = offlineCtx.createGain();
    masterOut.gain.value = masterVolume;
    if (master && master.preset !== 'off') {
      // Glue / tone / width stages; loudness + limiting happen afterwards in masterBuffer()
      const chain = createMasterChain(offlineCtx, false);
      applyMasterChain(offlineCtx, chain, master, 0, true);
      masterOut.connect(chain.input);
      chain.output.connect(offlineCtx.destination);
    } else {
      masterOut.connect(offlineCtx.destination);
    }

    const anySolo = tracks.some((t) => t.solo);
    const offlineTrackNodes = new Map<string, TrackGraphNodes>();

    for (const track of tracks) {
      const nodes = this.buildTrackChain(offlineCtx, masterOut, track, true);
      const isAudible = anySolo ? track.solo : !track.muted;
      nodes.volumeNode.gain.value = isAudible ? track.volume : 0;
      nodes.pannerNode.pan.value = track.pan;
      offlineTrackNodes.set(track.id, nodes);
    }

    for (const clip of clips) {
      const buffer = this.buffers.get(clip.bufferId);
      const trackGraph = offlineTrackNodes.get(clip.trackId);
      if (!buffer || !trackGraph) continue;

      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;
      // Pitch is rendered into the buffer; only legacy clips carry a residual rate change
      const rate = this.clipRate(clip);
      source.playbackRate.value = rate;

      const clipGain = offlineCtx.createGain();
      clipGain.gain.setValueAtTime(clip.gain, clip.startTime);

      if (clip.fadeIn > 0.01) {
        clipGain.gain.setValueAtTime(0.0001, clip.startTime);
        clipGain.gain.linearRampToValueAtTime(clip.gain, clip.startTime + clip.fadeIn);
      }
      if (clip.fadeOut > 0.01) {
        const fadeOutStart = Math.max(
          clip.startTime,
          clip.startTime + clip.duration - clip.fadeOut
        );
        clipGain.gain.setValueAtTime(clip.gain, fadeOutStart);
        clipGain.gain.linearRampToValueAtTime(0.0001, clip.startTime + clip.duration);
      }

      source.connect(clipGain);
      clipGain.connect(trackGraph.input);
      source.start(clip.startTime, clip.offset, clip.duration * rate);
    }

    return offlineCtx.startRendering();
  }

  private encodeWavFromAudioBuffer(buffer: AudioBuffer): Blob {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const out = new ArrayBuffer(length);
    const view = new DataView(out);
    const channels: Float32Array[] = [];
    let offset = 0;

    const writeString = (str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
      offset += str.length;
    };

    writeString('RIFF');
    view.setUint32(offset, length - 8, true);
    offset += 4;
    writeString('WAVE');
    writeString('fmt ');
    view.setUint32(offset, 16, true);
    offset += 4;
    view.setUint16(offset, 1, true);
    offset += 2;
    view.setUint16(offset, numOfChan, true);
    offset += 2;
    view.setUint32(offset, buffer.sampleRate, true);
    offset += 4;
    view.setUint32(offset, buffer.sampleRate * 2 * numOfChan, true);
    offset += 4;
    view.setUint16(offset, numOfChan * 2, true);
    offset += 2;
    view.setUint16(offset, 16, true);
    offset += 2;
    writeString('data');
    view.setUint32(offset, length - offset - 4, true);
    offset += 4;

    for (let i = 0; i < numOfChan; i++) {
      channels.push(buffer.getChannelData(i));
    }

    let sampleIdx = 0;
    while (sampleIdx < buffer.length) {
      for (let ch = 0; ch < numOfChan; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][sampleIdx]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
      sampleIdx++;
    }

    return new Blob([out], { type: 'audio/wav' });
  }
}

export const audioEngine = new StudioAudioEngine();
