import { useRef } from 'react';
import CF from '../lib/core.js';
import C from '../lib/canvas.js';
import { Icon } from './Icon.jsx';
import { pickAndImport } from '../lib/files.js';
import { LiveButton } from './LiveCall.jsx';

function ValidityBadge() {
  const list = CF.issues();
  const errors = list.filter((i) => i.level === 'error').length;
  const warns = list.length - errors;
  if (!CF.state.nodes.length) return null;
  return (
    <button type="button" className={'valid flow-only ' + (errors ? 'bad' : warns ? 'warn' : 'ok')} onClick={() => CF.openExport()}
      title={errors ? 'AIServant ידחה את התסריט. לחצו לפרטים' : 'התסריט עובר את הבדיקות של AIServant'}>
      <Icon name={errors ? 'close' : 'check'} />
      <span>{errors ? `${errors} בעיות` : 'תקין'}{!errors && warns ? ` · ${warns} הערות` : ''}</span>
    </button>
  );
}

export default function Toolbar({ view }) {
  const addRef = useRef(null);
  const flowBtn = useRef(null);
  const S = CF.state;
  const dark = document.documentElement.dataset.theme === 'dark';

  const commitName = (e) => {
    const v = e.target.value.trim() || 'תסריט חדש';
    if (v === S.name) return;
    CF.checkpoint();
    S.name = v;
    CF.commit();
  };

  return (
    <header id="toolbar" className="glass toolbar">
      <div className="brand">
        <button className="app-icon" type="button" title="התסריטים" aria-label="התסריטים" onClick={() => CF.navigate('flows')}>
          <Icon name="flow" />
        </button>
        <div className="brand-text">
          <div className="brand-name">Call Flow Studio</div>
          <div className="flow-switch flow-only">
            <input key={S.id + '|' + S.name} id="flowName" className="flow-name" type="text" defaultValue={S.name}
              aria-label="שם התסריט" spellCheck="false" onBlur={commitName}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            <button ref={flowBtn} id="flowMenuBtn" className="flow-menu-btn" type="button" title="כל התסריטים" aria-label="כל התסריטים"
              onClick={(e) => {
                e.stopPropagation();
                if (CF.ui.menu && CF.ui.menu.kind === 'flows') { CF.closeMenu(); return; }
                const r = flowBtn.current.getBoundingClientRect();
                CF.openMenu({ kind: 'flows', x: r.right, y: r.bottom + 10 });
              }}>
              <Icon name="chevronDown" />
            </button>
          </div>
          <div className="agents-title agents-only">סוכנים</div>
        </div>
      </div>

      <div className="nav-seg" role="tablist" aria-label="אזור">
        <button type="button" role="tab" className={view === 'flows' ? 'on' : ''} aria-selected={view === 'flows'} onClick={() => CF.navigate('flows')}>תסריטים</button>
        <button type="button" role="tab" className={view === 'agents' ? 'on' : ''} aria-selected={view === 'agents'} onClick={() => CF.navigate('agents')}>סוכנים</button>
        <button type="button" role="tab" onClick={() => CF.navigate('voices')}>ספריית קול</button>
      </div>

      <div className="tb-sep flow-only" />
      <div className="tb-group flow-only">
        <button ref={addRef} className="tb-btn" type="button" title="הוסף צומת"
          onClick={(e) => {
            e.stopPropagation();
            const r = addRef.current.getBoundingClientRect();
            CF.openMenu({ kind: 'nodes', x: r.right - 272, y: r.bottom + 8, ctx: null });
          }}>
          <Icon name="plus" /><span className="tb-label">צומת</span>
        </button>
        <button id="tbTidy" className="tb-btn" type="button" title="סדר את הדיאגרמה" onClick={() => C.tidy()}><Icon name="tidy" /><span className="tb-label">סדר</span></button>
        <button id="tbUndo" className="tb-btn icon-only" type="button" title="בטל (⌘Z)" aria-label="בטל" disabled={!CF.canUndo()} onClick={() => CF.undo()}><Icon name="undo" /></button>
        <button id="tbRedo" className="tb-btn icon-only" type="button" title="בצע שוב (⇧⌘Z)" aria-label="בצע שוב" disabled={!CF.canRedo()} onClick={() => CF.redo()}><Icon name="redo" /></button>
      </div>

      <div className="tb-sep flow-only" />
      <button className={'tb-btn flow-only' + (CF.ui.flowPanel ? ' on' : '')} type="button" title="personality, context, goldenRules, values, חצים גלובליים וכלים"
        onClick={() => CF.openFlowPanel(CF.ui.flowPanel ? null : 'instructions')}>
        <Icon name="sliders" /><span className="tb-label">הוראות</span>
      </button>
      <ValidityBadge />
      <LiveButton />
      <div className="tb-spacer" />

      <div className="engine flow-only" title="כך AIServant עונה בכל תור: ההחלטה מסווגת את תשובת הלקוח לחץ, ה-starter של הצעד הבא מושמע מיד, והמוח המהיר כותב את ההמשך לפי ה-context.">
        <span className="eng-step decide">החלטה</span>
        <span className="eng-arrow"><Icon name="chevronLeft" /></span>
        <span className="eng-step lead"><Icon name="lead" />starter</span>
        <span className="eng-arrow"><Icon name="chevronLeft" /></span>
        <span className="eng-step brain"><Icon name="sparkle" />מוח מהיר</span>
      </div>
      <button id="tbTheme" className="tb-btn icon-only" type="button" title={dark ? 'מצב בהיר' : 'מצב כהה'} aria-label="החלף מצב בהיר או כהה" onClick={() => CF.toggleTheme()}>
        <span className="theme-ic"><Icon name={dark ? 'sun' : 'moon'} /></span>
      </button>
      <button id="tbImport" className="tb-btn icon-only flow-only" type="button" title="ייבוא תסריט מקובץ JSON" aria-label="ייבוא JSON" onClick={() => pickAndImport(true)}><Icon name="upload" /></button>
      <button id="tbExport" className="tb-btn icon-only flow-only" type="button" title="ייצוא ל-AIServant" aria-label="ייצוא ל-AIServant" onClick={() => CF.openExport()}><Icon name="download" /></button>
      <button className="tb-btn icon-only" type="button" title="הגדרות" aria-label="הגדרות" onClick={() => CF.openSettings(true)}><Icon name="gear" /></button>
      <button id="tbTest" className="btn-primary flow-only" type="button" title="שיחה אמיתית עם התסריט הפתוח, למספר שתבחרו" onClick={() => CF.openExport('call')}><Icon name="phone" />שיחת בדיקה</button>
      <button className="btn-primary agents-only" type="button" onClick={() => {
        const a = CF.agents.create();
        CF.agents.current = a.id;
        CF.emit('agents');
        requestAnimationFrame(() => { const i = document.getElementById('ag-name'); if (i) { i.focus(); i.select(); } });
      }}><Icon name="plus" />סוכן חדש</button>
    </header>
  );
}
