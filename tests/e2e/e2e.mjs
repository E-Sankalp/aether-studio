// Aether end-to-end tests: drives the real app in headless Chrome over the DevTools protocol
// with real mouse/keyboard input and Chrome's fake microphone.
// Run: start the dev server (npx vite --port 5199), then: npm run test:e2e
// Set CHROME_PATH if Chrome isn't at the default Windows location.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = process.argv[2];
const dlDir = join(outDir, 'downloads');
mkdirSync(dlDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'e2e-'))}`,
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 60 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
  } catch {}
  if (!target) await sleep(200);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    pageErrors.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const mid = ++id;
    pending.set(mid, r);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval failed: ' + expr.slice(0, 80) + ' :: ' + r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
// Scroll into view, let layout settle for two frames (sections using content-visibility get
// their real size only once visible), then measure
const center = async (selectorExpr) =>
  evaluate(`(async()=>{const el=${selectorExpr}; if(!el) return null; el.scrollIntoView({block:'nearest',inline:'nearest'}); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})()`);
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...extra });
const clickAt = async (x, y, clickCount = 1) => {
  await mouse('mouseMoved', x, y, { buttons: 0 });
  await mouse('mousePressed', x, y, { clickCount });
  await mouse('mouseReleased', x, y, { clickCount });
};
const click = async (selectorExpr) => {
  const c = await center(selectorExpr);
  if (!c) throw new Error('not found: ' + selectorExpr);
  await clickAt(c.x, c.y);
  return c;
};
const drag = async (x0, y0, x1, y1, steps = 8) => {
  await mouse('mouseMoved', x0, y0, { buttons: 0 });
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  await mouse('mouseReleased', x1, y1);
};
const MOD = { ctrl: 2, shift: 8 };
const key = async (key, code, modifiers = 0, text) => {
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers, text, windowsVirtualKeyCode: keyCodeOf(key) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCodeOf(key) });
};
function keyCodeOf(k) {
  const map = { ' ': 32, Enter: 13, Backspace: 8, Delete: 46, Home: 36 };
  if (map[k] !== undefined) return map[k];
  return k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
}
const shot = async (name, w = 1440, h = 900) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
};
const byText = (sel, re) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>${re}.test(e.textContent))`;
const timecode = () => evaluate(`(()=>{const t=document.querySelector('header span.brand-text.tabular-nums')?.textContent||'00:00.00'; const [m,s]=t.split(':'); return +m*60 + +s})()`);
const clipCount = () => evaluate(`document.querySelectorAll('[data-clip-id]').length`);
const toasts = () => evaluate(`[...document.querySelectorAll('[role=status],[role=alert]')].map(e=>e.textContent.trim())`);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    check(name, false, 'threw: ' + err.message);
  }
};

await send('Runtime.enable');
await send('Page.enable');
{
  // Downloads are a browser-level permission: use the browser target, not the page
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => bws.addEventListener('open', r));
  const res = await new Promise((r) => {
    bws.addEventListener('message', (e) => r(JSON.parse(e.data)));
    bws.send(JSON.stringify({
      id: 1,
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: dlDir.replace(/\//g, '\\'), eventsEnabled: true },
    }));
  });
  if (res.error) console.log('download setup error:', JSON.stringify(res.error));
}
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5199/' });
await sleep(4000);


// ---- helpers for the newer features
const clipRects = () =>
  evaluate(`[...document.querySelectorAll('[data-clip-id]')].map(el=>{const r=el.getBoundingClientRect(); return {id: el.dataset.clipId, x:r.left, y:r.top, w:r.width, h:r.height, left: parseFloat(el.style.left), selected: /ring-2/.test(el.className)}})`);
const clickWithShift = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1, modifiers: 8 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0, modifiers: 8 });
};
const overlapsOnSameTrack = () =>
  evaluate(`(()=>{const rows=new Map(); for(const el of document.querySelectorAll('[data-clip-id]')){const lane=el.parentElement; const l=parseFloat(el.style.left), w=parseFloat(el.style.width); if(!rows.has(lane)) rows.set(lane,[]); rows.get(lane).push([l,l+w]);} for(const list of rows.values()){list.sort((a,b)=>a[0]-b[0]); for(let i=1;i<list.length;i++) if(list[i][0] < list[i-1][1]-1) return true;} return false})()`);

// 1. First launch
await step('first launch opens Home with no project', async () => {
  const hasField = await evaluate(`!!document.querySelector('input[aria-label="Project name"]')`);
  const hero = await evaluate(`/Record, mix & master/.test(document.body.innerText)`);
  check('first launch opens Home with no project', !hasField && hero);
  await shot('01-home');
});
await step('home offers the demo when no project is open', async () => {
  check('home offers templates when no project is open', await evaluate(`/Demo song/.test(document.body.innerText) && /New project/.test(document.body.innerText)`));
});

// 2. Demo template
await step('demo template loads tracks & clips', async () => {
  await click(byText('button', '/Demo song/'));
  await sleep(1500);
  const n = await clipCount();
  const name = await evaluate(`document.querySelector('input[aria-label="Project name"]')?.value`);
  check('demo template loads tracks & clips', n >= 3 && name === 'Demo Song', `${n} clips, name "${name}"`);
  await shot('02-studio');
});

// 3. Playback + seamless loop (demo loops 0-8 s)
await step('playback advances & loop wraps', async () => {
  await key(' ', 'Space', 0, ' ');
  await sleep(1500);
  const t1 = await timecode();
  await sleep(8000);
  const t2 = await timecode();
  const playing = await evaluate(`document.querySelector('button[aria-label=Pause]')!==null`);
  check('playback advances', t1 > 0.8 && t1 < 2.5, `t=${t1.toFixed(2)}s after 1.5 s`);
  check('loop wraps back inside 0–8 s and keeps playing', playing && t2 < 8 && t2 > 0.5, `t=${t2.toFixed(2)}s after 9.5 s`);
  await key(' ', 'Space', 0, ' ');
  await sleep(300);
  const stopped = await evaluate(`document.querySelector('button[aria-label=Play]')!==null`);
  check('Space stops playback', stopped);
});

