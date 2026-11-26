import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import CF from '../lib/core.js';
import C from '../lib/canvas.js';
import { useCF } from '../lib/useCF.js';
import { Icon } from './Icon.jsx';
import { TEMPLATE_INFO } from '../lib/templates.js';

/* The diagram world flows left → right, so it stays LTR. */
export default function Canvas() {
  useCF();
  const canvas = useRef(null);
  const world = useRef(null);
  const gEdges = useRef(null);
  const temp = useRef(null);
  const layer = useRef(null);
  const delBtn = useRef(null);

  useEffect(() => {
    const un = C.mount({ canvas: canvas.current, world: world.current, gEdges: gEdges.current, temp: temp.current, layer: layer.current, delBtn: delBtn.current });
    requestAnimationFrame(() => { C.renderEdges(); C.fit(false); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => C.renderEdges());
    const off = CF.on('flowSwitch', () => { requestAnimationFrame(() => { C.renderEdges(); C.fit(false); }); });
    return () => { off(); un(); };
  }, []);

  // edges follow the measured DOM, so they are drawn after every React commit
  useLayoutEffect(() => { C.renderEdges(); });

  const S = CF.state;
  const selId = CF.sel && CF.sel.type === 'node' ? CF.sel.id : null;

  return (
    <main id="canvas" ref={canvas} dir="ltr" aria-label="דיאגרמת השיחה">
      <div id="world" ref={world}>
        <svg id="edges" width="20000" height="20000" aria-hidden="true">
          <g transform="translate(10000 10000)">
            <g id="edgeG" ref={gEdges} />
            <path id="tempEdge" ref={temp} className="temp-edge" d="" />
          </g>
        </svg>
        <div id="nodes" ref={layer}>
          {S.nodes.map((n) => <NodeCard key={n.id} n={n} selected={selId === n.id} staged={C.hidden.has(n.id)} />)}
        </div>
        <button id="edgeDel" ref={delBtn} className="edge-del" type="button" title="מחק חיבור" aria-label="מחק חיבור"><Icon name="close" /></button>
      </div>
      {!S.nodes.length && CF.ui.view === 'flows' && <EmptyState />}
    </main>
  );
}

function NodeCard({ n, selected, staged }) {
  const T = CF.TYPES[n.type] || CF.TYPES.say;
  const act = n.type === 'action' ? CF.ACTIONS[n.action] || CF.ACTIONS.crm : null;
  const icon = act ? act.icon : T.icon;
  const kind = n.type === 'ask' ? 'ask · החלטה' : n.type === 'action' ? 'action · ' + (n.tool || '—') : (CF.KIND[n.type] || '') + (n.type === 'start' ? ' · start' : '');
  const id = n.id;
  const ref = useCallback((el) => {
    if (!el) return undefined;
    C.nodeEls.set(id, el);
    return () => { if (C.nodeEls.get(id) === el) C.nodeEls.delete(id); };
  }, [id]);
  const probs = CF.issuesFor(id);
  const errs = probs.filter((p) => p.level === 'error').length;

  const cls = ['node'];
  if (staged) cls.push('staged');
  else if (!C.appeared.has(id)) cls.push('appear');
  if (selected) cls.push('selected');
  if (C.agentFocus === id) cls.push('agent-edit');
  if (C.live.on) {
    if (C.live.active === id) cls.push('live-now');
    else if (C.live.final === id) cls.push('live-final');
    if (C.live.visited.has(id)) cls.push('live-path');
  }
  if (errs) cls.push('has-error');
  const unclearEdge = n.type === 'ask' && n.fallback ? CF.outEdge(id, 'fallback') : null;

  return (
    <div ref={ref} className={cls.join(' ')} data-id={id} data-type={n.type} dir="rtl" style={{ left: n.x, top: n.y }}
      onAnimationEnd={(e) => { if (e.animationName === 'nodeIn') { C.appeared.add(id); e.currentTarget.classList.remove('appear'); } }}>
      <div className="n-head">
        <span className="n-icon"><Icon name={icon} /></span>
        <div className="n-titles">
          <div className="n-kind"><span>{kind}</span><code className="n-key" dir="ltr">{n.key}</code></div>
          <div className="n-title" dir="auto">{n.title}</div>
        </div>
        {probs.length > 0 && <span className={'n-issue' + (errs ? '' : ' warn')} title={probs.map((p) => p.msg).join('\n')}>{probs.length}</span>}
      </div>
      <div className="n-body">
        {n.starter && n.starter.trim() && <div className="n-starter" dir="auto"><Icon name="lead" /><span>{n.starter.trim()}</span></div>}
        {n.text && <div className="n-say" dir="auto">{n.text}</div>}
      </div>
      {n.type === 'ask' && (
        <div className="n-opts">
          {n.mode === 'free'
            ? <div className="n-opt"><div className="n-opt-main"><span className="n-opt-label">תשובה חופשית</span><code className="n-when">answered</code></div><span className="port out" data-port="answered" /></div>
            : n.options.map((o) => (
              <div key={o.id} className="n-opt">
                <div className="n-opt-main"><span className="n-opt-label" dir="auto">{o.label}</span></div>
                <span className="port out" data-port={o.id} />
              </div>
            ))}
          {n.fallback && (
            <div className="n-opt fb"><Icon name="sparkle" /><span className="n-opt-label">{unclearEdge ? 'לא ברור' : 'לא ברור · עונה מה-context'}</span><code className="n-when">unclear</code><span className="port out" data-port="fallback" /></div>
          )}
          {n.slot && <div className="n-slot" dir="ltr">slot: {n.slot}</div>}
        </div>
      )}
      {n.type === 'action' && (
        <div className="n-opts">
          <div className="n-opt ok"><div className="n-opt-main"><span className="n-opt-label">הצליח</span><code className="n-when">ok</code></div><span className="port out" data-port="out" /></div>
          <div className="n-opt fail"><div className="n-opt-main"><span className="n-opt-label">נכשל</span><code className="n-when">failed</code></div><span className="port out" data-port="failed" /></div>
        </div>
      )}
      {n.type !== 'start' && <span className="port in" data-port="in" />}
      {(n.type === 'start' || n.type === 'say') && <span className="port out single" data-port="out" title={n.when || ''} />}
    </div>
  );
}

/* the empty canvas offers the templates; the first is featured */
const TPLS = TEMPLATE_INFO.map((t, i) => ({ ...t, feature: i === 0 }));

function EmptyState() {
  const run = (p) => { CF.chat.open(); CF.assistant.handle(p); };
  return (
    <div id="empty" className="empty" dir="rtl">
      <div className="empty-art" aria-hidden="true">
        <svg viewBox="0 0 320 124" width="320" height="124">
          <g fill="none" strokeWidth="2" strokeLinecap="round">
            <path d="M78 62 C100 62 100 62 122 62" stroke="var(--edge)" />
            <path d="M198 50 C222 50 220 22 244 22" stroke="var(--edge)" />
            <path d="M198 62 C222 62 222 62 244 62" stroke="var(--edge)" />
            <path d="M198 76 C222 76 220 102 244 102" stroke="var(--purple)" strokeDasharray="4 5" />
          </g>
          <rect x="10" y="44" width="68" height="36" rx="10" fill="var(--surface)" stroke="var(--hair-strong)" />
          <rect x="20" y="54" width="16" height="16" rx="5" fill="var(--green)" />
          <rect x="42" y="59" width="26" height="6" rx="3" fill="var(--fill-strong)" />
          <rect x="122" y="34" width="76" height="56" rx="10" fill="var(--surface)" stroke="var(--hair-strong)" />
          <rect x="132" y="44" width="16" height="16" rx="5" fill="var(--indigo)" />
          <rect x="154" y="49" width="34" height="6" rx="3" fill="var(--fill-strong)" />
          <rect x="132" y="68" width="56" height="5" rx="2.5" fill="var(--fill)" />
          <rect x="132" y="78" width="40" height="5" rx="2.5" fill="var(--fill)" />
          <rect x="244" y="8" width="66" height="28" rx="9" fill="var(--surface)" stroke="var(--hair-strong)" />
          <rect x="252" y="16" width="12" height="12" rx="4" fill="var(--orange)" />
          <rect x="270" y="19" width="30" height="6" rx="3" fill="var(--fill-strong)" />
          <rect x="244" y="48" width="66" height="28" rx="9" fill="var(--surface)" stroke="var(--hair-strong)" />
          <rect x="252" y="56" width="12" height="12" rx="4" fill="var(--red)" />
          <rect x="270" y="59" width="30" height="6" rx="3" fill="var(--fill-strong)" />
          <rect x="244" y="88" width="66" height="28" rx="9" fill="var(--surface)" stroke="var(--purple)" strokeOpacity=".5" />
          <rect x="252" y="96" width="12" height="12" rx="4" fill="var(--purple)" />
          <rect x="270" y="99" width="30" height="6" rx="3" fill="var(--fill-strong)" />
        </svg>
      </div>
      <h1>תאר את השיחה. העץ נבנה לבד.</h1>
      <p>כל צומת הוא צעד בתסריט של AIServant. ההחלטה קובעת לאיזה חץ התשובה של הלקוח שייכת, ה-starter של הצעד הבא מושמע מיד, והמוח המהיר כותב את ההמשך לפי ה-context.</p>
      <div className="tpl-row">
        {TPLS.map((t) => (
          <button key={t.prompt} className={'tpl' + (t.feature ? ' feature' : '')} type="button" onClick={() => run(t.prompt)}>
            <span className="tpl-icon" style={{ '--c': `var(${t.c})` }}><Icon name={t.icon} /></span>
            {t.feature
              ? <span className="tpl-text"><b>{t.title}</b><span>{t.sub}</span></span>
              : <><b>{t.title}</b><span>{t.sub}</span></>}
          </button>
        ))}
      </div>
      <div className="empty-hint">או כתוב לעוזר בצ׳אט, במילים שלך</div>
    </div>
  );
}
