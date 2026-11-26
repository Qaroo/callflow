import CF from '../lib/core.js';
import chat from '../lib/chat.js';
import { usd } from '../lib/pricing.js';
import { Icon } from './Icon.jsx';

/* The builder agent's mouse: a cursor that glides to what the agent is working on, clicks and types.
   On pages without the side chat, a small status pill keeps the run visible and stoppable. */
export default function AgentCursor() {
  const c = CF.cursor || {};
  const a = chat.agent || {};
  const home = CF.ui.view === 'voices';
  return (
    <>
      <div id="agent-cursor" aria-hidden="true" className={(c.on ? 'on' : '') + (c.clicking ? ' clicking' : '') + (c.typing ? ' typing' : '')}
        style={{ transform: `translate(${Math.round(c.x || 0)}px, ${Math.round(c.y || 0)}px)`, transitionDuration: (c.dur || 400) + 'ms' }}>
        <svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2.5l15 7.2-6.5 2-2.4 6.8z" fill="#7c3aed" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /></svg>
        <span className="ac-ring" />
        <span className="ac-tag"><Icon name="sparkle" />{c.typing ? 'מקליד…' : 'מוח מהיר'}</span>
      </div>
      {a.busy && (home || !CF.ui.chatOpen) && (
        <div className="agent-pill" role="status">
          <span className="ap-dot" />
          <span>מוח מהיר: {a.label || 'עובד…'}{a.cost ? ` · ${usd(a.cost)}` : ''}</span>
          {!CF.ui.chatOpen && !home && <button type="button" onClick={() => chat.open()}>פתח צ׳אט</button>}
          <button type="button" className="stop" onClick={() => CF.builder && CF.builder.stop()}><Icon name="stop" />עצור</button>
        </div>
      )}
    </>
  );
}
