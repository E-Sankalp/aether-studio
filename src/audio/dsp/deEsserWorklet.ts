/**
 * AudioWorklet de-esser for the live track chain (Voice Softener). Same algorithm as
 * `deEss` in vocalDsp.ts: Linkwitz-Riley split at 5.5 kHz, only the high band is reduced while
 * sibilance is present. amount 0 = exact pass-through. Zero latency, so tracks stay aligned.
 *
 * Exported as source text: worklet modules are loaded from a Blob URL so they work the same in
 * dev, production and inside OfflineAudioContext renders.
 */
export const DEESSER_WORKLET_SOURCE = `
function butter(type, f0, sr) {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (type === 'lp' ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b1 = (type === 'lp' ? 1 - cos : -(1 + cos)) / a0;
  return { b0, b1, b2: b0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}
function makeState() { return { x1: 0, x2: 0, y1: 0, y2: 0 }; }
function run(c, st, x) {
  const y = c.b0 * x + c.b1 * st.x1 + c.b2 * st.x2 - c.a1 * st.y1 - c.a2 * st.y2;
  st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
  return y;
}
class AetherDeEsser extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'amount', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.lp = butter('lp', 5500, sampleRate);
    this.hp = butter('hp', 5500, sampleRate);
    this.ch = [];
    this.att = Math.exp(-1 / (0.0008 * sampleRate));
    this.rel = Math.exp(-1 / (0.06 * sampleRate));
  }
  state(i) {
    if (!this.ch[i]) {
      this.ch[i] = { l1: makeState(), l2: makeState(), h1: makeState(), h2: makeState(), envS: 0, envX: 0, g: 1 };
    }
    return this.ch[i];
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const amt = Math.min(1, Math.max(0, parameters.amount[0]));
    for (let c = 0; c < output.length; c++) {
      const x = input[c] || input[0];
      const y = output[c];
      if (!x) { y.fill(0); continue; }
      if (amt <= 0) { y.set(x); continue; }
      const s = this.state(c);
      const thr = Math.pow(10, (-20 - amt * 20) / 20);
      const ratio = 2 + amt * 8;
      const maxCut = Math.pow(10, -(6 + amt * 12) / 20);
      for (let i = 0; i < x.length; i++) {
        const xi = x[i];
        const lo = run(this.lp, s.l2, run(this.lp, s.l1, xi));
        const hi = run(this.hp, s.h2, run(this.hp, s.h1, xi));
        const as = Math.abs(hi), ax = Math.abs(xi);
        s.envS = as > s.envS ? this.att * s.envS + (1 - this.att) * as : this.rel * s.envS + (1 - this.rel) * as;
        s.envX = ax > s.envX ? this.att * s.envX + (1 - this.att) * ax : this.rel * s.envX + (1 - this.rel) * ax;
        let g = 1;
        if (s.envS > thr && s.envS > 0.35 * s.envX) g = Math.max(maxCut, Math.pow(thr / s.envS, 1 - 1 / ratio));
        s.g = g < s.g ? g : s.g + 0.002 * (g - s.g);
        y[i] = lo + hi * s.g;
      }
    }
    return true;
  }
}
registerProcessor('aether-deesser', AetherDeEsser);
`;
