/* Core: the workspace model (flows of steps + arrows), undo/redo, browser persistence, auto-layout.
   One mutable object (CF) plus an event bus. React reads it through useCF(), which re-renders on every
   emitted event (except the per-frame 'view' event). Disk persistence is in localStore.js. */

const KEY = 'callflow-studio:v2';
const OLD_KEY = 'callflow-studio:v1';

const CF = {};
export default CF;
if (typeof window !== 'undefined') window.CF = CF; // handy in devtools

/* ---------- tiny event bus + React subscription ---------- */
const handlers = {};
const anyHandlers = new Set();
CF.v = 0;
CF.on = (ev, fn) => {
  (handlers[ev] = handlers[ev] || []).push(fn);
  return () => { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); };
};
CF.emit = (ev, data) => {
  (handlers[ev] || []).slice().forEach((fn) => fn(data));
  if (ev === 'view') return; // pan/zoom frames never re-render React
  CF.v++;
  anyHandlers.forEach((fn) => fn());
};
CF.subscribe = (fn) => { anyHandlers.add(fn); return () => anyHandlers.delete(fn); };

/* ---------- helpers ---------- */
let seq = 0;
CF.uid = (p) => p + '_' + Math.random().toString(36).slice(2, 7) + (seq++).toString(36);
CF.wait = (ms) => new Promise((r) => setTimeout(r, ms));
CF.reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
CF.clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- node vocabulary ---------- */
CF.TYPES = {
  start:  { label: 'פתיחת שיחה', icon: 'phone', desc: 'המשפט הראשון שהבוט אומר' },
  say:    { label: 'הודעה', icon: 'bubble', desc: 'הבוט אומר משפט וממשיך' },
  ask:    { label: 'החלטה', icon: 'branch', desc: 'שאלה עם אופציות סגורות' },
  action: { label: 'פעולה', icon: 'bolt', desc: 'יומן, וואטסאפ, CRM, נציג' },
  end:    { label: 'סיום שיחה', icon: 'phoneDown', desc: 'משפט סיום וניתוק' },
};
CF.ACTIONS = {
  calendar: { label: 'קביעת פגישה ביומן', icon: 'calendar', receipt: 'נקבעה פגישה ביומן', desc: 'מציע מועד פנוי ושומר אותו ביומן.' },
  whatsapp: { label: 'שליחת וואטסאפ', icon: 'message', receipt: 'נשלחה הודעת וואטסאפ', desc: 'שולח ללקוח הודעת סיכום בוואטסאפ.' },
  crm:      { label: 'עדכון CRM', icon: 'database', receipt: 'הליד עודכן ב-CRM', desc: 'מעדכן את סטטוס הליד ב-CRM.' },
  transfer: { label: 'העברה לנציג', icon: 'headset', receipt: 'השיחה הועברה לנציג', desc: 'מעביר את השיחה לנציג אנושי זמין.' },
  callback: { label: 'תזמון שיחה חוזרת', icon: 'clock', receipt: 'נקבעה שיחה חוזרת', desc: 'יוצר משימה לשיחה חוזרת.' },
};
CF.typeColor = (t) => ({ start: '--green', say: '--blue', ask: '--indigo', action: '--orange', end: '--red' }[t] || '--blue');

/* ---------- state ---------- */
const blank = (name) => ({
  id: CF.uid('f'), name: name || 'תסריט חדש', business: 'קליניקת אור', nodes: [], edges: [],
  instructions: { personality: '', context: '', goldenRules: '', hotWords: '', values: [] }, globalArrows: [], aiTools: CF.DEFAULT_TOOLS ? CF.DEFAULT_TOOLS() : null,
});
CF.blankFlow = blank;
/* workspace: many flows, many agents. CF.state is always the flow open in the editor. */
CF.ws = { flows: [], agents: [], activeFlowId: null };
CF.state = blank();
CF.ws.flows.push(CF.state);
CF.ws.activeFlowId = CF.state.id;
CF.sel = null;          // { type: 'node' | 'edge', id }
CF.lastTouched = null;  // last node the assistant created or edited

