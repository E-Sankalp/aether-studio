/**
 * Master bus processing:
 *  - a Web Audio master chain (glue comp -> low/air shelves -> stereo width -> makeup -> limiter)
 *    used for live playback and the offline mixdown, and
 *  - offline loudness mastering for export: ITU-R BS.1770 integrated loudness (LUFS) measurement,
 *    gain to a target, and a lookahead true-peak limiter.
 */
import { LoudnessReport, MasterPresetId, MasterSettings } from '../types/audio';

type PresetValues = Omit<MasterSettings, 'preset'>;

export const MASTER_PRESETS: { id: Exclude<MasterPresetId, 'custom'>; label: string; hint: string; values: PresetValues }[] = [
  {
    id: 'streaming',
    label: 'Streaming',
    hint: '-14 LUFS · Spotify, YouTube, Apple Music',
    values: { glue: 35, lowDb: 1, airDb: 2, width: 1.1, targetLufs: -14, ceilingDb: -1 },
  },
  {
    id: 'loud',
    label: 'Loud',
    hint: '-9 LUFS · punchy, competitive pop/rap',
    values: { glue: 60, lowDb: 1.5, airDb: 2.5, width: 1.15, targetLufs: -9, ceilingDb: -1 },
  },
  {
    id: 'warm',
    label: 'Warm',
    hint: '-12 LUFS · smooth, acoustic, R&B',
    values: { glue: 45, lowDb: 2.5, airDb: 0.5, width: 1.0, targetLufs: -12, ceilingDb: -1 },
  },
  {
    id: 'voice',
    label: 'Voice',
    hint: '-16 LUFS · podcast, spoken word',
    values: { glue: 50, lowDb: -1, airDb: 1.5, width: 0.9, targetLufs: -16, ceilingDb: -1 },
  },
  {
    id: 'off',
    label: 'Off',
    hint: 'Raw mix, no mastering',
    values: { glue: 0, lowDb: 0, airDb: 0, width: 1, targetLufs: -14, ceilingDb: -1 },
  },
];

export const DEFAULT_MASTER: MasterSettings = { preset: 'streaming', ...MASTER_PRESETS[0].values };

export function masterFromPreset(id: Exclude<MasterPresetId, 'custom'>): MasterSettings {
  const p = MASTER_PRESETS.find((m) => m.id === id) ?? MASTER_PRESETS[0];
  return { preset: p.id, ...p.values };
}

const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

/* ------------------------------ Web Audio chain ----------------------------- */

export interface MasterChainNodes {
  input: GainNode;
  glue: DynamicsCompressorNode;
  low: BiquadFilterNode;
  air: BiquadFilterNode;
  ll: GainNode;
  lr: GainNode;
  rl: GainNode;
  rr: GainNode;
  makeup: GainNode;
  limiter: DynamicsCompressorNode | null;
  output: GainNode;
}

/**
 * Builds the master chain. `withLimiter` adds a fast compressor-style limiter for live playback;
 * offline renders skip it and use the precise lookahead limiter in `masterBuffer` instead.
 */
export function createMasterChain(ctx: BaseAudioContext, withLimiter: boolean): MasterChainNodes {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';

  const glue = ctx.createDynamicsCompressor();
  glue.knee.value = 10;
  glue.attack.value = 0.03;
  glue.release.value = 0.2;

  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;

  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 10000;

  // Mid/side width matrix: L' = L(1+w)/2 + R(1-w)/2, R' = L(1-w)/2 + R(1+w)/2
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const ll = ctx.createGain();
  const lr = ctx.createGain();
  const rl = ctx.createGain();
  const rr = ctx.createGain();

  const makeup = ctx.createGain();
  const output = ctx.createGain();

  input.connect(glue);
  glue.connect(low);
  low.connect(air);
  air.connect(splitter);
  splitter.connect(ll, 0);
  splitter.connect(lr, 0);
  splitter.connect(rl, 1);
  splitter.connect(rr, 1);
  ll.connect(merger, 0, 0);
  rl.connect(merger, 0, 0);
  lr.connect(merger, 0, 1);
  rr.connect(merger, 0, 1);
  merger.connect(makeup);

  let limiter: DynamicsCompressorNode | null = null;
  if (withLimiter) {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    makeup.connect(limiter);
    limiter.connect(output);
  } else {
    makeup.connect(output);
  }

  const nodes = { input, glue, low, air, ll, lr, rl, rr, makeup, limiter, output };
  applyMasterChain(ctx, nodes, DEFAULT_MASTER, 0, true);
  return nodes;
}

