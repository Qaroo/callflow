import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import CF from '../lib/core.js';
import chat from '../lib/chat.js';
import builder from '../lib/builder.js';
import { usd, ktok, PRICES_CHECKED } from '../lib/pricing.js';
import { Icon } from './Icon.jsx';

/* The floating AI chat that builds and edits the open flow.
   With a fast-brain key (Settings) it is the builder agent (lib/builder.js); without one, a rule-based helper (lib/assistant.js). */
export default function Chat() {
  const [text, setText] = useState('');
  const ta = useRef(null);
  const sel = CF.sel && CF.sel.type === 'node' ? CF.node(CF.sel.id) : null;

  useEffect(() => CF.on('focusComposer', () => {
    if (ta.current && window.innerWidth > 680) ta.current.focus({ preventScroll: true });
  }), []);
  useLayoutEffect(() => {
    if (!ta.current) return;
    ta.current.style.height = 'auto';
    ta.current.style.height = Math.min(ta.current.scrollHeight, 120) + 'px';
  }, [text]);

  const send = (e) => {
    if (e) e.preventDefault();
    const v = text.trim();
    if (!v) return;
    setText('');
    chat.submit(v);
  };

  return (
    <section id="chat" className="glass chat" aria-label="עוזר הבנייה">
      <header className="chat-head">
        <div className="chat-title">
          <div className="chat-avatar"><Icon name="sparkle" /></div>
          <div className="chat-titles">
            <div className="t1">עוזר הבנייה{builder.on() && <span className="brain-tag">מוח מהיר</span>}</div>
            <div className="t2">{builder.on() ? 'המוח המהיר בונה ובודק, אתם מאשרים' : 'מתארים במילים, הדיאגרמה נבנית'}</div>
          </div>
          {builder.on() && <button className="icon-btn" type="button" title="שיחה חדשה עם המוח המהיר" aria-label="שיחה חדשה עם המוח המהיר" onClick={() => builder.reset()}><Icon name="undo" /></button>}
          <button className="icon-btn" type="button" title="מזער" aria-label="מזער את הצ׳אט" onClick={() => chat.close()}><Icon name="chevronDown" /></button>
        </div>
      </header>

      <Log />

      <footer className="chat-foot">
        <AgentBar />
        {sel && (
          <div className="ctx">
            <span className="dot" style={{ '--c': `var(${CF.typeColor(sel.type)})` }} /><span>פועל על:</span><b dir="auto">{sel.title}</b>
            <button className="icon-btn" type="button" aria-label="בטל בחירה" onClick={() => CF.select(null)}><Icon name="close" /></button>
          </div>
        )}
        <Chips />
        <form className="composer" autoComplete="off" onSubmit={send}>
          <textarea ref={ta} rows={1} value={text} aria-label="הודעה"
            placeholder={builder.state.pending ? 'כתבו תשובה…' : builder.on() ? 'מה לבנות, לשנות או לבדוק?' : 'למשל: הוסף שאלה על תקציב'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }} />
          <button className="send" type="submit" aria-label="שלח" disabled={!text.trim()}><Icon name="send" /></button>
        </form>
      </footer>
    </section>
  );
}

/* while the fast brain works: what it is doing, what it has cost so far, and a stop button */
function AgentBar() {
  const a = chat.agent;
  if (!a || !a.busy) return null;
  return (
    <div className="agent-bar" role="status">
      <span className="ab-spin" />
      <span className="ab-label">{a.label || 'עובד…'}</span>
      <span className="ab-meta">{a.ops} פעולות{a.tokens ? ` · ${ktok(a.tokens)} טוקנים` : ''}{a.cost ? ` · ${usd(a.cost)}` : ''}</span>
      <button type="button" className="ab-stop" onClick={() => builder.stop()}><Icon name="stop" />עצור</button>
    </div>
  );
}

function OpRow({ card }) {
  return (
    <div className={'op-row ' + card.status}>
      <span className="op-ic"><Icon name={card.icon} /></span>
      <span className="op-label">{card.label}</span>
      <span className="op-detail" dir="auto">{card.detail}</span>
      <span className="op-st">{card.status === 'run' ? <i className="ab-spin" /> : card.status === 'ok' ? <Icon name="check" /> : card.status === 'rejected' ? 'נדחה' : <Icon name="close" />}</span>
      {card.note && <div className="op-note" dir="auto">{card.note}</div>}
    </div>
  );
}

