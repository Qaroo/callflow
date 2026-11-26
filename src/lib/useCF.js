import { useSyncExternalStore } from 'react';
import CF from './core.js';

/* re-render on every workspace event (pan/zoom frames excluded) */
export const useCF = () => useSyncExternalStore(CF.subscribe, () => CF.v);
