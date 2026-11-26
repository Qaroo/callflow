import { useEffect, useRef } from 'react';
import CF from '../lib/core.js';
import AG from '../lib/agents.js';
import { setLastVoice, GUID } from '../lib/speechClips.js';
import { Icon } from '../components/Icon.jsx';

export function Avatar({ a, size: s }) {
  return <span className="avatar" style={{ '--av': a.color, width: s, height: s, fontSize: Math.round(s * 0.38) }}>{AG.initials(a)}</span>;
}

/* Agents: list on one side, the selected agent's requirements (script, voice, personality) on the other. */
export default function AgentsView() {
  const list = CF.ws.agents;
  if (AG.current && !AG.get(AG.current)) AG.current = null;
  if (!AG.current && list.length) AG.current = list[0].id;
  const a = AG.current && AG.get(AG.current);

  const newAgent = () => {
    const n = AG.create();
    AG.current = n.id;
    CF.emit('agents');
    requestAnimationFrame(() => { const i = document.getElementById('ag-name'); if (i) { i.focus(); i.select(); } });
  };

  return (
    <section id="agentsView" className="agents-view" aria-label="סוכנים">
      <div className="ag-list">
        <div className="ag-list-head">
          <div><div className="ag-h">סוכנים</div><div className="ag-sub">{list.length ? list.length + ' סוכנים בסביבת העבודה' : 'עוד אין סוכנים'}</div></div>
          <button className="icon-btn add" type="button" title="סוכן חדש" aria-label="סוכן חדש" onClick={newAgent}><Icon name="plus" /></button>
        </div>
        <div className="ag-rows">
          {list.map((x) => {
            const miss = AG.missing(x);
            return (
              <button key={x.id} type="button" className={'ag-row' + (x.id === AG.current ? ' on' : '')}
                onClick={() => { AG.current = x.id; AG.confirmDel = null; CF.emit('agents'); }}>
                <Avatar a={x} size={36} />
                <span className="ag-row-text"><b dir="auto">{x.name}</b><small dir="auto">{x.role || 'ללא תיאור'}</small></span>
                {miss.length ? <span className="pill warn">חסרים {miss.length}</span> : <span className="pill ok"><Icon name="check" />מוכן</span>}
              </button>
            );
          })}
        </div>
        <div className="ag-flows">
          <div className="ag-flows-h"><span>תסריטי שיחה</span>
            <button type="button" className="link" onClick={() => { CF.newFlow(); CF.navigate('flows'); }}><Icon name="plus" />חדש</button>
          </div>
          {CF.ws.flows.map((f) => {
            const st = CF.flowStats(f);
            const users = CF.ws.agents.filter((x) => x.flowId === f.id).length;
            return (
              <button key={f.id} type="button" className="ag-flow" onClick={() => { CF.openFlow(f.id); CF.navigate('flows'); }}>
                <Icon name="flow" /><span dir="auto">{f.name}</span><small>{st.states} מצבים{users ? ' · ' + users + ' סוכנים' : ''}</small>
              </button>
            );
          })}
        </div>
      </div>
      <div className="ag-detail">{a ? <Detail key={a.id} a={a} /> : <Empty onNew={newAgent} />}</div>
    </section>
  );
}

function Empty({ onNew }) {
  return (
    <div className="ag-empty">
      <div className="ag-empty-icon"><Icon name="agent" /></div>
      <h2>הסוכן הראשון שלך</h2>
      <p>סוכן הוא הבוט שמדבר בטלפון. כדי שיהיה מוכן לשיחות הוא צריך תסריט שיחה, קול ואישיות.</p>
      <div className="req-preview">{AG.REQS.map((r) => <span key={r.key}><Icon name={r.icon} />{r.label}</span>)}</div>
      <button className="btn-primary" type="button" onClick={onNew}><Icon name="plus" />סוכן חדש</button>
    </div>
  );
}

