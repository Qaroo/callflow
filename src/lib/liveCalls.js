/* Live calls in the browser. The local server (server/live-calls.js) follows each call: it polls AIServant
   for status + transcript and listens on Conversation/listen/ws (script_moved, script_result, transcript, state_report,
   tool calls, speech). Hearing the call: a recvonly WebRTC leg whose offer/answer/ICE go through the local server.
   Here we read that through Server-Sent Events, keep one "watched" call, and mirror its live step
   onto the canvas when the call runs the flow that is open.
   A call that ended can be replayed: its recording plays and the panel + canvas show the call as it
   stood at that second of the recording (see "replay" below). */
import CF from './core.js';
import C from './canvas.js';

const live = {
  list: [], // [{ callId, meta, watching, info, step, result, socket, lastLine }]
  configured: null,
  rec: null, // the watched call's full record
  open: false, // the live panel is open
  listOpen: false,
  audio: { state: 'off', error: null }, // off | connecting | on | failed
  replay: null, // { on, state: idle|loading|playing|paused|ended|failed, t, dur, rate, error } for an ended call's recording
};
CF.live = live;
let es = null;
let listTimer = 0;
const emit = () => CF.emit('live');

export const STATUS = {
  pending: { label: 'מחייג…', tone: 'wait' },
  active: { label: 'בשיחה', tone: 'live' },
  ended: { label: 'הסתיימה', tone: 'done' },
  failed: { label: 'נכשלה', tone: 'bad' },
};
export const END_REASON = {
  callerHangup: 'הלקוח ניתק', agentHangup: 'הסוכן סיים', noAnswer: 'לא ענו', busy: 'תפוס', cancelled: 'בוטלה', error: 'שגיאה',
  hangup: 'נותקה', timeout: 'פג זמן', voicemail: 'תא קולי',
};
export const SOCKET = {
  idle: 'ממתין לשיחה', waiting: 'ממתין שיענו כדי להתחבר לאירועים…', connecting: 'מתחבר לאירועי השיחה…', open: 'מחובר, האירועים יתחילו כשיענו', live: 'מקבל אירועים חיים מהשיחה', retrying: 'השרת עוד לא מוכן, מנסה שוב…',
  rejected: 'AIServant דחה את ההאזנה. מוצגים סטטוס ותמלול בלבד', closed: 'ההאזנה נסגרה', off: 'אין האזנה',
};
export const statusOf = (r) => (r && r.info && r.info.status) || (r && r.watching ? 'pending' : 'ended');
export const isLiveRec = (r) => !!r && !!r.watching && !['ended', 'failed'].includes(statusOf(r));

/* the flow a call runs, if it's in this workspace: by id first, then by name */
export function flowOfCall(r) {
  if (!r || !r.meta) return null;
  const flows = [CF.state].concat((CF.ws && CF.ws.flows) || []);
  const byId = r.meta.flowId && CF.flowById(r.meta.flowId);
  return byId || (r.meta.flowName && flows.find((f) => f && f.name === r.meta.flowName)) || null;
}
/* step id (= node key) → node in a flow */
export const nodeByKey = (flow, key) => (flow && key ? flow.nodes.find((n) => n.key === key) : null);
/* a readable name for a step id */
export function stepName(r, key) {
  if (!key) return '';
  const f = flowOfCall(r);
  const n = nodeByKey(f, key);
  if (n) return n.title || key;
  const s = r && r.tree && r.tree.steps.find((x) => x.id === key);
  return (s && s.goal) || key;
}

/* ---------- list ---------- */
export async function refreshList() {
  try {
    const r = await fetch('./local-api/live');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    live.configured = d.configured;
    live.list = d.calls || [];
    live.listError = d.error || null; // AIServant's history failed (calls followed live still show)
    live.listAccount = d.agencyId || '';
  } catch (e) {
    live.configured = false;
    live.list = [];
    live.listError = null;
  }
  emit();
  return live.list;
}
/* poll the list while the list is open or a call is live (cheap: the server answers from memory + one AIServant call) */
function scheduleList() {
  clearTimeout(listTimer);
  const busy = live.listOpen || live.list.some((c) => c.watching);
  if (!busy) return;
  listTimer = setTimeout(async () => { await refreshList(); scheduleList(); }, live.listOpen ? 3000 : 6000);
}
export function setListOpen(on) {
  live.listOpen = !!on;
  if (on) refreshList().then(scheduleList);
  emit();
}

