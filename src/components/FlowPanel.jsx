import { useRef } from 'react';
import CF from '../lib/core.js';
import { valuesObject, scriptAsText } from '../lib/script.js';
import { Icon } from './Icon.jsx';

/* Flow-level parts of the request: instructions (personality, context, goldenRules, hotWords, values),
   globalArrows and aiTools. */
export default function FlowPanel() {
  const tab = CF.ui.flowPanel;
  const f = CF.state;
  const ins = f.instructions;
  const pending = useRef(false);
  const live = (fn) => (e) => {
    if (pending.current) { CF.checkpoint(); pending.current = false; }
    fn(e.target.value);
    CF.commit({ source: 'inspector' });
  };
  const step = (fn) => { CF.checkpoint(); fn(); CF.commit(); };
  const steps = f.nodes.filter((n) => CF.KIND[n.type]);
  const tools = CF.tools(f);
  const used = (name) => f.nodes.filter((n) => n.type === 'action' && n.tool === name).length;
  const autoBiz = !(ins.values || []).some((v) => v.key === 'business');

  return (
    <aside id="inspector" className="glass inspector flow-only flow-panel" aria-label="הוראות התסריט" onFocus={() => { pending.current = true; }}>
      <div className="insp-head">
        <span className="n-icon" style={{ '--c': 'var(--accent)' }}><Icon name="sliders" /></span>
        <div><div className="insp-kind">הוראות התסריט</div><div className="insp-sub">instructions · {f.name}</div></div>
        <button className="icon-btn" type="button" aria-label="סגור" onClick={() => CF.openFlowPanel(null)}><Icon name="close" /></button>
      </div>
      <div className="segmented tabs3">
        <button type="button" className={tab === 'instructions' ? 'on' : ''} onClick={() => CF.openFlowPanel('instructions')}>הוראות</button>
        <button type="button" className={tab === 'globals' ? 'on' : ''} onClick={() => CF.openFlowPanel('globals')}>חצים גלובליים</button>
        <button type="button" className={tab === 'tools' ? 'on' : ''} onClick={() => CF.openFlowPanel('tools')}>כלים</button>
      </div>

      {tab === 'instructions' && (
        <>
          <div className="field"><span>מה נשלח ב-makecall</span>
            <div className="seg2 sm">
              <button type="button" className={ins.mode !== 'text' ? 'on' : ''} onClick={() => step(() => { ins.mode = 'tree'; })}><b>תסריט צעדים</b><small>instructionTree, עם מעקב צעדים</small></button>
              <button type="button" className={ins.mode === 'text' ? 'on' : ''} onClick={() => step(() => { ins.mode = 'text'; if (!ins.text.trim()) ins.text = scriptAsText(f); })}><b>טקסט חופשי</b><small>text, כמו קודם</small></button>
            </div>
          </div>
          {ins.mode === 'text' && (
            <label className="field"><span>הוראות השיחה <code>text</code></span>
              <textarea className="textarea" rows={9} dir="auto" value={ins.text} placeholder="איך הסוכן מנהל את השיחה, במילים חופשיות" onChange={live((v) => { ins.text = v; })} />
              <span className="row-btns">
                <button type="button" className="link" onClick={() => step(() => { ins.text = scriptAsText(f); })}><Icon name="flow" />צור מחדש מהתסריט</button>
                <small className="opt-to">אחד מהשניים בלבד: כשהפורמט הוא text, הצעדים בגרף לא נשלחים.</small>
              </span>
            </label>
          )}
          <label className="field"><span>אישיות <code>personality</code></span>
            <textarea className="textarea" rows={2} dir="auto" value={ins.personality} placeholder="איך הסוכן נשמע. ריק: נלקח מאישיות הסוכן המחובר." onChange={live((v) => { ins.personality = v; })} />
          </label>
          <label className="field"><span>רקע לתשובות <code>context</code></span>
            <textarea className="textarea" rows={5} dir="auto" value={ins.context} placeholder="העסק, מחירים, שעות. שאלות שהתסריט לא מכסה נענות מכאן." onChange={live((v) => { ins.context = v; })} />
          </label>
          <label className="field"><span>כללי זהב <code>goldenRules</code></span>
            <textarea className="textarea" rows={2} dir="auto" value={ins.goldenRules} placeholder="כללים שהסוכן אף פעם לא שובר" onChange={live((v) => { ins.goldenRules = v; })} />
          </label>
          <label className="field"><span>מילים לזיהוי והגייה <code>hotWords</code></span>
            <input className="input" type="text" dir="auto" value={ins.hotWords} placeholder="שמות ומונחים, מופרדים בפסיק" onChange={live((v) => { ins.hotWords = v; })} />
          </label>
          <div className="field">
            <div className="section-title"><span>ערכים <code>values</code></span><small>{'{key}'} מוחלף בערך בכל הטקסטים ובתסריט</small></div>
            <div className="kv-list">
              {(ins.values || []).map((v, i) => (
                <div key={i} className="kv">
                  <input className="input mono" dir="ltr" value={v.key} placeholder="key" onChange={live((x) => { v.key = x.replace(/[{}\s]/g, ''); })} />
                  <input className="input" dir="auto" value={v.value} placeholder="ערך" onChange={live((x) => { v.value = x; })} />
                  <button className="icon-btn danger" type="button" aria-label="מחק ערך" onClick={() => step(() => { ins.values.splice(i, 1); })}><Icon name="trash" /></button>
                </div>
              ))}
              {autoBiz && <div className="kv auto"><code dir="ltr">business</code><span dir="auto">{f.business}</span><small>אוטומטי, משם העסק</small></div>}
            </div>
            <button className="add-opt" type="button" onClick={() => step(() => { ins.values.push({ key: '', value: '' }); })}><Icon name="plus" />הוסף ערך</button>
            <small className="opt-to" dir="ltr">{Object.keys(valuesObject(f)).map((k) => '{' + k + '}').join('  ')}</small>
          </div>
        </>
      )}

      {tab === 'globals' && (
        <>
          <p className="hint">חץ גלובלי נלקח מכל צעד, רק כשאף אחד מהחצים של הצעד לא מתאים. השיחה לא חוזרת ממנו, אז כדאי לכוון אותו לצעד שמסיים את השיחה: סיום, או פעולה שמובילה לסיום.</p>
          <div className="opt-list">
            {(f.globalArrows || []).map((g, i) => {
              const t = g.to && CF.node(g.to);
              const finishes = t && (t.type === 'end' || t.type === 'action');
              return (
                <div key={g.id || i} className="opt-card">
                  <input className="input opt-label" type="text" dir="auto" value={g.when} placeholder="when, למשל: רוצה נציג" onChange={live((v) => { g.when = v; })} />
                  <button className="icon-btn danger" type="button" aria-label="מחק חץ" onClick={() => step(() => { f.globalArrows.splice(i, 1); })}><Icon name="trash" /></button>
                  <input className="input opt-ex" type="text" dir="auto" value={(g.examples || []).join(', ')} placeholder="מה הלקוח יגיד, מופרד בפסיק. נשלח להחלטה כ-description"
                    onChange={live((v) => { g.examples = v.split(/[,،]/).map((x) => x.trim()).filter(Boolean); })} />
                  <select className="select" value={g.to || ''} onChange={(e) => step(() => { g.to = e.target.value || null; })}>
                    <option value="">בחרו צעד יעד</option>
                    {steps.map((n) => <option key={n.id} value={n.id}>{n.key} · {n.title}</option>)}
                  </select>
                  {t && !finishes && <div className="opt-to warn">היעד לא מסיים את השיחה. עדיף לכוון לסיום או לפעולה שמובילה לסיום.</div>}
                </div>
              );
            })}
          </div>
          <button className="add-opt" type="button" onClick={() => step(() => { f.globalArrows.push({ id: CF.uid('g'), when: '', examples: [], to: null }); })}><Icon name="plus" />הוסף חץ גלובלי</button>
        </>
      )}

      {tab === 'tools' && (
        <>
          <p className="hint">צעד action קורא לאחד הכלים האלה, או לכלי מובנה של הדיילר (transfer_call, end_call; וכלי היומן רק בחשבון שמחובר אליו יומן). נשלחים ב-aiTools רק הכלים שצעד כלשהו קורא להם. שם: אותיות באנגלית, ספרות וקו תחתון; url מלא ב-https.</p>
          <div className="opt-list">
            {tools.map((t, i) => (
              <div key={i} className="opt-card tool-card">
                <input className="input opt-label mono" dir="ltr" value={t.name} placeholder="tool_name" onChange={live((v) => {
                  const old = t.name;
                  t.name = v.replace(/\s+/g, '_');
                  f.nodes.forEach((n) => { if (n.type === 'action' && n.tool === old) n.tool = t.name; });
                })} />
                <button className="icon-btn danger" type="button" aria-label="מחק כלי" title={used(t.name) ? `בשימוש ב-${used(t.name)} צעדים` : 'מחק'}
                  onClick={() => step(() => { tools.splice(i, 1); })}><Icon name="trash" /></button>
                <input className="input opt-ex" dir="ltr" value={t.description} placeholder="description" onChange={live((v) => { t.description = v; })} />
                <input className="input opt-ex mono" dir="ltr" value={t.url} placeholder="https://…" onChange={live((v) => { t.url = v; })} />
                <div className="params">
                  {(t.params || []).map((p, j) => (
                    <div key={j} className="kv param">
                      <input className="input mono" dir="ltr" value={p.name} placeholder="param" onChange={live((v) => { p.name = v; })} />
                      <input className="input" dir="ltr" value={p.description} placeholder="description" onChange={live((v) => { p.description = v; })} />
                      <select className="select" value={p.type || 'string'} onChange={(e) => step(() => { p.type = e.target.value; })}>
                        <option>string</option><option>number</option><option>boolean</option>
                      </select>
                      <label className="req-chk" title="required"><input type="checkbox" checked={!!p.required} onChange={(e) => step(() => { p.required = e.target.checked; })} />חובה</label>
                      <button className="icon-btn danger" type="button" aria-label="מחק פרמטר" onClick={() => step(() => { t.params.splice(j, 1); })}><Icon name="close" /></button>
                    </div>
                  ))}
                  <button type="button" className="link" onClick={() => step(() => { (t.params = t.params || []).push({ name: '', description: '' }); })}><Icon name="plus" />פרמטר</button>
                </div>
                <div className="tool-opts">
                  <label>timeoutMs <input className="input mono" type="number" min="500" max="10000" step="500" value={t.timeoutMs || 8000} onChange={live((v) => { t.timeoutMs = Number(v) || 8000; })} /></label>
                  <label className="req-chk"><input type="checkbox" checked={t.shouldInvokeAnswer !== false} onChange={(e) => step(() => { t.shouldInvokeAnswer = e.target.checked; })} />shouldInvokeAnswer</label>
                </div>
                <div className="opt-to">{CF.callableBuiltins().includes(t.name) ? 'שם של כלי מובנה: לא יישלח' : used(t.name) ? `בשימוש ב-${used(t.name)} צעדים` : 'לא בשימוש, ולכן לא נשלח'}</div>
              </div>
            ))}
          </div>
          <button className="add-opt" type="button" onClick={() => step(() => { tools.push({ name: 'new_tool', description: '', url: 'https://', timeoutMs: 8000, shouldInvokeAnswer: true, params: [] }); })}><Icon name="plus" />הוסף כלי</button>
        </>
      )}
    </aside>
  );
}
