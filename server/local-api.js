/* Local API, served by the Vite dev server (and `vite preview`).
   Everything done in the studio is saved to disk under data/, and real calls go out from here:
     GET  /local-api/info      → { hasSecret, agencyId, envAgencyId, agencyOverridden, api, dataDir, savedAt }
     PUT  /local-api/account   ← { agencyId }: set the account by hand (kept in data/account.json); '' = back to .env
     GET  /local-api/state     → { workspace, settings, savedAt } from data/state.json
     PUT  /local-api/state     ← the same, written atomically (previous copy kept as state.prev.json)
     GET  /local-api/balance   → the account's AI minutes (AIServant /Credits/{agency}/balance)
     GET  /local-api/calls     → the last real call requests and AIServant's responses (data/calls.jsonl)
     POST /local-api/makecall  ← { flowName, body } (body = the makecall body); forwarded to AIServant with the shared secret, logged
     GET  /local-api/call/:id  → a placed call's status and transcript (AIServant /Calls/{callId})
     GET  /local-api/live              → the account's call history from AIServant (GET /Calls) + calls followed live (server/live-calls.js)
     GET  /local-api/live/:id          → one call's live record: status, transcript, script steps, events
     GET  /local-api/live/:id/stream   → the same as Server-Sent Events while the call runs
     POST /local-api/live/:id/watch    ← { flowName, flowId }: start following a call (makecall does this by itself)
     POST /local-api/live/:id/rtc      ← { type: offer|ice|stop, ... }: the browser's WebRTC leg to hear the call
     GET  /local-api/live/:id/recording → the call's recording (audio/mpeg; fetched once into data/recordings, Range supported)
     GET  /local-api/speech/config                 → { backend, tts, ttsModel }
     GET  /local-api/speech/:kind/table            → { backend, table }   (kind = starter | reaction)
     PUT  /local-api/speech/:kind/table            ← the whole table; 400 = AIServant's reason as text
     POST /local-api/speech/:voice/:kind/status    ← { texts } → { status: { text: has clip } }
     GET  /local-api/speech/:voice/:kind/clip?text= → the clip (audio/wav)
     GET  /local-api/speech/:voice/:kind/timestamps?text= → { timestamps } last saved from here (AIServant doesn't return them)
     PUT  /local-api/speech/:voice/:kind/clip      ← { text, audio (base64 WAV), timestamps }
     POST /local-api/speech/tts                    ← { voice, text, speed? } → { audio, timestamps } from Cartesia (8 kHz μ-law)
       (server/speech-clips.js: AIServant's /SpeechClips, or a local stand-in until it is live: SPEECH_CLIPS_BACKEND)
   Auth to AIServant (same as the CallPilot server): X-Api-Key = AISERVANT_SHARED_SECRET, X-Agency-Id = the account uid.
   The account is resolved here (DEMO_LEADS_OWNER_UID from .env, or the one set in the settings window: server/account.js),
   never taken from a call request; the body's apiKey is forced to the same uid. The secret is read from .env and never sent to the browser. */
import fs from 'node:fs';
import path from 'node:path';
import liveCalls, { CALL_ID } from './live-calls.js';
import speechClips, { KINDS, GUID, cartesiaSpeak } from './speech-clips.js';

