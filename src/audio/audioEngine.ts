import {
  AudioClip,
  AudioTrack,
  BufferOperationType,
  ClipProcessSettings,
  LoopRegion,
  MeterLevels,
  TrackEffects,
  VocalScale,
} from '../types/audio';
import { VOCAL_SCALES } from './presets';
import { saveBufferToStorage } from '../utils/projectStorage';

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

export class StudioAudioEngine {
  private ctx: AudioContext | null = null;
  private buffers: Map<string, AudioBuffer> = new Map();
  private trackNodes: Map<string, TrackGraphNodes> = new Map();
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private activeClipNodes: Map<string, ActiveClipNode> = new Map();

  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private leftAnalyser: AnalyserNode | null = null;
  private rightAnalyser: AnalyserNode | null = null;

  private isPlaying = false;
  private playStartContextTime = 0;
  private playStartOffset = 0;
  private currentMaxEndTime: number | undefined = undefined;

  // Metronome state
  private metronomeEnabled = false;
  private metronomeTimer: number | null = null;
  private currentBpm = 120;

  // Microphone recording & live FX monitoring state
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private micAnalyser: AnalyserNode | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micMonitorGain: GainNode | null = null;
  private micMonitorEnabled = false;

  public getContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1.0;

      this.masterLimiter = this.ctx.createDynamicsCompressor();
      this.masterLimiter.threshold.value = -1.0;
      this.masterLimiter.knee.value = 0.0;
      this.masterLimiter.ratio.value = 20.0;
      this.masterLimiter.attack.value = 0.002;
      this.masterLimiter.release.value = 0.08;

      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 2048;
      this.masterAnalyser.smoothingTimeConstant = 0.82;

      this.splitter = this.ctx.createChannelSplitter(2);
      this.leftAnalyser = this.ctx.createAnalyser();
      this.leftAnalyser.fftSize = 512;
      this.rightAnalyser = this.ctx.createAnalyser();
      this.rightAnalyser.fftSize = 512;