CF.select = (sel) => { CF.sel = sel; if (sel && sel.type === 'node' && CF.ui) CF.ui.flowPanel = null; CF.emit('select', sel); };
CF.node = (id) => CF.state.nodes.find((n) => n.id === id);
CF.edge = (id) => CF.state.edges.find((e) => e.id === id);
CF.outEdge = (id, port) => CF.state.edges.find((e) => e.from === id && e.port === port);

/* Every node is one step of AIServant's instructionTree (script.js turns a flow into the tree).
   Shared fields: key (step id), title (= goal), text (= context: what to get across, not a line to read),
   starter (1–3 words played the moment the call reaches the step), maxVisits.
   start/say → kind say, one arrow whose `when` is the caller's reaction.
   ask       → kind ask ("החלטה"): slot, options = named arrows, or mode 'free' = a single `answered` arrow;
               fallback = the `unclear` arrow.
   action    → kind action: tool from the flow's aiTools (or a dialer built-in); ports out (= ok) and failed.
   end       → no arrows; its goal is the call's outcome.
   Edges: { from: node id, port: option id | 'out' | 'failed' | 'answered' | 'fallback', to: node id }. */
CF.ports = (n) => {
  if (!n || n.type === 'end') return [];
  if (n.type === 'ask') return (n.mode === 'free' ? ['answered'] : n.options.map((o) => o.id)).concat(n.fallback ? ['fallback'] : []);
  if (n.type === 'action') return ['out', 'failed'];
  return ['out'];
};
CF.KIND = { start: 'say', say: 'say', ask: 'ask', action: 'action', end: 'end' };
CF.RESERVED = ['answered', 'unclear', 'ok', 'failed', 'none'];

const opt = (label, ex) => ({
  id: CF.uid('o'),
  label,
  examples: String(ex || label).split('|').map((s) => s.trim()).filter(Boolean),
});
CF.opt = opt;

/* ---------- step ids and slots: short, unique, ASCII ---------- */
const KEY_BASE = { start: 'greet', say: 'say', ask: 'ask', action: 'action', end: 'end' };
CF.slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
CF.uniqueKey = (base, flow, selfId) => {
  const f = flow || CF.state;
  const taken = new Set(f.nodes.filter((n) => n.id !== selfId).map((n) => n.key));
  const b = CF.slug(base) || 'step';
  if (!taken.has(b)) return b;
  for (let i = 2; ; i++) if (!taken.has(b + '_' + i)) return b + '_' + i;
};
CF.uniqueSlot = (base, flow, selfId) => {
  const f = flow || CF.state;
  const taken = new Set(f.nodes.filter((n) => n.type === 'ask' && n.id !== selfId).map((n) => n.slot));
  const b = CF.slug(base) || 'answer';
  if (!taken.has(b)) return b;
  for (let i = 2; ; i++) if (!taken.has(b + '_' + i)) return b + '_' + i;
};

/* ---------- tools: action steps call one of the flow's aiTools ---------- */
/* Tools the dialer already has. An action step may call them by name; they are never sent in aiTools
   (a tool with one of these names is dropped by the dialer). book_meeting / check_availability / cancel_booking
   exist only for accounts with a calendar connected. */
CF.CALENDAR_TOOLS = ['check_availability', 'book_meeting', 'cancel_booking'];
CF.BUILTIN_TOOLS = ['end_call', 'transfer_call', 'get_current_time', 'check_availability', 'book_meeting', 'cancel_booking',
  'ignore_uncertain_turn', 'barged_in', 'report_conversation_state', 'provide_agent_advice', 'accept_unknown_speaker'];
/* the built-ins an action step may call on this account: the calendar ones only when a calendar is connected
   (AIServant otherwise answers "[x] calls book_meeting, which is not among the call's tools") */