/** Applies settings to a master chain. `makeupDb` is the loudness-matching preview gain. */
export function applyMasterChain(
  ctx: BaseAudioContext,
  n: MasterChainNodes,
  s: MasterSettings,
  makeupDb: number,
  immediate = false
): void {
  const off = s.preset === 'off';
  const now = ctx.currentTime;
  const set = (p: AudioParam, v: number) =>
    immediate ? (p.value = v) : p.setTargetAtTime(v, now, 0.03);

  const glue = off ? 0 : Math.max(0, Math.min(100, s.glue)) / 100;
  set(n.glue.threshold, glue > 0 ? -6 - glue * 18 : 0);
  set(n.glue.ratio, 1 + glue * 3);
  set(n.low.gain, off ? 0 : s.lowDb);
  set(n.air.gain, off ? 0 : s.airDb);

  const w = off ? 1 : Math.max(0, Math.min(2, s.width));
  set(n.ll.gain, (1 + w) / 2);
  set(n.rr.gain, (1 + w) / 2);
  set(n.lr.gain, (1 - w) / 2);
  set(n.rl.gain, (1 - w) / 2);

  set(n.makeup.gain, off ? 1 : dbToLin(Math.max(-24, Math.min(24, makeupDb))));
  if (n.limiter) set(n.limiter.threshold, off ? -1 : Math.min(-0.5, s.ceilingDb));
}

/* ---------------------------- loudness measurement -------------------------- */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** BS.1770 K-weighting filter coefficients for an arbitrary sample rate. */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high-frequency shelf (head acoustic model)
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, hp];
}

function filterSquared(x: Float32Array, filters: Biquad[]): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i];
  for (const f of filters) {
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const xi = out[i];
      const y = f.b0 * xi + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] *= out[i];
  return out;
}

/** Integrated loudness in LUFS (BS.1770-4 gating). Returns -Infinity for silence / very short audio. */
export function measureIntegratedLufs(channels: Float32Array[], sampleRate: number): number {
  const n = channels[0]?.length ?? 0;
  const hop = Math.round(sampleRate * 0.1); // 100 ms (75 % overlap of 400 ms blocks)
  const hops = Math.floor(n / hop);
  if (hops < 4) return -Infinity;

  const filters = kWeighting(sampleRate);
  const hopEnergy = new Float64Array(hops);
  for (const ch of channels.slice(0, 2)) {
    const sq = filterSquared(ch, filters);
    for (let h = 0; h < hops; h++) {
      let s = 0;
      const base = h * hop;
      for (let i = 0; i < hop; i++) s += sq[base + i];
      hopEnergy[h] += s;
    }
  }

  const blockCount = hops - 3;
  const blocks = new Float64Array(blockCount);
  const blockLen = hop * 4;
  for (let b = 0; b < blockCount; b++) {
    blocks[b] = (hopEnergy[b] + hopEnergy[b + 1] + hopEnergy[b + 2] + hopEnergy[b + 3]) / blockLen;
  }

  const toLufs = (z: number) => -0.691 + 10 * Math.log10(z);
  const absGated: number[] = [];
  for (const z of blocks) if (z > 0 && toLufs(z) > -70) absGated.push(z);
  if (absGated.length === 0) return -Infinity;

  const relThreshold = toLufs(absGated.reduce((a, z) => a + z, 0) / absGated.length) - 10;
  let sum = 0;
  let count = 0;
  for (const z of absGated) {
    if (toLufs(z) > relThreshold) {
      sum += z;
      count++;
    }
  }
  return count > 0 ? toLufs(sum / count) : -Infinity;
}

/** Cubic (Catmull-Rom) estimate of the inter-sample peak around sample i. */
function truePeakAt(x: Float32Array, i: number): number {
  const n = x.length;
  const p0 = x[i > 0 ? i - 1 : i];
  const p1 = x[i];
  const p2 = x[i + 1 < n ? i + 1 : i];
  const p3 = x[i + 2 < n ? i + 2 : i + 1 < n ? i + 1 : i];
  let peak = Math.abs(p1);
  for (const t of [0.25, 0.5, 0.75]) {
    const t2 = t * t;
    const t3 = t2 * t;
    const v =
      0.5 *
      (2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return peak;
}

export function measureTruePeakDb(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      // Only do the cubic check near loud samples to keep this fast
      if (a > peak * 0.7) {
        const tp = truePeakAt(ch, i);
        if (tp > peak) peak = tp;
      }
    }
  }
  return linToDb(peak);
}

/* ------------------------------ lookahead limiter --------------------------- */

/**
 * Transparent lookahead brick-wall limiter (in place). Gain reduction starts `lookahead` before
 * each peak and recovers with an exponential release, so peaks never exceed the ceiling.
 */
