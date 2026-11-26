import { useEffect, useState } from 'react';
import CF from '../lib/core.js';
import C from '../lib/canvas.js';
import { useCF } from '../lib/useCF.js';
import Toolbar from '../components/Toolbar.jsx';
import Canvas from '../components/Canvas.jsx';
import Inspector from '../components/Inspector.jsx';
import FlowPanel from '../components/FlowPanel.jsx';
import Chat from '../components/Chat.jsx';
import AgentsView from './Agents.jsx';
import { Icon } from '../components/Icon.jsx';

/* The editor: canvas + floating chrome. The agents view slides over the same chrome. */
export default function Workspace({ view }) {
  useCF();
  useKeys();
  const S = CF.state;
  const sel = view === 'flows' && CF.sel && CF.sel.type === 'node' ? CF.node(CF.sel.id) : null;
  const count = (t) => S.nodes.filter((n) => n.type === t).length;
  const leads = CF.flowStats(S).leads;

  return (
    <>
      <Canvas />
      <Toolbar view={view} />
      {sel ? <Inspector key={sel.id} n={sel} /> : view === 'flows' && CF.ui.flowPanel ? <FlowPanel /> : null}
      {view === 'agents' && <AgentsView />}
      <ZoomBar />
      <div id="status" className="status flow-only">
        {S.nodes.length > 0 && (
          <>
            <span><b>{S.nodes.length}</b> מצבים</span><span>·</span>
            <span><b>{count('ask')}</b> החלטות</span><span>·</span>
            {leads > 0 && <><span className="st-lead"><b>{leads}</b> starters</span><span>·</span></>}
            <span><b>{count('action')}</b> פעולות</span><span>·</span>
            <span className={'saved on' + (CF.disk && CF.disk.error ? ' bad' : '')} title={CF.disk && CF.disk.available ? 'data/state.json' : 'localStorage'}>
              <Icon name="check" />{CF.disk && CF.disk.available ? (CF.disk.error ? 'השמירה לדיסק נכשלה' : 'נשמר בדיסק') : 'נשמר בדפדפן'}
            </span>
          </>
        )}
      </div>
      <Chat />
      {!CF.ui.chatOpen && (
        <button id="chatFab" className="chat-fab" type="button" aria-label="פתח את העוזר" onClick={() => CF.chat.open()}>
          <Icon name="sparkle" />
        </button>
      )}
    </>
  );
}

function ZoomBar() {
  const [k, setK] = useState(C.view.k);
  useEffect(() => CF.on('view', (v) => setK(v.k)), []);
  return (
    <div id="zoom" className="glass zoom flow-only">
      <button type="button" title="הקטן" aria-label="הקטן" onClick={() => C.zoomBy(1 / 1.2)}><Icon name="minus" /></button>
      <button id="zLabel" type="button" title="100%" onClick={() => C.zoomTo(1)}>{Math.round(k * 100)}%</button>
      <button type="button" title="הגדל" aria-label="הגדל" onClick={() => C.zoomBy(1.2)}><Icon name="plus" /></button>
      <span className="z-sep" />
      <button type="button" title="התאם למסך" aria-label="התאם למסך" onClick={() => C.fit(true)}><Icon name="fit" /></button>
    </div>
  );
}

function useKeys() {
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (CF.ui.settingsOpen) { CF.openSettings(false); return; }
        if (CF.ui.exportOpen) { CF.ui.exportOpen = false; CF.emit('export'); return; }
        if (CF.ui.menu) { CF.closeMenu(); return; }
        if (typing) { e.target.blur(); return; }
        if (CF.sel) CF.select(null);
        return;
      }
      if (typing || CF.ui.view !== 'flows' || CF.ui.settingsOpen || CF.ui.exportOpen) return;
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) CF.redo(); else CF.undo(); return; }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); CF.redo(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && CF.sel) {
        e.preventDefault();
        CF.checkpoint();
        if (CF.sel.type === 'node') CF.removeNode(CF.sel.id); else CF.removeEdge(CF.sel.id);
        CF.select(null);
        CF.commit({ structural: true });
        return;
      }
      if (mod) return;
      if (e.key === 'f' || e.key === 'F') { C.fit(true); return; }
      if (e.key === '=' || e.key === '+') { C.zoomBy(1.2); return; }
      if (e.key === '-' || e.key === '_') { C.zoomBy(1 / 1.2); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