/* ---------- one call ---------- */
function applyPatch(p) {
  const r = live.rec;
  if (!r) return;
  for (const k of Object.keys(p)) {
    if (k === 'event') { r.events = (r.events || []).concat(p.event); if (p.event.event === 'script_moved') r.moves = (r.moves || []).concat(Object.assign({ at: p.event.at }, p.event.data)); continue; }
    r[k] = p[k];
  }
}

export function watchCall(callId, meta, opts) {
  if (!callId) return;
  if (es) { es.close(); es = null; }
  stopAudio(true);
  disposeReplay();
  wantPlay = !!(opts && opts.play);
  live.rec = { callId, meta: meta || {}, watching: true, info: null, transcripts: [], events: [], moves: [], path: [], slots: {}, tools: [], socket: { state: 'idle' } };
  live.open = true;
  emit();
  const start = () => {
    es = new EventSource('./local-api/live/' + encodeURIComponent(callId) + '/stream');
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse(e.data);
      if (d.missing) return;
      live.rec = Object.assign({ events: [], moves: [], path: [], slots: {}, tools: [], transcripts: [] }, d);
      paint();
      if (!playIfWanted() && canReplay(live.rec)) ensurePlayer(); // load it now so play starts at once
    });
    es.addEventListener('patch', (e) => { applyPatch(JSON.parse(e.data)); paint(); playIfWanted(); });
    es.addEventListener('event', (e) => { applyPatch(JSON.parse(e.data)); paint(); });
    es.addEventListener('rtc', (e) => onRtc(JSON.parse(e.data)));
    es.addEventListener('done', async () => {
      if (es) { es.close(); es = null; }
      // the stream can end before it delivered the call (the server finished it a moment before we connected): read it once
      if (live.rec && live.rec.callId === callId && !live.rec.info) {
        try {
          const res = await fetch('./local-api/live/' + encodeURIComponent(callId));
          if (res.ok && live.rec && live.rec.callId === callId) live.rec = Object.assign({ events: [], moves: [], path: [], slots: {}, tools: [], transcripts: [] }, await res.json());
        } catch (e) { /* offline: keep what we have */ }
      }
      if (live.rec) live.rec.watching = false;
      stopAudio(true);
      paint();
      refreshList();
      // a call that just ended live: AIServant may still be saving the recording, so don't load it before play is pressed
      playIfWanted();
      wantPlay = false; // the call is fully known now: no recording means none is coming
    });
    es.onerror = () => { /* EventSource reconnects by itself while the server runs */ };
  };
  // tell the server to follow it (idempotent), then subscribe
  fetch('./local-api/live/' + encodeURIComponent(callId) + '/watch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta || {}),
  }).catch(() => {}).finally(start);
  refreshList().then(scheduleList);
}

export function closePanel() {
  wantPlay = false;
  stopAudio();
  disposeReplay();
  live.open = false;
  if (es) { es.close(); es = null; }
  live.rec = null;
  clearCanvas();
  emit();
}

/* open the call's flow in the studio and show where the call is */
export function showOnCanvas() {
  const r = live.rec;
  const f = flowOfCall(r);
  if (!f) return false;
  if (CF.state.id !== f.id && CF.openFlow) CF.openFlow(f.id);
  if (CF.ui.view !== 'flows') CF.navigate('studio');
  // coming from another page the canvas mounts a moment later: wait for it (up to ~2s) before moving the view
  let tries = 0;
  const go = () => {
    if (!(CF.canvas && CF.canvas.mounted && document.querySelector('.node')) && tries++ < 40) { setTimeout(go, 50); return; }
    paint();
    const v = shownRec() || r;
    const n = nodeByKey(CF.state, v.step || (v.path && v.path[v.path.length - 1]));
    if (n && v.replay && C.zoomToNode) C.zoomToNode(n.id, 0.7); // a replay: close enough to read the steps
    else if (n && C.focus) C.focus(n.id);
  };
  requestAnimationFrame(go);
  return true;
}