function Section({ k, icon, title, sub, done, children }) {
  return (
    <section className="ag-sec" id={'sec-' + k}>
      <div className="ag-sec-head">
        <span className="sec-ic"><Icon name={icon} /></span>
        <div><h3>{title}</h3><p>{sub}</p></div>
        <span className={'pill ' + (done ? 'ok' : 'warn')}>{done ? <><Icon name="check" />הושלם</> : 'חובה'}</span>
      </div>
      <div className="ag-sec-body">{children}</div>
    </section>
  );
}

function Detail({ a }) {
  const delTimer = useRef(0);
  useEffect(() => () => clearTimeout(delTimer.current), []);
  const c = AG.checks(a);
  const total = AG.REQS.length;
  const done = Object.values(c).filter(Boolean).length;
  const ready = done === total;
  const voice = AG.voiceOf(a);
  const p = a.personality;
  const f = a.flowId && CF.flowById(a.flowId);
  const quiet = () => { CF.save(); CF.emit('agents'); };
  const persist = AG.persist;

  return (
    <>
      <div className="ag-hero">
        <Avatar a={a} size={60} />
        <div className="ag-hero-text">
          <input className="ag-name" id="ag-name" type="text" value={a.name} dir="auto" aria-label="שם הסוכן" spellCheck="false"
            onChange={(e) => { a.name = e.target.value; quiet(); }} />
          <input className="ag-role" type="text" value={a.role} dir="auto" aria-label="תפקיד"
            placeholder="מה הסוכן עושה? למשל: חוזר ללידים מהאתר וקובע הדגמות" onChange={(e) => { a.role = e.target.value; quiet(); }} />
        </div>
        <div className="ring" style={{ '--p': Math.round((done / total) * 100) }} title={`${done} מתוך ${total}`}><span>{done}/{total}</span></div>
      </div>

      <div className="ag-actions">
        <button className="btn-primary" type="button" disabled={!ready} onClick={() => AG.test(a.id)}><Icon name="phone" />שיחת בדיקה עם {a.name}</button>
        <button className="btn-soft" type="button" onClick={() => { const cpy = AG.duplicate(a.id); AG.current = cpy.id; CF.emit('agents'); }}><Icon name="copy" />שכפל</button>
        <button className="btn-soft danger" type="button" onClick={() => {
          if (AG.confirmDel === a.id) { AG.confirmDel = null; AG.remove(a.id); CF.toast('הסוכן נמחק'); return; }
          AG.confirmDel = a.id;
          CF.emit('agents');
          clearTimeout(delTimer.current);
          delTimer.current = setTimeout(() => { if (AG.confirmDel === a.id) { AG.confirmDel = null; CF.emit('agents'); } }, 3500);
        }}><Icon name="trash" />{AG.confirmDel === a.id ? 'ללחוץ שוב כדי למחוק' : 'מחק'}</button>
      </div>

      <div className="reqs">
        {AG.REQS.map((r) => (
          <button key={r.key} type="button" className={'req' + (c[r.key] ? ' done' : '')}
            onClick={() => { const s = document.getElementById('sec-' + r.key); if (s) s.scrollIntoView({ behavior: CF.reducedMotion() ? 'auto' : 'smooth', block: 'start' }); }}>
            <span className="req-dot">{c[r.key] && <Icon name="check" />}</span>{r.label}
          </button>
        ))}
      </div>
      {!ready && <p className="hint center">כדי להריץ את הסוכן חסרים: {AG.missing(a).join(', ')}.</p>}

      <Section k="flow" icon="flow" title="תסריט שיחה" sub="עץ המצבים שהסוכן מריץ: ההחלטה בוחרת מתוך האופציות, ופתיחים מיידיים מכסים את זמן החשיבה של המוח המהיר." done={c.flow}>
        <div className="flow-pick">
          {CF.ws.flows.map((fl) => {
            const st = CF.flowStats(fl);
            return (
              <button key={fl.id} type="button" className={'flow-card' + (fl.id === a.flowId ? ' on' : '')} onClick={() => { a.flowId = fl.id; persist(); }}>
                <b dir="auto">{fl.name}</b>
                <small>{st.states ? `${st.states} מצבים · ${st.asks} החלטות · ${st.leads} פתיחים` : 'תסריט ריק'}</small>
              </button>
            );
          })}
          <button type="button" className="flow-card new" onClick={() => {
            const nf = CF.newFlow((a.name || 'סוכן') + ' · תסריט');
            a.flowId = nf.id;
            persist();
            CF.navigate('flows');
            CF.toast('תסריט חדש נפתח. תארו לעוזר את השיחה');
          }}><Icon name="plus" /><b>תסריט חדש</b><small>נפתח בעורך</small></button>
        </div>
        {f && <button type="button" className="link" onClick={() => { CF.openFlow(f.id); CF.navigate('flows'); }}><Icon name="flow" />פתח את "{f.name}" בעורך</button>}
        {f && !f.nodes.length && <p className="hint">התסריט שנבחר ריק. פתחו אותו ובקשו מהעוזר לבנות אותו.</p>}
      </Section>

      <Section k="voice" icon="wave" title="קול" sub="הקול של Cartesia שמדבר בשיחה. בלי voice id כאן, השיחה משתמשת בברירת המחדל מההגדרות." done={c.voice}>
        <div className="form-2">
          <label className="field"><span>Cartesia voice id <code>cartesiaSettings.voice</code></span>
            <input className="input mono" dir="ltr" value={a.cartesiaVoiceId || ''} placeholder={(CF.settings && CF.settings.voiceId) || 'ריק = ברירת המחדל מההגדרות'}
              onChange={(e) => { a.cartesiaVoiceId = e.target.value.trim(); quiet(); }} />
          </label>
          <label className="field"><span>מגדר הקול <code>voiceGender</code></span>
            <select className="select" value={a.voiceGender || ''} onChange={(e) => { a.voiceGender = e.target.value; persist(); }}>
              <option value="">ברירת המחדל מההגדרות</option><option value="female">female</option><option value="male">male</option>
            </select>
          </label>
        </div>
        {GUID.test(voice) && (
          <button type="button" className="link" onClick={() => { setLastVoice(voice.toLowerCase()); CF.navigate('voices'); }}>
            <Icon name="speaker" />הפתיחים והתגובות של הקול הזה בספריית הקול
          </button>
        )}
      </Section>

      <Section k="persona" icon="sliders" title="אישיות" sub="איך הסוכן נשמע: טון, קצב והתנהגות. נשלח בשיחה כ-personality, כשלתסריט אין personality משלו." done={c.persona}>
        <div className="presets">
          {Object.entries(AG.PRESETS).map(([k, pr]) => (
            <button key={k} type="button" className={'preset' + (p.preset === k ? ' on' : '')} onClick={() => { AG.applyPreset(a, k); persist(); }}>{pr.label}</button>
          ))}
        </div>
        {[['formal', 'חברי', 'רשמי'], ['concise', 'מפורט', 'תמציתי'], ['energy', 'רגוע', 'אנרגטי']].map(([k, lo, hi]) => (
          <div key={k} className="tone"><span>{lo}</span>
            <input type="range" min="0" max="100" step="5" value={p[k]} aria-label={`${lo} עד ${hi}`}
              onChange={(e) => { p[k] = Number(e.target.value); p.preset = null; quiet(); }} />
            <span>{hi}</span></div>
        ))}
        <div className="field"><span>תכונות</span>
          <div className="traits">
            {AG.TRAITS.map((t) => (
              <button key={t} type="button" className={'trait' + (p.traits.includes(t) ? ' on' : '')} onClick={() => {
                const i = p.traits.indexOf(t);
                if (i >= 0) p.traits.splice(i, 1); else p.traits.push(t);
                p.preset = null;
                persist();
              }}>{t}</button>
            ))}
          </div>
        </div>
        <label className="field"><span>הנחיות התנהגות</span>
          <textarea className="textarea" rows={3} dir="auto" value={p.prompt} placeholder="למשל: לא ללחוץ על לקוח שאומר לא פעמיים. לפנות בשם הפרטי."
            onChange={(e) => { p.prompt = e.target.value; quiet(); }} />
        </label>
      </Section>
    </>
  );
}
