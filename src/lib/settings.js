/* Studio settings (kept per browser, and on disk through localStore.js), and the AIServant account.

   The account (X-Agency-Id) is decided by the local server, never by the browser: it comes from .env
   (DEMO_LEADS_OWNER_UID) or from the settings window (PUT /local-api/account, kept in data/account.json).
   ENV mirrors what the server said in /local-api/info. */
import CF from './core.js';

const SKEY = 'callflow-studio:settings';
/* build-time constants from vite.config.js (.env) */
/* global __API_BASE__, __DEFAULT_ACCOUNT__, __HAS_SECRET__ */
export const ENV = {
  apiBase: typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : 'https://yoavhaik.com:7025',
  account: typeof __DEFAULT_ACCOUNT__ !== 'undefined' ? __DEFAULT_ACCOUNT__ : '',
  hasSecret: typeof __HAS_SECRET__ !== 'undefined' ? __HAS_SECRET__ : false,
  envAccount: typeof __DEFAULT_ACCOUNT__ !== 'undefined' ? __DEFAULT_ACCOUNT__ : '',
  accountOverridden: false,
};

export const settings = {
  // the "fast brain": the LLM behind the studio's AI chat (builder agent). Its key stays in this browser
  brainKey: '',
  brainModel: '',
  brainAutoUnder: 0, // runs estimated under this many USD start without asking
  wpm: 160, // speaking rate, to estimate how long a starter sounds
  apiBase: ENV.apiBase,
  accountId: ENV.account,
  voiceId: '', // default Cartesia voice for calls (an agent's own voice wins)
  voiceGender: '',
  calendarConnected: false, // the account has a calendar: book_meeting & co. may be called
};

/* older saved settings used other names */
function migrate(o) {
  if (!o || typeof o !== 'object') return {};
  const out = Object.assign({}, o);
  if (out.key && !out.brainKey) out.brainKey = out.key;
  if (out.builderModel && !out.brainModel) out.brainModel = out.builderModel;
  if (out.builderAutoUnder != null && out.brainAutoUnder == null) out.brainAutoUnder = out.builderAutoUnder;
  ['key', 'mode', 'model', 'builderModel', 'builderAutoUnder'].forEach((k) => delete out[k]);
  return out;
}
export const loadSettings = (o) => Object.assign(settings, migrate(o));
try { loadSettings(JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch (e) { /* ignore */ }

export const saveSettings = (patch) => {
  Object.assign(settings, patch);
  try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  CF.emit('settings');
};
/* the AI chat runs on the fast brain only with a key; without one it falls back to the built-in rule-based helper */
export const brainOn = () => !!(settings.brainKey || '').trim();

/* the account the local server acts on: ENV.account follows /local-api/info; setAccount changes it on the server ('' = back to .env) */
export const applyServerAccount = (info) => {
  if (!info || typeof info.agencyId !== 'string') return;
  ENV.account = info.agencyId;
  ENV.envAccount = info.envAgencyId != null ? info.envAgencyId : ENV.envAccount;
  ENV.accountOverridden = !!info.agencyOverridden;
  settings.accountId = info.agencyId;
  CF.emit('settings');
};
export async function setAccount(id) {
  const r = await fetch('./local-api/account', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agencyId: String(id || '').trim() }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  applyServerAccount(d);
  return d;
}
CF.settings = settings;

/* how long a line takes to say out loud (Hebrew TTS ≈ 2.5–3 words a second) */
export const speechMs = (text) => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.round(260 + words * (60000 / (settings.wpm || 160)));
};