CF.calendarConnected = () => !!(CF.settings && CF.settings.calendarConnected);
CF.callableBuiltins = () => CF.BUILTIN_TOOLS.filter((t) => !CF.CALENDAR_TOOLS.includes(t) || CF.calendarConnected());
CF.builtinPick = () => ['transfer_call', 'end_call', 'get_current_time'].concat(CF.calendarConnected() ? CF.CALENDAR_TOOLS : []);
CF.TOOL_OF = { calendar: 'schedule_meeting', whatsapp: 'send_whatsapp', crm: 'update_crm', transfer: 'transfer_call', callback: 'schedule_callback' };
CF.DEFAULT_TOOLS = () => [
  { name: 'schedule_meeting', description: 'Books a meeting at the day and time the caller agreed to.', url: 'https://example.com/tools/meeting', timeoutMs: 8000, shouldInvokeAnswer: true, params: [{ name: 'when', type: 'string', description: 'The day and time the caller chose', required: true }] },
  { name: 'send_whatsapp', description: 'Sends the caller a WhatsApp summary of the call.', url: 'https://example.com/tools/whatsapp', timeoutMs: 8000, shouldInvokeAnswer: true, params: [] },
  { name: 'update_crm', description: "Updates the lead's status in the CRM.", url: 'https://example.com/tools/crm', timeoutMs: 8000, shouldInvokeAnswer: true, params: [{ name: 'status', type: 'string', description: 'The new status of the lead', required: true }] },
  { name: 'schedule_callback', description: 'Creates a task to call the caller back.', url: 'https://example.com/tools/callback', timeoutMs: 8000, shouldInvokeAnswer: true, params: [{ name: 'when', type: 'string', description: 'When the caller asked to be called back', required: true }] },
];
CF.toolExists = (f, name) => CF.callableBuiltins().includes(name) || CF.tools(f).some((t) => t.name === name && !CF.callableBuiltins().includes(name));
CF.tools = (f) => (f.aiTools || (f.aiTools = CF.DEFAULT_TOOLS()));
CF.actionOfTool = (name) => Object.keys(CF.TOOL_OF).find((k) => CF.TOOL_OF[k] === name) || null;

