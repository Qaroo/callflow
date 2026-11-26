/* JSON export / import of call flows */
import CF from './core.js';
import { isTreeData, treeToFlow } from './script.js';

/* nodes imported from an instructionTree have no positions: lay them out without touching the open flow */
export function layoutFlow(f) {
  const prev = CF.state;
  CF.state = f;
  try { CF.layout(); } finally { CF.state = prev; }
}

export function exportFlow(flow) {
  const data = Object.assign({ format: 'callflow/v2' }, flow);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (flow.name || 'callflow').replace(/[\\/:*?"<>|]/g, '') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  CF.toast('התסריט יוצא כקובץ JSON');
}

/* accepts one flow file, or a whole workspace export ({ flows: [...] }) */
export async function importFiles(files, open) {
  let added = 0;
  let last = null;
  for (const file of Array.from(files || [])) {
    try {
      const data = JSON.parse(await file.text());
      if (isTreeData(data)) {
        const conv = treeToFlow(data, file.name.replace(/\.json$/i, '').replace(/\.(instructions|makecall)$/i, ''));
        last = CF.importFlow(conv);
        if (conv.importWarnings.length) setTimeout(() => CF.toast(conv.importWarnings.length + ' חלקים לא יובאו: ' + conv.importWarnings[0]), 2600);
        layoutFlow(last);
        CF.save();
        added++;
        continue;
      }
      const list = Array.isArray(data.flows) ? data.flows : [data];
      list.forEach((f) => { last = CF.importFlow(f); added++; });
    } catch (e) {
      CF.toast(`לא הצלחתי לקרוא את "${file.name}". צריך קובץ JSON מהסטודיו, או instructions / גוף makecall של AIServant.`);
    }
  }
  if (added) {
    CF.toast(added === 1 ? `יובא התסריט "${last.name}"` : `יובאו ${added} תסריטים`);
    if (open && last) { CF.openFlow(last.id); CF.navigate('studio'); }
  }
  return added;
}

export function pickAndImport(open) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.multiple = true;
  input.onchange = () => importFiles(input.files, open);
  input.click();
}

export function exportWorkspace() {
  CF.syncActive();
  const data = { format: 'callflow-workspace/v2', exportedAt: new Date().toISOString(), flows: CF.ws.flows, agents: CF.ws.agents };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'callflow-workspace.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  CF.toast(`יוצאו ${CF.ws.flows.length} תסריטים`);
}