      this.masterGain.connect(this.masterLimiter);
      this.masterLimiter.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);

      this.masterLimiter.connect(this.splitter);
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

  public setMetronome(enabled: boolean, bpm?: number): void {
    this.metronomeEnabled = enabled;
    if (typeof bpm === 'number' && bpm > 0) {
      this.currentBpm = bpm;
    }
    if (this.metronomeTimer !== null) {
      window.clearInterval(this.metronomeTimer);
      this.metronomeTimer = null;
    }
    if (enabled && this.isPlaying) {
      const beatMs = (60 / Math.max(40, Math.min(240, this.currentBpm))) * 1000;
      let beatCount = 0;
      this.playClickSound(true);
      this.metronomeTimer = window.setInterval(() => {
        beatCount = (beatCount + 1) % 4;
        this.playClickSound(beatCount === 0);
      }, beatMs);
    }
  }

  /**
   * Plays a crisp studio woodblock/metronome click immediately.
   */
  public playClickSound(isDownbeat: boolean): void {
    const ctx = this.getContext();
    if (!this.masterGain) return;
    const now = ctx.currentTime;

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

  public syncClipsLive(tracks: AudioTrack[], clips: AudioClip[]): void {
    if (!this.isPlaying || !this.ctx) return;

    const now = this.ctx.currentTime;
    const currentPlayhead = this.playStartOffset + (now - this.playStartContextTime);

    let needsReschedule = false;
    const incomingIds = new Set(clips.map((c) => c.id));

    for (const [id] of this.activeClipNodes.entries()) {
      if (!incomingIds.has(id)) {
        needsReschedule = true;
        break;
      }
    }

    if (!needsReschedule) {
      for (const clip of clips) {
        const active = this.activeClipNodes.get(clip.id);
        const clipEnd = clip.startTime + clip.duration;
        if (clipEnd <= currentPlayhead) continue;

        if (!active) {
          needsReschedule = true;
          break;
        }
        const prev = active.clip;
        if (
          prev.bufferId !== clip.bufferId ||
          prev.trackId !== clip.trackId ||
          Math.abs(prev.startTime - clip.startTime) > 0.01 ||
          Math.abs(prev.offset - clip.offset) > 0.01 ||
          Math.abs(prev.duration - clip.duration) > 0.01 ||
          Math.abs(prev.playbackRate - clip.playbackRate) > 0.01
        ) {
          needsReschedule = true;
          break;
        }
      }
    }

    if (needsReschedule) {
      this.play(tracks, clips, currentPlayhead, this.currentMaxEndTime);
      return;
    }

    for (const clip of clips) {
      const active = this.activeClipNodes.get(clip.id);
      if (!active) continue;
      active.source.detune.setTargetAtTime(clip.pitchSemitones * 100, now, 0.015);
      active.clipGainNode.gain.setTargetAtTime(clip.gain, now, 0.015);
      active.clip = clip;
    }
  }

  public play(
    tracks: AudioTrack[],
    clips: AudioClip[],
    fromTime: number,
    maxEndTime?: number,
    bpm = this.currentBpm
  ): void {
    this.stop();
    this.currentBpm = bpm;
    const ctx = this.getContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    this.syncTracks(tracks);

    this.isPlaying = true;
    this.playStartContextTime = ctx.currentTime;
    this.playStartOffset = fromTime;
    this.currentMaxEndTime = maxEndTime;

    // Start Metronome Click Loop if enabled
    if (this.metronomeEnabled) {
      const beatMs = (60 / bpm) * 1000;
      let beatCount = Math.floor(fromTime / (60 / bpm));
      this.playClickSound(beatCount % 4 === 0);
      this.metronomeTimer = window.setInterval(() => {
        if (!this.isPlaying || !this.metronomeEnabled) return;
        beatCount++;
        this.playClickSound(beatCount % 4 === 0);
      }, beatMs);
    }

    for (const clip of clips) {
      const buffer = this.buffers.get(clip.bufferId);
      const trackGraph = this.trackNodes.get(clip.trackId);
      if (!buffer || !trackGraph) continue;

      const clipStart = clip.startTime;
      const clipEnd =
        maxEndTime !== undefined
          ? Math.min(clip.startTime + clip.duration, maxEndTime)
          : clip.startTime + clip.duration;

      if (clipEnd <= fromTime) continue;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = clip.playbackRate;
      source.detune.value = clip.pitchSemitones * 100;

      const clipGainNode = ctx.createGain();
      source.connect(clipGainNode);
      clipGainNode.connect(trackGraph.input);

      const whenDelay = Math.max(0, clipStart - fromTime);
      const skippedTimelineTime = Math.max(0, fromTime - clipStart);
      const playDurationTimeline = clipEnd - Math.max(clipStart, fromTime);
      if (playDurationTimeline <= 0.002) continue;

      const bufferOffset = clip.offset + skippedTimelineTime * clip.playbackRate;
      const bufferDuration = playDurationTimeline * clip.playbackRate;

      if (bufferOffset >= buffer.duration) continue;

      const absStart = ctx.currentTime + whenDelay;
      const absEnd = absStart + playDurationTimeline;

      const baseGain = clip.gain;
      clipGainNode.gain.setValueAtTime(baseGain, absStart);

      if (clip.fadeIn > 0.01 && skippedTimelineTime < clip.fadeIn) {
        const startRatio = skippedTimelineTime / clip.fadeIn;
        clipGainNode.gain.setValueAtTime(Math.max(0.0001, baseGain * startRatio), absStart);
        clipGainNode.gain.linearRampToValueAtTime(
          baseGain,
          absStart + (clip.fadeIn - skippedTimelineTime)
        );
      }

      if (clip.fadeOut > 0.01) {
        const fadeOutStartTimeline = clip.startTime + clip.duration - clip.fadeOut;
        const fadeOutStartAbs = ctx.currentTime + Math.max(0, fadeOutStartTimeline - fromTime);
        if (fadeOutStartAbs < absEnd) {
          clipGainNode.gain.setValueAtTime(baseGain, Math.max(absStart, fadeOutStartAbs));
          clipGainNode.gain.linearRampToValueAtTime(
            0.0001,
            clipStart + clip.duration - fromTime + ctx.currentTime
          );
        }
      }

      source.start(absStart, bufferOffset, bufferDuration);
      this.activeSources.add(source);
      this.activeClipNodes.set(clip.id, { source, clipGainNode, clip });
      source.onended = () => {
        this.activeSources.delete(source);
      };
    }
  }

  public stop(): void {
    if (this.metronomeTimer !== null) {
      window.clearInterval(this.metronomeTimer);
      this.metronomeTimer = null;
    }
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {}
    }
    this.activeSources.clear();
    this.activeClipNodes.clear();
    this.isPlaying = false;
  }

  public getCurrentPlayhead(
    loop: LoopRegion,
    tracks: AudioTrack[],
    clips: AudioClip[],
    totalDuration: number,
    bpm = 120
  ): {
    time: number;
    ended: boolean;
  } {
    if (!this.isPlaying || !this.ctx) {
      return { time: this.playStartOffset, ended: false };
    }
    const elapsed = this.ctx.currentTime - this.playStartContextTime;
    const current = this.playStartOffset + elapsed;

    if (loop.enabled && loop.end > loop.start + 0.1 && current >= loop.end) {
      this.play(tracks, clips, loop.start, loop.end, bpm);
      return { time: loop.start, ended: false };
    }

    if (current >= totalDuration) {
      this.stop();
      return { time: 0, ended: true };
    }

    return { time: current, ended: false };
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
  private detectPitchHz(frame: Float32Array, sampleRate: number): number | null {
    let rms = 0;
    for (let i = 0; i < frame.length; i++) {
      rms += frame[i] * frame[i];
    }
    rms = Math.sqrt(rms / frame.length);
    if (rms < 0.015) return null; // unvoiced or silence

    const minLag = Math.floor(sampleRate / 850); // max ~850 Hz
    const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / 75)); // min ~75 Hz

    let bestLag = -1;
    let bestCorr = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      let normA = 0;
      let normB = 0;
      const n = frame.length - lag;
      for (let i = 0; i < n; i += 2) {
        const a = frame[i];
        const b = frame[i + lag];
        sum += a * b;
        normA += a * a;
        normB += b * b;
      }
      const denom = Math.sqrt(normA * normB);
      const corr = denom > 0.00001 ? sum / denom : 0;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    if (bestLag > 0 && bestCorr > 0.55) {
      return sampleRate / bestLag;
    }
    return null;
  }

  private snapMidiToScale(midiFloat: number, scaleId: VocalScale): number {
    const scaleDef = VOCAL_SCALES.find((s) => s.id === scaleId) || VOCAL_SCALES[0];
    const nearestInt = Math.round(midiFloat);
    const octave = Math.floor(nearestInt / 12);
    const pc = ((nearestInt % 12) + 12) % 12;

    let bestPc = scaleDef.semitones[0];
    let minDist = 99;
    for (const st of scaleDef.semitones) {
      const dist = Math.abs(st - pc);
      if (dist < minDist) {
        minDist = dist;
        bestPc = st;
      }
    }
    return octave * 12 + bestPc;
  }

  public applyBufferOperation(
    sourceBufferId: string,
    clipOffsetSec: number,
    clipDurationSec: number,
    selStartRelativeSec: number,
    selEndRelativeSec: number,
    operation: BufferOperationType,
    scaleId: VocalScale = 'C_major',
    strengthPercent = 85
  ): string | null {
    const src = this.buffers.get(sourceBufferId);
    if (!src) return null;
    const ctx = this.getContext();

    const clone = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      clone.copyToChannel(new Float32Array(src.getChannelData(ch)), ch);
    }

    const absStartSec = clipOffsetSec + selStartRelativeSec;
    const absEndSec = clipOffsetSec + selEndRelativeSec;
    const startSample = Math.max(0, Math.floor(absStartSec * src.sampleRate));
    const endSample = Math.min(src.length, Math.floor(absEndSec * src.sampleRate));
    const count = endSample - startSample;
    if (count <= 1) return null;

    if (operation === 'normalize') {
      let maxAbs = 0.0001;
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = startSample; i < endSample; i++) {
          const a = Math.abs(data[i]);
          if (a > maxAbs) maxAbs = a;
        }
      }
      const scale = 0.96 / maxAbs;
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = startSample; i < endSample; i++) {
          data[i] *= scale;
        }
      }
    } else if (operation === 'reverse') {
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const slice = data.slice(startSample, endSample);
        slice.reverse();
        data.set(slice, startSample);
      }
    } else if (operation === 'fadeIn') {
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = 0; i < count; i++) {
          const ratio = i / count;
          data[startSample + i] *= ratio * ratio;
        }
      }
    } else if (operation === 'fadeOut') {
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = 0; i < count; i++) {
          const ratio = 1 - i / count;
          data[startSample + i] *= ratio * ratio;
        }
      }
    } else if (operation === 'silence') {
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = startSample; i < endSample; i++) {
          data[i] = 0;
        }
      }
    } else if (operation === 'boost' || operation === 'attenuate') {
      const mult = operation === 'boost' ? 1.4125 : 0.7079;
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = startSample; i < endSample; i++) {
          data[i] = Math.max(-1, Math.min(1, data[i] * mult));
        }
      }
    } else if (operation === 'denoise') {
      const threshold = 0.05;
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const copy = data.slice(startSample, endSample);
        let env = 0;
        for (let i = 0; i < count; i++) {
          const abs = Math.abs(copy[i]);
          env = env * 0.985 + abs * 0.015;
          const gateGain = env < threshold ? Math.pow(env / threshold, 2.8) : 1.0;
          const prev = i > 0 ? copy[i - 1] : copy[i];
          const next = i < count - 1 ? copy[i + 1] : copy[i];
          const smoothed = copy[i] * 0.55 + (prev + next) * 0.225;
          data[startSample + i] = smoothed * gateGain;
        }
      }
    } else if (operation === 'voiceSoften') {
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const copy = data.slice(startSample, endSample);
        let lpState = 0;
        for (let i = 0; i < count; i++) {
          const x = copy[i];
          lpState = lpState * 0.76 + x * 0.24;
          const highTransient = x - lpState;
          const softenedHigh = Math.tanh(highTransient * 1.6) * 0.32;
          data[startSample + i] = Math.tanh((lpState * 1.15 + softenedHigh) * 1.05);
        }
      }
    } else if (operation === 'autoPitch') {
      // Sample-accurate granular Auto-Pitch Tuner locked to musical scale
      const sr = clone.sampleRate;
      const frameSize = Math.floor(sr * 0.04); // 40ms window
      const hopSize = Math.floor(frameSize / 2);
      const strength = Math.max(0.2, Math.min(1, strengthPercent / 100));
      const ch0 = clone.getChannelData(0).slice(startSample, endSample);

      // Compute pitch ratio per hop using autocorrelation on channel 0
      const numHops = Math.max(1, Math.floor((count - frameSize) / hopSize));
      const ratios = new Float32Array(numHops);
      let prevRatio = 1.0;

      for (let h = 0; h < numHops; h++) {
        const offset = h * hopSize;
        const slice = ch0.subarray(offset, offset + frameSize);
        const f0 = this.detectPitchHz(slice, sr);
        if (f0) {
          const midiFloat = 69 + 12 * Math.log2(f0 / 440);
          const targetMidi = this.snapMidiToScale(midiFloat, scaleId);
          const targetFreq = 440 * Math.pow(2, (targetMidi - 69) / 12);
          const rawRatio = Math.max(0.75, Math.min(1.35, targetFreq / f0));
          const blended = 1.0 + (rawRatio - 1.0) * strength;
          prevRatio = prevRatio * 0.25 + blended * 0.75;
          ratios[h] = prevRatio;
        } else {
          ratios[h] = 1.0;
        }
      }

      // Apply overlap-add pitch-locked resampling across all channels
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const orig = data.slice(startSample, endSample);
        const out = new Float32Array(count);
        const weight = new Float32Array(count);

        for (let h = 0; h < numHops; h++) {
          const offset = h * hopSize;
          const ratio = ratios[h];
          for (let i = 0; i < frameSize && offset + i < count; i++) {
            const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
            const srcPos = offset + i * ratio;
            const idx0 = Math.min(count - 1, Math.floor(srcPos));
            const idx1 = Math.min(count - 1, idx0 + 1);
            const frac = srcPos - idx0;
            const sample = orig[idx0] * (1 - frac) + orig[idx1] * frac;
            out[offset + i] += sample * win;
            weight[offset + i] += win;
          }
        }

        for (let i = 0; i < count; i++) {
          data[startSample + i] = weight[i] > 0.01 ? out[i] / weight[i] : orig[i];
        }
      }
    } else if (operation === 'harmony') {
      // Generates a 3-part stereo vocal harmony (+4 semitones Left, +7 semitones Right) blended with lead
      const sr = clone.sampleRate;
      const grain = Math.floor(sr * 0.045);
      const ratioThird = Math.pow(2, 4 / 12); // Major 3rd
      const ratioFifth = Math.pow(2, 7 / 12); // Perfect 5th

      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const orig = data.slice(startSample, endSample);
        const ratio = ch === 0 ? ratioThird : ratioFifth;

        for (let i = 0; i < count; i++) {
          const grainIdx = Math.floor(i / grain) * grain;
          const posInGrain = i - grainIdx;
          const win = Math.sin((Math.PI * posInGrain) / grain);
          const shiftPos = Math.min(count - 1, Math.floor(grainIdx + posInGrain * ratio));
          const harmonySample = orig[shiftPos] * win * 0.42;
          data[startSample + i] = Math.tanh(orig[i] * 0.85 + harmonySample);
        }
      }
    }

    const newBufferId = `buf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.registerBuffer(newBufferId, clone, true);
    return newBufferId;
  }

  /**
   * Non-destructive multi-stage clip processor driven by adjustable sliders (`ClipProcessSettings`).
   * Always starts from `sourceBufferId` so the user can freely increase, decrease, or reset any
   * processed setting via sliders and immediately see the waveform and hear the result.
   */
  public renderClipProcesses(
    clipId: string,
    sourceBufferId: string,
    clipOffsetSec: number,
    selStartRelativeSec: number,
    selEndRelativeSec: number,
    processes: ClipProcessSettings,
    scaleId: VocalScale = 'C_major'
  ): string | null {
    const src = this.buffers.get(sourceBufferId);
    if (!src) return null;

    const isDefault =
      processes.autoPitch <= 0 &&
      processes.harmony <= 0 &&
      processes.voiceSoften <= 0 &&
      processes.denoise <= 0 &&
      processes.normalize <= 0 &&
      Math.abs(processes.boostDb) < 0.05 &&
      processes.fadeInShape <= 0 &&
      processes.fadeOutShape <= 0 &&
      !processes.reverse;

    if (isDefault) {
      return sourceBufferId;
    }

    const ctx = this.getContext();
    const clone = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      clone.copyToChannel(new Float32Array(src.getChannelData(ch)), ch);
    }

    const absStartSec = clipOffsetSec + selStartRelativeSec;
    const absEndSec = clipOffsetSec + selEndRelativeSec;
    const startSample = Math.max(0, Math.floor(absStartSec * src.sampleRate));
    const endSample = Math.min(src.length, Math.floor(absEndSec * src.sampleRate));
    const count = endSample - startSample;
    if (count <= 1) return sourceBufferId;

    // 1. Noise Removal (0..100%)
    if (processes.denoise > 0) {
      const amt = Math.min(1, processes.denoise / 100);
      const threshold = 0.015 + amt * 0.065;
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const copy = data.slice(startSample, endSample);
        let env = 0;
        for (let i = 0; i < count; i++) {
          const abs = Math.abs(copy[i]);
          env = env * 0.985 + abs * 0.015;
          const gateGain = env < threshold ? Math.pow(env / threshold, 1.5 + amt * 2.2) : 1.0;
          const prev = i > 0 ? copy[i - 1] : copy[i];
          const next = i < count - 1 ? copy[i + 1] : copy[i];
          const smoothed = copy[i] * (1 - amt * 0.45) + (prev + next) * (amt * 0.225);
          const wet = smoothed * gateGain;
          data[startSample + i] = copy[i] * (1 - amt) + wet * amt;
        }
      }
    }

    // 2. Voice Soften (0..100%)
    if (processes.voiceSoften > 0) {
      const amt = Math.min(1, processes.voiceSoften / 100);
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const copy = data.slice(startSample, endSample);
        let lpState = 0;
        for (let i = 0; i < count; i++) {
          const x = copy[i];
          lpState = lpState * (0.65 + amt * 0.2) + x * (0.35 - amt * 0.2);
          const highTransient = x - lpState;
          const softenedHigh = Math.tanh(highTransient * 1.5) * (0.5 - amt * 0.28);
          const wet = Math.tanh((lpState * (1 + amt * 0.2) + softenedHigh) * 1.04);
          data[startSample + i] = x * (1 - amt) + wet * amt;
        }
      }
    }

    // 3. Auto-Pitch Tune (0..100%)
    if (processes.autoPitch > 0) {
      const sr = clone.sampleRate;
      const frameSize = Math.floor(sr * 0.04);
      const hopSize = Math.floor(frameSize / 2);
      const strength = Math.max(0.05, Math.min(1, processes.autoPitch / 100));
      const ch0 = clone.getChannelData(0).slice(startSample, endSample);
      const numHops = Math.max(1, Math.floor((count - frameSize) / hopSize));
      const ratios = new Float32Array(numHops);
      let prevRatio = 1.0;

      for (let h = 0; h < numHops; h++) {
        const offset = h * hopSize;
        const slice = ch0.subarray(offset, offset + frameSize);
        const f0 = this.detectPitchHz(slice, sr);
        if (f0) {
          const midiFloat = 69 + 12 * Math.log2(f0 / 440);
          const targetMidi = this.snapMidiToScale(midiFloat, scaleId);
          const targetFreq = 440 * Math.pow(2, (targetMidi - 69) / 12);
          const rawRatio = Math.max(0.75, Math.min(1.35, targetFreq / f0));
          const blended = 1.0 + (rawRatio - 1.0) * strength;
          prevRatio = prevRatio * 0.25 + blended * 0.75;
          ratios[h] = prevRatio;
        } else {
          ratios[h] = 1.0;
        }
      }

      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const orig = data.slice(startSample, endSample);
        const out = new Float32Array(count);
        const weight = new Float32Array(count);

        for (let h = 0; h < numHops; h++) {
          const offset = h * hopSize;
          const ratio = ratios[h];
          for (let i = 0; i < frameSize && offset + i < count; i++) {
            const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
            const srcPos = offset + i * ratio;
            const idx0 = Math.min(count - 1, Math.floor(srcPos));
            const idx1 = Math.min(count - 1, idx0 + 1);
            const frac = srcPos - idx0;
            const sample = orig[idx0] * (1 - frac) + orig[idx1] * frac;
            out[offset + i] += sample * win;
            weight[offset + i] += win;
          }
        }

        for (let i = 0; i < count; i++) {
          data[startSample + i] = weight[i] > 0.01 ? out[i] / weight[i] : orig[i];
        }
      }
    }

    // 4. 3-Part Vocal Harmony (0..100%)
    if (processes.harmony > 0) {
      const amt = Math.min(1, processes.harmony / 100);
      const sr = clone.sampleRate;
      const grain = Math.floor(sr * 0.045);
      const ratioThird = Math.pow(2, 4 / 12);
      const ratioFifth = Math.pow(2, 7 / 12);

      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const orig = data.slice(startSample, endSample);
        const ratio = ch === 0 ? ratioThird : ratioFifth;

        for (let i = 0; i < count; i++) {
          const grainIdx = Math.floor(i / grain) * grain;
          const posInGrain = i - grainIdx;
          const win = Math.sin((Math.PI * posInGrain) / grain);
          const shiftPos = Math.min(count - 1, Math.floor(grainIdx + posInGrain * ratio));
          const harmonySample = orig[shiftPos] * win * (0.65 * amt);
          data[startSample + i] = Math.tanh(orig[i] * (1 - amt * 0.18) + harmonySample);
        }
      }
    }

    // 5. Peak Normalize (0..100%)
    if (processes.normalize > 0) {
      const amt = Math.min(1, processes.normalize / 100);
      let maxAbs = 0.0001;
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = startSample; i < endSample; i++) {
          const a = Math.abs(data[i]);
          if (a > maxAbs) maxAbs = a;
        }
      }
      const fullScale = 0.96 / maxAbs;
      const scale = 1 + (fullScale - 1) * amt;
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = startSample; i < endSample; i++) {
          data[i] = Math.max(-1, Math.min(1, data[i] * scale));
        }
      }
    }

    // 6. Gain Boost / Cut (-12..+12 dB)
    if (Math.abs(processes.boostDb) >= 0.05) {
      const mult = Math.pow(10, processes.boostDb / 20);
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = startSample; i < endSample; i++) {
          data[i] = Math.tanh(data[i] * mult);
        }
      }
    }

    // 7. Envelope Fade-In & Fade-Out (0..100% of selected region or clip)
    if (processes.fadeInShape > 0) {
      const fadeSamples = Math.max(1, Math.floor(count * Math.min(1, processes.fadeInShape / 100)));
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = 0; i < fadeSamples; i++) {
          const ratio = i / fadeSamples;
          data[startSample + i] *= ratio * ratio;
        }
      }
    }
    if (processes.fadeOutShape > 0) {
      const fadeSamples = Math.max(1, Math.floor(count * Math.min(1, processes.fadeOutShape / 100)));
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        for (let i = 0; i < fadeSamples; i++) {
          const ratio = 1 - i / fadeSamples;
          data[endSample - fadeSamples + i] *= ratio * ratio;
        }
      }
    }

    // 8. Reverse (toggleable)
    if (processes.reverse) {
      for (let ch = 0; ch < clone.numberOfChannels; ch++) {
        const data = clone.getChannelData(ch);
        const slice = data.slice(startSample, endSample);
        slice.reverse();
        data.set(slice, startSample);
      }
    }

    const procBufferId = `proc_${clipId}_${Date.now()}`;
    this.registerBuffer(procBufferId, clone, true);
    return procBufferId;
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

  public async stopMicRecording(): Promise<{ bufferId: string; buffer: AudioBuffer } | null> {
    if (!this.mediaRecorder) return null;
    const ctx = this.getContext();

    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        resolve(null);
        return;
      }
      const recMime = this.mediaRecorder.mimeType || 'audio/webm';
      this.mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(this.recordedChunks, { type: recMime });
          const arrayBuf = await blob.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(arrayBuf);

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
              for (let i = 0; i < d.length; i++) {
                d[i] *= boost;
              }
            }
          }

          const bufferId = `mic_${Date.now()}`;
          this.registerBuffer(bufferId, audioBuffer, true);
          resolve({ bufferId, buffer: audioBuffer });
        } catch {
          resolve(null);
        } finally {
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
    const maxEnd =
      clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 4.0) + 1.5;
    const sampleRate = 44100;
    const offlineCtx = new OfflineAudioContext(2, Math.ceil(maxEnd * sampleRate), sampleRate);

    const masterOut = offlineCtx.createGain();
    masterOut.gain.value = masterVolume;
    masterOut.connect(offlineCtx.destination);

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
      source.playbackRate.value = clip.playbackRate;
      source.detune.value = clip.pitchSemitones * 100;

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
      source.start(clip.startTime, clip.offset, clip.duration * clip.playbackRate);
    }

    const renderedBuffer = await offlineCtx.startRendering();
    return this.encodeWavFromAudioBuffer(renderedBuffer);
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