function AskCard({ card }) {
  const done = card.answered;
  const pick = (o) => { chat.add('user', o); builder.answer({ text: o }); };
  return (
    <div className={'ask-card' + (done ? ' done' : '')}>
      <div className="ak-q" dir="auto"><Icon name="sparkle" />{card.question}</div>
      {!done && card.options && card.options.length > 0 && (
        <div className="ak-opts">{card.options.map((o) => <button key={o} type="button" onClick={() => pick(o)}>{o}</button>)}</div>
      )}
      {!done && <div className="ak-hint">או כתבו תשובה משלכם למטה</div>}
      {done && done.cancelled && <div className="ak-hint">בוטל</div>}
    </div>
  );
}

function ApproveCard({ card }) {
  const d = card.answered;
  return (
    <div className={'approve-card' + (card.danger ? ' danger' : '') + (card.plan ? ' plan' : '') + (d ? ' done' : '')}>
      <div className="apc-title"><Icon name={card.call ? 'phone' : card.plan ? 'flow' : 'sparkle'} />{card.title}</div>
      {card.summary && <p className="apc-sum" dir="auto">{card.summary}</p>}
      {card.steps && card.steps.length > 0 && <ol className="apc-steps">{card.steps.map((x, i) => <li key={i} dir="auto">{x}</li>)}</ol>}
      {card.balance && <div className="apc-bal">יתרה ב-AIServant: <code dir="ltr">{card.balance}</code></div>}
      {!d ? (
        <div className="apc-btns">
          <button type="button" className={card.danger ? 'btn-danger' : 'btn-primary'} onClick={() => builder.answer({ approved: true })}>{card.plan ? 'מאשר, תבנה' : card.call ? 'כן, לחייג' : 'כן, לבצע'}</button>
          {card.plan
            ? <button type="button" className="btn-soft" onClick={() => CF.emit('focusComposer')}>לשנות משהו…</button>
            : <button type="button" className="btn-soft" onClick={() => builder.answer({ approved: false })}>לא</button>}
        </div>
      ) : <div className={'apc-state ' + (d.approved ? 'ok' : 'no')}>{d.cancelled ? 'בוטל' : d.approved ? 'אושר' : d.feedback ? 'ביקשת שינוי' : 'נדחה'}</div>}
      {!d && card.plan && <div className="ak-hint">אפשר גם לכתוב למטה מה לשנות בתוכנית</div>}
    </div>
  );
}

