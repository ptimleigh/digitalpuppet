'use strict';
/* ============================================================
   Digital Puppet – single-file vanilla JS app (no build step)
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- state ---------------- */
const defaults = () => ({
  stage: { aspect: '16/9', bgColor: '#1b2a41', bgFit: 'cover', bgSrc: null },
  puppet: {
    baseSrc: null, cells: [],          // cells: {id,name,src,mouth|null}
    mouth: null,                       // {x,y,w,h} normalised 0..1 of the image
    shape: 'rect', drop: 0.8, angle: 0, interior: '#2a0a12',
    x: 0.5, y: 0.55, scale: 0.7, flip: false, locked: false, idle: true
  },
  audio: { gain: 8, threshold: 0.08, release: 0.25, mouthKey: 'Space' },
  animations: [],  // {id,name,frames:[cellId|'base'],fps,loop,fx,amount,fxDuration,cycles}
  bindings: []     // {id,code,animId,mode:'hold'|'tap'|'toggle'}
});
let S = defaults();

const FX = {
  none: 'None (frames only)', bounce: 'Bounce', jump: 'Jump', shake: 'Shake (side to side)',
  nod: 'Nod / wiggle (rotate)', sway: 'Sway', spin: 'Spin 360°', pulse: 'Pulse (grow/shrink)', squash: 'Squash & stretch'
};

/* ---------------- images ---------------- */
const imgCache = new Map();
function getImg(src) {
  if (!src) return null;
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.src = src; imgCache.set(src, im); }
  return im.complete && im.naturalWidth ? im : null;
}
const readFile = f => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f);
});
function frameInfo(id) {            // 'base' or cell id -> {src, mouth}
  if (id === 'base') return { src: S.puppet.baseSrc, mouth: S.puppet.mouth };
  const c = S.puppet.cells.find(c => c.id === id);
  return c ? { src: c.src, mouth: c.mouth || S.puppet.mouth } : null;
}

/* ---------------- persistence (IndexedDB autosave + JSON export) ---------------- */
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const open = indexedDB.open('digitalpuppet', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onsuccess = () => { try { open.result.transaction('kv', 'readwrite').objectStore('kv').put(JSON.stringify(S), 'project'); } catch (e) { } };
    } catch (e) { }
  }, 400);
}
function loadSaved() {
  return new Promise(res => {
    try {
      const open = indexedDB.open('digitalpuppet', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => res(null);
      open.onsuccess = () => {
        try {
          const g = open.result.transaction('kv').objectStore('kv').get('project');
          g.onsuccess = () => res(g.result ? JSON.parse(g.result) : null);
          g.onerror = () => res(null);
        } catch (e) { res(null); }
      };
    } catch (e) { res(null); }
  });
}
function adopt(obj) {                // merge loaded project over defaults
  const d = defaults();
  S = {
    stage: { ...d.stage, ...obj.stage }, puppet: { ...d.puppet, ...obj.puppet },
    audio: { ...d.audio, ...obj.audio }, animations: obj.animations || [], bindings: obj.bindings || []
  };
  active.length = 0;
  applyStage();
}

/* ---------------- audio ---------------- */
let actx, analyser, buf, micStream, micNode, fileNode, audioEl;
let level = 0, mouthOpen = 0, manualHeld = false;
function ensureCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    buf = new Float32Array(analyser.fftSize);
  }
  if (actx.state === 'suspended') actx.resume();
}
async function startMic() {
  ensureCtx();
  stopMic();
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  micNode = actx.createMediaStreamSource(micStream);
  micNode.connect(analyser);         // NOT connected to speakers -> no feedback
}
function stopMic() {
  if (micNode) { micNode.disconnect(); micNode = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
}
function loadAudioFile(file) {
  ensureCtx();
  if (!audioEl) {
    audioEl = new Audio(); audioEl.crossOrigin = 'anonymous'; audioEl.controls = true; audioEl.style.width = '100%';
    fileNode = actx.createMediaElementSource(audioEl);
    fileNode.connect(analyser);
    fileNode.connect(actx.destination);     // hear the recording
  }
  if (audioEl._url) URL.revokeObjectURL(audioEl._url);
  audioEl._url = URL.createObjectURL(file);
  audioEl.src = audioEl._url;
  return audioEl;
}
function readLevel() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buf);
  let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

/* ---------------- animation playback ---------------- */
const active = [];   // {anim, start, mode, code, bid}
function animTotal(a) {
  const ft = a.frames.length ? a.frames.length / a.fps : 0;
  const xt = a.fx !== 'none' ? a.fxDuration : 0;
  return Math.max(ft, xt, 0.05);
}
function startBinding(b) {
  const anim = S.animations.find(a => a.id === b.animId);
  if (!anim) return;
  if (b.mode === 'toggle') {
    const i = active.findIndex(x => x.bid === b.id);
    if (i >= 0) { active.splice(i, 1); return; }
  }
  active.push({ anim, start: performance.now(), mode: b.mode, code: b.code, bid: b.id });
}
function playAnim(anim, mode = 'tap') { active.push({ anim, start: performance.now(), mode, code: null, bid: null }); }