export function limitInPlace(
  channels: Float32Array[],
  sampleRate: number,
  ceilingDb: number,
  lookaheadSec = 0.005,
  releaseSec = 0.12
): void {
  const n = channels[0]?.length ?? 0;
  if (n === 0) return;
  const ceiling = dbToLin(ceilingDb);
  const L = Math.max(1, Math.round(lookaheadSec * sampleRate));

  // Required gain per sample
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const ch of channels) {
      const a = Math.abs(ch[i]);
      if (a > ceiling * 0.8) {
        const tp = truePeakAt(ch, i);
        if (tp > peak) peak = tp;
      }
    }
    g[i] = peak > ceiling ? ceiling / peak : 1;
  }

  // Sliding minimum over the lookahead window [i, i + L]
  const m = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let j = n - 1; j >= 0; j--) {
    while (tail > head && g[dq[tail - 1]] >= g[j]) tail--;
    dq[tail++] = j;
    while (dq[head] > j + L) head++;
    m[j] = g[dq[head]];
  }

  // Release smoothing (never rises above the required gain)
  const rel = 1 - Math.exp(-1 / (releaseSec * sampleRate));
  let r = 1;
  for (let i = 0; i < n; i++) {
    r = m[i] < r ? m[i] : r + (m[i] - r) * rel;
    m[i] = r;
  }

  // Attack smoothing: moving average over L+1 samples ending at i (still <= required gain at peaks)
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += m[i];
    if (i > L) sum -= m[i - L - 1];
    const env = sum / Math.min(i + 1, L + 1);
    for (const ch of channels) {
      const v = ch[i] * env;
      ch[i] = v > ceiling ? ceiling : v < -ceiling ? -ceiling : v;
    }
  }
}

/* ------------------------------- full mastering ----------------------------- */

function scaleChannels(channels: Float32Array[], gain: number): Float32Array[] {
  return channels.map((src) => {
    const dst = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) dst[i] = src[i] * gain;
    return dst;
  });
}

/**
 * Pure, DOM-free core of `masterBuffer`: loudness-normalizes and true-peak-limits raw channels.
 * Runs inside the mastering Web Worker so long songs don't freeze the UI.
 */
export function masterChannels(
  channels: Float32Array[],
  sampleRate: number,
  settings: MasterSettings
): { channels: Float32Array[]; report: LoudnessReport } {
  const inputLufs = measureIntegratedLufs(channels, sampleRate);
  if (settings.preset === 'off' || !Number.isFinite(inputLufs)) {
    return {
      channels,
      report: {
        inputLufs,
        outputLufs: inputLufs,
        truePeakDb: measureTruePeakDb(channels),
        gainDb: 0,
      },
    };
  }

  const clampGain = (db: number) => Math.max(-24, Math.min(24, db));
  let gainDb = clampGain(settings.targetLufs - inputLufs);
  let chans: Float32Array[] = channels;
  let outLufs = inputLufs;

  for (let iter = 0; iter < 3; iter++) {
    chans = scaleChannels(channels, dbToLin(gainDb));
    limitInPlace(chans, sampleRate, settings.ceilingDb);
    outLufs = measureIntegratedLufs(chans, sampleRate);
    const diff = settings.targetLufs - outLufs;
    if (!Number.isFinite(diff) || Math.abs(diff) < 0.3) break;
    const next = clampGain(gainDb + diff);
    if (Math.abs(next - gainDb) < 0.05) break; // gain clamp reached
    gainDb = next;
  }

  return {
    channels: chans,
    report: { inputLufs, outputLufs: outLufs, truePeakDb: measureTruePeakDb(chans), gainDb },
  };
}

/** Measures a buffer without changing it. */
export function analyzeBuffer(buffer: AudioBuffer): { lufs: number; truePeakDb: number } {
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  return {
    lufs: measureIntegratedLufs(chans, buffer.sampleRate),
    truePeakDb: measureTruePeakDb(chans),
  };
}

/**
 * Normalizes a rendered mix to the target loudness and limits it to the true-peak ceiling.
 * Iterates so the limiter's loudness loss is compensated. Returns a new buffer + report.
 */
export function masterBuffer(
  buffer: AudioBuffer,
  settings: MasterSettings
): { buffer: AudioBuffer; report: LoudnessReport } {
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const res = masterChannels(chans, buffer.sampleRate, settings);
  if (res.channels === chans) return { buffer, report: res.report };

  const out = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  res.channels.forEach((d, c) => out.copyToChannel(d, c));
  return { buffer: out, report: res.report };
}