const MAX_BODY = 20 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const send = (res, status, data, type) => {
  res.statusCode = status;
  res.setHeader('Content-Type', type || 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export default function localApi({ api, secret, account, dataDir, cartesia = {}, speechBackend = 'local' }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'state.json');
  const prevFile = path.join(dataDir, 'state.prev.json');
  const callsFile = path.join(dataDir, 'calls.jsonl');
  const recDir = path.join(dataDir, 'recordings'); // finished calls' recordings, fetched once from AIServant

  const agency = () => account.get(); // read on every request: the settings window can change it
  const live = liveCalls({ api, secret, agencyId: agency, dataDir });
  const speech = speechClips({ backend: speechBackend, api, secret, dataDir, agencyId: agency });
  // word timings saved from this studio, per account/voice/kind: AIServant doesn't hand them back
  const tsStore = (voice, kind, change) => {
    const f = path.join(dataDir, 'speech', String(agency()), 'timestamps', voice.toLowerCase() + '.' + kind + '.json');
    let m = {};
    try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* none yet */ }
    if (change) { change(m); fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, JSON.stringify(m, null, 1)); }
    return m;
  };
  const sameMachine = (req) => {
    const origin = req.headers.origin || '';
    return !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  };

  const readState = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return null; }
  };

  async function handle(req, res, next) {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/local-api/')) return next();
    // only pages served from this machine. A page on another site could otherwise send a "simple" cross-site
    // request (a form POST, no preflight) and, for example, place a real call with this server's secret
    if (!sameMachine(req)) return send(res, 403, { error: 'origin' });
    try {
      if (url === '/local-api/info' && req.method === 'GET') {
        const s = readState();
        return send(res, 200, { hasSecret: !!secret, agencyId: agency(), envAgencyId: account.env, agencyOverridden: account.overridden(), api, dataDir, savedAt: s ? s.savedAt : null });
      }
      // the settings window sets the account by hand (empty = back to DEMO_LEADS_OWNER_UID from .env)
      if (url === '/local-api/account' && req.method === 'PUT') {
        if (!sameMachine(req)) return send(res, 403, { error: 'origin' });
        let b;
        try { b = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return send(res, 400, { error: 'body is not JSON' }); }
        try { account.set(b.agencyId); } catch (e) { return send(res, 400, { error: e.message }); }
        return send(res, 200, { agencyId: agency(), envAgencyId: account.env, agencyOverridden: account.overridden() });
      }
      if (url === '/local-api/state' && req.method === 'GET') {
        return send(res, 200, readState() || {});
      }
      if (url === '/local-api/state' && req.method === 'PUT') {
        const data = JSON.parse(await readBody(req));
        if (!data || typeof data !== 'object' || !data.workspace || !Array.isArray(data.workspace.flows)) return send(res, 400, { error: 'expected { workspace: { flows } }' });
        data.savedAt = data.savedAt || Date.now();
        if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, prevFile);
        writeAtomic(stateFile, JSON.stringify(data, null, 1));
        return send(res, 200, { ok: true, savedAt: data.savedAt });
      }
      // a placed call's status, transcript and state reports (AIServant GET /Calls/{callId})
      if (url.startsWith('/local-api/call/') && req.method === 'GET') {
        if (!secret) return send(res, 400, { error: 'no-secret' });
        let id = url.slice('/local-api/call/'.length);
        try { id = decodeURIComponent(id); } catch (e) { /* checked below */ }
        if (!CALL_ID.test(id)) return send(res, 400, { error: 'bad call id' });
        const r = await fetch(api.replace(/\/+$/, '') + '/Calls/' + encodeURIComponent(id), { headers: { 'X-Api-Key': secret, 'X-Agency-Id': agency() } });
        return send(res, r.status, await r.text(), r.headers.get('content-type') || 'application/json; charset=utf-8');
      }
      // live call tracking: status + transcript polling and AIServant's listen socket (script_moved / script_result)
      if (url === '/local-api/live' && req.method === 'GET') {
        if (!secret || !agency()) return send(res, 200, { configured: false, calls: [] });
        const l = await live.list();
        return send(res, 200, { configured: true, calls: l.calls, error: l.error, agencyId: l.agencyId });
      }
      if (url.startsWith('/local-api/live/')) {
        const [rawId, action] = url.slice('/local-api/live/'.length).split('/');
        let id = rawId || '';
        try { id = decodeURIComponent(id); } catch (e) { /* checked below */ }
        if (!CALL_ID.test(id)) return send(res, 400, { error: 'bad call id' });
        if (!sameMachine(req)) return send(res, 403, { error: 'origin' });
        if (!action && req.method === 'GET') { const r = live.get(id); return r ? send(res, 200, r) : send(res, 404, { error: 'not watched' }); }
        if (action === 'stream' && req.method === 'GET') return live.stream(id, req, res);
        // the call's recording (MP3). Fetched from AIServant once (the secret is added here) and kept in data/recordings,
        // since a finished call's recording doesn't change; then served from disk with Range, so the player seeks instantly.
        if (action === 'recording' && req.method === 'GET') {
          if (!secret || !agency()) return send(res, 400, { error: 'no-secret' });
          const file = path.join(recDir, id + '.mp3');
          if (!fs.existsSync(file)) {
            const r = await fetch(api.replace(/\/+$/, '') + '/Calls/' + encodeURIComponent(id) + '/recording', { headers: { 'X-Api-Key': secret, 'X-Agency-Id': agency() } });
            if (!r.ok) return send(res, r.status === 404 ? 404 : 502, { error: 'recording: AIServant answered ' + r.status });
            const buf = Buffer.from(await r.arrayBuffer());
            if (!buf.length) return send(res, 404, { error: 'recording is empty' });
            // only a finished call's recording is kept; a call still running is served as is
            const rec = live.get(id);
            const done = rec && rec.info && (rec.info.status === 'ended' || rec.info.status === 'failed') && !rec.watching;
            if (!done) { res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' }); return res.end(buf); }
            fs.mkdirSync(recDir, { recursive: true });
            writeAtomic(file, buf);
          }
          const size = fs.statSync(file).size;
          const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
          const head = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
          if (!m || (m[1] === '' && m[2] === '')) {
            res.writeHead(200, Object.assign(head, { 'Content-Length': size }));
            return fs.createReadStream(file).pipe(res);
          }
          let a = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
          let b = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
          a = Math.max(0, a);
          if (a > b || a >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
          res.writeHead(206, Object.assign(head, { 'Content-Range': 'bytes ' + a + '-' + b + '/' + size, 'Content-Length': b - a + 1 }));
          return fs.createReadStream(file, { start: a, end: b }).pipe(res);
        }
        if (action === 'rtc' && req.method === 'POST') {
          let m;
          try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'body is not JSON' }); }
          const r = live.rtc(id, m || {});
          return send(res, r.ok ? 200 : 409, r);
        }
        if (action === 'watch' && req.method === 'POST') {
          if (!secret || !agency()) return send(res, 400, { error: 'no-secret' });
          let meta = {};
          try { const b = JSON.parse((await readBody(req)) || '{}'); meta = { flowName: b.flowName ? String(b.flowName).slice(0, 200) : undefined, flowId: b.flowId ? String(b.flowId).slice(0, 80) : undefined }; } catch (e) { /* no meta */ }
          Object.keys(meta).forEach((k) => meta[k] === undefined && delete meta[k]);
          const r = live.watch(id, meta);
          return send(res, 200, { ok: true, watching: !!r.watching });
        }
        return send(res, 404, { error: 'unknown live route' });
      }
      // speech clips: the agency's starter / reaction tables and a clip per voice + text (server/speech-clips.js)
      if (url.startsWith('/local-api/speech/')) {
        if (!sameMachine(req)) return send(res, 403, { error: 'origin' });
        const parts = url.slice('/local-api/speech/'.length).split('/').map((x) => { try { return decodeURIComponent(x); } catch (e) { return '\u0000'; } });
        const q = new URL(req.url, 'http://local').searchParams;
        const json = async () => { try { return JSON.parse((await readBody(req)) || 'null'); } catch (e) { throw Object.assign(new Error('body is not JSON'), { status: 400 }); } };
        try {
          if (parts[0] === 'config' && parts.length === 1 && req.method === 'GET') {
            return send(res, 200, { backend: speech.name, tts: !!cartesia.key, ttsModel: cartesia.model, agency: !!agency() });
          }
          // POST /local-api/speech/tts ← { voice, text, speed? } → { audio (base64 WAV, 8 kHz μ-law), timestamps }. The key stays here
          if (parts[0] === 'tts' && parts.length === 1 && req.method === 'POST') {
            if (!cartesia.key) return send(res, 400, { error: 'CARTESIA_API_KEY לא מוגדר ב-.env' });
            const b = (await json()) || {};
            const text = String(b.text || '').trim();
            if (!GUID.test(String(b.voice || ''))) return send(res, 400, { error: 'voice id של Cartesia הוא GUID' });
            if (!text || text.length > 500) return send(res, 400, { error: text ? 'הטקסט ארוך מדי (עד 500 תווים)' : 'חסר טקסט' });
            const out = await cartesiaSpeak(cartesia, { voice: b.voice, text, speed: b.speed });
            return send(res, 200, { audio: out.wav.toString('base64'), type: 'audio/wav', timestamps: out.timestamps });
          }
          // /local-api/speech/:kind/table
          if (KINDS.includes(parts[0]) && parts[1] === 'table' && parts.length === 2) {
            if (!agency()) return send(res, 400, { error: 'לא הוגדר חשבון (agency id)' });
            if (req.method === 'GET') return send(res, 200, { backend: speech.name, table: await speech.getTable(parts[0]) });
            if (req.method === 'PUT') { await speech.putTable(parts[0], await json()); return send(res, 200, { ok: true }); }
          }
          // /local-api/speech/:voice/:kind/(status|clip)
          if (GUID.test(parts[0]) && KINDS.includes(parts[1]) && parts.length === 3) {
            if (!agency()) return send(res, 400, { error: 'לא הוגדר חשבון (agency id)' });
            const [voice, kind, what] = parts;
            if (what === 'status' && req.method === 'POST') {
              const b = (await json()) || {};
              const texts = (Array.isArray(b.texts) ? b.texts : []).map(String).slice(0, 300);
              return send(res, 200, { status: await speech.status(voice, kind, texts) });
            }
            // the word timings last saved from here for that text (to start the editor from), or null
            if (what === 'timestamps' && req.method === 'GET') return send(res, 200, { timestamps: tsStore(voice, kind)[String(q.get('text') || '')] || null });
            if (what === 'clip' && req.method === 'GET') {
              const c = await speech.getClip(voice, kind, String(q.get('text') || ''));
              if (!c) return send(res, 404, { error: 'no clip' });
              res.writeHead(200, { 'Content-Type': c.type, 'Content-Length': c.body.length, 'Cache-Control': 'no-store' });
              return res.end(c.body);
            }
            // ← { text, audio: base64 WAV, timestamps: { words, start, end } }
            if (what === 'clip' && req.method === 'PUT') {
              const b = (await json()) || {};
              const wav = Buffer.from(String(b.audio || ''), 'base64');
              if (!wav.length) return send(res, 400, { error: 'the clip is empty.' });
              if (wav.length > 5 * 1024 * 1024) return send(res, 413, { error: 'the clip is too large (5 MB).' });
              await speech.putClip(voice, kind, String(b.text || ''), wav, b.timestamps);
              tsStore(voice, kind, (m) => { m[String(b.text || '')] = b.timestamps; });
              return send(res, 200, { ok: true });
            }
          }
        } catch (e) {
          return send(res, e.status || 400, { error: String(e.message || e) });
        }
        return send(res, 404, { error: 'unknown speech route' });
      }
      if (url === '/local-api/balance' && req.method === 'GET') {
        if (!secret || !agency()) return send(res, 200, { error: 'not configured' });
        const r = await fetch(api.replace(/\/+$/, '') + '/Credits/' + encodeURIComponent(agency()) + '/balance', { headers: { 'X-Api-Key': secret, 'X-Agency-Id': agency() } });
        const t = await r.text();
        return send(res, r.ok ? 200 : r.status, r.ok ? t : { error: 'HTTP ' + r.status });
      }
      if (url === '/local-api/calls' && req.method === 'GET') {
        let lines = [];
        try { lines = fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean); } catch (e) { /* none yet */ }
        return send(res, 200, lines.slice(-100).reverse().map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean));
      }
      if (url === '/local-api/makecall' && req.method === 'POST') {
        const text = await readBody(req);
        let wrap;
        try { wrap = JSON.parse(text); } catch (e) { return send(res, 400, { error: 'body is not JSON' }); }
        // the browser sends { flowName, body }: only `body` goes to AIServant
        const body = wrap && wrap.body ? wrap.body : wrap;
        if (!secret || !agency()) return send(res, 500, 'AISERVANT_SHARED_SECRET and DEMO_LEADS_OWNER_UID must be set in .env', 'text/plain; charset=utf-8');
        body.apiKey = agency(); // the account is resolved on the server, never from the browser
        const headers = { 'Content-Type': 'application/json', 'X-Api-Key': secret, 'X-Agency-Id': agency() };
        const t0 = Date.now();
        let status = 0;
        let out = '';
        try {
          const r = await fetch(api.replace(/\/+$/, '') + '/sip/makecall', { method: 'POST', headers, body: JSON.stringify(body) });
          status = r.status;
          out = await r.text();
        } catch (e) {
          out = 'could not reach AIServant: ' + (e.message || e);
        }
        const entry = {
          at: new Date(t0).toISOString(), ms: Date.now() - t0, to: body.to, apiKey: body.apiKey,
          flow: (wrap && wrap.flowName) || null, status, response: out.slice(0, 8000), request: body,
        };
        fs.appendFileSync(callsFile, JSON.stringify(entry) + '\n');
        // follow the new call live right away
        if (status >= 200 && status < 300) {
          try { const id = JSON.parse(out).callId; if (id && CALL_ID.test(id)) live.watch(id, { flowName: (wrap && wrap.flowName) || undefined, flowId: (wrap && wrap.flowId) || undefined, source: 'studio' }); } catch (e) { /* not JSON */ }
        }
        return send(res, status || 502, out || '', 'text/plain; charset=utf-8');
      }
      return send(res, 404, { error: 'unknown local-api route' });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  return {
    name: 'callflow-local-api',
    configureServer(server) { server.middlewares.use(handle); },
    configurePreviewServer(server) { server.middlewares.use(handle); },
  };
}
