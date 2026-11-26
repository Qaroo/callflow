import { useState } from 'react';
import CF from '../lib/core.js';
import { settings, saveSettings, brainOn, speechMs, ENV, setAccount } from '../lib/settings.js';
import { DEFAULT_MODEL, listModels } from '../lib/pricing.js';
import { exportWorkspace, pickAndImport } from '../lib/files.js';
import { refreshList } from '../lib/liveCalls.js';
import { Icon } from './Icon.jsx';

/* Settings: the fast brain's key (the AI chat), the speaking rate, and the AIServant connection. */
export default function Settings() {
  const [key, setKey] = useState(settings.brainKey);
  const [model, setModel] = useState(settings.brainModel || DEFAULT_MODEL);
  const [models, setModels] = useState([]);
  const [wpm, setWpm] = useState(settings.wpm);
  const [test, setTest] = useState(null);
  const [srv, setSrv] = useState({ apiBase: settings.apiBase, accountId: settings.accountId, voiceId: settings.voiceId, voiceGender: settings.voiceGender });
  // the AIServant account (X-Agency-Id): set on the local server, so calls, live tracking and the balance all follow it
  const [acct, setAcct] = useState(ENV.account);
  const [acctMsg, setAcctMsg] = useState(null);
  const saveAcct = async (v) => {
    setAcctMsg({ busy: true });
    try {
      const d = await setAccount(v);
      setAcct(d.agencyId);
      refreshList(); // the calls list follows the account
      setAcctMsg({ ok: true, text: d.agencyOverridden ? 'נשמר. היסטוריית השיחות, החיוג והיתרה עובדים עכשיו מול החשבון הזה.' : 'חזרה לחשבון מ-.env.' });
    } catch (e) {
      setAcctMsg({ ok: false, text: 'לא נשמר: ' + (e.message || e) });
    }
  };
  const setS = (k) => (e) => { const v = e.target.value; setSrv((x) => ({ ...x, [k]: v })); saveSettings({ [k]: v.trim() }); };

  const apply = (patch) => saveSettings(patch);
  const close = () => CF.openSettings(false);

  // the key works if the provider lists its models for it
  const runTest = async () => {
    setTest({ busy: true });
    try {
      const list = await listModels(true);
      setModels(list.map((m) => m.id));
      setTest({ ok: true, text: `המפתח עובד: ${list.length} מודלים זמינים.` + (list.some((m) => m.id === model) ? '' : ` המודל "${model}" לא ביניהם.`) });
    } catch (e) {
      setTest({ ok: false, text: 'המפתח לא עבד: ' + (e.message || e) });
    }
  };

  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal glass" role="dialog" aria-modal="true" aria-label="הגדרות">
        <div className="modal-head">
          <span className="sec-ic"><Icon name="gear" /></span>
          <div><h2>הגדרות</h2><p>בשיחה, ההחלטה בוחרת לאיזה חץ התשובה של הלקוח שייכת, וה-starter של הצעד הבא מושמע מיד.</p></div>
          <button className="icon-btn" type="button" aria-label="סגור" onClick={close}><Icon name="close" /></button>
        </div>

        <div className="section-title"><span>מוח מהיר</span><small>המודל שמריץ את עוזר הבנייה בצ׳אט</small></div>
        <label className="field"><span>מפתח API</span>
          <input className="input" type="password" dir="ltr" value={key} placeholder="AIza…" autoComplete="off" spellCheck="false"
            onChange={(e) => { setKey(e.target.value); setTest(null); apply({ brainKey: e.target.value.trim() }); }} />
        </label>
        <label className="field"><span>מודל</span>
          <input className="input" type="text" dir="ltr" list="brain-models" value={model} spellCheck="false"
            onChange={(e) => { setModel(e.target.value); apply({ brainModel: e.target.value.trim() }); }} />
          <datalist id="brain-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <div className="test-box">
          <button className="btn-soft" type="button" onClick={runTest} disabled={!key.trim() || (test && test.busy)}><Icon name="check" />{test && test.busy ? 'בודק…' : 'בדיקת המפתח'}</button>
          {test && !test.busy && <small className={'hint' + (test.ok ? '' : ' err')}>{test.text}</small>}
        </div>
        <p className="hint">בלי מפתח, הצ׳אט עובד כעוזר מובנה שמבין פקודות פשוטות. המפתח נשמר בדפדפן הזה ובקובץ data/state.json במחשב הזה (התיקייה לא נכנסת ל-git), והבקשות יוצאות ישירות מהדפדפן לספק.</p>

        <div className="slider-row">
          <span className="section-title">קצב דיבור משוער</span><output>{wpm} מילים לדקה</output>
          <input type="range" min="110" max="220" step="10" value={wpm} aria-label="קצב דיבור"
            onChange={(e) => { const v = Number(e.target.value); setWpm(v); apply({ wpm: v }); }} />
        </div>
        <p className="hint">משמש להערכה כמה זמן ה-starter נשמע בקול (מוצג בעורך הצעד). לדוגמה, "בסדר גמור," נמשך כ-{(speechMs('בסדר גמור,') / 1000).toFixed(1)} שנ׳.</p>

        <div className="srv">
          <div className="section-title"><span>שרת השיחות (AIServant)</span><small>לחיוג אמיתי מחלון הייצוא</small></div>
          <label className="field"><span>כתובת השרת</span>
            <input className="input mono" dir="ltr" value={srv.apiBase} placeholder={ENV.apiBase} onChange={setS('apiBase')} />
          </label>
          <div className="field"><span>חשבון <code>X-Agency-Id</code> · {ENV.accountOverridden ? 'הוגדר ידנית' : 'מ-.env'}</span>
            <div className="acct-row">
              <input className="input mono" dir="ltr" value={acct} placeholder={ENV.envAccount || 'agency uid'} spellCheck="false" autoComplete="off" aria-label="Agency ID"
                onChange={(e) => { setAcct(e.target.value); setAcctMsg(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveAcct(acct); } }} />
              <button className="btn-soft" type="button" disabled={(acctMsg && acctMsg.busy) || acct.trim() === ENV.account} onClick={() => saveAcct(acct)}>שמירה</button>
              {ENV.accountOverridden && ENV.envAccount && (
                <button className="link" type="button" disabled={acctMsg && acctMsg.busy} onClick={() => saveAcct('')}>חזרה ל-.env</button>
              )}
            </div>
            {acctMsg && acctMsg.text && <small className={'hint' + (acctMsg.ok ? '' : ' err')}>{acctMsg.text}</small>}
          </div>
          <div className="row-2">
            <label className="field"><span>Cartesia voice id (ברירת מחדל)</span>
              <input className="input mono" dir="ltr" value={srv.voiceId} placeholder="a0e99841-…" onChange={setS('voiceId')} />
            </label>
            <label className="field key"><span>מגדר קול</span>
              <select className="select" value={srv.voiceGender} onChange={setS('voiceGender')}>
                <option value="">לפי הסוכן</option><option value="female">female</option><option value="male">male</option>
              </select>
            </label>
          </div>
          <label className="card-row">
            <span className="lbl"><Icon name="calendar" />לחשבון מחובר יומן</span>
            <span className="switch"><input type="checkbox" checked={!!settings.calendarConnected} aria-label="יומן מחובר"
              onChange={(e) => saveSettings({ calendarConnected: e.target.checked })} /><i /></span>
          </label>
          <p className="hint">רק אז צעד פעולה יכול לקרוא לכלים המובנים book_meeting, check_availability ו-cancel_booking. בלי יומן, AIServant דוחה אותם.</p>
          <p className="hint">voice id שמוגדר על סוכן (באזור הסוכנים) גובר על ברירת המחדל כאן. בלי אף אחד מהם, AIServant משתמש בקול ברירת המחדל שלו. הסוד נקבע בשרת המקומי מ-.env (AISERVANT_SHARED_SECRET) ונשלח כ-X-Api-Key. החשבון (X-Agency-Id) מגיע מ-DEMO_LEADS_OWNER_UID ב-.env, אלא אם שינית אותו כאן. השינוי נשמר בקובץ data/account.json ונשאר גם אחרי הפעלה מחדש.</p>
          {srv.apiBase !== ENV.apiBase && (
            <button type="button" className="link" onClick={() => { const v = { apiBase: ENV.apiBase }; setSrv((x) => ({ ...x, ...v })); saveSettings(v); }}>חזרה לברירת המחדל</button>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn-soft" type="button" onClick={() => pickAndImport(false)}><Icon name="upload" />ייבוא תסריטים</button>
          <button className="btn-soft" type="button" onClick={exportWorkspace}><Icon name="download" />גיבוי של כל התסריטים</button>
          <span className="tb-spacer" />
          <span className={'brain-state' + (brainOn() ? ' on' : '')}>{brainOn() ? 'מוח מהיר פעיל' : 'בלי מפתח למוח המהיר'}</span>
        </div>
      </div>
    </div>
  );
}
