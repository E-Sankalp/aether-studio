export type VocalScale =
  | 'chromatic'
  | 'C_major'
  | 'G_major'
  | 'F_major'
  | 'D_major'
  | 'Eb_major';

export type HarmonyMode = 'doubler' | 'thirds' | 'octave' | 'choir';

export interface TrackEffects {
  eqLowGain: number;       // -18 to +18 dB (110 Hz)
  eqMidGain: number;       // -18 to +18 dB
  eqMidFreq: number;       // 250 to 5000 Hz
  eqMidQ: number;          // 0.3 to 8.0
  eqHighGain: number;      // -18 to +18 dB (7500 Hz)
  compEnabled: boolean;
  compThreshold: number;   // -60 to 0 dB
  compRatio: number;       // 1 to 20
  compAttack: number;      // 0.001 to 0.2 sec
  compRelease: number;     // 0.02 to 1.0 sec
  reverbMix: number;       // 0 to 1
  reverbDecay: number;     // 0.4 to 5.0 sec
  delayMix: number;        // 0 to 1
  delayTime: number;       // 0.05 to 1.0 sec
  delayFeedback: number;   // 0 to 0.85
  drive: number;           // 0 to 100 %
  /** Voice Softener (De-Esser + Velvet Warmth: 0 to 100 %) */
  voiceSoftener: number;
  /** Noise Removal (Rumble High-Pass + Hiss Gate: 0 to 100 %) */
  noiseRemoval: number;
  /** Dry Unprocessed Signal Level (0 to 150 %) */
  dryLevel: number;
  /** Wet Processed FX Signal Level (0 to 150 %) */
  wetLevel: number;
  /** Auto-Pitch / Vocal Tuner Retune Speed & Amount (0 to 100 %) */
  autoPitchAmount: number;
  /** Musical Scale for Auto-Pitch Vocal Tuner */
  autoPitchScale: VocalScale;
  /** Vocal Harmony / Choir Blend (0 to 100 %) */
  harmonyAmount: number;
  /** Vocal Harmony Voicing Mode */
  harmonyMode: HarmonyMode;
}

export type BufferOperationType =
  | 'normalize'
  | 'reverse'
  | 'fadeIn'
  | 'fadeOut'
  | 'silence'
  | 'boost'
  | 'attenuate'
  | 'denoise'
  | 'voiceSoften'
  | 'autoPitch'
  | 'harmony';

export interface ClipProcessSettings {
  /** Auto-Pitch Tune strength (0 to 100 %) */
  autoPitch: number;
  /** 3-Part Vocal Harmony blend (0 to 100 %) */
  harmony: number;
  /** Voice Softener / De-Esser & Warmth (0 to 100 %) */
  voiceSoften: number;
  /** Noise & Hiss Gate Removal (0 to 100 %) */
  denoise: number;
  /** Peak Normalization blend toward -0.4 dBFS (0 to 100 %) */
  normalize: number;
  /** Gain Boost / Cut in dB (-12 to +12 dB) */
  boostDb: number;
  /** Envelope Fade-In curve amount (0 to 100 %) */
  fadeInShape: number;
  /** Envelope Fade-Out curve amount (0 to 100 %) */
  fadeOutShape: number;
  /** Whether the clip or region is reversed */
  reverse: boolean;
}

export const DEFAULT_CLIP_PROCESSES: ClipProcessSettings = {
  autoPitch: 0,
  harmony: 0,
  voiceSoften: 0,
  denoise: 0,
  normalize: 0,
  boostDb: 0,
  fadeInShape: 0,
  fadeOutShape: 0,
  reverse: false,
};

export interface AudioClip {
  id: string;
  trackId: string;
  name: string;
  bufferId: string;
  /** Original unprocessed source buffer ID for non-destructive slider control */
  sourceBufferId?: string;
  /** Applied process settings and slider values on this clip */
  processes?: ClipProcessSettings;
  /** Start time on the timeline in seconds */
  startTime: number;
  /** Offset into the source AudioBuffer in seconds */
  offset: number;
  /** Active duration on timeline in seconds (in timeline time) */
  duration: number;
  /** Clip-level linear gain (0.0 to 2.0) */
  gain: number;
  /** Fade in duration in seconds */
  fadeIn: number;
  /** Fade out duration in seconds */
  fadeOut: number;
  /** Pitch shift in semitones (-12 to +12), duration-preserving */
  pitchSemitones: number;
  /**
   * Semitones already rendered into `bufferId`. Older projects lack this and played pitch via
   * playback-rate detune; any difference from `pitchSemitones` is still applied that way.
   */
  renderedPitch?: number;
  /** Playback rate multiplier (0.5 to 2.0) */
  playbackRate: number;
  /** Accent color hex */
  color: string;
  /**
   * Loop-recording takes: alternative recordings of the same region (same length/alignment).
   * The active take's audio is `sourceBufferId`/`bufferId`. Split the clip to comp sections.
   */
  takes?: ClipTake[];
  /** Index into `takes` of the take currently used */
  activeTake?: number;
}