/* before a run: which model, and what it will roughly cost */
function Preflight({ card }) {
  const [list, setList] = useState(null);
  const [model, setModel] = useState(card.model);
  const [est, setEst] = useState(card.est);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  useEffect(() => { builder.models().then(setList).catch(() => setList([])); }, []);
  const change = async (m) => { setModel(m); setBusy(true); setEst(await builder.estimate(m, card.text).catch(() => null)); setBusy(false); };
  const d = card.answered;
  const p = est && est.price;
  const known = list && list.length ? list : [{ id: model, name: model, price: p }];
  if (d) return <div className="preflight done"><Icon name={d.approved ? 'check' : 'close'} />{d.approved ? `הופעל עם ${d.model || model}` : 'לא הופעל'}</div>;
  return (
    <div className="preflight">
      <div className="pf-title"><Icon name="sparkle" />לפני שהמוח המהיר מתחיל</div>
      <label className="pf-row"><span>מודל</span>
        <select value={model} onChange={(e) => change(e.target.value)} dir="ltr">
          {!known.some((m) => m.id === model) && <option value={model}>{model}</option>}
          {known.map((m) => <option key={m.id} value={m.id}>{m.id}{m.price ? ` · $${m.price.in}/$${m.price.out}` : ''}</option>)}
        </select>
      </label>
      {list === null && <div className="pf-note">טוען את רשימת המודלים של המפתח…</div>}
      <div className="pf-price">
        {p ? <>מחיר: <b dir="ltr">${p.in}</b> ל-1M טוקנים נכנסים, <b dir="ltr">${p.out}</b> ל-1M יוצאים (כולל חשיבה){p.tier ? `, יותר מעל ${ktok(p.tier)}` : ''}</> : 'אין לי מחיר למודל הזה, אז רק מספר הטוקנים.'}
        {p && p.note && <div className="pf-note">{p.note}</div>}
      </div>
      <div className={'pf-est' + (busy ? ' busy' : '')}>
        {est ? (
          <>
            <b dir="ltr">{est.cost ? `${usd(est.cost[0])} – ${usd(est.cost[1])}` : `${ktok(est.tokens[0])}–${ktok(est.tokens[1])} tokens`}</b>
            <small>{est.turns[0]}–{est.turns[1]} קריאות למוח המהיר · {ktok(est.tokens[0])}–{ktok(est.tokens[1])} טוקנים · כל קריאה שולחת {est.counted ? '' : 'בערך '}{ktok(est.base)} טוקנים של הקשר</small>
          </>
        ) : 'לא הצלחתי להעריך.'}
      </div>
      <div className="pf-note">{p && p.free ? 'במפתח בחשבון חינמי: $0, עם מגבלת קצב. ' : ''}מחירון מ-{PRICES_CHECKED}. ההערכה לא כוללת שיחות אמיתיות (דקות AIServant).</div>
      <label className="pf-auto"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />להתחיל בלי לשאול כשההערכה עד $0.05</label>
      <div className="apc-btns">
        <button type="button" className="btn-primary" onClick={() => builder.answer({ approved: true, model, auto: auto ? 0.05 : null })}>הפעל</button>
        <button type="button" className="btn-soft" onClick={() => builder.answer({ approved: false })}>ביטול</button>
      </div>
    </div>
  );
}

function CostCard({ card }) {
  return (
    <div className="cost-card">
      <Icon name="database" />
      <span>הסבב: {card.calls} קריאות · {ktok(card.inTok)} נכנסים / {ktok(card.outTok)} יוצאים{card.priced ? <> · <b>{usd(card.cost)}</b></> : ''}</span>
      <small dir="ltr">{card.model}{card.priced && card.total > card.cost ? ` · total ${usd(card.total)}` : ''}</small>
    </div>
  );
}

function Chips() {
  const list = chat.chips || [];
  if (!list.length) return null;
  return (
    <div className="chips">
      {list.map((c, i) => {
        const item = typeof c === 'string' ? { label: c } : c;
        return (
          <button key={i + item.label} type="button" className={'chip' + (item.primary ? ' primary' : '')}
            onClick={() => { if (item.run) item.run(); else chat.submit(item.value || item.label); }}>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function Log() {
  const ref = useRef(null);
  const msgs = chat.log;
  const last = msgs[msgs.length - 1];
  const sig = msgs.length + ':' + (last ? (last.text || '').length : 0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sig]);
  return (
    <div ref={ref} className="chat-log" aria-live="polite">
      {msgs.map((msg) => <Message key={msg.id} msg={msg} />)}
    </div>
  );
}

function Via({ msg }) {
  if (!msg.via) return null;
  return <div className={'via ' + (msg.viaClass || '')}>{msg.viaIcon && <Icon name={msg.viaIcon} />}{msg.via}</div>;
}

function Message({ msg }) {
  if (msg.role === 'typing') {
    return <div className="row bot"><Via msg={msg} /><div className="bubble typing"><i /><i /><i /></div></div>;
  }
  if (msg.role === 'card') return <div className="row card"><Card card={msg.card} /></div>;
  return (
    <div className={'row ' + msg.role}>
      <Via msg={msg} />
      <div className="bubble" dir="auto">{msg.text}</div>
      {msg.receipts && <div className="receipts">{msg.receipts.map((r, i) => <span key={i} className="receipt">{r}</span>)}</div>}
    </div>
  );
}

function Card({ card }) {
  switch (card.kind) {
    case 'op': return <OpRow card={card} />;
    case 'ask': return <AskCard card={card} />;
    case 'approve': return <ApproveCard card={card} />;
    case 'preflight': return <Preflight card={card} />;
    case 'cost': return <CostCard card={card} />;
    default: return null;
  }
}
