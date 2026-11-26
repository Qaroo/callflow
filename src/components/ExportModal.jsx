import CF from '../lib/core.js';
import { buildInstructions, buildMakeCall, validate } from '../lib/script.js';
import DialPanel from './DialPanel.jsx';
import { exportFlow } from '../lib/files.js';
import { Icon } from './Icon.jsx';

/* What gets sent to AIServant, and whether it would be accepted. */
export default function ExportModal() {
  // the tab lives in CF.ui, so openExport('call') switches it even when the window is already open
  const tab = CF.ui.exportTab || 'instructions';
  const setTab = (t) => { CF.ui.exportTab = t; CF.emit('export'); };
  const f = CF.state;
  const agent = CF.agents.forFlow(f.id);
  const list = validate(f);
  const errors = list.filter((i) => i.level === 'error');
  const warns = list.filter((i) => i.level === 'warn');
  const obj = tab === 'instructions' ? { instructions: buildInstructions(f, agent) } : buildMakeCall(f, agent);
  const json = JSON.stringify(obj, null, 2);
  const close = () => { CF.ui.exportOpen = false; CF.emit('export'); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(json); CF.toast('הועתק'); } catch (e) { CF.toast('לא הצלחתי להעתיק. סמנו את הטקסט והעתיקו ידנית.'); }
  };
  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (f.name || 'script').replace(/[\\/:*?"<>|]/g, '') + (tab === 'instructions' ? '.instructions.json' : '.makecall.json');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const jump = (i) => { if (i.nodeId) { close(); CF.select({ type: 'node', id: i.nodeId }); requestAnimationFrame(() => CF.canvas.focus(i.nodeId)); } else if (i.global) { close(); CF.openFlowPanel('globals'); } };

  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal glass wide" role="dialog" aria-modal="true" aria-label="ייצוא ל-AIServant">
        <div className="modal-head">
          <span className="sec-ic"><Icon name="download" /></span>
          <div><h2>ייצוא ל-AIServant</h2><p>instructionTree לבקשת makecall ולתשובת ה-webhook של שיחות נכנסות.</p></div>
          <button className="icon-btn" type="button" aria-label="סגור" onClick={close}><Icon name="close" /></button>
        </div>

        <div className={'verdict ' + (errors.length ? 'bad' : 'ok')}>
          <Icon name={errors.length ? 'close' : 'check'} />
          <span>{errors.length ? `AIServant ידחה את התסריט: ${errors.length} בעיות (400, "Invalid script:"). בשיחה נכנסת היא פשוט תידחה.` : 'התסריט עובר את כל הבדיקות של AIServant.'}</span>
        </div>
        {list.length > 0 && (
          <div className="issue-list">
            {errors.concat(warns).map((i, k) => (
              <button key={k} type="button" className={'iss ' + i.level} onClick={() => jump(i)} disabled={!i.nodeId && !i.global}>
                <Icon name={i.level === 'error' ? 'close' : 'sparkle'} /><span dir="auto">{i.msg}</span>
              </button>
            ))}
          </div>
        )}

        <div className="segmented">
          <button type="button" className={tab === 'instructions' ? 'on' : ''} onClick={() => setTab('instructions')}>instructions</button>
          <button type="button" className={tab === 'makecall' ? 'on' : ''} onClick={() => setTab('makecall')}>גוף makecall מלא</button>
          <button type="button" className={tab === 'call' ? 'on' : ''} onClick={() => setTab('call')}>חיוג אמיתי</button>
        </div>
        {tab === 'call' && <DialPanel flow={f} agent={agent} errors={errors} />}
        {tab !== 'call' && <pre className="json" dir="ltr">{json}</pre>}
        {tab !== 'call' && <div className="modal-foot">
          <button className="btn-primary" type="button" onClick={copy}><Icon name="copy" />העתק</button>
          <button className="btn-soft" type="button" onClick={download}><Icon name="download" />הורד JSON</button>
          <span className="tb-spacer" />
          <button className="btn-soft" type="button" onClick={() => exportFlow(f)} title="קובץ הסטודיו, כולל מיקומי הצמתים">קובץ סטודיו</button>
        </div>}
        {tab === 'makecall' && <p className="hint">to ו-leadInfo הם מציינים מקום. apiKey הוא מזהה החשבון. AIServant מקבל instructionTree או את ה-text הישן, אחד מהם ולא שניהם; הסטודיו שולח instructionTree.</p>}
      </div>
    </div>
  );
}
