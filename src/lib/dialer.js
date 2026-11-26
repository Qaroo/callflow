/* Real calls: POST /sip/makecall with the flow's script.
   With the local server running (npm run dev), the call goes to /local-api/makecall: the server adds the
   shared secret from .env, forwards to AIServant and logs request + response to data/calls.jsonl.
   A static build without the local server calls AIServant directly (no secret, likely blocked). */
import CF from './core.js';
import { settings, ENV } from './settings.js';
import { buildMakeCall } from './script.js';

export const apiUrl = (path) => {
  const direct = (settings.apiBase || ENV.apiBase).replace(/\/+$/, '');
  return CF.disk && CF.disk.available ? '/local-api/makecall' : direct + path;
};

/* returns { ok, status, message, json, body } */
export async function placeCall(flow, agent, call) {
  const f = flow || CF.state;
  const body = buildMakeCall(f, agent, call);
  if (!/^\+?\d[\d-]{6,}$/.test(body.to)) return { ok: false, status: 0, message: 'מספר הטלפון לא תקין.', body };
  const viaLocal = CF.disk && CF.disk.available;
  let res;
  try {
    res = viaLocal
      ? await fetch('./local-api/makecall', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowName: f.name, flowId: f.id, body }) })
      : await fetch(apiUrl('/sip/makecall'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, status: 0, message: 'לא הצלחתי להגיע לשרת השיחות (' + (e.message || e) + ').', body };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* plain text */ }
  let message = text;
  // shape problems come back as ASP.NET validation errors under `errors`; the tool check as plain text
  if (json && json.errors) {
    // when the script fails to parse, ASP.NET also reports the whole body as missing ("callOptions"): drop that echo
    let errs = Object.entries(json.errors);
    if (errs.length > 1) errs = errs.filter(([k]) => k !== 'callOptions');
    message = errs.map(([k, v]) => [].concat(v).join('\n') + (k.startsWith('$.') ? '' : ' (' + k + ')')).join('\n');
  }
  else if (json && (json.message || json.title)) message = json.message || json.title;
  if (res.status === 401) message = '401: AIServant דחה את ההרשאה. בדקו את AISERVANT_SHARED_SECRET ואת DEMO_LEADS_OWNER_UID ב-.env.';
  CF.emit('dial');
  return { ok: res.ok, status: res.status, message, json, body };
}
