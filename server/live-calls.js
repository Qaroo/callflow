/* Live call tracking on the local server.
   For each watched call the server does two things at once:
     1. polls AIServant GET /Calls/{callId} (status, transcript, state reports). This works on every call today.
       2. listens on AIServant's Conversation/listen/ws and records the events: script_moved (live step),
        script_result (final step, path, slots, tools), transcript, state_report, tool calls, call state.
   Protocol (from Yoav, 2026-11-23): first frame { ticket, callid, events }, ticket = HS256 JWT
   { agencyId, callId, scope: 'listen', exp } signed with AISERVANT_SHARED_SECRET (CallPilot's
   wsAuthFrame({ agencyId, callId, scope: 'listen' })). It can connect while the call rings; events start at answer
   and the transcript so far is replayed first. Every socket closes after call_closed.
   Audio: subscribe to "audio", then relay the browser's WebRTC offer / ICE (webrtc_offer, webrtc_answer, ice_candidate).
   The ticket is minted here and never leaves this process.
   Browsers read a call through GET /local-api/live/:id (snapshot) and /local-api/live/:id/stream (Server-Sent Events).
   Every call's record is saved to data/live/<callId>.json, so script_result survives a page reload. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket as WsClient } from 'ws';

const POLL_MS = 1500;
const MAX_EVENTS = 800;
const GRACE_MS = 20000; // keep listening this long after the call ends, for script_result and the summary
const STALE_PENDING_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 50; // calls shown in the list, from AIServant's history of the account
const HISTORY_MS = 10000; // the history is fetched at most this often (the list polls every few seconds)
const MAX_AUTO = 8; // live calls on the account followed automatically (each one polls AIServant every 1.5s)
// AIServant's ids, and inbound SIP call ids like 721989692_39766090@82.166.90.51 (no slashes: safe as a file name)
export const CALL_ID = /^(?!\.)[A-Za-z0-9_.@-]{6,120}$/;

const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
export function mintTicket(secret, agencyId, callId, scope = 'listen', ttlSec = 60) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ agencyId, callId, scope, exp: Math.floor(Date.now() / 1000) + ttlSec });
  const sig = crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}

/* the script the call runs, kept small: step id, kind, goal (for names in the UI) */
function treeOf(info) {
  const ins = info && info.options && info.options.instructions;
  const t = ins && (ins.instructionTree || ins.InstructionTree);
  if (!t || !Array.isArray(t.nodes)) return null;
  return { start: t.start, steps: t.nodes.map((n) => ({ id: n.id, kind: n.kind, goal: n.goal || '', slot: n.slot || undefined, tool: n.tool || undefined })) };
}
const slimInfo = (ci) => {
  const { options, ...rest } = ci || {}; // options carry the phone number and the whole prompt: not needed in the browser
  return rest;
};
const ended = (rec) => rec.info && (rec.info.status === 'ended' || rec.info.status === 'failed');