/* ---------- canvas mirror ---------- */
function clearCanvas() {
  if (!C.live || !C.live.on) return;
  C.liveSet(null);
}
function paint() {
  emit();
  const r = shownRec();
  if (!r || !C.liveSet) return;
  const f = flowOfCall(r);
  if (!f || f.id !== CF.state.id) { clearCanvas(); return; }
  const keys = (r.path && r.path.length ? r.path : []).slice();
  const cur = r.step || keys[keys.length - 1] || null;
  if (!cur) { clearCanvas(); return; } // no script events (yet): leave the diagram as it is
  const idOf = (k) => { const n = nodeByKey(CF.state, k); return n ? n.id : null; };
  const visited = new Set(keys.map(idOf).filter(Boolean));
  // the trail: an edge between each consecutive pair of the path (To can skip steps, and a pair reached
  // through a global arrow has no edge: those pairs are simply not drawn)
  const trail = new Set();
  for (let i = 1; i < keys.length; i++) {
    const a = idOf(keys[i - 1]);
    const b = idOf(keys[i]);
    if (!a || !b) continue;
    const e = CF.state.edges.find((x) => x.from === a && x.to === b);
    if (e) trail.add(e.id);
  }
  const moving = isLiveRec(r) || (r.replay && !r.replayDone); // a replay mid-recording looks like a live call
  C.liveSet({ active: moving ? idOf(cur) : null, final: !moving ? idOf(cur) : null, visited, trail });
}
CF.on('flowSwitch', () => requestAnimationFrame(paint));

/* ---------- hearing the call (WebRTC, receive only) ---------- */
let rtc = null; // { pc, offerId, el, pending: [], answered }
const setAudio = (state, error) => { live.audio = { state, error: error || null }; emit(); };
const rtcPost = (callId, body) => fetch('./local-api/live/' + encodeURIComponent(callId) + '/rtc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => (r.ok ? { ok: true } : Object.assign({ ok: false }, await r.json().catch(() => ({ error: 'HTTP ' + r.status })))));

export async function startAudio() {
  const r = live.rec;
  if (!r || typeof RTCPeerConnection !== 'function') { setAudio('failed', 'הדפדפן לא תומך ב-WebRTC'); return; }
  stopAudio(true);
  const callId = r.callId;
  const offerId = 'o' + Date.now().toString(36);
  const pc = new RTCPeerConnection();
  const el = new Audio();
  el.autoplay = true;
  rtc = { pc, offerId, el, callId, pending: [], answered: false };
  setAudio('connecting');
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.ontrack = (e) => {
    el.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]);
    el.play().then(() => setAudio('on')).catch(() => setAudio('on', 'לחצו על הדף כדי לאפשר שמע'));
  };
  pc.onicecandidate = (e) => {
    if (e.candidate && rtc && rtc.pc === pc) rtcPost(callId, { type: 'ice', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex, offerId });
  };
  pc.onconnectionstatechange = () => {
    if (!rtc || rtc.pc !== pc) return;
    if (pc.connectionState === 'failed') setAudio('failed', 'החיבור לשמע נכשל');
    if (pc.connectionState === 'connected' && live.audio.state !== 'on') setAudio('on');
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await rtcPost(callId, { type: 'offer', sdp: pc.localDescription.sdp, offerId });
    if (!res.ok) { stopAudio(true); setAudio('failed', res.error === 'the call is not connected for listening' ? 'השיחה עוד לא מחוברת להאזנה' : res.error); return; }
    // no answer in 10s: say so
    setTimeout(() => { if (rtc && rtc.pc === pc && !rtc.answered) setAudio('failed', 'AIServant לא ענה להצעת השמע'); }, 10000);
  } catch (e) { stopAudio(true); setAudio('failed', String(e.message || e)); }
}

async function onRtc(m) {
  if (!rtc || !m || !m.data) return;
  const d = m.data;
  if (d.offerId && d.offerId !== rtc.offerId) return; // an answer to an older offer
  try {
    if (m.event === 'webrtc_answer') {
      await rtc.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
      rtc.answered = true;
      for (const cand of rtc.pending.splice(0)) await rtc.pc.addIceCandidate(cand);
    } else if (m.event === 'ice_candidate' && d.candidate) {
      const cand = { candidate: d.candidate, sdpMid: d.sdpMid, sdpMLineIndex: d.sdpMLineIndex };
      if (rtc.answered) await rtc.pc.addIceCandidate(cand); else rtc.pending.push(cand);
    }
  } catch (e) { setAudio('failed', 'שגיאת WebRTC: ' + (e.message || e)); }
}

export function stopAudio(quiet) {
  if (rtc) {
    const { pc, el, callId } = rtc;
    rtc = null;
    try { pc.close(); } catch (e) { /* closed */ }
    try { el.pause(); el.srcObject = null; } catch (e) { /* gone */ }
    rtcPost(callId, { type: 'stop' }).catch(() => {});
  }
  if (!quiet || live.audio.state !== 'off') setAudio('off');
}