// 4. Loop region: double-click bar 2 in the ruler
await step('double-click ruler bar loops it', async () => {
  const ruler = await evaluate(`(()=>{const el=document.querySelector('[title^="Click to move the playhead"]'); const r=el.getBoundingClientRect(); return {x:r.left,y:r.top+r.height/2}})()`);
  const pps = 88; // default zoom
  const barPx = 2 * pps; // 4 beats @120 = 2 s
  await clickAt(ruler.x + barPx * 1.5, ruler.y, 1);
  await clickAt(ruler.x + barPx * 1.5, ruler.y, 2);
  await sleep(400);
  const loopBox = await evaluate(`(()=>{const el=document.querySelector('[title="Drag to move the loop"]')?.parentElement; if(!el) return null; return {left: parseFloat(el.style.left), width: parseFloat(el.style.width)}})()`);
  check('double-click ruler bar loops it', loopBox && Math.abs(loopBox.left - barPx) < 2 && Math.abs(loopBox.width - barPx) < 2, JSON.stringify(loopBox));
  // drag its right edge one bar further
  const edge = await center(`document.querySelector('[title="Drag to set loop end"]')`);
  await drag(edge.x, edge.y, edge.x + barPx, edge.y);
  await sleep(300);
  const after = await evaluate(`(()=>{const el=document.querySelector('[title="Drag to move the loop"]').parentElement; return parseFloat(el.style.width)})()`);
  check('dragging the loop end resizes it', Math.abs(after - 2 * barPx) < 2, `width ${after}px`);
});

// 5. Split / undo / redo / duplicate / delete via keyboard
await step('clip editing shortcuts', async () => {
  const before = await clipCount();
  // seek to 3 s (inside the first clips) and select the first clip
  const ruler = await evaluate(`(()=>{const el=document.querySelector('[title^="Click to move the playhead"]'); const r=el.getBoundingClientRect(); return {x:r.left,y:r.top+r.height/2}})()`);
  await clickAt(ruler.x + 3 * 88, ruler.y);
  await sleep(200);
  const clip = await center(`document.querySelector('[data-clip-id]')`);
  await clickAt(clip.x - clip.w / 2 + 30, clip.y + 10);
  await sleep(200);
  await key('s', 'KeyS', 0, 's');
  await sleep(300);
  const afterSplit = await clipCount();
  check('S splits the selected clip at the playhead', afterSplit === before + 1, `${before} → ${afterSplit}`);
  await key('z', 'KeyZ', MOD.ctrl);
  await sleep(300);
  check('Ctrl+Z undoes the split', (await clipCount()) === before);
  await key('z', 'KeyZ', MOD.ctrl | MOD.shift);
  await sleep(300);
  check('Ctrl+Shift+Z redoes it', (await clipCount()) === before + 1);
  await key('d', 'KeyD', MOD.ctrl);
  await sleep(300);
  check('Ctrl+D duplicates', (await clipCount()) === before + 2);
  await key('Delete', 'Delete');
  await sleep(300);
  check('Delete removes the selected clip', (await clipCount()) === before + 1);
});

// 6. Clip move is one undo step
await step('clip drag is undoable as one step', async () => {
  // the right-most clip has free space after it (dropping onto a neighbour would snap back)
  const target = (await clipRects()).sort((p, q) => q.x + q.w - (p.x + p.w))[0];
  const sel = `document.querySelector('[data-clip-id="${target.id}"]')`;
  const c = await center(sel);
  const leftBefore = await evaluate(`parseFloat(${sel}.style.left)`);
  await drag(c.x, c.y + 10, c.x + 120, c.y + 10, 12);
  await sleep(300);
  const leftAfter = await evaluate(`parseFloat(${sel}.style.left)`);
  await key('z', 'KeyZ', MOD.ctrl);
  await sleep(300);
  const leftUndo = await evaluate(`parseFloat(${sel}.style.left)`);
  check('clip drag moves the clip', Math.abs(leftAfter - leftBefore) > 60, `${leftBefore} → ${leftAfter}`);
  check('one Ctrl+Z restores the whole drag', Math.abs(leftUndo - leftBefore) < 1, `undo → ${leftUndo}`);
});

// 7. BPM typing
await step('BPM can be typed', async () => {
  await click(`document.querySelector('input[aria-label="Tempo in BPM"]')`);
  await key('a', 'KeyA', MOD.ctrl);
  await send('Input.insertText', { text: '95' });
  await key('Enter', 'Enter', 0, '\r');
  await sleep(300);
  const v = await evaluate(`document.querySelector('input[aria-label="Tempo in BPM"]').value`);
  check('BPM can be typed (95)', v === '95', `value ${v}`);
});

// 7b. Shortcut help + idle meter silence (DC-offset regression)
await step('shortcuts dialog', async () => {
  await click(`document.querySelector('[data-clip-id]')`); // focus the timeline, not an input
  await key('?', 'Slash', MOD.shift, '?');
  await sleep(300);
  const open = await evaluate(`!!document.querySelector('[role=dialog]')`);
  await shot('03b-shortcuts');
  await key('Escape', 'Escape');
  await sleep(200);
  const closed = await evaluate(`!document.querySelector('[role=dialog]')`);
  check('? opens the shortcuts list and Esc closes it', open && closed);
});
await step('idle meter is silent', async () => {
  await sleep(2500);
  const lufs = await evaluate(`[...document.querySelectorAll('header button[aria-label="Output visualizer and loudness"] span')].map(s=>s.textContent).join(' ')`);
  check('meter reads -∞ when nothing plays (no DC offset)', /-∞/.test(lufs), lufs);
});

