import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import CF from '../lib/core.js';
import C from '../lib/canvas.js';
import { Icon } from './Icon.jsx';

const MENU_TYPES = ['say', 'ask', 'action', 'end'];

/* One floating menu at a time: "add node" or "all flows". */
export default function Menu() {
  const m = CF.ui.menu;
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [armed, setArmed] = useState(null);

  useEffect(() => {
    if (!m) return undefined;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest('#flowMenuBtn')) CF.closeMenu();
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [m]);
  useEffect(() => { setArmed(null); }, [m && m.kind]);

  useLayoutEffect(() => {
    if (!m || !ref.current) { setPos(null); return; }
    const w = m.kind === 'flows' ? 300 : 272;
    const h = ref.current.offsetHeight;
    const x = m.kind === 'flows' ? m.x - w : m.x;
    setPos({ left: CF.clamp(x, 8, window.innerWidth - w - 8), top: CF.clamp(m.y, 8, window.innerHeight - h - 8), width: w });
    if (m.kind === 'nodes') { const f = ref.current.querySelector('.menu-item'); if (f) f.focus({ preventScroll: true }); }
  }, [m]);

  if (!m) return null;
  const style = pos || { left: -9999, top: 0 };

  if (m.kind === 'nodes') {
    const types = (CF.state.nodes.some((n) => n.type === 'start') ? [] : ['start']).concat(MENU_TYPES);
    return (
      <div ref={ref} className="glass menu" role="menu" style={style}>
        <div className="menu-title">{m.ctx && m.ctx.from ? 'חבר לצומת חדש' : 'הוסף צומת'}</div>
        {types.map((t) => {
          const T = CF.TYPES[t];
          return (
            <button key={t} className="menu-item" type="button" role="menuitem" onClick={() => { CF.closeMenu(); C.createNode(t, m.ctx); }}>
              <span className="mi-icon" style={{ '--c': `var(${CF.typeColor(t)})` }}><Icon name={T.icon} /></span>
              <span><b>{T.label}</b><small>{T.desc}</small></span>
            </button>
          );
        })}
      </div>
    );
  }

  CF.syncActive();
  return (
    <div ref={ref} className="glass menu flows-menu" role="menu" style={style}>
      <div className="menu-title">תסריטי שיחה</div>
      {CF.ws.flows.map((f) => {
        const st = CF.flowStats(f);
        const ag = CF.ws.agents.filter((a) => a.flowId === f.id).map((a) => a.name);
        const on = f.id === CF.state.id;
        return (
          <div key={f.id} className={'fm-row' + (on ? ' on' : '')}>
            <button type="button" className="fm-open" onClick={() => { CF.closeMenu(); CF.openFlow(f.id); }}>
              <span className="fm-check">{on && <Icon name="check" />}</span>
              <span className="fm-text"><b dir="auto">{f.name}</b><small>{st.states} מצבים{st.leads ? ` · ${st.leads} פתיחים` : ''}{ag.length ? ' · ' + ag.join(', ') : ''}</small></span>
            </button>
            <button type="button" className="icon-btn" title="שכפל" aria-label="שכפל" onClick={() => { const c = CF.duplicateFlow(f.id); if (c) CF.toast('נוצר עותק: ' + c.name); }}><Icon name="copy" /></button>
            <button type="button" className={'icon-btn danger' + (armed === f.id ? ' armed' : '')} title={armed === f.id ? 'ללחוץ שוב כדי למחוק' : 'מחק'} aria-label="מחק"
              onClick={() => {
                if (armed === f.id) { setArmed(null); CF.deleteFlow(f.id); CF.closeMenu(); CF.toast('התסריט נמחק'); }
                else setArmed(f.id);
              }}><Icon name="trash" /></button>
          </div>
        );
      })}
      <button type="button" className="menu-item fm-new" onClick={() => { CF.closeMenu(); CF.newFlow(); CF.toast('תסריט חדש נפתח'); }}>
        <span className="mi-icon" style={{ '--c': 'var(--accent)' }}><Icon name="plus" /></span>
        <span><b>תסריט חדש</b><small>קנבס ריק</small></span>
      </button>
    </div>
  );
}
