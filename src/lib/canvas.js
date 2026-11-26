/* Canvas controller: pan / zoom, edge drawing, dragging, connecting.
   React renders the node cards (components/Canvas.jsx). Everything that runs per frame stays
   imperative here: the world transform, SVG edges that follow measured port positions, drags. */
import { flushSync } from 'react-dom';
import CF from './core.js';

const C = {};
CF.canvas = C;
export default C;

const NS = 'http://www.w3.org/2000/svg';
const view = (C.view = { x: 0, y: 0, k: 1 });
const nodeEls = (C.nodeEls = new Map());
const edgeEls = new Map();
C.hidden = new Set();
// a real call followed live or replayed (src/lib/liveCalls.js): the step it is on, the path so far, the final step
C.live = { on: false, active: null, final: null, visited: new Set(), trail: new Set() };
C.appeared = new Set(); // nodes whose entrance animation already ran

let canvas = null, world = null, gEdges = null, temp = null, layer = null, delBtn = null;
C.mounted = false;

/* ---------- mount (called by the Canvas component) ---------- */
C.mount = (refs) => {
  ({ canvas, world, gEdges, temp, layer, delBtn } = refs);
  edgeEls.clear();
  delBtn.hidden = true;
  C.mounted = true;
  const opts = { passive: false };
  const stopPinch = (e) => { if (e.ctrlKey) e.preventDefault(); };
  const preventGesture = (e) => e.preventDefault();
  let gestureK = 1;
  const gStart = (e) => { e.preventDefault(); gestureK = view.k; };
  const gChange = (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, gestureK * e.scale); };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('wheel', onWheel, opts);
  canvas.addEventListener('dblclick', onDbl);
  // keep trackpad pinch from zooming the whole page when it happens over the chrome
  document.addEventListener('wheel', stopPinch, opts);
  // Safari reports trackpad pinch as gesture events instead of ctrl+wheel
  canvas.addEventListener('gesturestart', gStart);
  canvas.addEventListener('gesturechange', gChange);
  document.addEventListener('gesturestart', preventGesture);
  window.addEventListener('resize', applyView);
  CF.measure = measure;
  applyView();
  applyLiveClass();
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('wheel', onWheel, opts);
    canvas.removeEventListener('dblclick', onDbl);
    document.removeEventListener('wheel', stopPinch, opts);
    canvas.removeEventListener('gesturestart', gStart);
    canvas.removeEventListener('gesturechange', gChange);
    document.removeEventListener('gesturestart', preventGesture);
    window.removeEventListener('resize', applyView);
    C.mounted = false;
    canvas = world = gEdges = temp = layer = delBtn = null;
  };
};
/* resolves once the canvas is on screen (e.g. right after navigating to the studio) */
C.ready = async () => {
  for (let i = 0; i < 60 && !C.mounted; i++) await new Promise((r) => requestAnimationFrame(r));
  return C.mounted;
};

C.render = () => CF.emit('render');
/* render synchronously: needed before measuring freshly added nodes */
C.flush = () => { flushSync(() => CF.emit('render')); };

/* ---------- view ---------- */
function applyView() {
  if (!world) return;
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const s = 22 * view.k;
  canvas.style.backgroundSize = `${s}px ${s}px`;
  canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  CF.emit('view', view);
}
C.applyView = applyView;