/* ---------- replaying an ended call: its recording + the call as it stood at that second ----------
   Clocks: the recording starts when the call was answered (info.startTime). Transcript lines carry AIServant's
   time (when the utterance ended). Script moves carry `at`, the local server's clock when the event arrived;
   the gap between the two clocks is measured on the transcript events, which carry both. */
let player = null; // HTMLAudioElement of the recording
let wantPlay = false;
let tlCache = { rec: null, key: '', tl: null };
let lastView = '';
const ms = (t) => Date.parse(String(t || '').replace(/(\.\d{3})\d+/, '$1'));

/* opened with "play" (from the history): start as soon as the call is known to have a recording */
function playIfWanted() {
  if (!wantPlay || !canReplay(live.rec)) return false;
  wantPlay = false;
  replayPlay();
  return true;
}
export const canReplay = (r) => !!(r && r.info && r.info.recordingId && r.info.startTime && !isLiveRec(r));

function timeline(r) {
  const key = (r.events || []).length + ':' + (r.moves || []).length + ':' + (r.transcripts || []).length;
  if (tlCache.rec === r && tlCache.key === key) return tlCache.tl;
  const t0 = ms(r.info.startTime);
  // local `at` minus AIServant time, on the events that carry both (median: one slow frame doesn't skew it)
  const gaps = (r.events || []).filter((e) => e.event === 'transcript' && e.data && (e.data.Timestamp || e.data.timestamp))
    .map((e) => e.at - ms(e.data.Timestamp || e.data.timestamp)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const lag = gaps.length ? gaps[gaps.length >> 1] : 0;
  const sec = (at) => (at - lag - t0) / 1000;
  const moves = (r.moves || []).map((m) => ({ sec: sec(m.at), m })).sort((a, b) => a.sec - b.sec);
  const lines = (r.transcripts || []).map((t) => ({ sec: (ms(t.timestamp) - t0) / 1000, t }));
  const events = (r.events || []).map((e) => ({ sec: sec(e.at), e }));
  const resultEv = events.find((x) => x.e.event === 'script_result');
  const reportEv = [...events].reverse().find((x) => x.e.event === 'state_report');
  // the second each step of the path was entered (chip i ↔ enter[i]); a stay in the same step doesn't count
  const enter = [0];
  moves.forEach(({ sec: s0, m }) => { if (m.From !== m.To) enter.push(s0); });
  const start = (r.path && r.path[0]) || (r.tree && r.tree.start) || null;
  const tl = { t0, lag, moves, lines, events, resultSec: resultEv ? resultEv.sec : Infinity, reportSec: reportEv ? reportEv.sec : Infinity, enter, start };
  tlCache = { rec: r, key, tl };
  return tl;
}

/* the record as it was `t` seconds into the recording */
function viewAt(r, t, done) {
  const tl = timeline(r);
  const mv = tl.moves.filter((x) => x.sec <= t).map((x) => x.m);
  const last = mv[mv.length - 1];
  const hasScript = tl.moves.length > 0;
  let path = [];
  if (last && Array.isArray(last.Path)) path = last.Path.slice();
  else if (hasScript && tl.start) { path = [tl.start]; mv.forEach((m) => { if (m.To && m.To !== path[path.length - 1]) path.push(m.To); }); }
  const step = !hasScript ? null : last ? last.To : tl.start;
  const evs = tl.events.filter((x) => x.sec <= t).map((x) => x.e);
  let runningTool = null;
  evs.forEach((e) => {
    if (e.event === 'tool_call_start') runningTool = (e.data && (e.data.Tool || e.data.tool || e.data.Name || e.data.name)) || 'tool';
    if (e.event === 'tool_call_end') runningTool = null;
  });
  const v = Object.assign({}, r, {
    replay: true,
    replayDone: !!done,
    transcripts: tl.lines.filter((x) => x.sec <= t).map((x) => x.t),
    moves: mv,
    events: evs,
    path,
    step,
    slots: (last && last.Slots) || {},
    tools: (last && last.Tools) || [],
    result: done || t >= tl.resultSec ? r.result : null,
    liveReport: done || t >= tl.reportSec ? r.liveReport : null,
    reports: done ? r.reports : [],
    runningTool,
    partial: null,
    speaking: null,
  });
  return v;
}

/* what the panel and the canvas show: the full record, or the replay's view of it */
export function shownRec() {
  const r = live.rec;
  const p = live.replay;
  if (!r || !p || !p.on) return r;
  return viewAt(r, p.t, p.state === 'ended');
}
/* the second of the recording where a transcript line starts (about when the line before it ended) */
export function lineStart(r, i) {
  const tl = timeline(r);
  const prev = tl.lines[i - 1];
  return Math.max(0, prev ? prev.sec + 0.2 : tl.lines[i] ? tl.lines[i].sec - 4 : 0);
}
/* the second the call entered the i-th step of its path */
export const stepStart = (r, i) => timeline(r).enter[i];

const setReplay = (p) => { live.replay = Object.assign({}, live.replay || {}, p); };
function onTime() {
  if (!player || !live.replay) return;
  setReplay({ t: player.currentTime });
  // repaint the canvas only when what it shows changes; the panel (time, bar) on every tick
  const v = shownRec();
  const key = v ? [v.step, (v.path || []).length, (v.transcripts || []).length, !!v.result, v.replayDone].join('|') : '';
  if (key !== lastView) {
    const stepChanged = v && lastView.split('|')[0] !== String(v.step);
    lastView = key;
    paint();
    // the canvas follows the call: pan to the new step if it's off screen (zoom stays as the person set it)
    if (stepChanged && v.step && live.replay.state === 'playing' && C.focus) {
      const f = flowOfCall(v);
      const n = f && f.id === CF.state.id && nodeByKey(CF.state, v.step);
      if (n) C.focus(n.id);
    }
  } else emit();
}
function ensurePlayer() {
  const r = live.rec;
  if (player || !canReplay(r)) return player;
  player = new Audio('./local-api/live/' + encodeURIComponent(r.callId) + '/recording');
  player.preload = 'auto';
  setReplay({ on: false, state: 'loading', t: 0, dur: Number(r.info.duration) || 0, rate: 1, error: null });
  player.addEventListener('loadedmetadata', () => { if (Number.isFinite(player.duration)) setReplay({ dur: player.duration }); emit(); });
  player.addEventListener('timeupdate', onTime);
  player.addEventListener('playing', () => { setReplay({ state: 'playing', error: null }); emit(); });
  player.addEventListener('pause', () => { if (live.replay && live.replay.state !== 'ended') { setReplay({ state: 'paused' }); emit(); } });
  player.addEventListener('waiting', () => { setReplay({ state: 'loading' }); emit(); });
  player.addEventListener('canplay', () => { if (live.replay && !live.replay.on && live.replay.state === 'loading') { setReplay({ state: 'idle' }); emit(); } }); // preloaded, play not pressed yet
  player.addEventListener('ended', () => { setReplay({ state: 'ended', t: live.replay.dur || player.currentTime }); lastView = ''; paint(); });
  player.addEventListener('error', () => {
    setReplay({ state: 'failed', error: 'ההקלטה לא נטענה. אם השיחה הסתיימה ממש עכשיו, AIServant אולי עוד שומר אותה: לחצו נגן שוב בעוד רגע.' });
    emit();
  });
  return player;
}
export function replayPlay() {
  wantPlay = false;
  if (live.replay && live.replay.state === 'failed') disposeReplay(); // try loading again
  const p = ensurePlayer();
  if (!p) return;
  const first = !live.replay.on;
  if (live.replay.state === 'ended') { p.currentTime = 0; }
  setReplay({ on: true, state: live.replay.state === 'ended' ? 'loading' : live.replay.state });
  lastView = '';
  onTime();
  if (first) showOnCanvas(); // open the call's flow once; after that the person may look elsewhere
  p.play().catch((e) => { if (e && e.name === 'NotAllowedError') setReplay({ state: 'paused', error: 'לחצו על נגן כדי להתחיל' }); emit(); });
}
export function replayPause() { wantPlay = false; if (player) player.pause(); }
export function replaySeek(sec) {
  wantPlay = false;
  const p = ensurePlayer();
  if (!p) return;
  const t = Math.max(0, Math.min(Number(sec) || 0, (live.replay.dur || Infinity) - 0.05));
  p.currentTime = t;
  setReplay({ on: true, t, state: live.replay.state === 'ended' ? 'paused' : live.replay.state });
  lastView = '';
  onTime();
}
export function replayRate(rate) { if (player) player.playbackRate = rate; setReplay({ rate }); emit(); }
/* leave the replay: back to the whole call */
export function replayExit() { wantPlay = false; disposeReplay(); paint(); }
function disposeReplay() {
  if (player) { try { player.pause(); player.removeAttribute('src'); player.load(); } catch (e) { /* gone */ } player = null; }
  live.replay = null;
  lastView = '';
}

export default live;