const DEFAULTS = {
  start: () => ({ title: 'פתיחת שיחה', starter: 'היי,', text: 'להציג את עצמך מ{business} ולהזכיר שהשאירו פרטים באתר', when: 'ממשיך' }),
  say: () => ({ title: 'הודעה', starter: '', text: 'מה הבוט צריך להעביר בשלב הזה', when: 'ממשיך' }),
  ask: () => ({
    title: 'שאלה חדשה', starter: '', text: 'לשאול את הלקוח…',
    mode: 'options', options: [opt('כן', 'כן|בטח|אפשר|בסדר|נכון'), opt('לא', 'לא|לא תודה|לא מעוניין')],
    fallback: false,
  }),
  action: () => ({ action: 'crm', tool: 'update_crm', title: CF.ACTIONS.crm.label, starter: '', text: 'להגיד ללקוח שמעדכנים את הפרטים' }),
  end: () => ({ title: 'סיום', starter: '', text: 'להודות ללקוח ולהיפרד' }),
};
CF.makeNode = (type, over) => {
  const n = Object.assign({ id: CF.uid('n'), type, x: 0, y: 0, maxVisits: null }, DEFAULTS[type](), over || {});
  if (!n.key) n.key = CF.uniqueKey(KEY_BASE[type]);
  if (type === 'ask' && !n.slot) n.slot = CF.uniqueSlot(n.key);
  return n;
};
CF.addNode = (type, over) => { const n = CF.makeNode(type, over); CF.state.nodes.push(n); return n; };
CF.removeNode = (id) => {
  CF.state.nodes = CF.state.nodes.filter((n) => n.id !== id);
  CF.state.edges = CF.state.edges.filter((e) => e.from !== id && e.to !== id);
  (CF.state.globalArrows || []).forEach((g) => { if (g.to === id) g.to = null; });
  if (CF.sel && CF.sel.id === id) CF.sel = null;
  if (CF.lastTouched === id) CF.lastTouched = null;
};
CF.connect = (from, port, to) => {
  if (!from || !to || from === to) return null;
  CF.state.edges = CF.state.edges.filter((e) => !(e.from === from && e.port === port));
  const e = { id: CF.uid('e'), from, port, to };
  CF.state.edges.push(e);
  return e;
};
CF.removeEdge = (id) => {
  CF.state.edges = CF.state.edges.filter((e) => e.id !== id);
  if (CF.sel && CF.sel.id === id) CF.sel = null;
};
CF.removeOption = (nodeId, optId) => {
  const n = CF.node(nodeId);
  if (!n || !n.options) return;
  n.options = n.options.filter((o) => o.id !== optId);
  CF.state.edges = CF.state.edges.filter((e) => !(e.from === nodeId && e.port === optId));
};
CF.setFallback = (n, on) => {
  n.fallback = !!on;
  if (!on) CF.state.edges = CF.state.edges.filter((e) => !(e.from === n.id && e.port === 'fallback'));
};
CF.setMode = (n, mode) => {
  n.mode = mode;
  const keep = new Set(CF.ports(n));
  CF.state.edges = CF.state.edges.filter((e) => e.from !== n.id || keep.has(e.port));
};
CF.renameBusiness = (st, name) => {
  const old = st.business;
  if (!name || !old || name === old) { st.business = name || old; return; }
  const swap = (s) => (typeof s === 'string' ? s.split(old).join(name) : s);
  st.nodes.forEach((n) => { ['title', 'text', 'starter'].forEach((k) => { n[k] = swap(n[k]); }); });
  const ins = st.instructions || {};
  ['personality', 'context', 'goldenRules', 'hotWords'].forEach((k) => { ins[k] = swap(ins[k]); });
  (ins.values || []).forEach((v) => { v.value = swap(v.value); });
  st.business = name;
};
/* mode: what makecall gets as the call flow. 'tree' = instructionTree (the script), 'text' = the legacy free text.
   AIServant accepts exactly one of them. */
CF.blankInstructions = () => ({ personality: '', context: '', goldenRules: '', hotWords: '', values: [], mode: 'tree', text: '' });