let tweenId = 0;
function tweenTo(target, dur) {
  const id = ++tweenId;
  if (CF.reducedMotion() || !dur) { Object.assign(view, target); applyView(); return; }
  const from = { x: view.x, y: view.y, k: view.k };
  const t0 = performance.now();
  const step = (now) => {
    if (id !== tweenId) return;
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    view.x = from.x + (target.x - from.x) * e;
    view.y = from.y + (target.y - from.y) * e;
    view.k = from.k + (target.k - from.k) * e;
    applyView();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* the part of the screen not covered by floating chrome */
function avail() {
  const r = canvas.getBoundingClientRect();
  const narrow = r.width < 680;
  const chatOpen = document.body.classList.contains('chat-open');
  const chatEl = document.getElementById('chat');
  const chatW = (chatEl && chatEl.offsetWidth) || 388;
  if (narrow) {
    return { left: 12, top: 72, width: r.width - 24, height: r.height * (chatOpen ? 0.46 : 1) - 84 };
  }
  const insp = document.getElementById('inspector');
  // the live-call panel sits on the left too: keep focused nodes clear of it
  const lp = document.querySelector('.live-panel');
  const lpRight = lp ? lp.getBoundingClientRect().right - r.left + 16 : 0;
  const left = Math.max(insp ? 344 : 28, lpRight);
  const right = chatOpen ? chatW + 44 : 28;
  return { left, top: 88, width: r.width - left - right, height: r.height - 88 - 70 };
}

function bounds() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of CF.state.nodes) {
    const el = nodeEls.get(n.id);
    const w = el ? el.offsetWidth : 264;
    const h = el ? el.offsetHeight : 120;
    x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
    x2 = Math.max(x2, n.x + w); y2 = Math.max(y2, n.y + h);
  }
  if (x1 === Infinity) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

C.fit = (animate = true) => {
  if (!canvas) return;
  const a = avail();
  const b = bounds();
  if (!b) { tweenTo({ x: a.left + a.width / 2, y: a.top + a.height / 2, k: 1 }, animate ? 450 : 0); return; }
  const k = CF.clamp(Math.min(a.width / (b.w + 60), a.height / (b.h + 60)), 0.18, 1.05);
  tweenTo({
    x: a.left + (a.width - b.w * k) / 2 - b.x * k,
    y: a.top + (a.height - b.h * k) / 2 - b.y * k,
    k,
  }, animate ? 520 : 0);
};

C.focus = (id) => {
  if (!canvas) return;
  const n = CF.node(id);
  const el = nodeEls.get(id);
  if (!n || !el) return;
  const a = avail();
  const sx = view.x + n.x * view.k;
  const sy = view.y + n.y * view.k;
  const sw = el.offsetWidth * view.k;
  const sh = el.offsetHeight * view.k;
  const inside = sx >= a.left && sy >= a.top && sx + sw <= a.left + a.width && sy + sh <= a.top + a.height;
  if (inside) return;
  tweenTo({
    x: a.left + a.width / 2 - (n.x + el.offsetWidth / 2) * view.k,
    y: a.top + a.height / 2 - (n.y + el.offsetHeight / 2) * view.k,
    k: view.k,
  }, 480);
};

/* centre a node at a readable zoom (used when a test call starts) */
C.zoomToNode = (id, minK) => {
  if (!canvas) return;
  const n = CF.node(id);
  const el = nodeEls.get(id);
  if (!n || !el) return;
  const a = avail();
  const k = Math.max(view.k, minK || 0.8);
  tweenTo({
    x: a.left + a.width * 0.3 - (n.x + el.offsetWidth / 2) * k,
    y: a.top + a.height / 2 - (n.y + el.offsetHeight / 2) * k,
    k,
  }, 600);
};

function zoomAt(cx, cy, k) {
  tweenId++;
  k = CF.clamp(k, 0.25, 2);
  const r = canvas.getBoundingClientRect();
  const px = cx - r.left;
  const py = cy - r.top;
  view.x = px - (px - view.x) * (k / view.k);
  view.y = py - (py - view.y) * (k / view.k);
  view.k = k;
  applyView();
}
C.zoomBy = (f) => {
  if (!canvas) return;
  const a = avail();
  const target = CF.clamp(view.k * f, 0.25, 2);
  const px = a.left + a.width / 2;
  const py = a.top + a.height / 2;
  tweenTo({
    x: px - (px - view.x) * (target / view.k),
    y: py - (py - view.y) * (target / view.k),
    k: target,
  }, 220);
};
C.zoomTo = (k) => C.zoomBy(k / view.k);

/* world coordinates of the visible centre (used to drop new nodes) */
C.viewCenter = () => {
  if (!canvas) return { x: 0, y: 0 };
  const a = avail();
  return { x: (a.left + a.width / 2 - view.x) / view.k - 132, y: (a.top + a.height / 2 - view.y) / view.k - 50 };
};
C.toWorld = (cx, cy) => {
  const r = canvas.getBoundingClientRect();
  return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
};

/* ---------- measuring ---------- */
function portEl(nodeId, port) {
  const el = nodeEls.get(nodeId);
  return el ? el.querySelector(`.port[data-port="${port}"]`) : null;
}
function portOffset(el, port) {
  const p = el.querySelector(`.port[data-port="${port}"]`);
  if (!p) return { x: port === 'in' ? 0 : el.offsetWidth, y: 28 };
  let x = p.offsetWidth / 2;
  let y = p.offsetHeight / 2;
  let cur = p;
  while (cur && cur !== el) { x += cur.offsetLeft; y += cur.offsetTop; cur = cur.offsetParent; }
  return { x: x + el.clientLeft, y: y + el.clientTop };
}
const fallbackMeasure = CF.measure;
function measure(id) {
  const el = nodeEls.get(id);
  if (!el || !el.offsetHeight) return fallbackMeasure(id);
  return { w: el.offsetWidth, h: el.offsetHeight, portY: (port) => portOffset(el, port).y };
}
/* live position: offsetLeft/Top follow CSS transitions, so edges track gliding nodes */
function portPos(n, port) {
  const el = nodeEls.get(n.id);
  if (!el) return { x: n.x, y: n.y + 28 };
  const o = portOffset(el, port);
  return { x: el.offsetLeft + o.x, y: el.offsetTop + o.y };
}

/* forward edges: smooth bezier. Back edges (loops): rounded orthogonal route under the nodes in between. */
function route(a, b, backIdx, forceCurve) {
  if (forceCurve || b.x >= a.x + 30) {
    const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5);
    const c1 = { x: a.x + dx, y: a.y };
    const c2 = { x: b.x - dx, y: b.y };
    return {
      d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`,
      mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 },
      back: false,
    };
  }
  const x1 = a.x + 26;
  const x2 = b.x - 26;
  let low = Math.max(a.y, b.y);
  for (const n of CF.state.nodes) {
    const el = nodeEls.get(n.id);
    if (!el || C.hidden.has(n.id)) continue;
    const nx = el.offsetLeft;
    if (nx < x1 && nx + el.offsetWidth > x2) low = Math.max(low, el.offsetTop + el.offsetHeight);
  }
  const yl = low + 34 + backIdx * 12;
  const r = 14;
  const d = `M${a.x},${a.y} H${x1 - r} Q${x1},${a.y} ${x1},${a.y + r} V${yl - r} Q${x1},${yl} ${x1 - r},${yl} ` +
    `H${x2 + r} Q${x2},${yl} ${x2},${yl - r} V${b.y + r} Q${x2},${b.y} ${x2 + r},${b.y} H${b.x}`;
  return { d, mid: { x: (x1 + x2) / 2, y: yl }, back: true };
}

function renderEdges() {
  if (!gEdges) return;
  const seen = new Set();
  layer.querySelectorAll('.port.connected').forEach((p) => p.classList.remove('connected'));
  const byId = new Map(CF.state.nodes.map((n) => [n.id, n]));
  const selId = CF.sel && CF.sel.type === 'edge' ? CF.sel.id : null;
  let backIdx = 0;
  const now = Date.now();
  for (const e of CF.state.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b || C.hidden.has(a.id) || C.hidden.has(b.id)) continue;
    if (!CF.ports(a).includes(e.port)) continue;
    const geo = route(portPos(a, e.port), portPos(b, 'in'), backIdx, false);
    if (geo.back) backIdx++;
    let g = edgeEls.get(e.id);
    if (!g) {
      g = document.createElementNS(NS, 'g');
      g.dataset.id = e.id;
      g.dataset.born = String(now);
      const hit = document.createElementNS(NS, 'path');
      hit.setAttribute('class', 'edge-hit');
      const line = document.createElementNS(NS, 'path');
      line.setAttribute('class', 'edge-line');
      g.appendChild(hit);
      g.appendChild(line);
      gEdges.appendChild(g);
      edgeEls.set(e.id, g);
    }
    g.firstChild.setAttribute('d', geo.d);
    g.lastChild.setAttribute('d', geo.d);
    let cls = 'edge';
    if (e.port === 'fallback') cls += ' fb';
    if (e.port === 'failed') cls += ' fail';
    if (b.starter && b.starter.trim()) cls += ' lead';
    if (CF.issuesFor && CF.issuesFor(e.from).some((i) => i.edgeId === e.id)) cls += ' bad';
    if (geo.back) cls += ' back';
    if (selId === e.id) cls += ' sel';
    if (C.live.on && C.live.trail.has(e.id)) cls += ' live-trail';
    if (now - Number(g.dataset.born) < 500) cls += ' appear';
    g.setAttribute('class', cls);
    g._mid = geo.mid;
    seen.add(e.id);
    const pa = portEl(a.id, e.port);
    const pb = portEl(b.id, 'in');
    if (pa) pa.classList.add('connected');
    if (pb) pb.classList.add('connected');
  }
  for (const [id, g] of edgeEls) if (!seen.has(id)) { g.remove(); edgeEls.delete(id); }
  const sg = selId && edgeEls.get(selId);
  if (sg) {
    delBtn.hidden = false;
    delBtn.style.left = sg._mid.x + 'px';
    delBtn.style.top = sg._mid.y + 'px';
  } else {
    delBtn.hidden = true;
  }
}
C.renderEdges = renderEdges;

function applyLiveClass() { if (world) world.classList.toggle('live-on', C.live.on); }
C.liveSet = (s) => {
  C.live = s ? { on: true, active: s.active || null, final: s.final || null, visited: s.visited || new Set(), trail: s.trail || new Set() }
    : { on: false, active: null, final: null, visited: new Set(), trail: new Set() };
  applyLiveClass();
  C.render();
};

/* let nodes glide to new positions while edges follow */
C.glide = () => {
  if (!world) { C.render(); return; }
  world.classList.add('glide');
  C.render();
  const t0 = performance.now();
  const loop = (now) => {
    renderEdges();
    if (now - t0 < 620) requestAnimationFrame(loop);
    else { if (world) world.classList.remove('glide'); renderEdges(); }
  };
  requestAnimationFrame(loop);
};

/* build a whole flow with a staggered reveal */
let buildToken = 0;
C.buildAnimated = async (flow) => {
  const tok = ++buildToken;
  await C.ready();
  CF.checkpoint();
  CF.select(null);
  CF.state = CF.normalizeFlow(Object.assign({}, flow, { id: CF.state.id }));
  CF.syncActive();
  C.hidden = new Set(flow.nodes.map((n) => n.id));
  C.flush();
  const order = CF.layout();
  C.flush();
  CF.emit('change', { building: true });
  C.fit(true);
  await CF.wait(CF.reducedMotion() ? 0 : 380);
  for (const id of order) {
    if (tok !== buildToken) break;
    C.hidden.delete(id);
    C.render();
    await CF.wait(CF.reducedMotion() ? 0 : 90);
  }
  C.hidden.clear();
  C.render();
  CF.commit({ structural: true });
};

/* ---------- interaction ---------- */
function track(move, up) {
  const mv = (e) => move(e);
  const u = (e) => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', u);
    window.removeEventListener('pointercancel', u);
    up(e);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', u);
  window.addEventListener('pointercancel', u);
}

function onDown(ev) {
  if (ev.button !== 0 && ev.button !== 1) return;
  CF.closeMenu();
  const t = ev.target;
  if (t.closest('#edgeDel')) {
    ev.preventDefault();
    if (CF.sel && CF.sel.type === 'edge') { CF.checkpoint(); CF.removeEdge(CF.sel.id); CF.select(null); CF.commit(); }
    return;
  }
  if (ev.button === 1) { startPan(ev); return; }
  const port = t.closest('.port.out');
  if (port) { ev.preventDefault(); startConnect(ev, port); return; }
  const nodeEl = t.closest('.node');
  if (nodeEl) { startNodeDrag(ev, nodeEl); return; }
  const edgeG = t.closest('.edge');
  if (edgeG) { CF.select({ type: 'edge', id: edgeG.dataset.id }); return; }
  startPan(ev);
}

function startPan(ev) {
  tweenId++;
  const sx = ev.clientX, sy = ev.clientY, vx = view.x, vy = view.y;
  let moved = false;
  track((e) => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 3) { moved = true; canvas && canvas.classList.add('panning'); }
    if (moved) { view.x = vx + dx; view.y = vy + dy; applyView(); }
  }, () => {
    if (canvas) canvas.classList.remove('panning');
    if (!moved && CF.sel) CF.select(null);
  });
}

function startNodeDrag(ev, el) {
  const n = CF.node(el.dataset.id);
  if (!n) return;
  const sx = ev.clientX, sy = ev.clientY, nx = n.x, ny = n.y;
  let moved = false;
  if (!(CF.sel && CF.sel.id === n.id)) CF.select({ type: 'node', id: n.id });
  track((e) => {
    const dx = (e.clientX - sx) / view.k, dy = (e.clientY - sy) / view.k;
    if (!moved && Math.hypot(dx, dy) > 3) { moved = true; CF.checkpoint(); el.classList.add('dragging'); }
    if (moved) {
      n.x = Math.round((nx + dx) / 4) * 4;
      n.y = Math.round((ny + dy) / 4) * 4;
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      renderEdges();
    }
  }, () => {
    el.classList.remove('dragging');
    if (moved) CF.commit({ moved: true });
  });
}

function startConnect(ev, pEl) {
  const from = pEl.closest('.node').dataset.id;
  const port = pEl.dataset.port;
  const a = CF.node(from);
  if (!a) return;
  const sx = ev.clientX, sy = ev.clientY;
  let hover = null;
  canvas.classList.add('connecting');
  const setHover = (id) => {
    if (hover === id) return;
    if (hover && nodeEls.get(hover)) nodeEls.get(hover).classList.remove('drop-target');
    hover = id;
    if (hover && nodeEls.get(hover)) nodeEls.get(hover).classList.add('drop-target');
  };
  track((e) => {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const tn = under && under.closest && under.closest('.node');
    const cand = tn ? CF.node(tn.dataset.id) : null;
    setHover(cand && cand.id !== from && cand.type !== 'start' ? cand.id : null);
    const pb = hover ? portPos(CF.node(hover), 'in') : C.toWorld(e.clientX, e.clientY);
    if (temp) temp.setAttribute('d', route(portPos(a, port), pb, 0, true).d);
  }, (e) => {
    if (temp) temp.setAttribute('d', '');
    if (canvas) canvas.classList.remove('connecting');
    if (hover) {
      const target = hover;
      setHover(null);
      CF.checkpoint();
      CF.connect(from, port, target);
      CF.commit();
    } else if (Math.hypot(e.clientX - sx, e.clientY - sy) > 24 && canvas) {
      const at = C.toWorld(e.clientX, e.clientY);
      CF.openMenu({ kind: 'nodes', x: e.clientX, y: e.clientY, ctx: { from, port, at } });
    }
  });
}

function onWheel(ev) {
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    zoomAt(ev.clientX, ev.clientY, view.k * Math.exp(-ev.deltaY * 0.01));
  } else {
    tweenId++;
    const f = ev.deltaMode === 1 ? 16 : 1;
    view.x -= ev.deltaX * f;
    view.y -= ev.deltaY * f;
    applyView();
  }
}

function onDbl(ev) {
  if (ev.target.closest('.node') || ev.target.closest('.edge')) return;
  CF.openMenu({ kind: 'nodes', x: ev.clientX, y: ev.clientY, ctx: { at: C.toWorld(ev.clientX, ev.clientY) } });
}

/* ---------- node creation shared by the add menu and the toolbar ---------- */
C.createNode = (type, ctx) => {
  CF.checkpoint();
  const n = CF.addNode(type);
  if (ctx && ctx.from) {
    n.x = Math.round(ctx.at.x);
    n.y = Math.round(ctx.at.y - 28);
    CF.connect(ctx.from, ctx.port, n.id);
  } else if (ctx && ctx.at) {
    n.x = Math.round(ctx.at.x - 132);
    n.y = Math.round(ctx.at.y - 28);
  } else {
    const res = CF.attachNew(n);
    if (!res.anchor) { const c = C.viewCenter(); n.x = Math.round(c.x); n.y = Math.round(c.y); }
    else avoidOverlap(n);
  }
  CF.lastTouched = n.id;
  CF.commit();
  CF.select({ type: 'node', id: n.id });
  requestAnimationFrame(() => C.focus(n.id));
};
function avoidOverlap(n) {
  for (let i = 0; i < 30; i++) {
    const hit = CF.state.nodes.some((o) => o.id !== n.id && Math.abs(o.x - n.x) < 270 && n.y < o.y + CF.measure(o.id).h + 20 && o.y < n.y + 120);
    if (!hit) return;
    n.y += 60;
  }
}

C.tidy = () => {
  if (!CF.state.nodes.length) return;
  CF.checkpoint();
  CF.layout();
  C.glide();
  CF.commit({ moved: true });
  setTimeout(() => C.fit(true), 80);
};