export interface ClipTake {
  bufferId: string;
  label: string;
}

export interface AudioTrack {
  id: string;
  name: string;
  color: string;
  volume: number;          // 0.0 to 1.5 (1.0 = 0 dB)
  pan: number;             // -1.0 (L) to +1.0 (R)
  muted: boolean;
  solo: boolean;
  armed: boolean;
  effects: TrackEffects;
  /** Post-fader send levels to the shared FX return buses (0 to 1) */
  sends?: TrackSends;
  /** Automation lanes (timeline seconds -> value) */
  automation?: TrackAutomation;
  /** Automation lane visible under the track */
  showAutomation?: boolean;
}

export interface TrackSends {
  reverb: number;
  delay: number;
}

/** One automation breakpoint: at timeline time `t` (s) the value is `v`. */
export interface AutomationPoint {
  t: number;
  v: number;
}

export interface TrackAutomation {
  /** Volume multiplier on top of the fader (0 to 1.5, 1 = unchanged), linear between points */
  volume?: AutomationPoint[];
}

export type DelayDivision = '1/2' | '1/4' | '1/4d' | '1/8' | '1/8d' | '1/16';

/** Shared FX return buses (project-wide): one reverb, one tempo-synced delay. */
export interface FxReturns {
  /** Reverb decay time (RT60) in seconds, 0.4 to 6 */
  reverbSize: number;
  /** Reverb pre-delay in ms, 0 to 150 */
  reverbPreDelayMs: number;
  /** Reverb brightness 0 (dark) to 100 (bright) */
  reverbTone: number;
  /** Reverb return level 0 to 1.5 */
  reverbLevel: number;
  /** Delay time as a note value at the project tempo */
  delayDivision: DelayDivision;
  /** Delay feedback 0 to 0.85 */
  delayFeedback: number;
  /** Delay repeat brightness 0 to 100 */
  delayTone: number;
  /** Delay return level 0 to 1.5 */
  delayLevel: number;
  /** Alternate repeats left/right */
  delayPingPong: boolean;
}

export const DEFAULT_RETURNS: FxReturns = {
  reverbSize: 2.2,
  reverbPreDelayMs: 20,
  reverbTone: 60,
  reverbLevel: 1,
  delayDivision: '1/8d',
  delayFeedback: 0.32,
  delayTone: 55,
  delayLevel: 1,
  delayPingPong: true,
};

export interface LoopRegion {
  enabled: boolean;
  start: number;
  end: number;
}

export interface WaveformSelection {
  clipId: string;
  /** Start offset within the clip's visible region (0 to clip.duration) */
  startOffset: number;
  /** End offset within the clip's visible region (0 to clip.duration) */
  endOffset: number;
}

export type VisualizerMode = 'spectrum' | 'oscilloscope' | 'phase' | 'eq-curve';

export type ActiveBottomTab = 'editor' | 'fx' | 'mixer';

export interface MeterLevels {
  masterLeft: number;      // 0 to 1
  masterRight: number;     // 0 to 1
  masterPeakDb: number;    // dBFS
  masterRmsDb: number;     // dBFS (LUFS approx)
  phaseCorrelation: number;// -1 to +1
  trackLevels: Record<string, number>;
}

export type MasterPresetId = 'off' | 'streaming' | 'loud' | 'warm' | 'voice' | 'custom';

/** Master bus / mastering settings, saved per project. */
export interface MasterSettings {
  preset: MasterPresetId;
  /** Glue compression amount (0 to 100 %) */
  glue: number;
  /** Low-shelf "warmth" at 120 Hz (-6 to +6 dB) */
  lowDb: number;
  /** High-shelf "air" at 10 kHz (-3 to +6 dB) */
  airDb: number;
  /** Stereo width (0 = mono, 1 = unchanged, 1.5 = wide) */
  width: number;
  /** Integrated loudness target for export (LUFS) */
  targetLufs: number;
  /** True-peak ceiling for export (dBTP) */
  ceilingDb: number;
}

/** Result of measuring (and optionally mastering) a mixdown. */
export interface LoudnessReport {
  /** Loudness of the unmastered mix (LUFS) */
  inputLufs: number;
  /** Loudness after mastering (LUFS) */
  outputLufs: number;
  /** Estimated true peak after mastering (dBTP) */
  truePeakDb: number;
  /** Gain applied by loudness normalization (dB) */
  gainDb: number;
}