/* older saves and imported files may miss newer fields */
CF.normalizeFlow = (f) => {
  if (!f.id) f.id = CF.uid('f');
  if (!Array.isArray(f.nodes)) f.nodes = [];
  if (!Array.isArray(f.edges)) f.edges = [];
  if (!f.name) f.name = 'תסריט';
  if (!f.business) f.business = 'העסק';
  f.instructions = Object.assign(CF.blankInstructions(), f.instructions || {});
  if (f.instructions.mode !== 'text') f.instructions.mode = 'tree';
  if (typeof f.instructions.text !== 'string') f.instructions.text = '';
  if (!Array.isArray(f.instructions.values)) {
    f.instructions.values = Object.entries(f.instructions.values || {}).map(([key, value]) => ({ key, value: String(value) }));
  }
  if (!Array.isArray(f.globalArrows)) f.globalArrows = [];
  if (!Array.isArray(f.aiTools)) f.aiTools = CF.DEFAULT_TOOLS();
  // saves from earlier versions: the question step had another type id, and a free-answer node outside the format existed
  f.nodes.forEach((n) => { if (n.type === 'jev') n.type = 'ask'; });
  const dropped = new Set(f.nodes.filter((n) => !CF.KIND[n.type]).map((n) => n.id));
  if (dropped.size) {
    f.nodes = f.nodes.filter((n) => !dropped.has(n.id));
    f.edges = f.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to));
  }
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const extra = [];
  f.nodes.forEach((n) => {
    if (typeof n.x !== 'number') n.x = 0;
    if (typeof n.y !== 'number') n.y = 0;
    if (!n.key) n.key = CF.uniqueKey(KEY_BASE[n.type] || 'step', f, n.id);
    if (typeof n.starter !== 'string') n.starter = '';
    if (n.maxVisits === undefined) n.maxVisits = null;
    delete n.example; delete n.threshold; delete n.prompt; // simulator-only fields of earlier versions
    if ((n.type === 'start' || n.type === 'say') && !n.when) n.when = 'ממשיך';
    if (n.type === 'action') {
      if (!n.action) n.action = 'crm';
      if (!n.tool) n.tool = CF.TOOL_OF[n.action] || 'update_crm';
      // without a connected calendar the dialer has no book_meeting: use the regular meeting tool instead
      if (n.tool === 'book_meeting' && !CF.calendarConnected() && !(f.aiTools || []).some((t) => t.name === 'book_meeting')) {
        n.tool = 'schedule_meeting';
        if (!(f.aiTools || []).some((t) => t.name === 'schedule_meeting')) (f.aiTools = f.aiTools || CF.DEFAULT_TOOLS().filter((t) => t.name !== 'schedule_meeting')).push(CF.DEFAULT_TOOLS()[0]);
      }
    }
    if (n.type === 'ask') {
      if (!Array.isArray(n.options)) n.options = [];
      if (!n.mode) n.mode = 'options';
      if (!n.slot) n.slot = CF.uniqueSlot(n.key, f, n.id);
      // the previous build put lead-ins on branches and knowledge on the question:
      // a branch's lead becomes the starter of the step it leads to, knowledge becomes flow context
      n.options.forEach((o) => {
        if (!o.id) o.id = CF.uid('o');
        if (!Array.isArray(o.examples)) o.examples = [];
        if (o.lead && o.lead.trim()) {
          const e = f.edges.find((x) => x.from === n.id && x.port === o.id);
          const t = e && byId.get(e.to);
          if (t && !t.starter) t.starter = o.lead.trim();
        }
        if (o.facts) extra.push(o.label + ': ' + o.facts);
        delete o.lead;
        delete o.facts;
      });
      if (n.knowledge) { extra.push(n.knowledge); delete n.knowledge; }
    }
  });
  if (extra.length) f.instructions.context = [f.instructions.context].concat(extra).filter(Boolean).join('\n');
  return f;
};

/* ---------- history + persistence ---------- */
const undoStack = [];
const redoStack = [];
const snap = () => JSON.stringify(CF.state);
CF.checkpoint = () => {
  undoStack.push(snap());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  CF.emit('history');
};
CF.canUndo = () => undoStack.length > 0;
CF.canRedo = () => redoStack.length > 0;
CF.undo = () => {
  if (!undoStack.length) return false;
  redoStack.push(snap());
  CF.state = JSON.parse(undoStack.pop());
  CF.sel = null;
  CF.emit('select', null);
  CF.commit({ structural: true });
  CF.emit('history');
  return true;
};
CF.redo = () => {
  if (!redoStack.length) return false;
  undoStack.push(snap());
  CF.state = JSON.parse(redoStack.pop());
  CF.sel = null;
  CF.emit('select', null);
  CF.commit({ structural: true });
  CF.emit('history');
  return true;
};

/* keep the open flow inside the workspace list (undo and builds replace the object) */
function syncActive() {
  if (!CF.state.id) CF.state.id = CF.uid('f');
  const i = CF.ws.flows.findIndex((f) => f.id === CF.state.id);
  if (i >= 0) CF.ws.flows[i] = CF.state; else CF.ws.flows.push(CF.state);
  CF.ws.activeFlowId = CF.state.id;
}
CF.syncActive = syncActive;