// 7c. Precision slider behaviour (touch + mouse + keyboard)
await step('precision sliders', async () => {
  await click(`[...document.querySelectorAll('aside button')].find(b=>/^\\s*Mixer\\s*$/.test(b.textContent))`);
  await sleep(300);
  const SEL = `document.querySelector('aside [role=slider][aria-label="Pan"]')`;
  const info = async () =>
    evaluate(`(async()=>{const el=${SEL}; el.scrollIntoView({block:'center'}); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); const r=el.getBoundingClientRect(); return {x:r.left,y:r.top+r.height/2,w:r.width,v:+el.getAttribute('aria-valuenow'),scroll:el.closest('.overflow-y-auto')?.scrollTop ?? 0}})()`);
  const touch = (type, x, y) =>
    send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });

  // 1. vertical swipe that starts on the slider: page scrolls, value unchanged
  let s = await info();
  const v0 = s.v;
  const sc0 = s.scroll;
  const x = s.x + s.w * 0.8;
  await touch('touchStart', x, s.y);
  for (let i = 1; i <= 10; i++) await touch('touchMove', x + i * 0.6, s.y - i * 14);
  await touch('touchEnd', 0, 0);
  await sleep(400);
  let after = await evaluate(`({v:+${SEL}.getAttribute('aria-valuenow'), scroll:${SEL}.closest('.overflow-y-auto')?.scrollTop ?? 0})`);
  check('touch: vertical swipe over a slider scrolls and does not change it', after.v === v0 && after.scroll !== sc0, `value ${v0} → ${after.v}, scroll ${sc0} → ${after.scroll}`);

  // 2. a tap far from the thumb does nothing
  s = await info();
  await touch('touchStart', s.x + s.w * 0.95, s.y);
  await touch('touchEnd', 0, 0);
  await sleep(350); // longer than double-tap window
  after = await info();
  check('touch: a tap never changes the value', after.v === s.v, `${s.v} → ${after.v}`);

  // 3. sideways drag of 40 px moves relative to the current value (no jump to the finger)
  s = await info();
  const startX = s.x + s.w * 0.9; // far from the thumb at centre
  await touch('touchStart', startX, s.y);
  for (let i = 1; i <= 8; i++) await touch('touchMove', startX + i * 5, s.y);
  await touch('touchEnd', 0, 0);
  await sleep(200);
  after = await info();
  const expected = (40 - 6) / s.w * 2; // pan range is 2 (-1..1); first 6 px only start the drag
  check('touch: sideways drag changes the value relative to where it was', after.v > s.v && Math.abs(after.v - s.v - expected) < 0.12, `${s.v} → ${after.v} (expected ≈ +${expected.toFixed(2)})`);
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // 4. mouse: Shift-drag is 10x finer than a normal drag
  const dragBy = async (px, modifiers) => {
    const r = await info();
    const thumbX = r.x + ((r.v + 1) / 2) * r.w;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: thumbX, y: r.y, buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: thumbX, y: r.y, button: 'left', clickCount: 1, buttons: 1, modifiers });
    for (let i = 1; i <= 10; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: thumbX - (px * i) / 10, y: r.y, button: 'left', buttons: 1, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: thumbX - px, y: r.y, button: 'left', clickCount: 1, buttons: 0, modifiers });
    await sleep(150);
    return (await info()).v - r.v;
  };
  const normal = await dragBy(60, 0);
  const fine = await dragBy(60, 8);
  check('mouse: Shift-drag is ~10x finer', normal < 0 && fine < 0 && Math.abs(fine) < Math.abs(normal) * 0.25, `60 px: normal ${normal.toFixed(2)}, shift ${fine.toFixed(2)}`);

  // 5. type an exact value in the readout (linear slider), and Pan's "25 R" syntax
  const RSEL = `document.querySelector('aside [role=slider][aria-label="Reverb send"]')`;
  const typeInto = async (sel, text) => {
    const can = await evaluate(`(()=>{const b=${sel}.parentElement.querySelector('button'); if(!b || b.disabled) return false; b.click(); return true})()`);
    if (!can) return false;
    await sleep(150);
    const focused = await evaluate(`document.activeElement?.getAttribute('aria-label') || ''`);
    if (!/value$/.test(focused)) return false;
    await key('a', 'KeyA', MOD.ctrl);
    await send('Input.insertText', { text });
    await key('Enter', 'Enter', 0, '\r');
    await sleep(250);
    return true;
  };
  const typed = await typeInto(RSEL, '25');
  const rv = await evaluate(`+${RSEL}.getAttribute('aria-valuenow')`);
  check('typing an exact value in the readout sets it', typed && Math.abs(rv - 0.25) < 0.001, `reverb send = ${rv}`);
  const typedPan = await typeInto(SEL, '30 R');
  const pv = await evaluate(`+${SEL}.getAttribute('aria-valuenow')`);
  check('Pan accepts "30 R" typed', typedPan && Math.abs(pv - 0.3) < 0.001, `pan = ${pv}`);

  // 6. keyboard nudges by one step (focus via keyboard, not a click: a click on the track jumps)
  await evaluate(`${RSEL}.focus()`);
  await key('ArrowLeft', 'ArrowLeft');
  await sleep(150);
  const kb = await evaluate(`+${RSEL}.getAttribute('aria-valuenow')`);
  check('arrow keys nudge by one step', Math.abs(kb - 0.24) < 0.001, `reverb send = ${kb}`);
  // leave the mix as it was for later steps
  await typeInto(RSEL, '0');
  await typeInto(SEL, 'c');
});

// 8. Clip process slider (commit on release, rendered in worker)
await step('clip process slider renders in background', async () => {
  const clip = await center(`document.querySelector('[data-clip-id]')`);
  await clickAt(clip.x, clip.y + 10);
  await click(`[...document.querySelectorAll('aside button')].find(b=>/^\\s*Edit\\s*$/.test(b.textContent))`);
  await sleep(400);
  const slider = await evaluate(`(()=>{const el=document.querySelector('aside [role=slider][aria-label="Normalize peak"]'); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.left,y:r.top+r.height/2,w:r.width}})()`);
  if (!slider) throw new Error('Normalize slider not found');
  await drag(slider.x + 2, slider.y, slider.x + slider.w * 0.8, slider.y, 10);
  await sleep(150);
  const rendering = await evaluate(`/Rendering/.test(document.querySelector('aside').innerText)`);
  await sleep(2500);
  const badge = await evaluate(`[...document.querySelectorAll('[data-clip-id]')].some(c=>/Norm \\d+%/.test(c.textContent))`);
  const stillRendering = await evaluate(`/Rendering/.test(document.querySelector('aside').innerText)`);
  check('process slider commits on release and renders', badge && !stillRendering, `spinner seen: ${rendering}, badge: ${badge}`);
  await key('z', 'KeyZ', MOD.ctrl);
  await sleep(400);
  const badgeAfterUndo = await evaluate(`[...document.querySelectorAll('[data-clip-id]')].some(c=>/Norm \\d+%/.test(c.textContent))`);
  check('process change is undoable', !badgeAfterUndo);
  await shot('03-edit-panel');
});