function fxValue(fx, p, amt) {   // p: 0..1 -> {dx,dy,rot,sx,sy}  (units: puppet heights / radians)
  const o = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1 };
  const TAU = Math.PI * 2;
  switch (fx) {
    case 'bounce': o.dy = -Math.abs(Math.sin(Math.PI * p)) * 0.12 * amt; break;
    case 'jump': o.dy = -4 * p * (1 - p) * 0.3 * amt; break;
    case 'shake': o.dx = Math.sin(TAU * p) * 0.03 * amt; break;
    case 'nod': o.rot = Math.sin(TAU * p) * 0.17 * amt; break;
    case 'sway': o.dx = Math.sin(TAU * p) * 0.05 * amt; o.rot = Math.sin(TAU * p + 0.8) * 0.08 * amt; break;
    case 'spin': o.rot = TAU * p * Math.sign(amt || 1); break;
    case 'pulse': { const k = 1 + Math.sin(TAU * p) * 0.1 * amt; o.sx = o.sy = k; break; }
    case 'squash': { const k = Math.sin(TAU * p) * 0.12 * amt; o.sx = 1 + k; o.sy = 1 - k; break; }
  }
  return o;
}
function evalActive(now) {
  const out = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, frame: 'base' };
  for (let i = active.length - 1; i >= 0; i--) {
    const a = active[i], an = a.anim;
    const el = (now - a.start) / 1000, total = animTotal(an);
    const loopy = a.mode === 'toggle' || (a.mode === 'hold' && an.loop);
    let t = el;
    if (!loopy && el >= total) {
      if (a.mode === 'hold') t = total;      // hold final pose while key is down
      else { active.splice(i, 1); continue; }
    }
    if (an.frames.length) {
      const n = an.frames.length;
      const idx = loopy ? Math.floor(t * an.fps) % n : Math.min(Math.floor(t * an.fps), n - 1);
      out.frame = an.frames[idx];     // most recent animation wins (loop runs old->new)
    }
    if (an.fx !== 'none') {
      const d = Math.max(an.fxDuration / Math.max(an.cycles, 1), 0.05);   // one cycle
      const p = (!loopy && t >= an.fxDuration) ? 0 : (t % d) / d;         // rest pose once finished
      const v = fxValue(an.fx, p, an.amount);
      out.dx += v.dx; out.dy += v.dy; out.rot += v.rot; out.sx *= v.sx; out.sy *= v.sy;
    }
  }
  return out;
}

