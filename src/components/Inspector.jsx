import { useRef } from 'react';
import CF from '../lib/core.js';
import { speechMs } from '../lib/settings.js';
import { incomingArrows, applyValues } from '../lib/script.js';
import { Icon } from './Icon.jsx';

const WORDS = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

/* Step editor. Fields map 1:1 onto an instructionTree step:
   key → id, title → goal, text → context, starter, slot (ask), tool (action), maxVisits, arrows. */
export default function Inspector({ n }) {
  const pending = useRef(false);
  const T = CF.TYPES[n.type];
  const act = n.type === 'action' ? CF.ACTIONS[n.action] || CF.ACTIONS.crm : null;
  const kind = CF.KIND[n.type];
  const probs = CF.issuesFor(n.id);

  const live = (fn) => (e) => {
    if (pending.current) { CF.checkpoint(); pending.current = false; }
    fn(e.target.value, e);
    CF.commit({ source: 'inspector' });
  };
  const step = (fn) => { CF.checkpoint(); fn(); CF.commit(); };

  const iconStyle = { '--c': `var(${CF.typeColor(n.type)})` };
  const words = WORDS(n.starter);
  const tools = CF.tools(CF.state);
  const target = (port) => { const e = CF.outEdge(n.id, port); const t = e && CF.node(e.to); return t ? t.key : null; };

  return (
    <aside id="inspector" className="glass inspector flow-only" aria-label="מאפייני צעד" onFocus={() => { pending.current = true; }}>
      <div className="insp-head">
        <span className="n-icon" style={iconStyle}><Icon name={act ? act.icon : T.icon} /></span>
        <div><div className="insp-kind">{kind ? `צעד ${kind}` : T.label}{n.type === 'start' ? ' · start' : ''}</div><div className="insp-sub">{T.label}</div></div>
        <button className="icon-btn" type="button" aria-label="סגור" onClick={() => CF.select(null)}><Icon name="close" /></button>
      </div>

      {probs.length > 0 && (
        <div className="insp-issues">
          {probs.map((p, i) => <div key={i} className={'iss ' + p.level}><Icon name={p.level === 'error' ? 'close' : 'sparkle'} /><span>{p.msg}</span></div>)}
        </div>
      )}

      <div className="row-2">
        <label className="field"><span>מטרה <code>goal</code></span>
          <input className="input" type="text" value={n.title || ''} dir="auto" placeholder={n.type === 'end' ? 'התוצאה של השיחה' : 'למשל: האם יגיע לתור'} onChange={live((v) => { n.title = v; })} />
        </label>
        <label className="field key"><span>מזהה <code>id</code></span>
          <input className="input mono" type="text" value={n.key || ''} dir="ltr" spellCheck="false"
            onChange={live((v) => { n.key = CF.slug(v) || v; })}
            onBlur={() => { if (!n.key) { n.key = CF.uniqueKey('step', null, n.id); CF.commit(); } }} />
        </label>
      </div>

      <label className="field"><span className="lbl-lead"><Icon name="lead" />פתיח מיידי <code>starter</code><small className={words > 3 ? 'bad' : ''}>{words ? `${words} מילים · ~${(speechMs(n.starter) / 1000).toFixed(1)} שנ׳` : 'לא חובה'}</small></span>
        <input className="input lead-in" type="text" value={n.starter || ''} dir="auto" placeholder="1 עד 3 מילים, למשל: מעולה," onChange={live((v) => { n.starter = v; })} />
      </label>

      <label className="field"><span>מה להעביר <code>context</code></span>
        <textarea className="textarea" rows={3} dir="auto" value={n.text || ''} placeholder="מה התשובה בצעד הזה צריכה להעביר. לא משפט להקראה: הסוכן מנסח בעצמו."
          onChange={live((v) => { n.text = v; })} />
      </label>
      <HeardAfter n={n} />

      {(n.type === 'start' || n.type === 'say') && (
        <label className="field"><span>תגובת הלקוח שמעבירה הלאה <code>when</code></span>
          <input className="input" type="text" value={n.when || ''} dir="auto" placeholder="למשל: מקשיב, מסכים" onChange={live((v) => { n.when = v; })} />
          <small className="opt-to">ממשיך אל: {target('out') || 'לא מחובר'}</small>
        </label>
      )}

      {n.type === 'action' && (
        <>
          <label className="field"><span>כלי <code>tool</code></span>
            <select className="select" value={n.tool || ''} onChange={(e) => step(() => {
              n.tool = e.target.value;
              const k = CF.actionOfTool(n.tool);
              if (k) n.action = k;
            })}>
              {!CF.toolExists(CF.state, n.tool) && <option value={n.tool || ''}>{n.tool || 'בחרו כלי'} (לא קיים)</option>}
              <optgroup label="הכלים של התסריט (aiTools)">
                {tools.filter((t) => !CF.callableBuiltins().includes(t.name)).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </optgroup>
              <optgroup label="מובנים בדיילר">
                {CF.builtinPick().map((t) => <option key={t} value={t}>{t}</option>)}
              </optgroup>
            </select>
            <small className="opt-to">{CF.callableBuiltins().includes(n.tool) ? 'כלי מובנה של הדיילר, לא נשלח ב-aiTools.' : 'כלי מהוראות התסריט, נשלח ב-aiTools.'} ok: {target('out') || 'לא מחובר'} · failed: {target('failed') || 'לא מחובר'}</small>
          </label>
          <button type="button" className="link" onClick={() => CF.openFlowPanel('tools')}><Icon name="bolt" />ניהול הכלים</button>
        </>
      )}

      {n.type === 'ask' && (
        <>
          <label className="field"><span>שם התשובה בתוצאות <code>slot</code></span>
            <input className="input mono" type="text" value={n.slot || ''} dir="ltr" spellCheck="false" onChange={live((v) => { n.slot = CF.slug(v) || v; })} />
          </label>
          <div className="field"><span>סוג התשובה</span>
            <div className="seg2 sm">
              <button type="button" className={n.mode !== 'free' ? 'on' : ''} onClick={() => step(() => CF.setMode(n, 'options'))}><b>אפשרויות</b><small>כל אפשרות היא חץ</small></button>
              <button type="button" className={n.mode === 'free' ? 'on' : ''} onClick={() => step(() => CF.setMode(n, 'free'))}><b>תשובה חופשית</b><small>חץ answered אחד</small></button>
            </div>
          </div>
          {n.mode !== 'free' ? (
            <div className="field">
              <div className="section-title"><span>חצים: האפשרויות שההחלטה מסווגת אליהן</span><small>{n.options.length}</small></div>
              <div className="opt-list">
                {n.options.map((o) => {
                  const e = CF.outEdge(n.id, o.id);
                  const to = e && CF.node(e.to);
                  const reserved = CF.RESERVED.includes((o.label || '').trim());
                  return (
                    <div key={o.id} className={'opt-card' + (reserved ? ' bad' : '')}>
                      <input className="input opt-label" type="text" value={o.label} dir="auto" aria-label="when" data-oid={o.id} onChange={live((v) => { o.label = v; })} />
                      <button className="icon-btn danger" type="button" aria-label="מחק אפשרות" onClick={() => step(() => CF.removeOption(n.id, o.id))}><Icon name="trash" /></button>
                      <input className="input opt-ex" type="text" value={o.examples.join(', ')} placeholder="מה הלקוח יגיד, מופרד בפסיק. נשלח להחלטה כ-description" dir="auto" aria-label="דוגמאות"
                        onChange={live((v) => { o.examples = v.split(/[,،]/).map((x) => x.trim()).filter(Boolean); })} />
                      <div className="opt-to">{to ? 'אל: ' + to.key : 'לא מחובר, ולכן לא נשלח. גררו מהנקודה בצומת.'}</div>
                    </div>
                  );
                })}
              </div>
              <button className="add-opt" type="button" onClick={() => {
                step(() => { const o = CF.opt('אפשרות חדשה', ''); o.examples = []; n.options.push(o); });
                requestAnimationFrame(() => {
                  const cards = document.querySelectorAll('#inspector .opt-label');
                  const last = cards[cards.length - 1];
                  if (last) { last.focus(); last.select(); }
                });
              }}><Icon name="plus" />הוסף אפשרות</button>
            </div>
          ) : (
            <p className="hint">כל תשובה נשמרת תחת <code>{n.slot}</code> וממשיכה בחץ answered אל {target('answered') || 'צעד שעוד לא חובר'}.</p>
          )}
          <div className="card-row">
            <span className="lbl"><Icon name="sparkle" />חץ "לא ברור" <code>unclear</code></span>
            <label className="switch"><input type="checkbox" checked={!!n.fallback} aria-label="חץ unclear" onChange={(e) => step(() => CF.setFallback(n, e.target.checked))} /><i /></label>
          </div>
          <p className="hint">כשהלקוח שואל משהו שאין לו חץ, למשל "כמה זה עולה?", הסוכן עונה מה-context של התסריט ונשאר בשאלה. אם הלקוח כבר ענה על השאלה קודם בשיחה, AIServant מדלג עליה.</p>
        </>
      )}

      <label className="field narrow"><span>מספר ביקורים מקסימלי <code>maxVisits</code></span>
        <input className="input" type="number" min="1" step="1" value={n.maxVisits || ''} placeholder="ללא הגבלה"
          onChange={live((v) => { const x = parseInt(v, 10); n.maxVisits = x > 0 ? x : null; })} />
      </label>

      <div className="insp-foot">
        <button className="btn-soft" type="button" onClick={() => {
          CF.checkpoint();
          const copy = JSON.parse(JSON.stringify(n));
          copy.id = CF.uid('n');
          copy.x += 30; copy.y += 30;
          copy.key = CF.uniqueKey(n.key);
          if (copy.slot) copy.slot = CF.uniqueSlot(n.slot);
          if (copy.options) copy.options.forEach((o) => { o.id = CF.uid('o'); });
          copy.title = n.title + ' (עותק)';
          CF.state.nodes.push(copy);
          CF.commit();
          CF.select({ type: 'node', id: copy.id });
        }}><Icon name="copy" />שכפל</button>
        <button className="btn-soft danger" type="button" onClick={() => { CF.checkpoint(); CF.removeNode(n.id); CF.select(null); CF.commit({ structural: true }); }}>
          <Icon name="trash" />מחק
        </button>
      </div>
    </aside>
  );
}

/* a starter is played after every arrow that reaches the step: show each one */
const SRC = (x) => (x.kind === 'start' ? 'תחילת השיחה' : x.kind === 'global' ? `חץ גלובלי "${x.when}"` : x.kind === 'failed' ? `[${x.from.key}] נכשל` : x.kind === 'ok' ? `[${x.from.key}] הצליח` : x.kind === 'unclear' ? `[${x.from.key}] לא ברור` : x.kind === 'answered' ? `[${x.from.key}] ענה` : `[${x.from.key}] "${x.when}"`);
function HeardAfter({ n }) {
  if (!CF.KIND[n.type]) return null;
  const list = incomingArrows(CF.state).get(n.id) || [];
  const st = applyValues((n.starter || '').trim(), CF.state);
  const probs = CF.issuesFor(n.id).filter((i) => i.starter);
  if (!list.length) return null;
  return (
    <div className={'heard' + (probs.length ? ' bad' : '')}>
      <div className="heard-h">{st ? <>הפתיח <b>{st}</b> נשמע אחרי כל אחד מאלה:</> : 'מגיעים לצעד הזה מ:'}</div>
      {list.map((x, i) => (
        <div key={i} className={'heard-row k-' + x.kind}>
          <span className="heard-src" dir="auto">{SRC(x)}</span>
          {st && <span className="heard-say" dir="auto"><span className="lead-part">{st}</span> …</span>}
        </div>
      ))}
      {st && !probs.length && list.length > 1 && <small className="heard-ok">מתאים לכל הענפים.</small>}
    </div>
  );
}