// 9. Mixer tab: mastering analysis
await step('mastering analysis', async () => {
  await click(`[...document.querySelectorAll('aside button')].find(b=>/^\\s*Mixer\\s*$/.test(b.textContent))`);
  await sleep(300);
  await click(byText('aside button', '/Analyze loudness/'));
  const t0 = Date.now();
  await sleep(500);
  while (Date.now() - t0 < 40000 && /Analyzing/.test(await evaluate(`document.querySelector('aside').innerText`))) await sleep(300);
  const txt = await evaluate(`document.querySelector('aside').innerText`);
  const m = /Mastered\s*(-?[\d.]+) LUFS/.exec(txt);
  console.log(`      (analysis took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  check('analysis reaches the -14 LUFS streaming target', m && Math.abs(+m[1] + 14) < 1, m ? `${m[1]} LUFS` : 'no report');
  await shot('04-mixer');
});

// 10. Export WAV
await step('WAV export produces a valid file', async () => {
  // Capture the file the app hands to the download link, and every toast that appears
  await evaluate(`(()=>{window.__exports=[]; window.__toasts=new Set(); const o=URL.createObjectURL.bind(URL); URL.createObjectURL=(b)=>{window.__exports.push(b); return o(b)}; const a=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){window.__dlName=this.download; return a.call(this)}; window.__tw=setInterval(()=>document.querySelectorAll('[role=status],[role=alert]').forEach(e=>window.__toasts.add(e.textContent.trim())),100); return true})()`);
  await click(`document.querySelector('button[aria-label="Export audio"]')`);
  await sleep(300);
  await click(byText('[role=menu] button', '/WAV · 16-bit/'));
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !(await evaluate(`window.__exports.length`))) await sleep(300);
  const info = await evaluate(`(async()=>{const b=window.__exports[0]; if(!b) return null; const u=new Uint8Array(await b.arrayBuffer()); const s=(a,n)=>String.fromCharCode(...u.slice(a,a+n)); const dv=new DataView(u.buffer); return {name: window.__dlName, type:b.type, size:b.size, riff:s(0,4), wave:s(8,4), channels:dv.getUint16(22,true), rate:dv.getUint32(24,true), bits:dv.getUint16(34,true), dataBytes:dv.getUint32(40,true)}})()`);
  console.log(`      (export took ${((Date.now() - t0) / 1000).toFixed(1)} s)`, JSON.stringify(info));
  if (!info) throw new Error('export produced no file');
  const seconds = info.dataBytes / (info.rate * info.channels * (info.bits / 8));
  check('WAV export produces a valid 16-bit stereo file', info.riff === 'RIFF' && info.wave === 'WAVE' && info.bits === 16 && info.channels === 2 && seconds > 5, `${info.name}, ${seconds.toFixed(1)} s`);
  await sleep(500);
  check('export shows a success toast', (await evaluate(`[...window.__toasts]`)).some((t) => /Exported/.test(t)));
});

await step('stem export at 48 kHz', async () => {
  await evaluate(`window.__exports=[]`);
  await click(`document.querySelector('button[aria-label="Export audio"]')`);
  await sleep(300);
  await click(`[...document.querySelectorAll('[role=menu] [role=radio]')].find(b=>b.textContent.trim()==='Stems (ZIP)')`);
  await click(`[...document.querySelectorAll('[role=menu] [role=radio]')].find(b=>b.textContent.trim()==='48k')`);
  await sleep(150);
  await click(byText('[role=menu] button', '/WAV · 24-bit/'));
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && !(await evaluate(`window.__exports.length`))) await sleep(300);
  // Read the ZIP's central directory, then each WAV header inside it
  const zip = await evaluate(`(async()=>{const b=window.__exports[0]; if(!b) return null; const u=new Uint8Array(await b.arrayBuffer()); const v=new DataView(u.buffer); const e=u.length-22; if(v.getUint32(e,true)!==0x06054b50) return {bad:'no EOCD'}; const n=v.getUint16(e+10,true); let cd=v.getUint32(e+16,true); const files=[]; for(let i=0;i<n;i++){const nl=v.getUint16(cd+28,true); const size=v.getUint32(cd+24,true); const lo=v.getUint32(cd+42,true); const name=new TextDecoder().decode(u.subarray(cd+46,cd+46+nl)); const d=lo+30+v.getUint16(lo+26,true); files.push({name, size, riff:String.fromCharCode(...u.subarray(d,d+4)), rate:v.getUint32(d+24,true), bits:v.getUint16(d+34,true), frames:v.getUint32(d+40,true)/(v.getUint16(d+22,true)*v.getUint16(d+34,true)/8)}); cd+=46+nl;} return {name:window.__dlName, type:b.type, files}})()`);
  console.log(`      (stems took ${((Date.now() - t0) / 1000).toFixed(1)} s)`, JSON.stringify(zip));
  if (!zip || zip.bad) throw new Error('no stem zip: ' + JSON.stringify(zip));
  const expected = await evaluate(`(async()=>{const e=(await import(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>u.includes('/src/audio/audioEngine.ts')).pop())).audioEngine; return e.lastSyncedTracks.filter(t=>!t.muted).length})()`);
  const ok = zip.files.length === expected && zip.files.every((f) => f.riff === 'RIFF' && f.rate === 48000 && f.bits === 24);
  const sameLength = new Set(zip.files.map((f) => f.frames)).size === 1;
  check('stems export one 24-bit / 48 kHz WAV per track in a ZIP', ok && /_stems\.zip$/.test(zip.name), `${zip.name}: ${zip.files.map((f) => f.name).join(', ')}`);
  check('all stems have the same length (they line up)', sameLength, `${zip.files[0]?.frames} frames`);
  // back to the defaults for the rest of the run
  await click(`document.querySelector('button[aria-label="Export audio"]')`);
  await sleep(300);
  await click(`[...document.querySelectorAll('[role=menu] [role=radio]')].find(b=>b.textContent.trim()==='Full mix')`);
  await click(`[...document.querySelectorAll('[role=menu] [role=radio]')].find(b=>b.textContent.trim()==='44.1k')`);
  await key('Escape', 'Escape');
  await sleep(200);
});

// 10b. Multi-select, group drag, copy/paste, overlap resolution
await step('multi-select & clipboard', async () => {
  await click(`document.querySelector('[data-clip-id]')`);
  await sleep(200);
  // two clips on different tracks, each the last on its row (free space to drag into)
  const rects = await clipRects();
  const rows = [...new Set(rects.map((r) => Math.round(r.y)))];
  const lastInRow = (y) => rects.filter((r) => Math.round(r.y) === y).sort((p, q) => q.x - p.x)[0];
  const a = lastInRow(rows[0]);
  const b = lastInRow(rows[1]);
  await clickAt(a.x + 20, a.y + a.h / 2);
  await sleep(150);
  await clickWithShift(b.x + 20, b.y + b.h / 2);
  await sleep(250);
  const sel = (await clipRects()).filter((r) => r.selected).map((r) => r.id).sort();
  check('Shift+click selects multiple clips', sel.length === 2 && sel.includes(a.id) && sel.includes(b.id), `${sel.length} selected`);

  // group drag: drag clip a by +1 s; b must move by the same amount
  const before = Object.fromEntries((await clipRects()).map((r) => [r.id, r.left]));
  await drag(a.x + 20, a.y + a.h / 2, a.x + 20 + 88, a.y + a.h / 2, 10);
  await sleep(300);
  const after = Object.fromEntries((await clipRects()).map((r) => [r.id, r.left]));
  const da = after[a.id] - before[a.id];
  const dbb = after[b.id] - before[b.id];
  check('dragging moves the whole selection together', da > 40 && Math.abs(da - dbb) < 1, `a +${da.toFixed(0)}px, b +${dbb.toFixed(0)}px`);
  check('no clips overlap after the drop', !(await overlapsOnSameTrack()));
  await key('z', 'KeyZ', MOD.ctrl);
  await sleep(300);
  const undone = Object.fromEntries((await clipRects()).map((r) => [r.id, r.left]));
  check('one undo restores the group move', Math.abs(undone[a.id] - before[a.id]) < 1 && Math.abs(undone[b.id] - before[b.id]) < 1);

  // copy/paste at the playhead (Home -> paste at 0 would overlap: must be resolved)
  const n0 = await clipCount();
  await clickAt(a.x + 20, a.y + a.h / 2);
  await clickWithShift(b.x + 20, b.y + b.h / 2);
  await key('c', 'KeyC', MOD.ctrl);
  await key('Home', 'Home');
  await key('v', 'KeyV', MOD.ctrl);
  await sleep(400);
  check('Ctrl+C / Ctrl+V pastes the selection', (await clipCount()) === n0 + 2, `${n0} → ${await clipCount()}`);
  check('pasted clips are placed without overlaps', !(await overlapsOnSameTrack()));
  await key('z', 'KeyZ', MOD.ctrl);
  await sleep(300);
  check('undo removes the paste', (await clipCount()) === n0);

  // drop a clip onto its neighbour: it must snap to a free spot
  const lane = (await clipRects()).sort((p, q) => p.y - q.y || p.x - q.x);
  const rowY = lane[0].y;
  const sameRow = lane.filter((r) => Math.abs(r.y - rowY) < 5).sort((p, q) => p.x - q.x);
  if (sameRow.length >= 2) {
    const [first, second] = sameRow;
    await clickAt(second.x + 20, second.y + second.h / 2);
    await drag(second.x + 20, second.y + second.h / 2, first.x + 40, second.y + second.h / 2, 10);
    await sleep(300);
    check('dropping a clip onto another resolves the overlap', !(await overlapsOnSameTrack()));
    await key('z', 'KeyZ', MOD.ctrl);
    await sleep(200);
  }
  await shot('07-multiselect');
});

// 10c. Volume automation lane
await step('volume automation', async () => {
  const toggle = await center(`document.querySelector('button[aria-label="Show volume automation"]')`);
  await clickAt(toggle.x, toggle.y);
  await sleep(300);
  const svg = await evaluate(`(()=>{const el=document.querySelector('svg[aria-label^="Volume automation"]'); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  check('automation lane opens under the track', !!svg);
  if (!svg) return;
  await clickAt(svg.x + 1 * 88, svg.y + svg.h * 0.3); // ~1 s, high
  await sleep(150);
  await clickAt(svg.x + 3 * 88, svg.y + svg.h * 0.85); // ~3 s, low
  await sleep(300);
  const pts = await evaluate(`document.querySelectorAll('svg[aria-label^="Volume automation"] circle').length`);
  check('clicking the lane adds automation points', pts === 2, `${pts} points`);
  // drag the second point up
  const p2 = await evaluate(`(()=>{const c=document.querySelectorAll('svg[aria-label^="Volume automation"] circle')[1].getBoundingClientRect(); return {x:c.left+c.width/2, y:c.top+c.height/2}})()`);
  await drag(p2.x, p2.y, p2.x, p2.y - 15, 6);
  await sleep(200);
  const y2 = await evaluate(`document.querySelectorAll('svg[aria-label^="Volume automation"] circle')[1].getBoundingClientRect().top`);
  check('dragging a point changes its value', y2 < p2.y - 8);
  await key('z', 'KeyZ', MOD.ctrl);
  await sleep(250);
  const ptsUndo = await evaluate(`document.querySelectorAll('svg[aria-label^="Volume automation"] circle').length`);
  const y2Undo = await evaluate(`(()=>{const c=document.querySelectorAll('svg[aria-label^="Volume automation"] circle')[1]?.getBoundingClientRect(); return c ? c.top + c.height/2 : null})()`);
  check('undo reverts just the last automation gesture', ptsUndo === 2 && y2Undo !== null && Math.abs(y2Undo - p2.y) < 3, `${ptsUndo} points, point back at ${y2Undo?.toFixed(0)} (was ${p2.y.toFixed(0)})`);
  // play through the dip: the track meter must drop near the low point
  await shot('08-automation');
});

// 10d. FX returns + sends
await step('fx returns and sends', async () => {
  await click(`[...document.querySelectorAll('aside button')].find(b=>/^\\s*Mixer\\s*$/.test(b.textContent))`);
  await sleep(300);
  const hasPanel = await evaluate(`/FX returns/.test(document.querySelector('aside').innerText)`);
  check('Mixer shows the shared FX returns', hasPanel);
  const slider = await evaluate(`(()=>{const el=document.querySelector('aside [role=slider][aria-label="Reverb send"]'); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.left,y:r.top+r.height/2,w:r.width}})()`);
  if (!slider) throw new Error('no reverb send slider');
  await drag(slider.x + 2, slider.y, slider.x + slider.w * 0.5, slider.y, 8);
  await sleep(300);
  const txt = await evaluate(`document.querySelector('aside [role=slider][aria-label="Reverb send"]').getAttribute('aria-valuetext')`);
  const pct = +(/(\d+)%/.exec(txt)?.[1] ?? 0);
  check('a track reverb send can be set', pct >= 30 && pct <= 70, txt.trim());
  const delayButton = await center(`[...document.querySelectorAll('[role=radio]')].find(b=>b.textContent.trim()==='1/4')`);
  await clickAt(delayButton.x, delayButton.y);
  await sleep(200);
  const ms = await evaluate(`/(\\d+) ms @/.exec(document.querySelector('aside').innerText)?.[1]`);
  check('delay syncs to tempo (1/4 note at 95 BPM = 632 ms)', ms === '632', `${ms} ms`);
  await shot('09-returns');
});

await step('compressor & ducking', async () => {
  const engine = `(await import(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>u.includes('/src/audio/audioEngine.ts')).pop())).audioEngine`;
  // Mixer: duck the first track under the second
  await click(`[...document.querySelectorAll('aside button')].find(b=>/^\\s*Mixer\\s*$/.test(b.textContent))`);
  await sleep(300);
  const keyName = await evaluate(`(()=>{const s=document.querySelector('aside select[id^=duck-]'); const opt=s.options[1]; const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,opt.value); s.dispatchEvent(new Event('change',{bubbles:true})); return opt.textContent})()`);
  await sleep(400);
  const wired = await evaluate(`(async()=>{const e=${engine}; return e.duckWired.size})()`);
  const amount = await evaluate(`document.querySelector('aside [role=slider][aria-label="Duck amount"]')?.getAttribute('aria-valuetext')`);
  check('a track can duck under another', wired === 1 && /-6\.0 dB/.test(amount || ''), `key ${keyName}, wired ${wired}, ${amount}`);
  await evaluate(`document.querySelector('aside select[id^=duck-]').scrollIntoView({block:'center'})`);
  await shot('10-ducking');
  // Off again
  await evaluate(`(()=>{const s=document.querySelector('aside select[id^=duck-]'); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,''); s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await sleep(300);
  const unwired = await evaluate(`(async()=>{const e=${engine}; return e.duckWired.size})()`);
  check('ducking can be switched off', unwired === 0, `wired ${unwired}`);

  // FX: compressor on with a low threshold -> the gain-reduction meter moves while playing
  await click(`[...document.querySelectorAll('aside button')].find(b=>/^\\s*FX\\s*$/.test(b.textContent) || /^\\s*Effects\\s*$/.test(b.textContent))`);
  await sleep(300);
  const sw = await evaluate(`(()=>{const sec=[...document.querySelectorAll('aside section')].find(e=>e.querySelector(':scope > [role=button] > span')?.textContent.trim()==='Compressor'); const s=sec?.querySelector('[role=switch]'); if(!s) return null; s.scrollIntoView({block:'center'}); return s.getAttribute('aria-checked')})()`);
  if (sw === null) throw new Error('compressor switch not found');
  if (sw === 'false') await evaluate(`[...document.querySelectorAll('aside section')].find(e=>e.querySelector(':scope > [role=button] > span')?.textContent.trim()==='Compressor').querySelector('[role=switch]').click()`);
  await sleep(300);
  // open the section if collapsed
  const hasMeter = await evaluate(`!!document.querySelector('aside [role=meter][aria-label="Gain reduction"]')`);
  if (!hasMeter) await evaluate(`[...document.querySelectorAll('aside section > [role=button]')].find(b=>/^Compressor/.test(b.textContent.trim())).click()`);
  await sleep(300);
  const th = await evaluate(`(()=>{const el=document.querySelector('aside [role=slider][aria-label="Threshold"]'); el.scrollIntoView({block:'center'}); el.focus(); return el.getAttribute('aria-valuetext')})()`);
  await key('Home', 'Home');
  await sleep(200);
  const th2 = await evaluate(`document.querySelector('aside [role=slider][aria-label="Threshold"]').getAttribute('aria-valuetext')`);
  await key(' ', 'Space', 0, ' ');
  await sleep(2500);
  let minGr = 0;
  for (let i = 0; i < 10; i++) {
    const v = await evaluate(`+document.querySelector('aside [role=meter][aria-label="Gain reduction"]').getAttribute('aria-valuenow')`);
    minGr = Math.min(minGr, v);
    await sleep(100);
  }
  await shot('11-compressor');
  await key(' ', 'Space', 0, ' ');
  await sleep(300);
  check('gain-reduction meter shows compression while playing', minGr <= -3, `threshold ${th} -> ${th2}, GR ${minGr} dB`);
  const mix = await evaluate(`!!document.querySelector('aside [role=slider][aria-label="Mix (parallel)"]')`);
  check('compressor has a parallel Mix control', mix);
  // leave the project as it was (threshold, and the switch if this step turned it on)
  for (let i = 0; i < (sw === 'false' ? 2 : 1); i++) {
    await key('z', 'KeyZ', MOD.ctrl);
    await sleep(250);
  }
});

await step('parametric EQ', async () => {
  const engine = `(await import(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>u.includes('/src/audio/audioEngine.ts')).pop())).audioEngine`;
  const midNode = `(async()=>{const e=${engine}; const id=[...e.trackNodes.keys()].find(k=>document.querySelector('aside').innerText.includes(e.lastSyncedTracks.find(t=>t.id===k)?.name)); const n=e.trackNodes.get(id).eqBands[3]; return {type:n.type, gain:+n.gain.value.toFixed(2), freq:Math.round(n.frequency.value)}})()`;
  const handle = (i) => `(()=>{const el=document.querySelector('aside [data-eq-band="${i}"]'); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,label:el.getAttribute('aria-label')}})()`;
  const open = await evaluate(`!!document.querySelector('aside [data-eq-band]')`);
  if (!open) await evaluate(`[...document.querySelectorAll('aside section > [role=button]')].find(b=>/^Equalizer/.test(b.textContent.trim())).click()`);
  await sleep(300);
  await evaluate(`document.querySelector('aside [aria-label="EQ curve"]').scrollIntoView({block:'center'})`);
  await sleep(200);
  let h = await evaluate(handle(3));
  if (!h) throw new Error('EQ handles not found');
  // Touch: a tap only selects (no change); vertical swipe on the graph (not a handle) changes nothing
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const touch = async (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const before = await evaluate(handle(3));
  await touch('touchStart', h.x, h.y); await sleep(40); await touch('touchMove', h.x + 1, h.y - 1); await sleep(40); await touch('touchEnd');
  await sleep(200);
  const afterTap = await evaluate(handle(3));
  check('tapping an EQ handle selects it without changing it', afterTap.label === before.label, afterTap.label);
  // Touch drag the handle up 40 px -> gain rises
  await touch('touchStart', h.x, h.y);
  for (let k = 1; k <= 8; k++) { await touch('touchMove', h.x, h.y - k * 5); await sleep(16); }
  await touch('touchEnd');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await sleep(300);
  const afterTouch = await evaluate(midNode);
  check('dragging an EQ handle by touch raises the band', afterTouch.gain > 3, JSON.stringify(afterTouch));
  // Mouse: drag right one octave-ish, Shift-drag for fine changes
  h = await evaluate(handle(3));
  await drag(h.x, h.y, h.x + 60, h.y, 8);
  await sleep(300);
  const afterMouse = await evaluate(midNode);
  check('dragging an EQ handle with the mouse moves its frequency', afterMouse.freq > afterTouch.freq * 1.5, `${afterTouch.freq} -> ${afterMouse.freq} Hz`);
  // Keyboard: focused handle, ArrowDown = -0.5 dB
  await evaluate(`document.querySelector('aside [data-eq-band="3"]').focus()`);
  await key('ArrowDown', 'ArrowDown');
  await sleep(250);
  const afterKey = await evaluate(midNode);
  check('arrow keys nudge the focused band', Math.abs(afterMouse.gain - 0.5 - afterKey.gain) < 0.06, `${afterMouse.gain} -> ${afterKey.gain} dB`);
  // Low cut: switch on via tab + switch -> node becomes a highpass
  await click(`document.querySelector('aside [role=tab][title="Low cut"]')`);
  await sleep(150);
  await click(`document.querySelector('aside [role=switch][aria-label="Low cut on"]')`);
  await sleep(250);
  const hp = await evaluate(`(async()=>{const e=${engine}; const n=[...e.trackNodes.values()].map(t=>t.eqBands[0]).find(n=>n.type==='highpass'); return !!n})()`);
  check('a low cut band can be switched on', hp);
  // Analyzer draws while playing
  await key(' ', 'Space', 0, ' ');
  await sleep(1200);
  const live = await evaluate(`(async()=>{const e=${engine}; const sp=e.spectrum; return sp ? Math.max(...sp.data) : null})()`);
  await shot('12-eq');
  await key(' ', 'Space', 0, ' ');
  await sleep(300);
  check('EQ analyzer shows the track spectrum while playing', live !== null && live > -90, `peak bin ${live?.toFixed?.(1)} dB`);
  // Back to flat via the header button, then undo history is intact
  await click(`[...document.querySelectorAll('aside section > [role=button] button')].find(b=>b.textContent.trim()==='Flat')`);
  await sleep(300);
  const flat = await evaluate(midNode);
  check('"Flat" resets the EQ', flat.gain === 0 && !(await evaluate(`(async()=>{const e=${engine}; return [...e.trackNodes.values()].some(t=>t.eqBands[0].type==='highpass')})()`)), JSON.stringify(flat));
});

await step('reference track A/B', async () => {
  const engine = `(await import(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>u.includes('/src/audio/audioEngine.ts')).pop())).audioEngine`;
  // 6 s stereo 16-bit WAV: 220 Hz + 2.2 kHz tones at a known level
  const sr = 44100, n = sr * 6, wav = Buffer.alloc(44 + n * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 4, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(sr, 24);
  wav.writeUInt32LE(sr * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(32767 * (0.25 * Math.sin(2 * Math.PI * 220 * i / sr) + 0.1 * Math.sin(2 * Math.PI * 2200 * i / sr)));
    wav.writeInt16LE(v, 44 + i * 4); wav.writeInt16LE(v, 46 + i * 4);
  }
  const refPath = join(dlDir, '..', 'reference-song.wav');
  writeFileSync(refPath, wav);

  await click(`[...document.querySelectorAll('aside button')].find(b=>/^\\s*Mixer\\s*$/.test(b.textContent))`);
  await sleep(300);
  const { root } = await send('DOM.getDocument', { depth: -1 }).then((r) => r.result);
  const { nodeId } = (await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[aria-label="Reference audio file"]' })).result;
  if (!nodeId) throw new Error('reference file input not found');
  await send('DOM.setFileInputFiles', { nodeId, files: [refPath] });
  let msg = '';
  for (let i = 0; i < 40 && !/to match your mix/.test(msg); i++) {
    await sleep(250);
    msg = await evaluate(`document.querySelector('aside [aria-live=polite]')?.textContent || ''`);
  }
  const name = await evaluate(`/reference-song/.test(document.querySelector('aside').innerText)`);
  check('a reference song can be loaded and is level-matched', name && /turned (down|up) [\d.]+ dB to match your mix/.test(msg), msg);
  const g = await evaluate(`(async()=>{const e=${engine}; return e.refGainDb})()`);
  const shown = +(/([\d.]+) dB to match/.exec(msg)?.[1] ?? NaN);
  check('the reference gain applied in the engine is the one shown', Math.abs(Math.abs(g) - shown) < 0.06, `engine ${g.toFixed(2)} dB, shown ${shown}`);

  await evaluate(`document.querySelector('aside [role=radiogroup][aria-label=Monitor]').scrollIntoView({block:'center'})`);
  await click(`[...document.querySelectorAll('aside [role=radio]')].find(b=>/Reference/.test(b.textContent))`);
  await key(' ', 'Space', 0, ' ');
  await sleep(1500);
  const st = await evaluate(`(async()=>{const e=${engine}; return {nodes:e.refNodes.size, mix:+e.abMix.gain.value.toFixed(3), ref:+e.refBus.gain.value.toFixed(3), pos:e.getTimelinePosition()}})()`);
  const pill = await evaluate(`/Hearing reference/.test(document.body.innerText)`);
  await shot('13-reference');
  check('B plays the reference in place of the mix', st.nodes > 0 && st.mix < 0.01 && st.ref > 0 && pill, JSON.stringify(st));
  await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Back to mix')`);
  await sleep(300);
  const back = await evaluate(`(async()=>{const e=${engine}; return {mix:+e.abMix.gain.value.toFixed(3), ref:+e.refBus.gain.value.toFixed(3)}})()`);
  const pillGone = await evaluate(`!/Hearing reference/.test(document.body.innerText)`);
  check('"Back to mix" returns to A', back.mix > 0.95 && back.ref < 0.01 && pillGone, JSON.stringify(back));
  await key(' ', 'Space', 0, ' ');
  await sleep(300);
  await click(`document.querySelector('aside [aria-label="Remove reference"]')`);
  await sleep(200);
  const removed = await evaluate(`(async()=>{const e=${engine}; return !e.hasReference()})()`);
  check('the reference can be removed', removed);
});

