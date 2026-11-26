/* The AIServant account (X-Agency-Id) the local server acts on.
   Default: DEMO_LEADS_OWNER_UID from .env. The settings window can override it; the override is kept in
   data/account.json so it survives a restart, and clearing it goes back to the .env value. */
import fs from 'node:fs';
import path from 'node:path';

export const AGENCY_ID = /^[A-Za-z0-9_-]{1,128}$/;

export default function accountStore(envId, dataDir) {
  const file = path.join(dataDir, 'account.json');
  let override = '';
  try {
    const v = String(JSON.parse(fs.readFileSync(file, 'utf8')).agencyId || '').trim();
    if (AGENCY_ID.test(v)) override = v;
  } catch (e) { /* no override yet */ }

  return {
    env: envId || '',
    get: () => override || envId || '',
    overridden: () => !!override,
    /* '' (or the .env value) clears the override */
    set(id) {
      const v = String(id || '').trim();
      if (v && !AGENCY_ID.test(v)) throw new Error('agency id may hold only letters, digits, _ and -');
      override = v === envId ? '' : v;
      fs.mkdirSync(dataDir, { recursive: true });
      if (override) fs.writeFileSync(file, JSON.stringify({ agencyId: override, savedAt: new Date().toISOString() }, null, 1));
      else fs.rmSync(file, { force: true });
      return override || envId || '';
    },
  };
}