let saveTimer = 0;
CF.save = () => {
  syncActive();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(CF.ws)); CF.emit('saved'); } catch (e) { /* storage unavailable or full: keep working in memory */ }
  }, 250);
};
CF.load = () => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && Array.isArray(o.flows) && o.flows.length) {
        CF.ws = { flows: o.flows, agents: Array.isArray(o.agents) ? o.agents : [], activeFlowId: o.activeFlowId };
        CF.ws.flows.forEach(CF.normalizeFlow);
        CF.ws.agents.forEach((a) => { delete a.knowledge; delete a.voiceId; delete a.rate; }); // simulator-only fields of earlier versions
        CF.state = CF.ws.flows.find((f) => f.id === CF.ws.activeFlowId) || CF.ws.flows[0];
        CF.ws.activeFlowId = CF.state.id;
        return true;
      }
    }
    const old = localStorage.getItem(OLD_KEY); // single-flow format from the first version
    if (old) {
      const o = JSON.parse(old);
      if (o && Array.isArray(o.nodes)) {
        CF.state = CF.normalizeFlow(Object.assign(blank(), o, { id: CF.uid('f') }));
        CF.ws = { flows: [CF.state], agents: [], activeFlowId: CF.state.id };
        return true;
      }
    }
  } catch (e) { /* ignore broken storage */ }
  return false;
};

