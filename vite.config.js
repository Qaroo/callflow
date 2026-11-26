import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import localApi from './server/local-api.js';
import accountStore from './server/account.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const api = env.YOAVHAIK_API_BASE_URL || 'https://yoavhaik.com:7025';
  // AIServant auth: X-Api-Key = shared secret, X-Agency-Id = account uid. Both are added on the local server;
  // the secret is never in the browser bundle
  const secret = env.AISERVANT_SHARED_SECRET || '';
  const agencyId = env.DEMO_LEADS_OWNER_UID || '';
  // Cartesia text-to-speech for the voice library (#/voices). The key stays on this server
  const cartesia = { key: env.CARTESIA_API_KEY || '', model: env.CARTESIA_MODEL || 'sonic-3.6', version: env.CARTESIA_VERSION || '2026-08-14' };
  const dataDir = path.resolve(process.cwd(), env.CALLFLOW_DATA_DIR || 'data');
  // the account can be changed by hand in the settings window (kept in data/account.json); .env is the default
  const account = accountStore(agencyId, dataDir);
  return {
    plugins: [react(), localApi({ api, secret, account, dataDir, cartesia, speechBackend: env.SPEECH_CLIPS_BACKEND === 'aiservant' ? 'aiservant' : 'local' })],
    base: './',
    define: {
      __API_BASE__: JSON.stringify(api),
      __DEFAULT_ACCOUNT__: JSON.stringify(agencyId),
      __HAS_SECRET__: JSON.stringify(!!secret),
    },
    server: {
      port: 5173,
      watch: { ignored: ['**/data/**'] },
    },
    preview: { port: 4173 },
  };
});