/* ---------------- drawing ---------------- */
function mouthPath(ctx, m, W, H, shape) {
  const x = m.x * W, y = m.y * H, w = m.w * W, h = m.h * H;
  ctx.beginPath();
  if (shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(x, y, w, h);
}
/** Draws `img` with its top-left at (0,0) at natural size; caller sets up the transform. */
function drawPuppetImage(ctx, img, mouth, open) {
  const W = img.naturalWidth, H = img.naturalHeight, P = S.puppet;
  ctx.drawImage(img, 0, 0);
  if (!mouth || open < 0.002) return;
  const mh = mouth.h * H, mx = (mouth.x + mouth.w / 2) * W, my = mouth.y * H;
  // 1) the hole the jaw leaves behind = mouth interior
  ctx.save(); mouthPath(ctx, mouth, W, H, P.shape); ctx.clip();
  ctx.fillStyle = P.interior; ctx.fillRect(0, 0, W, H);
  ctx.restore();
  // 2) the jaw: same pixels, moved down (and optionally hinged) with the voice
  ctx.save();
  ctx.translate(mx, my); ctx.translate(0, open * P.drop * mh);
  ctx.rotate(open * P.angle * Math.PI / 180); ctx.translate(-mx, -my);
  mouthPath(ctx, mouth, W, H, P.shape); ctx.clip();
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

const cv = $('#cv'), cx = cv.getContext('2d'), stage = $('#stage'), bgEl = $('#bg');
let stageW = 0, stageH = 0, dpr = 1;
function applyStage() {
  const [a, b] = S.stage.aspect.split('/').map(Number);
  stage.dataset.ratio = a / b;
  stage.style.background = S.stage.bgColor;
  bgEl.style.objectFit = S.stage.bgFit;
  if (S.stage.bgSrc) { bgEl.src = S.stage.bgSrc; bgEl.hidden = false; } else { bgEl.hidden = true; bgEl.removeAttribute('src'); }
  layout();
}
function layout() {
  const wrap = $('#stageWrap'), ratio = +stage.dataset.ratio || 16 / 9;
  const cs = getComputedStyle(wrap);
  const aw = wrap.clientWidth - parseFloat(cs.paddingLeft) * 2, ah = wrap.clientHeight - parseFloat(cs.paddingTop) * 2;
  const w = Math.max(50, Math.min(aw, ah * ratio)), h = w / ratio;
  stage.style.width = w + 'px'; stage.style.height = h + 'px';
  dpr = window.devicePixelRatio || 1;
  stageW = w; stageH = h;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
}
window.addEventListener('resize', layout);

let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  // --- mouth openness from audio (or the manual mouth key) ---
  const A = S.audio;
  level = readLevel();
  let target = clamp(level * A.gain, 0, 1);
  target = target < A.threshold ? 0 : (target - A.threshold) / (1 - A.threshold);
  if (manualHeld) target = Math.max(target, 0.9);
  const attack = 1 - Math.exp(-dt / 0.02), release = 1 - Math.exp(-dt / Math.max(A.release * 0.4, 0.01));
  mouthOpen += (target - mouthOpen) * (target > mouthOpen ? attack : release);

  drawStage(now);
  if (mouthEd.visible) drawMouthEditor();
  const m = $('#meterFill'); if (m) m.style.width = (clamp(level * A.gain, 0, 1) * 100) + '%';
  const m2 = $('#openFill'); if (m2) m2.style.width = (mouthOpen * 100) + '%';
  requestAnimationFrame(tick);
}

function drawStage(now) {
  cx.setTransform(1, 0, 0, 1, 0, 0);
  cx.clearRect(0, 0, cv.width, cv.height);
  const P = S.puppet;
  const fx = evalActive(now);
  const frame = frameInfo(fx.frame) || frameInfo('base');
  const img = frame && getImg(frame.src) || getImg(P.baseSrc);
  if (!img) {
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.fillStyle = '#fff9'; cx.font = '16px system-ui'; cx.textAlign = 'center';
    cx.fillText('Load a puppet image in the “Puppet” tab (or click “Load demo puppet”)', stageW / 2, stageH / 2);
    return;
  }
  const mouth = frame && frame.mouth || null;
  const ph = stageH * P.scale, k = ph / img.naturalHeight;
  let idleY = 0, idleS = 1;
  if (P.idle) { idleS = 1 + Math.sin(now / 650) * 0.008; idleY = Math.sin(now / 650) * 0.004; }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.translate(P.x * stageW + fx.dx * ph, P.y * stageH + (fx.dy + idleY) * ph);
  cx.rotate(fx.rot);
  cx.scale(fx.sx * idleS * (P.flip ? -1 : 1), fx.sy * idleS);
  cx.scale(k, k);
  cx.translate(-img.naturalWidth / 2, -img.naturalHeight / 2);
  drawPuppetImage(cx, img, mouth, mouthOpen);
  // key hud
  $('#hudKeys').textContent = active.filter(a => a.mode !== 'tap').map(a => a.anim.name).join(' · ');
}

/* ---- drag/zoom puppet on stage ---- */
let drag = null;
cv.addEventListener('pointerdown', e => {
  if (S.puppet.locked) return;
  cv.setPointerCapture(e.pointerId); cv.classList.add('drag');
  drag = { x: e.clientX, y: e.clientY, px: S.puppet.x, py: S.puppet.y };
});
cv.addEventListener('pointermove', e => {
  if (!drag) return;
  S.puppet.x = drag.px + (e.clientX - drag.x) / stageW;
  S.puppet.y = drag.py + (e.clientY - drag.y) / stageH;
});
cv.addEventListener('pointerup', () => { drag = null; cv.classList.remove('drag'); save(); });
cv.addEventListener('wheel', e => {
  if (S.puppet.locked) return;
  e.preventDefault();
  S.puppet.scale = clamp(S.puppet.scale * (e.deltaY < 0 ? 1.05 : 0.95), 0.05, 3); save();
}, { passive: false });

/* ---------------- keyboard ---------------- */
let capturing = null;      // callback while waiting for a key press
const prettyKey = c => !c ? '—' :
  ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[c] || c.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num '));
document.addEventListener('keydown', e => {
  if (capturing) {
    e.preventDefault();
    if (e.code !== 'Escape') capturing(e.code);
    capturing = null; return;
  }
  const t = e.target.tagName;
  if (t === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' || t === 'SELECT' || t === 'TEXTAREA') return;
  if (e.code === 'Tab') { e.preventDefault(); togglePanel(); return; }
  if (e.repeat) { if (e.code === S.audio.mouthKey || S.bindings.some(b => b.code === e.code)) e.preventDefault(); return; }
  let used = false;
  if (e.code === S.audio.mouthKey) { manualHeld = true; used = true; }
  for (const b of S.bindings) if (b.code === e.code) { startBinding(b); used = true; }
  if (used) e.preventDefault();
});
document.addEventListener('keyup', e => {
  if (e.code === S.audio.mouthKey) manualHeld = false;
  for (let i = active.length - 1; i >= 0; i--) if (active[i].mode === 'hold' && active[i].code === e.code) active.splice(i, 1);
});
window.addEventListener('blur', () => { manualHeld = false; for (let i = active.length - 1; i >= 0; i--) if (active[i].mode === 'hold') active.splice(i, 1); });
document.addEventListener('click', e => { if (e.target.tagName === 'BUTTON') e.target.blur(); });

function togglePanel() {
  $('#app').classList.toggle('nopanel');
  $('#btnShow').hidden = !$('#app').classList.contains('nopanel');
  layout();
}
$('#btnHide').onclick = togglePanel; $('#btnShow').onclick = togglePanel;
$('#btnFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('#stageWrap').requestFullscreen());
document.addEventListener('fullscreenchange', () => setTimeout(layout, 50));

/* ---------------- UI ---------------- */
const TABS = ['Scene', 'Puppet', 'Mouth', 'Animate', 'Keys', 'Audio', 'Project'];
let tab = 'Scene', selAnim = null, mouthTarget = 'base', mouthPreview = 0.8;
const mouthEd = { visible: false, cv: null, drag: null };

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(t => `<button data-t="${t}" class="${t === tab ? 'on' : ''}">${t}</button>`).join('');
  $('#tabs').onclick = e => { const t = e.target.dataset.t; if (t) { tab = t; renderTabs(); renderBody(); } };
}
function renderBody() {
  mouthEd.visible = false;
  const body = $('#tabBody');
  body.innerHTML = ({ Scene, Puppet, Mouth, Animate, Keys, Audio, Project }[tab])();
  ({ Scene: wireScene, Puppet: wirePuppet, Mouth: wireMouth, Animate: wireAnimate, Keys: wireKeys, Audio: wireAudio, Project: wireProject }[tab])(body);
}
const bind = (root, sel, ev, fn) => root.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(e, el)));
const range = (label, key, obj, min, max, step) =>
  `<div class="row"><label>${label}</label><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${obj[key]}"><span class="hint" data-v="${key}">${(+obj[key]).toFixed(2)}</span></div>`;