/* ---------- flows ---------- */
CF.flowStats = (f) => ({
  states: f.nodes.length,
  asks: f.nodes.filter((n) => n.type === 'ask').length,
  leads: f.nodes.filter((n) => n.starter && n.starter.trim()).length,
});
CF.flowById = (id) => (CF.state.id === id ? CF.state : CF.ws.flows.find((f) => f.id === id));
function resetEditor() {
  undoStack.length = 0;
  redoStack.length = 0;
  CF.sel = null;
  CF.lastTouched = null;
  CF.emit('select', null);
  CF.emit('history');
  CF.emit('flowSwitch', CF.state);
}
CF.openFlow = (id) => {
  if (id === CF.state.id) return;
  syncActive();
  const f = CF.ws.flows.find((x) => x.id === id);
  if (!f) return;
  CF.state = f;
  CF.ws.activeFlowId = id;
  resetEditor();
  CF.commit({ structural: true });
  CF.emit('flows');
};
CF.newFlow = (name) => {
  syncActive();
  const f = blank(name);
  CF.ws.flows.push(f);
  CF.openFlow(f.id);
  return f;
};
CF.duplicateFlow = (id) => {
  syncActive();
  const src = CF.flowById(id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = CF.uid('f');
  copy.name = src.name + ' (עותק)';
  CF.ws.flows.push(copy);
  CF.save();
  CF.emit('flows');
  return copy;
};
CF.deleteFlow = (id) => {
  syncActive();
  CF.ws.flows = CF.ws.flows.filter((f) => f.id !== id);
  CF.ws.agents.forEach((a) => { if (a.flowId === id) a.flowId = null; });
  if (!CF.ws.flows.length) CF.ws.flows.push(blank());
  if (CF.state.id === id) {
    CF.state = CF.ws.flows[0];
    CF.ws.activeFlowId = CF.state.id;
    resetEditor();
  }
  CF.commit({ structural: true });
  CF.emit('flows');
};
/* add a flow from a file (or a template) without touching the open one */
CF.importFlow = (data) => {
  if (!data || !Array.isArray(data.nodes)) throw new Error('bad file');
  syncActive();
  const f = CF.normalizeFlow({
    id: CF.uid('f'),
    name: String(data.name || 'תסריט מיובא'),
    business: String(data.business || 'העסק'),
    nodes: JSON.parse(JSON.stringify(data.nodes)),
    edges: JSON.parse(JSON.stringify(data.edges || [])),
    instructions: data.instructions ? JSON.parse(JSON.stringify(data.instructions)) : undefined,
    globalArrows: data.globalArrows ? JSON.parse(JSON.stringify(data.globalArrows)) : undefined,
    aiTools: data.aiTools ? JSON.parse(JSON.stringify(data.aiTools)) : undefined,
    startId: data.startId || null,
  });
  // keep only edges whose ends exist
  const ids = new Set(f.nodes.map((n) => n.id));
  f.edges = f.edges.filter((e) => e && ids.has(e.from) && ids.has(e.to));
  CF.ws.flows.push(f);
  CF.save();
  CF.emit('flows');
  return f;
};
CF.commit = (opts) => { CF.save(); CF.emit('change', opts || {}); };

/* ---------- measuring (canvas overrides with real DOM sizes) ---------- */
CF.measure = (id) => {
  const n = CF.node(id);
  const rows = n ? CF.ports(n).length * 34 + (n.type === 'ask' || n.type === 'action' ? 0 : -34) : 0;
  return { w: 264, h: 96 + rows, portY: () => 28 };
};

/* ---------- auto layout: left → right state tree ----------
   DFS from the start node to find back-edges (loops, e.g. an `unclear` arrow back to its question),
   longest-path depth on the remaining DAG for columns, then each column is ordered and
   placed next to its parents' ports so single branches stay straight. */
CF.layout = () => {
  const S = CF.state;
  if (!S.nodes.length) return [];
  const byId = new Map(S.nodes.map((n) => [n.id, n]));
  const outs = (id) => CF.ports(byId.get(id))
    .map((p) => S.edges.find((e) => e.from === id && e.port === p))
    .filter((e) => e && byId.has(e.to));

  const mark = {};
  const order = [];
  const back = new Set();
  const dfs = (id) => {
    mark[id] = 1; order.push(id);
    for (const e of outs(id)) {
      if (mark[e.to] === 1) back.add(e.id);
      else if (!mark[e.to]) dfs(e.to);
    }
    mark[id] = 2;
  };
  const start = S.nodes.find((n) => n.type === 'start');
  if (start) dfs(start.id);
  S.nodes.forEach((n) => { if (!mark[n.id]) dfs(n.id); });

  const fwd = S.edges.filter((e) => !back.has(e.id) && byId.has(e.from) && byId.has(e.to));
  const depth = {};
  order.forEach((id) => { depth[id] = 0; });
  for (let i = 0; i <= S.nodes.length; i++) {
    let changed = false;
    for (const e of fwd) if (depth[e.to] < depth[e.from] + 1) { depth[e.to] = depth[e.from] + 1; changed = true; }
    if (!changed) break;
  }

  const cols = [];
  order.forEach((id) => { (cols[depth[id]] = cols[depth[id]] || []).push(id); });
  const COL = 264 + 116;
  const GAP = 30;
  const IN_Y = 28;
  const pos = {};
  cols.forEach((col, ci) => {
    if (!col) return;
    const items = col.map((id, idx) => {
      const parents = fwd.filter((e) => e.to === id && pos[e.from]);
      let want = null;
      if (parents.length) {
        want = parents.reduce((s, e) => s + pos[e.from].y + CF.measure(e.from).portY(e.port), 0) / parents.length;
      }
      return { id, idx, h: CF.measure(id).h, want };
    });
    const placed = items.filter((it) => it.want !== null).sort((a, b) => (a.want - b.want) || (a.idx - b.idx));
    const loose = items.filter((it) => it.want === null);
    let cursor = -Infinity;
    placed.forEach((it) => {
      let top = it.want - IN_Y;
      if (top < cursor) top = cursor;
      it.top = top;
      cursor = top + it.h + GAP;
    });
    if (placed.length > 1) {
      const off = placed.reduce((s, it) => s + (it.want - IN_Y - it.top), 0) / placed.length;
      placed.forEach((it) => { it.top += off; });
      cursor += off;
    }
    if (cursor === -Infinity) cursor = 0;
    loose.forEach((it) => { it.top = cursor; cursor += it.h + GAP; });
    items.forEach((it) => { pos[it.id] = { x: ci * COL, y: Math.round(it.top) }; });
  });
  S.nodes.forEach((n) => { if (pos[n.id]) { n.x = pos[n.id].x; n.y = pos[n.id].y; } });
  return order;
};

/* ---------- attach a new node to the graph in a sensible place ---------- */
function freePort(a, n) {
  if (!a || a.id === n.id || a.type === 'end') return null;
  const free = CF.ports(a).filter((p) => !CF.outEdge(a.id, p));
  return free.find((p) => p !== 'fallback' && p !== 'failed') || null;
}
CF.attachNew = (n) => {
  const S = CF.state;
  const sel = CF.sel && CF.sel.type === 'node' ? CF.node(CF.sel.id) : null;
  let anchor = sel && sel.id !== n.id && sel.type !== 'end' ? sel : null;
  if (!anchor && CF.lastTouched) {
    const lt = CF.node(CF.lastTouched);
    if (lt && lt.id !== n.id && freePort(lt, n)) anchor = lt;
  }
  if (!anchor) anchor = S.nodes.find((x) => x.id !== n.id && freePort(x, n)) || null;
  let port = null;
  let inserted = false;
  if (anchor) {
    port = freePort(anchor, n);
    if (port) {
      CF.connect(anchor.id, port, n.id);
    } else if (CF.ports(anchor).includes('out')) {
      // insert between anchor and its current next step
      const old = CF.outEdge(anchor.id, 'out');
      CF.connect(anchor.id, 'out', n.id);
      const np = CF.ports(n).find((p) => p !== 'fallback');
      if (old && np) CF.connect(n.id, np, old.to);
      port = 'out';
      inserted = !!old;
    }
    n.x = anchor.x + 380;
    n.y = anchor.y;
  }
  if (!port) anchor = null;
  return { anchor, port, inserted };
};

/* ---------- UI-level state shared by components (menus, toast, view) ---------- */
CF.ui = {
  view: 'flows',     // 'flows' (#/studio) | 'agents' | 'voices'
  chatOpen: true,
  menu: null,       // { kind: 'nodes' | 'flows', x, y, ctx }
  toast: null,
  settingsOpen: false,
  flowPanel: null,  // 'instructions' | 'globals' | 'tools'
  exportOpen: false,
  exportTab: 'instructions', // 'instructions' | 'makecall' | 'call'
};
let toastTimer = 0;
CF.toast = (text) => {
  CF.ui.toast = { text, id: Date.now() };
  CF.emit('toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { CF.ui.toast = null; CF.emit('toast'); }, 2400);
};
/* routes: #/studio (the editor, view 'flows'), #/agents, #/voices. Anything else opens the editor. */
CF.navigate = (view) => {
  const hash = '#/' + (view === 'flows' ? 'studio' : view);
  if (location.hash !== hash) location.hash = hash;
  else CF.setViewFromHash();
};
CF.setViewFromHash = () => {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const v = ['studio', 'agents', 'voices'].includes(h) ? h : 'studio';
  CF.ui.view = v === 'studio' ? 'flows' : v;
  CF.ui.menu = null;
  CF.emit('route', CF.ui.view);
};
CF.openMenu = (m) => { CF.ui.menu = m; CF.emit('menu'); };
CF.closeMenu = () => { if (CF.ui.menu) { CF.ui.menu = null; CF.emit('menu'); } };
CF.openFlowPanel = (tab) => { CF.ui.flowPanel = tab || null; if (tab && CF.sel) CF.sel = null; CF.emit('flowPanel'); };
CF.openExport = (tab) => { CF.ui.exportOpen = true; CF.ui.exportTab = tab || 'instructions'; CF.emit('export'); };
CF.openSettings = (on) => { CF.ui.settingsOpen = on !== false; if (CF.ui.settingsOpen) CF.ui.exportOpen = false; CF.emit('settings'); };