export default function liveCalls({ api, secret, agencyId, dataDir, log = () => {} }) {
  const agency = typeof agencyId === 'function' ? agencyId : () => agencyId; // a function when the settings window can change it
  const base = api.replace(/\/+$/, '');
  const wsBase = base.replace(/^http/, 'ws');
  const dir = path.join(dataDir, 'live');
  fs.mkdirSync(dir, { recursive: true });
  const headers = () => ({ 'X-Api-Key': secret, 'X-Agency-Id': agency() });
  const calls = new Map(); // callId → { rec, subs:Set, timer, ws, saveTimer, stopAt }

  const fileOf = (id) => path.join(dir, id + '.json');
  const load = (id) => { try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch (e) { return null; } };
  const save = (c) => {
    clearTimeout(c.saveTimer);
    c.saveTimer = setTimeout(() => {
      try { fs.mkdirSync(dir, { recursive: true }); const f = fileOf(c.rec.callId); fs.writeFileSync(f + '.tmp', JSON.stringify(c.rec)); fs.renameSync(f + '.tmp', f); } catch (e) { /* disk full etc: the record stays in memory */ }
    }, 400);
  };
  const push = (c, kind, payload) => {
    c.rec.updatedAt = Date.now();
    const frame = 'event: ' + kind + '\ndata: ' + JSON.stringify(payload) + '\n\n';
    for (const res of c.subs) { try { res.write(frame); } catch (e) { c.subs.delete(res); } }
    save(c);
  };
  const changed = (c, part) => push(c, 'patch', Object.assign({ updatedAt: Date.now() }, part));

  async function poll(c) {
    const rec = c.rec;
    try {
      const r = await fetch(base + '/Calls/' + encodeURIComponent(rec.callId), { headers: headers() });
      if (!r.ok) {
        rec.pollError = 'HTTP ' + r.status;
        // a call AIServant doesn't know (a typo, another account): give up after a minute
        if (r.status === 404 && Date.now() - rec.watchedAt > 60000) { rec.pollError = 'not found'; c.stopAt = Date.now(); }
        changed(c, { pollError: rec.pollError });
      } else {
        const d = await r.json();
        const info = slimInfo(d.callInfo);
        const part = {};
        if (JSON.stringify(info) !== JSON.stringify(rec.info)) { rec.info = info; part.info = info; }
        if (!rec.tree) { const t = treeOf(d.callInfo); if (t) { rec.tree = t; part.tree = t; } }
        const tr = d.transcripts || [];
        // the socket's transcript is newer while it runs; the poll's list wins when it has more lines
        const sockN = c.sockLines ? c.sockLines.length : 0;
        if (tr.length > sockN && JSON.stringify(tr) !== JSON.stringify(rec.transcripts)) { rec.transcripts = tr; part.transcripts = tr; }
        const rep = d.stateReports || [];
        if (JSON.stringify(rep) !== JSON.stringify(rec.reports)) { rec.reports = rep; part.reports = rep; }
        if (rec.pollError) { rec.pollError = null; part.pollError = null; }
        if (Object.keys(part).length) changed(c, part);
        // first sight of the call (ringing is fine): open the listen socket. Reconnects are the close handler's job
        if (!ended(rec) && !c.ws && !c.retryTimer && rec.socket.state === 'idle') connect(c);
        if (!ended(rec)) c.seenLive = true;
        // ended: wait a little for the last events. A call that was already over when we first looked (opened from the
        // history) has nothing more coming: stop now, and say there was no listening rather than "waiting for the call"
        if (ended(rec) && !c.stopAt) {
          c.stopAt = Date.now() + (c.seenLive ? GRACE_MS : 0);
          if (!c.seenLive && rec.socket.state === 'idle') setSocket(c, { state: 'off' });
        }
        if (info.status === 'pending' && Date.now() - new Date(info.createdAt).getTime() > STALE_PENDING_MS) c.stopAt = Date.now();
      }
    } catch (e) {
      rec.pollError = String(e.message || e);
      if (Date.now() - rec.watchedAt > 3 * 60 * 60 * 1000) c.stopAt = Date.now(); // offline for hours: stop
      changed(c, { pollError: rec.pollError });
    }
    if (c.stopAt && Date.now() >= c.stopAt) return stop(c);
    c.timer = setTimeout(() => poll(c), POLL_MS);
  }

  function setSocket(c, s) { c.rec.socket = Object.assign({}, c.rec.socket, s); changed(c, { socket: c.rec.socket }); }

  // what we ask the listen socket for (all public events but the chatty interim ones; "audio" only while listening)
  const EVENTS = ['transcript', 'tentative_transcript', 'start_speech', 'end_speech', 'dtmf', 'call_answered', 'call_start',
    'call_ending', 'call_closed', 'state_report', 'agent_review', 'tool_call_start', 'tool_call_end', 'voicemail',
    'script_moved', 'script_result'];
  const eventsFor = (c) => (c.audioOn ? EVENTS.concat('audio') : EVENTS);
  // shown live but not kept in the record's event list
  const TRANSIENT = new Set(['tentative_transcript', 'interim_transcript', 'start_speech', 'end_speech', 'speech_completed', 'clear_speech']);
  const LISTEN_PATH = '/Conversation/listen/ws';

  function connect(c) {
    const rec = c.rec;
    const tries = (rec.socket.tries || 0) + 1;
    setSocket(c, { state: 'connecting', tries, endpoint: LISTEN_PATH, reason: null });
    let ws;
    try { ws = new WsClient(wsBase + LISTEN_PATH, { handshakeTimeout: 8000 }); } catch (e) { setSocket(c, { state: 'closed', reason: String(e.message || e) }); return; }
    c.ws = ws;
    c.sockLines = null;
    let gotFrame = false;
    let reason = '';
    ws.on('open', () => {
      ws.send(JSON.stringify({ ticket: mintTicket(secret, agency(), rec.callId, 'listen'), callid: rec.callId, events: eventsFor(c) }));
      c.sockLines = []; // the transcript so far is replayed first, so this list rebuilds it
      setSocket(c, { state: 'open', openedAt: Date.now() });
    });
    ws.on('message', (data) => {
      let msg;
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      try { msg = JSON.parse(text); } catch (e) { msg = { event: 'raw', data: text.slice(0, 2000) }; }
      const name = msg.event || msg.type || 'message';
      if (!gotFrame) { gotFrame = true; rec.socket.tries = 0; setSocket(c, { state: 'live' }); }
      if (name === 'audio') { rec.audioFrames = (rec.audioFrames || 0) + 1; return; } // WebRTC carries the sound; frames are not stored
      if (name === 'webrtc_answer' || name === 'ice_candidate') { push(c, 'rtc', { event: name, data: msg.data }); return; }
      onEvent(c, { at: Date.now(), event: name, data: msg.data !== undefined ? msg.data : msg });
    });
    ws.on('error', (e) => { reason = String(e.message || e).replace(/^Unexpected server response: /, 'HTTP '); });
    ws.on('close', (code, buf) => {
      if (c.ws === ws) c.ws = null;
      reason = (buf && buf.length ? buf.toString() : '') || reason || ('code ' + code);
      const mine = calls.get(rec.callId) === c;
      const over = c.callClosed || /ended before it was answered/i.test(reason) || ended(rec);
      if (/ended before it was answered/i.test(reason)) rec.unanswered = true;
      if (!mine || over) { setSocket(c, { state: 'closed', reason, closedAt: Date.now() }); return; }
      const rejected = code === 1008 || /unauthori[sz]ed|forbidden|HTTP 40[13]/i.test(reason);
      const retry = (ms, state) => {
        setSocket(c, { state, reason });
        clearTimeout(c.retryTimer);
        c.retryTimer = setTimeout(() => {
          c.retryTimer = null;
          if (calls.get(rec.callId) !== c || c.ws) return;
          if (ended(rec)) setSocket(c, { state: 'closed', closedAt: Date.now() }); else connect(c);
        }, ms);
      };
      if (rejected && !gotFrame) {
        // the call may not be registered yet right after makecall: a few tries with a fresh ticket, then stop
        if (tries < 4) return retry(1500 * tries, 'retrying');
        setSocket(c, { state: 'rejected', reason, closedAt: Date.now() });
        return;
      }
      // dropped mid-call: reconnect (the transcript is replayed on connect)
      if (tries < 10) return retry(1500, 'retrying');
      setSocket(c, { state: 'closed', reason, closedAt: Date.now() });
    });
  }

  /* who said it: "data carries the role" (names normalized: role/Role/speaker/Speaker, string or number) */
  function roleOf(d) {
    const r = d.Role ?? d.role ?? d.Speaker ?? d.speaker ?? d.From ?? d.from;
    if (typeof r === 'number') return r === 1 ? 'customer' : 'aiAgent';
    const s = String(r || '').toLowerCase();
    if (/^(customer|user|caller|lead|client|human)$/.test(s)) return 'customer';
    if (/agent|ai|assistant|bot|model/.test(s)) return 'aiAgent';
    return s || 'aiAgent';
  }
  const textOf = (d) => (typeof d === 'string' ? d : d.Text ?? d.text ?? d.Transcript ?? d.transcript ?? d.Content ?? d.content ?? '');
  const toolOf = (d) => d.Tool ?? d.tool ?? d.Name ?? d.name ?? d.ToolName ?? d.toolName ?? '';

  function onEvent(c, ev) {
    const rec = c.rec;
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
    const part = {};
    if (!TRANSIENT.has(ev.event)) {
      rec.events.push(ev);
      if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);
      part.event = ev;
    }
    switch (ev.event) {
      case 'transcript': {
        const text = textOf(ev.data);
        if (!text) break;
        const line = { text, speaker: roleOf(d), timestamp: d.Timestamp || d.timestamp || new Date(ev.at).toISOString(), live: true };
        if (!c.sockLines) c.sockLines = [];
        c.sockLines.push(line);
        if (c.sockLines.length >= rec.transcripts.length || rec.transcripts.every((t) => t.live)) { rec.transcripts = c.sockLines.slice(); part.transcripts = rec.transcripts; }
        if (rec.partial && rec.partial.speaker === line.speaker) { rec.partial = null; part.partial = null; }
        break;
      }
      case 'tentative_transcript': case 'interim_transcript': {
        const text = textOf(ev.data);
        rec.partial = text ? { text, speaker: roleOf(d) } : null;
        part.partial = rec.partial;
        break;
      }
      case 'start_speech': rec.speaking = roleOf(d); part.speaking = rec.speaking; break;
      case 'end_speech': case 'speech_completed': rec.speaking = null; part.speaking = null; break;
      case 'call_answered': case 'call_start':
        if (rec.info && rec.info.status === 'pending') { rec.info = Object.assign({}, rec.info, { status: 'active', answered: true, startTime: rec.info.startTime || new Date(ev.at).toISOString() }); part.info = rec.info; }
        break;
      case 'call_ending': rec.ending = true; part.ending = true; break;
      case 'call_closed': c.callClosed = true; rec.speaking = null; rec.partial = null; rec.runningTool = null; Object.assign(part, { speaking: null, partial: null, runningTool: null }); break;
      case 'voicemail': rec.voicemail = true; part.voicemail = true; break;
      case 'state_report':
        rec.liveReport = { satisfaction: d.Satisfaction ?? d.satisfaction, report: d.Report ?? d.report ?? '', needHuman: !!(d.NeedHuman ?? d.needHuman), at: ev.at };
        part.liveReport = rec.liveReport;
        break;
      case 'tool_call_start': rec.runningTool = toolOf(d) || 'tool'; part.runningTool = rec.runningTool; break;
      case 'tool_call_end': rec.runningTool = null; part.runningTool = null; break;
      case 'script_moved':
        rec.moves.push(Object.assign({ at: ev.at }, d));
        rec.step = d.To || rec.step;
        rec.path = Array.isArray(d.Path) ? d.Path : rec.path;
        if (d.Slots) rec.slots = d.Slots;
        if (Array.isArray(d.Tools)) rec.tools = d.Tools;
        Object.assign(part, { step: rec.step, path: rec.path, slots: rec.slots, tools: rec.tools });
        break;
      case 'script_result':
        rec.result = d;
        rec.step = d.FinalStep || rec.step;
        if (Array.isArray(d.Path)) rec.path = d.Path;
        if (d.Slots) rec.slots = d.Slots;
        if (Array.isArray(d.Tools)) rec.tools = d.Tools;
        Object.assign(part, { result: d, step: rec.step, path: rec.path, slots: rec.slots, tools: rec.tools });
        break;
      default:
    }
    if (Object.keys(part).length) push(c, 'event', part);
  }

  /* the browser's WebRTC leg for hearing the call: its offer and ICE go up the listen socket,
     AIServant's answer and ICE come back as SSE 'rtc' events (see onEvent's caller) */
  function rtc(callId, m) {
    const c = calls.get(callId);
    if (!c || !c.ws || c.ws.readyState !== 1) return { ok: false, error: 'the call is not connected for listening' };
    const send = (event, data) => c.ws.send(JSON.stringify({ event, data }));
    if (m.type === 'stop') {
      if (c.audioOn) { c.audioOn = false; send('subscribe', { events: eventsFor(c) }); }
      return { ok: true };
    }
    if (!c.audioOn) { c.audioOn = true; send('subscribe', { events: eventsFor(c) }); } // an offer without "audio" subscribed is ignored
    const offerId = String(m.offerId || 'o1').slice(0, 40);
    if (m.type === 'offer' && typeof m.sdp === 'string') { send('webrtc_offer', { sdp: m.sdp, offerId }); return { ok: true }; }
    if (m.type === 'ice') { send('ice_candidate', { candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex, offerId }); return { ok: true }; }
    return { ok: false, error: 'unknown rtc message' };
  }

  function stop(c) {
    clearTimeout(c.timer);
    clearTimeout(c.retryTimer);
    if (c.ws) { try { c.ws.close(); } catch (e) { /* closed */ } c.ws = null; }
    c.rec.watching = false;
    changed(c, { watching: false });
    calls.delete(c.rec.callId);
    for (const res of c.subs) { try { res.write('event: done\ndata: {}\n\n'); res.end(); } catch (e) { /* gone */ } }
    // write now, not after the save delay: the watcher is gone, so the next reader (a stream opened a moment later) reads the file
    clearTimeout(c.saveTimer);
    try { fs.mkdirSync(dir, { recursive: true }); const f = fileOf(c.rec.callId); fs.writeFileSync(f + '.tmp', JSON.stringify(c.rec)); fs.renameSync(f + '.tmp', f); } catch (e) { /* disk full etc */ }
  }

  /* start watching a call (idempotent). meta: { flowName, flowId, source } */
  function watch(callId, meta = {}) {
    if (!CALL_ID.test(callId)) throw new Error('bad call id');
    let c = calls.get(callId);
    if (c) { if (meta && Object.keys(meta).length) { c.rec.meta = Object.assign({}, c.rec.meta, meta); changed(c, { meta: c.rec.meta }); } return c.rec; }
    const old = load(callId);
    if (old && old.info && (old.info.status === 'ended' || old.info.status === 'failed') && !old.watching) {
      if (meta && Object.keys(meta).length) { old.meta = Object.assign({}, old.meta, meta); }
      return old; // finished: nothing live to follow
    }
    const rec = Object.assign({
      callId, meta: {}, watchedAt: Date.now(), info: null, tree: null, transcripts: [], reports: [],
      socket: { state: 'idle', tries: 0 }, events: [], moves: [], step: null, path: [], slots: {}, tools: [], result: null,
    }, old || {}, { watching: true });
    rec.meta = Object.assign({}, rec.meta, meta);
    if (!rec.agencyId) rec.agencyId = agency(); // the account it was followed on: the list shows only the current one's
    rec.socket = { state: 'idle', tries: 0 };
    rec.partial = null; rec.speaking = null; rec.runningTool = null;
    c = { rec, subs: new Set(), timer: null, retryTimer: null, ws: null, saveTimer: null, stopAt: 0 };
    calls.set(callId, c);
    save(c);
    poll(c);
    log('watching call ' + callId);
    return rec;
  }

  function get(callId) {
    const c = calls.get(callId);
    return c ? c.rec : load(callId);
  }

  function stream(callId, req, res) {
    const c = calls.get(callId);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.write('event: snapshot\ndata: ' + JSON.stringify(get(callId) || { callId, missing: true }) + '\n\n');
    if (!c) { res.write('event: done\ndata: {}\n\n'); res.end(); return; }
    c.subs.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* gone */ } }, 15000);
    req.on('close', () => { clearInterval(ping); c.subs.delete(res); });
  }

  /* the account's call history from AIServant (GET /Calls, all statuses, newest first), cached briefly per account */
  let hist = { at: 0, agency: '', items: [] };
  async function history() {
    const a = agency();
    if (hist.agency === a && Date.now() - hist.at < HISTORY_MS) return hist.items;
    const r = await fetch(base + '/Calls?limit=' + HISTORY_LIMIT, { headers: headers() });
    if (!r.ok) throw new Error('AIServant answered HTTP ' + r.status + (r.status === 401 ? ' (an unknown account?)' : ''));
    const items = await r.json();
    hist = { at: Date.now(), agency: a, items: Array.isArray(items) ? items : [] };
    return hist.items;
  }

  const item = (r) => ({
    callId: r.callId, meta: r.meta || {}, watching: !!r.watching, info: r.info, step: r.step || null,
    result: r.result ? { FinalStep: r.result.FinalStep } : null, socket: r.socket && r.socket.state,
    lastLine: r.transcripts && r.transcripts.length ? r.transcripts[r.transcripts.length - 1] : null, unanswered: !!r.unanswered,
    watchedAt: r.watchedAt, lead: r.lead || null,
  });

  /* calls to show in the list: the current account's history from AIServant. Live ones are followed automatically;
     what the studio recorded locally (script name, steps) is added to the calls it knows */
  async function list() {
    const a = agency();
    let error = null;
    let items = [];
    try { items = await history(); } catch (e) { error = String(e.message || e); }
    // live calls on the account (placed from anywhere: the studio, CallPilot, campaigns): follow them
    for (const status of ['active', 'pending']) {
      try {
        const r = await fetch(base + '/Calls?limit=20&status=' + status, { headers: headers() });
        if (!r.ok) continue;
        for (const s of await r.json()) {
          const ci = s.callInfo || {};
          if (status === 'pending' && Date.now() - new Date(ci.createdAt).getTime() > STALE_PENDING_MS) continue;
          if (!calls.has(ci.callId) && calls.size >= MAX_AUTO) continue; // a busy campaign: follow the first few only
          watch(ci.callId, {});
        }
      } catch (e) { /* offline: show what we have */ }
    }
    const out = new Map();
    // followed in this session on this account (a call just placed shows up before AIServant lists it)
    for (const [, c] of calls) if (c.rec.agencyId === a) out.set(c.rec.callId, item(c.rec));
    for (const s of items) {
      const ci = s.callInfo || {};
      if (!ci.callId || !CALL_ID.test(ci.callId)) continue;
      const lead = (ci.options && ci.options.leadInfo && ci.options.leadInfo.name) || null;
      const known = out.get(ci.callId);
      if (known) { known.lead = known.lead || lead; continue; }
      const local = load(ci.callId) || {};
      const tr = s.transcripts || [];
      out.set(ci.callId, item(Object.assign({}, local, {
        callId: ci.callId, watching: false, info: slimInfo(ci), lead,
        transcripts: tr.length ? tr : local.transcripts,
      })));
    }
    const when = (c) => new Date((c.info && c.info.createdAt) || c.watchedAt || 0).getTime();
    return { calls: [...out.values()].sort((x, y) => (y.watching - x.watching) || (when(y) - when(x))), error, agencyId: a };
  }

  return { watch, get, stream, list, rtc, stopAll: () => { for (const [, c] of calls) stop(c); } };
}