function wireRanges(root, obj, after) {
  bind(root, 'input[type=range][data-k]', 'input', (e, el) => {
    obj[el.dataset.k] = +el.value;
    const v = root.querySelector(`[data-v="${el.dataset.k}"]`); if (v) v.textContent = (+el.value).toFixed(2);
    if (after) after(); save();
  });
}

/* ----- Scene ----- */
function Scene() {
  return `
  <h3>Background</h3>
  <div class="row"><label>Image / GIF</label><input type="file" id="bgFile" accept="image/*"></div>
  <div class="row"><label>Fit</label><select id="bgFit"><option value="cover">Fill (crop)</option><option value="contain">Fit (letterbox)</option><option value="fill">Stretch</option></select>
    <button id="bgClear" class="danger small">Remove</button></div>
  <div class="row"><label>Colour</label><input type="color" id="bgColor" value="${S.stage.bgColor}"><span class="hint">shown behind transparent images / letterbox. Use green (#00b140) for chroma-key in OBS.</span></div>
  <h3>Stage</h3>
  <div class="row"><label>Aspect ratio</label><select id="aspect">
    ${['16/9', '4/3', '1/1', '9/16'].map(a => `<option ${S.stage.aspect === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
  <p class="hint">Tip: drag the puppet on the stage to move it, scroll wheel to resize.</p>`;
}
function wireScene(r) {
  $('#bgFit', r).value = S.stage.bgFit;
  $('#bgFile', r).onchange = async e => { if (e.target.files[0]) { S.stage.bgSrc = await readFile(e.target.files[0]); applyStage(); save(); } };
  $('#bgClear', r).onclick = () => { S.stage.bgSrc = null; applyStage(); save(); };
  $('#bgFit', r).onchange = e => { S.stage.bgFit = e.target.value; applyStage(); save(); };
  $('#bgColor', r).oninput = e => { S.stage.bgColor = e.target.value; applyStage(); save(); };
  $('#aspect', r).onchange = e => { S.stage.aspect = e.target.value; applyStage(); save(); };
}

/* ----- Puppet ----- */
function Puppet() {
  const P = S.puppet;
  return `
  <h3>Base image</h3>
  <div class="row"><input type="file" id="baseFile" accept="image/*"><button id="demo" class="primary">Load demo puppet</button></div>
  ${P.baseSrc ? `<div class="thumbs"><div class="thumb" style="background-image:url(${P.baseSrc})"><span class="n">base</span></div></div>` : '<p class="hint">Use a PNG with a transparent background for best results.</p>'}
  <h3>Animation cells (extra poses / frames)</h3>
  <div class="row"><input type="file" id="cellFile" accept="image/*" multiple></div>
  <p class="hint">Cells are full-size alternate versions of the puppet (e.g. eyes closed, angry, arm raised). Use the same canvas size as the base so they line up. Then use them in the <b>Animate</b> tab.</p>
  <div class="thumbs" id="cellList">${P.cells.map(c => `
    <div class="thumb" style="background-image:url(${c.src})" title="${esc(c.name)}"><span class="n">${esc(c.name)}</span><button class="x" data-del="${c.id}">×</button></div>`).join('')}</div>
  <h3>Placement</h3>
  ${range('Size', 'scale', P, 0.05, 2, 0.01)}
  ${range('X', 'x', P, -0.2, 1.2, 0.005)}
  ${range('Y', 'y', P, -0.2, 1.2, 0.005)}
  <div class="row"><label></label>
    <label style="flex:none"><input type="checkbox" id="flip" ${P.flip ? 'checked' : ''}> Flip</label>
    <label style="flex:none"><input type="checkbox" id="idle" ${P.idle ? 'checked' : ''}> Idle breathing</label>
    <label style="flex:none"><input type="checkbox" id="lock" ${P.locked ? 'checked' : ''}> Lock position</label></div>`;
}
function wirePuppet(r) {
  const P = S.puppet;
  wireRanges(r, P);
  $('#baseFile', r).onchange = async e => { if (e.target.files[0]) { P.baseSrc = await readFile(e.target.files[0]); mouthTarget = 'base'; save(); renderBody(); } };
  $('#cellFile', r).onchange = async e => {
    for (const f of e.target.files) P.cells.push({ id: uid(), name: f.name.replace(/\.[^.]+$/, ''), src: await readFile(f), mouth: null });
    save(); renderBody();
  };
  bind(r, '[data-del]', 'click', (e, el) => {
    const id = el.dataset.del;
    P.cells = P.cells.filter(c => c.id !== id);
    S.animations.forEach(a => a.frames = a.frames.filter(f => f !== id));
    if (mouthTarget === id) mouthTarget = 'base';
    save(); renderBody();
  });
  $('#flip', r).onchange = e => { P.flip = e.target.checked; save(); };
  $('#idle', r).onchange = e => { P.idle = e.target.checked; save(); };
  $('#lock', r).onchange = e => { P.locked = e.target.checked; save(); };
  $('#demo', r).onclick = () => { loadDemo(); renderBody(); };
}

/* ----- Mouth ----- */
function Mouth() {
  const P = S.puppet;
  const own = mouthTarget !== 'base' && P.cells.find(c => c.id === mouthTarget)?.mouth;
  return `
  <p class="hint">Drag a box on the picture around the part that should <b>move when the puppet talks</b> (usually the lower jaw: from just under the lip line down through the chin). It will drop open and reveal the mouth interior colour.</p>
  <div class="row"><label>Edit image</label><select id="mTarget">
    <option value="base">Base image</option>${P.cells.map(c => `<option value="${c.id}" ${mouthTarget === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
  ${mouthTarget !== 'base' ? `<div class="row"><label></label><label style="flex:none"><input type="checkbox" id="ownMouth" ${own ? 'checked' : ''}> This cell has its own mouth region (otherwise uses base's)</label></div>` : ''}
  <canvas id="mouthCv"></canvas>
  <div class="row"><label>Preview open</label><input type="range" id="mPrev" min="0" max="1" step="0.01" value="${mouthPreview}"></div>
  <h3>Jaw motion</h3>
  <div class="row"><label>Shape</label><select id="shape"><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select></div>
  ${range('Drop distance', 'drop', P, 0, 2, 0.01)}
  ${range('Hinge angle °', 'angle', P, -25, 25, 0.5)}
  <div class="row"><label>Mouth inside</label><input type="color" id="interior" value="${P.interior}"></div>
  <p class="hint">Drop distance is a multiple of the box height. A little hinge angle gives a classic “flappy jaw” look.</p>`;
}
function wireMouth(r) {
  const P = S.puppet;
  mouthEd.cv = $('#mouthCv', r); mouthEd.visible = true;
  $('#shape', r).value = P.shape;
  $('#shape', r).onchange = e => { P.shape = e.target.value; save(); };
  $('#interior', r).oninput = e => { P.interior = e.target.value; save(); };
  $('#mPrev', r).oninput = e => { mouthPreview = +e.target.value; };
  wireRanges(r, P);
  $('#mTarget', r).onchange = e => { mouthTarget = e.target.value; renderBody(); };
  const own = $('#ownMouth', r);
  if (own) own.onchange = () => {
    const c = P.cells.find(c => c.id === mouthTarget);
    c.mouth = own.checked ? (P.mouth ? { ...P.mouth } : { x: .3, y: .6, w: .4, h: .2 }) : null; save();
  };
  const cvm = mouthEd.cv;
  const pt = e => { const b = cvm.getBoundingClientRect(); return { x: clamp((e.clientX - b.left) / b.width, 0, 1), y: clamp((e.clientY - b.top) / b.height, 0, 1) }; };
  const target = () => {
    if (mouthTarget === 'base') return 'base';
    const c = P.cells.find(c => c.id === mouthTarget); return c && c.mouth ? c : 'base';
  };
  cvm.onpointerdown = e => { cvm.setPointerCapture(e.pointerId); mouthEd.drag = pt(e); };
  cvm.onpointermove = e => {
    if (!mouthEd.drag) return;
    const a = mouthEd.drag, b = pt(e);
    const m = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    const t = target(); if (t === 'base') P.mouth = m; else t.mouth = m;
  };
  cvm.onpointerup = () => { mouthEd.drag = null; save(); };
}
function drawMouthEditor() {
  const c = mouthEd.cv; if (!c || !c.isConnected) { mouthEd.visible = false; return; }
  const info = frameInfo(mouthTarget) || frameInfo('base');
  const img = info && getImg(info.src);
  const w = c.clientWidth || 340;
  if (!img) { c.width = w; c.height = 80; const g = c.getContext('2d'); g.fillStyle = '#999'; g.fillText('Load a puppet image first', 10, 40); return; }
  const h = Math.round(w * img.naturalHeight / img.naturalWidth);
  if (c.width !== w * 2 || c.height !== h * 2) { c.width = w * 2; c.height = h * 2; c.style.height = h + 'px'; }
  const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
  const k = c.width / img.naturalWidth; g.scale(k, k);
  drawPuppetImage(g, img, info.mouth, mouthPreview);
  const m = info.mouth;
  if (m) {
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = '#ff7a59'; g.lineWidth = 3; g.setLineDash([10, 6]);
    g.strokeRect(m.x * c.width, m.y * c.height, m.w * c.width, m.h * c.height); g.restore();
  }
}

/* ----- Animate ----- */
function Animate() {
  const P = S.puppet;
  if (selAnim && !S.animations.find(a => a.id === selAnim)) selAnim = null;
  const a = S.animations.find(a => a.id === selAnim);
  const palette = [{ id: 'base', name: 'base', src: P.baseSrc }, ...P.cells];
  return `
  <div class="row"><select id="animSel"><option value="">— select animation —</option>
    ${S.animations.map(x => `<option value="${x.id}" ${x.id === selAnim ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <button id="animNew" class="primary">+ New</button></div>
  ${a ? `
  <div class="card">
    <div class="row"><label>Name</label><input type="text" id="aName" value="${esc(a.name)}"></div>
    <h3 style="margin-top:6px">Frames (cells)</h3>
    <div class="hint">Click a cell below to append it to the sequence. Frames play in order at the chosen speed.</div>
    <div class="thumbs" id="palette">${palette.filter(p => p.src).map(p => `<div class="thumb" data-add="${p.id}" style="background-image:url(${p.src})"><span class="n">${esc(p.name)}</span></div>`).join('')}</div>
    <div class="hint" style="margin-top:8px">Sequence (${a.frames.length}):</div>
    <div class="thumbs" id="seq">${a.frames.map((f, i) => { const fi = frameInfo(f); return `
      <div class="thumb" style="background-image:url(${fi ? fi.src : ''})"><button class="x" data-rm="${i}">×</button>
      <div class="mv"><button data-l="${i}">‹</button><button data-r="${i}">›</button></div></div>`; }).join('') || '<span class="hint">empty – this animation only uses motion effects</span>'}</div>
    <div class="row"><label>Speed (fps)</label><input type="range" data-ak="fps" min="1" max="30" step="1" value="${a.fps}"><span class="hint" data-av="fps">${a.fps}</span></div>
    <div class="row"><label></label><label style="flex:none"><input type="checkbox" id="aLoop" ${a.loop ? 'checked' : ''}> Loop (while key held / toggled on)</label></div>
    <h3>Motion effect</h3>
    <div class="row"><label>Effect</label><select id="aFx">${Object.entries(FX).map(([k, v]) => `<option value="${k}" ${a.fx === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="row"><label>Amount</label><input type="range" data-ak="amount" min="0" max="3" step="0.05" value="${a.amount}"><span class="hint" data-av="amount">${a.amount}</span></div>
    <div class="row"><label>Duration (s)</label><input type="range" data-ak="fxDuration" min="0.1" max="5" step="0.05" value="${a.fxDuration}"><span class="hint" data-av="fxDuration">${a.fxDuration}</span></div>
    <div class="row"><label>Repeats</label><input type="range" data-ak="cycles" min="1" max="12" step="1" value="${a.cycles}"><span class="hint" data-av="cycles">${a.cycles}</span></div>
    <div class="row"><button id="aTest" class="primary">▶ Test</button><button id="aDup">Duplicate</button><button id="aDel" class="danger">Delete</button></div>
  </div>` : '<p class="hint">Create an animation, give it frames and/or a motion effect, then assign a key to it in the <b>Keys</b> tab.</p>'}`;
}
function wireAnimate(r) {
  $('#animSel', r).onchange = e => { selAnim = e.target.value || null; renderBody(); };
  $('#animNew', r).onclick = () => {
    const a = { id: uid(), name: 'Animation ' + (S.animations.length + 1), frames: [], fps: 8, loop: false, fx: 'bounce', amount: 1, fxDuration: 0.6, cycles: 1 };
    S.animations.push(a); selAnim = a.id; save(); renderBody();
  };
  const a = S.animations.find(a => a.id === selAnim); if (!a) return;
  $('#aName', r).oninput = e => { a.name = e.target.value; save(); };
  $('#aName', r).onchange = () => renderBody();
  bind(r, '[data-add]', 'click', (e, el) => { a.frames.push(el.dataset.add); save(); renderBody(); });
  bind(r, '[data-rm]', 'click', (e, el) => { a.frames.splice(+el.dataset.rm, 1); save(); renderBody(); });
  bind(r, '[data-l]', 'click', (e, el) => { const i = +el.dataset.l; if (i > 0) { [a.frames[i - 1], a.frames[i]] = [a.frames[i], a.frames[i - 1]]; save(); renderBody(); } });
  bind(r, '[data-r]', 'click', (e, el) => { const i = +el.dataset.r; if (i < a.frames.length - 1) { [a.frames[i + 1], a.frames[i]] = [a.frames[i], a.frames[i + 1]]; save(); renderBody(); } });
  bind(r, 'input[data-ak]', 'input', (e, el) => { a[el.dataset.ak] = +el.value; r.querySelector(`[data-av="${el.dataset.ak}"]`).textContent = el.value; save(); });
  $('#aLoop', r).onchange = e => { a.loop = e.target.checked; save(); };
  $('#aFx', r).onchange = e => { a.fx = e.target.value; save(); };
  $('#aTest', r).onclick = () => {
    if (!a.loop) return playAnim(a, 'tap');
    playAnim(a, 'toggle');       // looping animations preview for 2.5 s
    const entry = active[active.length - 1];
    setTimeout(() => { const i = active.indexOf(entry); if (i >= 0) active.splice(i, 1); }, 2500);
  };
  $('#aDup', r).onclick = () => { const c = JSON.parse(JSON.stringify(a)); c.id = uid(); c.name += ' copy'; S.animations.push(c); selAnim = c.id; save(); renderBody(); };
  $('#aDel', r).onclick = () => {
    S.animations = S.animations.filter(x => x.id !== a.id);
    S.bindings = S.bindings.filter(b => b.animId !== a.id); selAnim = null; save(); renderBody();
  };
}

/* ----- Keys ----- */
function Keys() {
  return `
  <div class="row"><label>Manual mouth</label><button id="mKey" class="keycap">${prettyKey(S.audio.mouthKey)}</button>
    <span class="hint">hold to flap the mouth without audio</span></div>
  <h3>Key bindings</h3>
  ${S.bindings.map(b => `
    <div class="keyrow" data-b="${b.id}">
      <button class="keycap" data-cap="${b.id}">${prettyKey(b.code)}</button>
      <select data-anim="${b.id}"><option value="">— animation —</option>${S.animations.map(a => `<option value="${a.id}" ${a.id === b.animId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <select data-mode="${b.id}"><option value="hold" ${b.mode === 'hold' ? 'selected' : ''}>While held</option><option value="tap" ${b.mode === 'tap' ? 'selected' : ''}>Once (tap)</option><option value="toggle" ${b.mode === 'toggle' ? 'selected' : ''}>Toggle on/off</option></select>
      <button class="small danger" data-rmb="${b.id}">×</button>
    </div>`).join('') || '<p class="hint">No keys assigned yet.</p>'}
  <div class="row"><button id="bAdd" class="primary">+ Add key binding</button></div>
  <p class="hint"><b>While held</b>: plays while the key is down (loops if the animation loops, otherwise holds the final frame — great for expressions). <b>Once</b>: plays a single time. <b>Toggle</b>: starts looping on one press, stops on the next. Tab hides the panel.</p>`;
}
function wireKeys(r) {
  const capBtn = (btn, set) => {
    btn.onclick = () => { btn.textContent = 'press a key…'; btn.classList.add('cap'); capturing = code => { set(code); save(); renderBody(); }; };
  };
  capBtn($('#mKey', r), c => S.audio.mouthKey = c);
  S.bindings.forEach(b => capBtn($(`[data-cap="${b.id}"]`, r), c => b.code = c));
  bind(r, '[data-anim]', 'change', (e, el) => { S.bindings.find(b => b.id === el.dataset.anim).animId = el.value; save(); });
  bind(r, '[data-mode]', 'change', (e, el) => { S.bindings.find(b => b.id === el.dataset.mode).mode = el.value; save(); });
  bind(r, '[data-rmb]', 'click', (e, el) => { S.bindings = S.bindings.filter(b => b.id !== el.dataset.rmb); save(); renderBody(); });
  $('#bAdd', r).onclick = () => { S.bindings.push({ id: uid(), code: '', animId: S.animations[0]?.id || '', mode: 'hold' }); renderBody(); };
}

/* ----- Audio ----- */
function Audio() {
  const A = S.audio;
  return `
  <h3>Live microphone</h3>
  <div class="row"><button id="micOn" class="primary">🎤 Start microphone</button><button id="micOff">Stop</button><span class="hint" id="micMsg"></span></div>
  <h3>Recording</h3>
  <div class="row"><input type="file" id="audFile" accept="audio/*,video/*"></div>
  <div id="audHost"></div>
  <h3>Mouth response</h3>
  <div class="row"><label>Input level</label><div class="meter" style="flex:1"><i id="meterFill"></i></div></div>
  <div class="row"><label>Mouth open</label><div class="meter" style="flex:1"><i id="openFill"></i></div></div>
  ${range('Sensitivity', 'gain', A, 1, 40, 0.5)}
  ${range('Noise gate', 'threshold', A, 0, 0.6, 0.01)}
  ${range('Close speed', 'release', A, 0.02, 1, 0.01)}
  <p class="hint">Raise sensitivity until the “Mouth open” bar reaches the top on your loudest words; raise the noise gate so background noise doesn't move the mouth. Audio from recordings plays through your speakers; the microphone is analysed only (never played back, so no feedback).</p>`;
}
function wireAudio(r) {
  wireRanges(r, S.audio);
  const host = $('#audHost', r); if (audioEl) host.appendChild(audioEl);
  $('#micOn', r).onclick = async () => {
    try { await startMic(); $('#micMsg').textContent = 'listening…'; }
    catch (e) { $('#micMsg').textContent = 'Mic unavailable: ' + e.message; }
  };
  $('#micOff', r).onclick = () => { stopMic(); $('#micMsg').textContent = 'stopped'; };
  $('#audFile', r).onchange = e => { if (e.target.files[0]) { host.appendChild(loadAudioFile(e.target.files[0])); audioEl.play().catch(() => { }); } };
}

/* ----- Project ----- */
function Project() {
  return `
  <p class="hint">Your work is auto-saved in this browser. Export a file to back it up or move it to another computer.</p>
  <div class="row"><button id="exp" class="primary">⬇ Export project (.json)</button></div>
  <div class="row"><label>Import</label><input type="file" id="imp" accept="application/json,.json"></div>
  <div class="row"><button id="reset" class="danger">Start over (clear everything)</button></div>
  <h3>Using it for streaming / video calls</h3>
  <p class="hint">Hide the panel (Tab), set the Scene colour to green and capture this window in OBS with a chroma-key filter, or add a Window/Browser Capture source. Use <b>Fullscreen</b> for a clean output.</p>`;
}
function wireProject(r) {
  $('#exp', r).onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S)], { type: 'application/json' }));
    a.download = 'puppet-project.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#imp', r).onchange = async e => {
    try { adopt(JSON.parse(await e.target.files[0].text())); save(); renderBody(); } catch (err) { alert('Could not read that file: ' + err.message); }
  };
  $('#reset', r).onclick = () => { if (confirm('Delete the current puppet, animations and key bindings?')) { S = defaults(); active.length = 0; applyStage(); save(); renderBody(); } };
}

/* ---------------- demo puppet ---------------- */
function demoFace(mood) {
  const c = document.createElement('canvas'); c.width = 600; c.height = 700;
  const g = c.getContext('2d');
  const skin = mood === 'angry' ? '#f0907a' : '#f6c9a0';
  g.fillStyle = '#4a2c17'; g.beginPath(); g.ellipse(300, 250, 235, 220, 0, Math.PI, 0); g.fill();        // hair
  g.fillStyle = skin; g.strokeStyle = '#5a3a22'; g.lineWidth = 6;
  g.beginPath(); g.ellipse(300, 340, 215, 280, 0, 0, Math.PI * 2); g.fill(); g.stroke();                    // head
  g.fillStyle = '#4a2c17'; g.beginPath(); g.ellipse(300, 205, 225, 120, 0, Math.PI, 0); g.fill();          // fringe
  g.fillStyle = skin;                                                                                       // ears
  for (const ex of [88, 512]) { g.beginPath(); g.ellipse(ex, 360, 26, 46, 0, 0, 7); g.fill(); g.stroke(); }
  // eyes
  const er = mood === 'surprised' ? 40 : 28;
  for (const ex of [220, 380]) {
    g.fillStyle = '#fff'; g.beginPath(); g.ellipse(ex, 290, er + 6, er + 4, 0, 0, 7); g.fill(); g.stroke();
    g.fillStyle = '#222'; g.beginPath(); g.arc(ex, 292, mood === 'surprised' ? 11 : 15, 0, 7); g.fill();
  }
  g.strokeStyle = '#3a2210'; g.lineWidth = 10; g.lineCap = 'round';
  g.beginPath();
  if (mood === 'angry') { g.moveTo(180, 228); g.lineTo(255, 262); g.moveTo(420, 228); g.lineTo(345, 262); }
  else if (mood === 'surprised') { g.moveTo(178, 215); g.quadraticCurveTo(220, 190, 262, 215); g.moveTo(338, 215); g.quadraticCurveTo(380, 190, 422, 215); }
  else { g.moveTo(180, 245); g.quadraticCurveTo(220, 228, 262, 245); g.moveTo(338, 245); g.quadraticCurveTo(380, 228, 420, 245); }
  g.stroke();
  g.strokeStyle = '#5a3a22'; g.lineWidth = 6;                                                               // nose
  g.beginPath(); g.moveTo(300, 310); g.quadraticCurveTo(280, 385, 305, 392); g.stroke();
  g.fillStyle = '#e8786a55';
  for (const ex of [160, 440]) { g.beginPath(); g.ellipse(ex, 410, 34, 20, 0, 0, 7); g.fill(); }
  // mouth line + chin
  g.strokeStyle = '#7a2f2f'; g.lineWidth = 8;
  g.beginPath();
  if (mood === 'angry') { g.moveTo(220, 470); g.quadraticCurveTo(300, 440, 380, 470); }
  else if (mood === 'surprised') { g.ellipse(300, 480, 32, 26, 0, 0, 7); }
  else { g.moveTo(215, 450); g.quadraticCurveTo(300, 505, 385, 450); }
  g.stroke();
  return c.toDataURL('image/png');
}
function loadDemo() {
  const P = S.puppet;
  P.baseSrc = demoFace('happy');
  const angry = { id: uid(), name: 'angry', src: demoFace('angry'), mouth: null };
  const surprised = { id: uid(), name: 'surprised', src: demoFace('surprised'), mouth: null };
  P.cells = [angry, surprised];
  P.mouth = { x: 0.26, y: 0.62, w: 0.48, h: 0.24 }; P.shape = 'rect'; P.drop = 0.9; P.angle = 4; P.interior = '#3a0c18';
  P.scale = 0.85; P.y = 0.52;
  const mk = (name, o) => ({ id: uid(), name, frames: [], fps: 8, loop: false, fx: 'none', amount: 1, fxDuration: 0.6, cycles: 1, ...o });
  const aAngry = mk('Angry', { frames: [angry.id], fx: 'shake', amount: 0.6, cycles: 6, fxDuration: 0.5, loop: true });
  const aSurp = mk('Surprised', { frames: [surprised.id], fx: 'jump', amount: 0.5, fxDuration: 0.35 });
  const aBounce = mk('Bounce', { fx: 'bounce', cycles: 2, fxDuration: 0.6 });
  const aSpin = mk('Spin', { fx: 'spin', fxDuration: 0.8 });
  const aDance = mk('Dance', { fx: 'sway', cycles: 1, fxDuration: 0.8, amount: 1.2, loop: true });
  const aNod = mk('Nod', { fx: 'nod', cycles: 2, fxDuration: 0.7, amount: 0.6 });
  S.animations = [aAngry, aSurp, aBounce, aSpin, aDance, aNod];
  const bd = (code, anim, mode) => ({ id: uid(), code, animId: anim.id, mode });
  S.bindings = [bd('KeyA', aAngry, 'hold'), bd('KeyS', aSurp, 'hold'), bd('KeyB', aBounce, 'tap'),
  bd('KeyP', aSpin, 'tap'), bd('KeyD', aDance, 'toggle'), bd('KeyN', aNod, 'tap')];
  selAnim = aAngry.id; mouthTarget = 'base'; save();
}

/* ---------------- boot ---------------- */
(async function boot() {
  const saved = await loadSaved();
  if (saved) { try { adopt(saved); } catch (e) { } } else applyStage();
  renderTabs(); renderBody(); layout();
  requestAnimationFrame(tick);
})();
// test hook
window.__puppet = { get S() { return S; }, loadDemo, renderBody, get mouthOpen() { return mouthOpen; } };
