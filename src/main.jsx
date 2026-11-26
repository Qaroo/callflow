import { createRoot } from 'react-dom/client';
import './styles/studio.css';
import './styles/app.css';
import CF from './lib/core.js';
import './lib/templates.js';
import './lib/settings.js';
import './lib/canvas.js';
import './lib/chat.js';
import './lib/agents.js';
import './lib/script.js';
import A from './lib/assistant.js';
import { loadFromDisk, startDiskSync } from './lib/localStore.js';
import App from './App.jsx';

/* theme: light by default, remembered per browser */
CF.applyTheme = (t) => {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('callflow-studio:theme', t); } catch (e) { /* ignore */ }
  CF.emit('theme');
};
CF.toggleTheme = () => CF.applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
let theme = 'light';
try { theme = localStorage.getItem('callflow-studio:theme') || 'light'; } catch (e) { /* ignore */ }
document.documentElement.dataset.theme = theme;

// everything is saved to data/state.json through the local server; load it first when it is newer
await loadFromDisk();
CF.load();
startDiskSync();
A.greet();
CF.setViewFromHash();
window.addEventListener('hashchange', CF.setViewFromHash);
// a file dropped outside a drop zone must not make the browser open it and replace the app
['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (!e.target.closest || !e.target.closest('.drop')) e.preventDefault();
}));

createRoot(document.getElementById('root')).render(<App />);
