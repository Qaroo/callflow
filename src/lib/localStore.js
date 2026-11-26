/* Disk persistence through the local server (server/local-api.js → data/state.json).
   localStorage stays as a fast cache; whichever copy is newer wins at startup.
   Without the local server (a static build) this quietly does nothing. */
import CF from './core.js';
import { settings, loadSettings, applyServerAccount } from './settings.js';

const STAMP = 'callflow-studio:savedAt';
const WS_KEY = 'callflow-studio:v2';
export const disk = { available: false, savedAt: null, error: null, info: null };
CF.disk = disk;

const localStamp = () => { try { return Number(localStorage.getItem(STAMP)) || 0; } catch (e) { return 0; } };

/* call before CF.load(): if the disk copy is newer, it replaces the browser copy */
export async function loadFromDisk() {
  try {
    const [infoRes, stateRes] = await Promise.all([fetch('./local-api/info'), fetch('./local-api/state')]);
    if (!infoRes.ok || !stateRes.ok) return false;
    disk.info = await infoRes.json();
    applyServerAccount(disk.info); // the account the server acts on (.env or set by hand in the settings window)
    const st = await stateRes.json();
    disk.available = true;
    disk.savedAt = st.savedAt || null;
    if (!st.workspace || !Array.isArray(st.workspace.flows)) return false;
    if ((st.savedAt || 0) < localStamp()) return false; // the browser has newer work: it will be written to disk
    try {
      localStorage.setItem(WS_KEY, JSON.stringify(st.workspace));
      localStorage.setItem(STAMP, String(st.savedAt || Date.now()));
    } catch (e) { /* storage full: keep going in memory */ }
    if (st.settings) loadSettings(st.settings);
    return true;
  } catch (e) {
    return false;
  }
}

let timer = 0;
let inflight = false;
let again = false;
async function flush() {
  if (!disk.available) return;
  if (inflight) { again = true; return; }
  inflight = true;
  const savedAt = Date.now();
  try {
    CF.syncActive();
    const r = await fetch('./local-api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: CF.ws, settings, savedAt }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    disk.savedAt = savedAt;
    disk.error = null;
    try { localStorage.setItem(STAMP, String(savedAt)); } catch (e) { /* ignore */ }
  } catch (e) {
    disk.error = String(e.message || e);
  }
  inflight = false;
  CF.emit('disk');
  if (again) { again = false; schedule(); }
}
export function schedule() { clearTimeout(timer); timer = setTimeout(flush, 500); }

/* every kind of change ends up on disk */
export function startDiskSync() {
  ['saved', 'settings', 'agents'].forEach((ev) => CF.on(ev, schedule));
  if (disk.available && (!disk.savedAt || localStamp() > disk.savedAt)) schedule();
  window.addEventListener('beforeunload', () => { if (timer) { clearTimeout(timer); navigator.sendBeacon && flushBeacon(); } });
}
function flushBeacon() {
  try {
    CF.syncActive();
    // sendBeacon can only POST; the server accepts the same body on PUT, so a final save goes through fetch keepalive
    fetch('./local-api/state', { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: CF.ws, settings, savedAt: Date.now() }) });
  } catch (e) { /* ignore */ }
}