// 11. Recording with the fake microphone (count-in on)
await step('recording creates a take', async () => {
  const before = await clipCount();
  await key('Home', 'Home');
  await key('r', 'KeyR', 0, 'r');
  let countIn = false;
  for (let i = 0; i < 40 && !countIn; i++) {
    countIn = await evaluate(`/\\d \\/ 4/.test(document.querySelector('header').innerText)`);
    if (!countIn) await sleep(100);
  }
  await sleep(4500);
  await key('r', 'KeyR', 0, 'r');
  await sleep(1500);
  const after = await clipCount();
  const take = await evaluate(`[...document.querySelectorAll('[data-clip-id]')].some(c=>/Take/.test(c.textContent))`);
  check('count-in shows before recording', countIn);
  check('recording creates a take clip', after === before + 1 && take, `${before} → ${after}`);
  check('a recorded take never overlaps existing clips', !(await overlapsOnSameTrack()));
  await shot('05-recorded');
});

// 11b. Loop recording -> takes -> comping
await step('loop recording makes takes', async () => {
  // loop bar 1 (one bar at 95 BPM = 2.53 s), count-in off for speed
  const ruler = await evaluate(`(()=>{const el=document.querySelector('[title^="Click to move the playhead"]'); const r=el.getBoundingClientRect(); return {x:r.left,y:r.top+r.height/2}})()`);
  await clickAt(ruler.x + 30, ruler.y, 1);
  await clickAt(ruler.x + 30, ruler.y, 2);
  await sleep(300);
  const countInOn = await evaluate(`document.querySelector('button[aria-label^="4-beat count-in"]').getAttribute('aria-pressed')==='true'`);
  if (countInOn) await click(`document.querySelector('button[aria-label^="4-beat count-in"]')`);
  const tracksBefore = await evaluate(`document.querySelectorAll('button[aria-label="Show volume automation"]').length`);
  await key('r', 'KeyR', 0, 'r');
  // Record until the loop has wrapped 3 times on the AUDIO clock (a loaded machine can run the
  // audio clock slower than wall-clock time, so a fixed sleep isn't reliable)
  let wraps = 0;
  let last = 0;
  const t0 = Date.now();
  while (wraps < 3 && Date.now() - t0 < 40000) {
    await sleep(100);
    const t = await timecode();
    if (t + 0.5 < last) wraps++;
    last = t;
  }
  await sleep(1200); // part of a 4th pass
  await key('r', 'KeyR', 0, 'r');
  await sleep(1500);
  const takes = await evaluate(`[...document.querySelectorAll('[role=radiogroup][aria-label=Takes] [role=radio]')].map(b=>({label:b.textContent.trim(), on:b.getAttribute('aria-checked')==='true'}))`);
  check('loop recording creates one take per pass', takes.length >= 3, JSON.stringify(takes.map((t) => t.label + (t.on ? '*' : ''))));
  const tracksAfter = await evaluate(`document.querySelectorAll('button[aria-label="Show volume automation"]').length`);
  check('takes go to a new lane when the loop region is occupied', tracksAfter === tracksBefore + 1, `${tracksBefore} → ${tracksAfter} tracks`);
  if (takes.length >= 2) {
    const first = await center(`document.querySelector('[role=radiogroup][aria-label=Takes] [role=radio]')`);
    const hit = await evaluate(`(()=>{const el=document.elementFromPoint(${first.x}, ${first.y}); return el ? (el.closest('[role=radio]') ? 'take button' : (el.closest('[role=status],[role=alert]') ? 'TOAST' : el.tagName + '.' + String(el.className).slice(0,40))) : null})()`);
    check('no toast covers the Take buttons', hit === 'take button', String(hit));
    await clickAt(first.x, first.y);
    await sleep(1500);
    const active = await evaluate(`[...document.querySelectorAll('[role=radiogroup][aria-label=Takes] [role=radio]')].findIndex(b=>b.getAttribute('aria-checked')==='true')`);
    check('choosing another take switches the clip', active === 0, `active take index ${active}`);
  }
  await shot('10-takes');
});

// 12. Home view: shortcuts disabled, continue chip
await step('home view', async () => {
  await click(`document.querySelector('button[aria-label=Home]')`);
  await sleep(400);
  const before = await clipCount();
  await key('Delete', 'Delete');
  await key(' ', 'Space', 0, ' ');
  await sleep(300);
  await click(`document.querySelector('button[aria-label=Studio]')`);
  await sleep(400);
  const after = await clipCount();
  const playing = await evaluate(`document.querySelector('button[aria-label=Pause]')!==null`);
  check('shortcuts do nothing on Home', after === before && !playing || before === 0 && !playing, `${before}/${after}, playing ${playing}`);
});

// 13. Persistence across reload
await step('project survives reload', async () => {
  const name = await evaluate(`document.querySelector('input[aria-label="Project name"]').value`);
  const n = await clipCount();
  await sleep(1200);
  await send('Page.reload');
  // The app opens on Home; the restored project is in the "Continue" card
  const t0 = Date.now();
  let continueName;
  while (Date.now() - t0 < 15000) {
    continueName = await evaluate(`document.querySelector('[aria-label="Continue where you left off"] h2')?.textContent`);
    if (continueName) break;
    await sleep(250);
  }
  check('app opens on Home after reload, with the project ready to continue', continueName === name, `continue card: "${continueName}"`);
  await click(byText('button', '/Open in studio/'));
  let name2;
  while (Date.now() - t0 < 15000) {
    name2 = await evaluate(`document.querySelector('input[aria-label="Project name"]')?.value`);
    if (name2 !== undefined && (await clipCount()) > 0) break;
    await sleep(250);
  }
  const n2 = await clipCount();
  const screen = await evaluate(`(document.querySelector('header')?.innerText || '').replace(/\s+/g, ' ').slice(0, 80)`);
  const saved = await evaluate(`/SAVED PROJECTS \((\d+)\)/i.exec(document.body.innerText)?.[1] ?? 'n/a'`);
  check(
    'project survives reload',
    name2 === name && n2 === n,
    `"${name}" ${n} clips → "${name2}" ${n2} clips after ${((Date.now() - t0) / 1000).toFixed(1)} s` +
      (name2 === name ? '' : ` | header: "${screen}" | saved projects on Home: ${saved}`)
  );
});

// 14. Mobile layout smoke
await step('mobile layout', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(1200);
  const overflow = await evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  const nav = await evaluate(`document.querySelectorAll('nav button').length`);
  check('mobile layout fits without horizontal overflow', !overflow && nav === 6);
  await shot('06-mobile');
});

console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' checks passed');
console.log(pageErrors.length ? 'Page errors/warnings:\n  ' + [...new Set(pageErrors)].join('\n  ') : 'No page errors or warnings');
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2));
ws.close();
chrome.kill();
process.exit(0);
