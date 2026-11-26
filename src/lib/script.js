/* AIServant call-script format (instructions.instructionTree).
   buildTree      flow → { start, nodes, globalArrows }   (what is sent)
   validate       the same rules AIServant checks (doc §7), run on every save, plus editor warnings
   buildInstructions / buildMakeCall   the full objects for POST /sip/makecall and the inbound webhook
   treeToFlow     an instructionTree (or a whole body) back into an editable flow */
import CF from './core.js';
import { settings, ENV } from './settings.js';

const WORDS = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
/* an option's (or global arrow's) phrasings → the arrow's description, which the decision model ("החלטה") reads to pick the arrow. An option with no phrasing of its own
   (examples = just its name, the default) sends none. */
export function optionDescription(o) {
  const label = String((o && o.label) || '').trim();
  const ex = ((o && o.examples) || []).map((x) => String(x).trim()).filter(Boolean);
  if (!ex.length || (ex.length === 1 && ex[0] === label)) return '';
  return ex.join(', ');
}
/* the when values that appear more than once in a list of arrows */
const dupWhens = (arrows) => {
  const whens = (arrows || []).map((a) => a.when).filter(Boolean);
  return [...new Set(whens.filter((w, i) => whens.indexOf(w) !== i))];
};
/* and back: a description into phrasings */
const splitDescription = (d) => String(d || '').split(/[,،|]/).map((x) => x.trim()).filter(Boolean);

/* ---------- flow → tree ---------- */
export function buildTree(flow) {
  const f = flow || CF.state;
  const steps = f.nodes.filter((n) => CF.KIND[n.type]);
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const keyOf = (id) => { const n = byId.get(id); return n && CF.KIND[n.type] ? n.key : null; };
  const out = (n, port) => { const e = f.edges.find((x) => x.from === n.id && x.port === port); return e ? keyOf(e.to) : null; };

  const nodes = steps.map((n) => {
    const kind = CF.KIND[n.type];
    // same key order as the format doc: id, kind, goal, slot/tool, starter, context, maxVisits, arrows
    const s = { id: n.key, kind, goal: (n.title || '').trim() };
    if (kind === 'ask') s.slot = n.slot;
    if (kind === 'action') s.tool = n.tool;
    if (n.starter && n.starter.trim()) s.starter = n.starter.trim();
    s.context = (n.text || '').trim();
    if (n.maxVisits) s.maxVisits = Number(n.maxVisits);
    if (kind === 'end') return s;
    const arrows = [];
    if (kind === 'say') {
      const to = out(n, 'out');
      if (to) arrows.push({ when: (n.when || 'ממשיך').trim(), to });
    } else if (kind === 'ask') {
      if (n.mode === 'free') { const to = out(n, 'answered'); if (to) arrows.push({ when: 'answered', to }); }
      else n.options.forEach((o) => {
        const to = out(n, o.id);
        if (!to) return;
        const when = (o.label || '').trim();
        const a = { when };
        // the phrasings written under the option ("כן, מדבר, מדברת…"), as written; left out when there are none
        const description = optionDescription(o);
        if (description) a.description = description;
        a.to = to;
        arrows.push(a);
      });
      if (n.fallback) { const to = out(n, 'fallback'); if (to) arrows.push({ when: 'unclear', to }); }
    } else if (kind === 'action') {
      const ok = out(n, 'out'); if (ok) arrows.push({ when: 'ok', to: ok });
      const bad = out(n, 'failed'); if (bad) arrows.push({ when: 'failed', to: bad });
    }
    s.arrows = arrows;
    return s;
  });
  const start = (f.startId && byId.get(f.startId)) || f.nodes.find((n) => n.type === 'start') || steps[0];
  return {
    start: start ? start.key : '',
    nodes,
    globalArrows: (f.globalArrows || []).filter((g) => (g.when || '').trim()).map((g) => {
      const a = { when: g.when.trim() };
      const description = optionDescription({ label: g.when, examples: g.examples });
      if (description) a.description = description;
      a.to = keyOf(g.to) || '';
      return a;
    }),
  };
}

export function valuesObject(flow) {
  const f = flow || CF.state;
  const v = {};
  (f.instructions.values || []).forEach((x) => { if (x.key && x.key.trim()) v[x.key.trim()] = String(x.value || ''); });
  if (!('business' in v) && f.business) v.business = f.business;
  return v;
}
/* {key} → value; a placeholder with no value stays as is, braces included */
export const applyValues = (text, flow) => {
  const v = valuesObject(flow);
  return String(text || '').replace(/\{([^{}\s]+)\}/g, (m, k) => (k in v ? v[k] : m));
};

export function buildInstructions(flow, agent) {
  const f = flow || CF.state;
  const ins = f.instructions;
  const persona = ins.personality.trim() || personaText(agent);
  const o = {};
  if (persona) o.personality = persona;
  if (ins.context.trim()) o.context = ins.context.trim();
  if (ins.goldenRules.trim()) o.goldenRules = ins.goldenRules.trim();
  if (ins.hotWords.trim()) o.hotWords = ins.hotWords.trim();
  o.values = valuesObject(f);
  // exactly one of the two: the script, or the legacy free text
  if (ins.mode === 'text') o.text = (ins.text || '').trim();
  else o.instructionTree = buildTree(f);
  return o;
}

/* The script written out as free instructions, for flows sent as legacy `text`.
   The other sections (personality, context, goldenRules, hotWords) travel separately, so they are not repeated. */
export function scriptAsText(flow) {
  const f = flow || CF.state;
  const t = buildTree(f);
  const byKey = new Map(t.nodes.map((s) => [s.id, s]));
  const name = (k) => { const s = byKey.get(k); return s ? `"${s.goal}"` : k; };
  const L = ['את/ה {agent} מ{business}. השיחה מתנהלת בשלבים. בכל שלב אומרים במילים שלך את מה שכתוב, פותחים במילות הפתיחה אם יש, ועוברים לשלב הבא לפי מה שהלקוח עונה. שאלה שלא מופיעה כאן: עונים מהרקע ונשארים באותו שלב.', ''];
  let i = 0;
  const order = [];
  const seen = new Set();
  const walk = (k) => { if (!k || seen.has(k) || !byKey.has(k)) return; seen.add(k); order.push(byKey.get(k)); (byKey.get(k).arrows || []).forEach((a) => walk(a.to)); };
  walk(t.start);
  t.globalArrows.forEach((g) => walk(g.to));
  t.nodes.forEach((s) => walk(s.id));
  order.forEach((s) => {
    i++;
    L.push(`${i}. ${s.goal}: ${s.context}${s.starter ? ` (לפתוח ב"${s.starter}")` : ''}.`);
    (s.arrows || []).forEach((a) => {
      const when = a.when === 'answered' ? 'אחרי שהלקוח עונה' : a.when === 'unclear' ? 'אם התשובה לא ברורה' : a.when === 'ok' ? 'אם זה הצליח' : a.when === 'failed' ? 'אם זה נכשל' : `אם הלקוח אומר "${a.when}"`;
      L.push(`   - ${when}: עוברים ל-${name(a.to)}.`);
    });
    if (s.kind === 'ask' && s.slot) L.push(`   - לזכור את התשובה (${s.slot}).`);
    if (s.kind === 'action' && s.tool) L.push(`   - להפעיל את הכלי ${s.tool}.`);
    if (s.kind === 'end') L.push('   - לסיים את השיחה.');
  });
  if (t.globalArrows.length) {
    L.push('', 'בכל שלב:');
    t.globalArrows.forEach((g) => L.push(`- אם הלקוח ${g.when}: עוברים ל-${name(g.to)}.`));
  }
  return L.join('\n');
}
function personaText(agent) {
  if (!agent) return '';
  const p = agent.personality || {};
  const bits = [];
  if (p.formal >= 60) bits.push('רשמי'); else if (p.formal <= 40) bits.push('חברי');
  if (p.concise >= 60) bits.push('משפטים קצרים');
  if (p.energy >= 65) bits.push('אנרגטי'); else if (p.energy <= 35) bits.push('רגוע');
  (p.traits || []).forEach((t) => bits.push(t));
  return [bits.join(', '), p.prompt].filter(Boolean).join('. ');
}

/* the aiTools array: only the tools some action step calls, never a dialer built-in, never a null value */
export function buildAiTools(f) {
  const used = new Set(f.nodes.filter((n) => n.type === 'action').map((n) => n.tool));
  return CF.tools(f)
    .filter((t) => t.name && t.name.trim() && used.has(t.name.trim()) && !CF.callableBuiltins().includes(t.name.trim()))
    .map((t) => {
      const o = { name: t.name.trim(), description: (t.description || '').trim(), url: (t.url || '').trim() };
      o.timeoutMs = Number(t.timeoutMs) || 8000;
      o.shouldInvokeAnswer = t.shouldInvokeAnswer !== false;
      const ps = (t.params || []).filter((p) => p.name && p.name.trim());
      if (ps.length) {
        o.parameters = Object.fromEntries(ps.map((p) => [p.name.trim(), { type: p.type || 'string', description: p.description || '', required: !!p.required }]));
      }
      return o;
    });
}

/* POST /sip/makecall body, as in the format doc §8. apiKey is the account owner uid (DEMO_LEADS_OWNER_UID by default). */
export function buildMakeCall(flow, agent, call) {
  const f = flow || CF.state;
  const c = call || {};
  // the agent's own Cartesia voice wins; Settings holds the default for agents without one
  const cartesia = {};
  const vid = ((agent && agent.cartesiaVoiceId) || settings.voiceId || '').trim();
  if (vid) cartesia.voice = vid;
  cartesia.voiceGender = (agent && agent.voiceGender) || settings.voiceGender || 'female';
  const instructions = buildInstructions(f, agent);
  // hot words can be set for one call (the dial screen); the lead's name can be added so it is recognized and said right
  if (c.hotWords != null || c.addLeadToHotWords) {
    const words = String(c.hotWords != null ? c.hotWords : (instructions.hotWords || '')).split(/[,،\n]/).map((w) => w.trim()).filter(Boolean);
    const lead = (c.leadName || '').trim();
    if (c.addLeadToHotWords && lead && !words.includes(lead)) words.push(lead);
    const joined = words.join(', ');
    const order = {};
    Object.keys(instructions).forEach((k) => {
      if (k === 'hotWords') return;
      if (k === 'values' && joined) order.hotWords = joined;
      order[k] = instructions[k];
    });
    if (joined && !('hotWords' in order)) order.hotWords = joined;
    Object.keys(instructions).forEach((k) => delete instructions[k]);
    Object.assign(instructions, order);
  }
  return {
    apiKey: (c.apiKey || ENV.account || settings.accountId || '').trim(),
    to: (c.to || '0500000000').trim(),
    cartesiaSettings: cartesia,
    leadInfo: { name: (c.leadName || '').trim() || 'לקוח' },
    aiTools: buildAiTools(f),
    instructions,
  };
}

/* ---------- validation ----------
   Errors are what AIServant rejects (doc §7). Warnings are editor advice (starter style, dropped bits). */
export function validate(flow) {
  const f = flow || CF.state;
  const tree = buildTree(f);
  const tools = new Set(CF.tools(f).map((t) => (t.name || '').trim()).filter(Boolean));
  const nodeOfKey = new Map();
  f.nodes.forEach((n) => { if (CF.KIND[n.type] && !nodeOfKey.has(n.key)) nodeOfKey.set(n.key, n); });
  const out = [];
  const err = (key, msg, extra) => out.push(Object.assign({ level: 'error', key, nodeId: key && nodeOfKey.get(key) ? nodeOfKey.get(key).id : null, msg }, extra || {}));
  const warn = (key, msg, extra) => out.push(Object.assign({ level: 'warn', key, nodeId: key && nodeOfKey.get(key) ? nodeOfKey.get(key).id : null, msg }, extra || {}));

  // sent as legacy text: AIServant reads the text, the steps are not sent and not checked
  if (f.instructions && f.instructions.mode === 'text') {
    if (!(f.instructions.text || '').trim()) err(null, 'הפורמט הוא text, אבל הטקסט ריק. כתבו אותו בהוראות התסריט, או צרו אותו מהתסריט.', { textMode: true });
    else warn(null, 'נשלח כ-text: AIServant מריץ את השיחה מהטקסט, בלי מעקב אחרי צעדים. הצעדים בגרף לא נשלחים.', { textMode: true });
    return out;
  }
  if (!tree.nodes.length) { err(null, 'בתסריט אין אף צעד.'); return out; }

  // inside each step first (AIServant reports these before the between-step problems)
  const seen = new Map();
  tree.nodes.forEach((s) => seen.set(s.id, (seen.get(s.id) || 0) + 1));
  seen.forEach((c, id) => { if (c > 1) err(id, `[${id}] המזהה מופיע ב-${c} צעדים. מזהה צעד חייב להיות ייחודי.`); });

  tree.nodes.forEach((s) => {
    const id = s.id || '?';
    if (!s.id) err(null, 'יש צעד בלי מזהה (id).');
    if (!s.goal) err(id, `[${id}] חסרה מטרה (goal).`);
    if (!s.context) err(id, `[${id}] חסר תוכן (context): מה התשובה בצעד הזה צריכה להעביר.`);
    if (s.kind === 'end') { if (s.arrows && s.arrows.length) err(id, `[${id}] לצעד סיום אסור שיהיו חצים.`); }
    else if (!s.arrows.length) err(id, `[${id}] אין לצעד אף חץ יוצא. חברו אותו לצעד הבא.`);
    if (s.kind === 'ask') {
      if (!s.slot) err(id, `[${id}] לשאלה חסר slot: השם שתחתיו התשובה נשמרת.`);
      const whens = s.arrows.map((a) => a.when);
      const answers = whens.filter((w) => w !== 'unclear');
      if (s.arrows.length && !answers.length) err(id, `[${id}] יש רק חץ unclear. צריך לפחות תשובה אחת.`);
      if (answers.includes('answered') && answers.length > 1) err(id, `[${id}] אי אפשר לשלב answered עם אפשרויות בשם. בחרו תשובה חופשית או אפשרויות.`);
      answers.forEach((w) => { if (w !== 'answered' && CF.RESERVED.includes(w)) err(id, `[${id}] "${w}" היא מילה שמורה ואי אפשר להשתמש בה כאפשרות.`); });
    }
    if (s.kind === 'action') {
      if (!s.tool) err(id, `[${id}] לפעולה חסר tool.`);
      else if (!tools.has(s.tool) && !CF.callableBuiltins().includes(s.tool)) {
        err(id, `[${id}] calls ${s.tool}, which is not among the call's tools. ` + (CF.CALENDAR_TOOLS.includes(s.tool)
          ? 'זה כלי יומן מובנה, וקיים רק בחשבון שמחובר אליו יומן. בחרו כלי אחר (למשל schedule_meeting), או סמנו בהגדרות שהיומן מחובר.'
          : 'הוסיפו אותו לכלים של התסריט או בחרו כלי אחר.'));
      }
      if (!s.arrows.some((a) => a.when === 'ok')) err(id, `[${id}] לפעולה חסר חץ ok.`);
    }
    if (s.kind === 'say' && s.arrows.some((a) => CF.RESERVED.includes(a.when))) err(id, `[${id}] התגובה "${s.arrows[0].when}" היא מילה שמורה.`);
    s.arrows && s.arrows.forEach((a) => { if (a.when === 'none') err(id, `[${id}] אסור חץ על none.`); });
    // AIServant follows an arrow by its when: of two arrows with the same when only the first can ever be taken,
    // even with different descriptions. A hint, not a block (Yoav, 2026-11-23). Same when as a global arrow is fine:
    // the step's arrow overrides the global one on that step.
    dupWhens(s.arrows).forEach((w) => warn(id, `[${id}] שני חצים בצעד נקראים "${w}". AIServant בוחר חץ לפי השם, אז רק הראשון ייבחר אי פעם, גם אם התיאורים שונים. תנו לכל חץ שם משלו.`));
    if (s.maxVisits != null && !(Number.isInteger(s.maxVisits) && s.maxVisits > 0)) err(id, `[${id}] maxVisits צריך להיות מספר שלם חיובי.`);
    if (s.starter) {
      if (WORDS(s.starter) > 3) warn(id, `[${id}] הפתיח "${s.starter}" ארוך מ-3 מילים. פתיח הוא 1 עד 3 מילים, לא משפט.`);
      if (/[?؟]\s*$/.test(s.starter)) warn(id, `[${id}] הפתיח לא אמור להיות שאלה.`);
    }
  });
  dupWhens(tree.globalArrows).forEach((w) => warn(null, `שני חצים גלובליים נקראים "${w}". AIServant בוחר חץ לפי השם, אז רק הראשון ייבחר אי פעם. תנו לכל חץ שם משלו.`, { global: true }));
  // aiTools, by the dialer's rules (an invalid tool list makes makecall fail with 400)
  const sent = buildAiTools(f);
  const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
  if (sent.length > 16) err(null, `יש ${sent.length} כלים. הדיילר מקבל עד 16.`, { tools: true });
  sent.forEach((t) => {
    if (!NAME.test(t.name)) err(null, `הכלי "${t.name}": שם חייב להתחיל באות, ורק אותיות באנגלית, ספרות וקו תחתון.`, { tools: true });
    if (!t.description) err(null, `לכלי ${t.name} חסר description.`, { tools: true });
    if (!/^https:\/\/[^/\s]+/i.test(t.url) || /^https:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(t.url)) err(null, `לכלי ${t.name} צריך url מלא ב-https, לא localhost ולא כתובת פנימית.`, { tools: true });
    else if (/example\.com/i.test(t.url)) warn(null, `ה-url של ${t.name} הוא מציין מקום (example.com). בשיחה אמיתית הכלי ייכשל.`, { tools: true });
    Object.keys(t.parameters || {}).forEach((p) => { if (!NAME.test(p)) err(null, `לכלי ${t.name} יש פרמטר "${p}" עם שם לא תקין.`, { tools: true }); });
  });
  CF.tools(f).forEach((t) => { if (CF.callableBuiltins().includes((t.name || '').trim())) warn(null, `${t.name} הוא שם של כלי מובנה בדיילר, אז הוא לא נשלח ב-aiTools. פעולה יכולה לקרוא לו ישירות.`, { tools: true }); });

  if (out.some((x) => x.level === 'error')) return withEditorWarnings(f, out, warn);

  // between steps
  const ids = new Set(tree.nodes.map((s) => s.id));
  if (!ids.has(tree.start)) err(null, `start מצביע על "${tree.start}", שלא קיים.`);
  const slots = new Map();
  tree.nodes.forEach((s) => { if (s.kind === 'ask' && s.slot) slots.set(s.slot, (slots.get(s.slot) || []).concat(s.id)); });
  slots.forEach((list, slot) => { if (list.length > 1) err(list[1], `ה-slot "${slot}" משמש ב-${list.map((x) => '[' + x + ']').join(', ')}. כל slot שייך לשאלה אחת.`); });
  tree.nodes.forEach((s) => (s.arrows || []).forEach((a) => { if (!ids.has(a.to)) err(s.id, `[${s.id}] has an arrow to [${a.to}], which does not exist.`); }));
  tree.globalArrows.forEach((g) => {
    if (g.when === 'none') err(null, 'אסור חץ גלובלי על none.');
    if (!ids.has(g.to)) err(null, `לחץ הגלובלי "${g.when}" אין צעד יעד קיים.`, { global: true });
  });
  // reachability from start and from global arrows
  const reach = new Set();
  const stack = [tree.start].concat(tree.globalArrows.map((g) => g.to)).filter((x) => ids.has(x));
  const byKey = new Map(tree.nodes.map((s) => [s.id, s]));
  while (stack.length) {
    const k = stack.pop();
    if (reach.has(k)) continue;
    reach.add(k);
    (byKey.get(k).arrows || []).forEach((a) => { if (ids.has(a.to)) stack.push(a.to); });
  }
  tree.nodes.forEach((s) => { if (!reach.has(s.id)) err(s.id, `[${s.id}] אי אפשר להגיע לצעד הזה מ-start או מחץ גלובלי.`); });
  return withEditorWarnings(f, out, warn);
}

/* ---------- starters vs. the branches that reach them ----------
   A step's starter is played every time the call reaches it, whichever arrow led there,
   so it has to fit every incoming arrow. */
export function incomingArrows(flow) {
  const f = flow || CF.state;
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const inc = new Map(f.nodes.map((n) => [n.id, []]));
  const start = (f.startId && byId.get(f.startId)) || f.nodes.find((n) => n.type === 'start');
  if (start) inc.get(start.id).push({ kind: 'start', when: 'תחילת השיחה', from: null });
  f.edges.forEach((e) => {
    const a = byId.get(e.from);
    if (!a || !byId.has(e.to) || !CF.KIND[a.type] || !CF.ports(a).includes(e.port)) return;
    let when;
    let kind = 'arrow';
    if (a.type === 'ask') {
      if (e.port === 'fallback') { when = 'unclear'; kind = 'unclear'; }
      else if (e.port === 'answered') { when = 'answered'; kind = 'answered'; }
      else when = ((a.options.find((o) => o.id === e.port) || {}).label || '').trim();
    } else if (a.type === 'action') { when = e.port === 'failed' ? 'failed' : 'ok'; kind = e.port === 'failed' ? 'failed' : 'ok'; }
    else { when = (a.when || 'ממשיך').trim(); kind = 'reaction'; }
    inc.get(e.to).push({ kind, when, from: a });
  });
  (f.globalArrows || []).forEach((g) => { if (g.to && inc.has(g.to) && (g.when || '').trim()) inc.get(g.to).push({ kind: 'global', when: g.when.trim(), from: null }); });
  return inc;
}
const POSITIVE = /^(מעולה|מצוין|מצויין|יפה|סגרנו|נהדר|ברוך הבא|ברוכה הבאה|איזה כיף|וואו|יופי|סגור|אחלה)/;
const SOFT_NO = /^(אין בעיה|הבנתי|זה בסדר|זה קורה|מבינה|מבין|אני מבינה|אני מבין)/;
const SORRY = /^(סליחה|מצטער|מצטערת|אופס|לצערי|רגע)/;
const NEG_WHEN = /^(לא(\s|$)|לא |לבטל|ביטול|עדיין|יקר|לא מעוניין|לא רלוונטי|לא תודה|לא עכשיו|לא הזמן|לא יודע|רק בודק|מתעקש|כבר יש)/;
const POS_WHEN = /^(כן|בטח|מעוניין|סוגרים|מקבל|להקפיא|להעביר|בוא נקבע|השבוע|מתאים|קנייה|שכירות|מיידי)/;
const bare = (s) => String(s || '').replace(/[,،.!?…\s]+$/g, '').trim();

export function starterProblems(f) {
  const inc = incomingArrows(f);
  const out = [];
  f.nodes.forEach((n) => {
    const st = (n.starter || '').trim();
    if (!CF.KIND[n.type] || !st) return;
    const s = applyValues(st, f);
    const list = inc.get(n.id) || [];
    const src = (x) => (x.from ? `[${x.from.key}] ` : '') + (x.kind === 'global' ? `חץ גלובלי "${x.when}"` : x.kind === 'failed' ? 'כשל (failed)' : x.kind === 'unclear' ? 'תשובה לא ברורה (unclear)' : `"${x.when}"`);
    list.forEach((x) => {
      if (x.kind === 'failed' && !SORRY.test(s)) out.push({ n, x, msg: `[${n.key}] הפתיח "${s}" נשמע גם אחרי ${src(x)}. אחרי כשל הוא לא מתאים: עדיף צעד נפרד לכשל, או פתיח של התנצלות ("סליחה,").` });
      else if (POSITIVE.test(s) && (x.kind === 'global' || x.kind === 'unclear' || (x.kind !== 'failed' && NEG_WHEN.test(x.when)))) out.push({ n, x, msg: `[${n.key}] הפתיח החיובי "${s}" נשמע גם אחרי ${src(x)}, ושם הוא לא מתאים.` });
      else if (SOFT_NO.test(s) && (x.kind === 'arrow' || x.kind === 'reaction') && POS_WHEN.test(x.when) && !NEG_WHEN.test(x.when)) out.push({ n, x, msg: `[${n.key}] הפתיח "${s}" נשמע גם אחרי ${src(x)}. אחרי הסכמה הוא נשמע כאילו הלקוח סירב.` });
      // two starters back to back: an action does not wait for the caller
      if (x.from && x.from.type === 'action' && x.kind !== 'failed' && (x.from.starter || '').trim()) {
        const a = applyValues(x.from.starter.trim(), f);
        out.push({ n, x, msg: `[${n.key}] הפתיח "${s}" בא מיד אחרי הפתיח "${a}" של [${x.from.key}], בלי שהלקוח דיבר ביניהם. כדאי להשאיר רק אחד.` + (bare(a) === bare(s) ? ' זה אותו פתיח פעמיים.' : '') });
      }
    });
  });
  return out;
}

function withEditorWarnings(f, out, warn) {
  starterProblems(f).forEach((p) => warn(p.n.key, p.msg, { starter: true }));
  f.nodes.forEach((n) => {
    if (n.type === 'ask' && n.mode !== 'free') n.options.forEach((o) => {
      if (!f.edges.some((e) => e.from === n.id && e.port === o.id)) warn(n.key, `[${n.key}] האפשרות "${o.label}" לא מחוברת ולכן לא נשלחת.`);
    });
  });
  return out;
}

/* cached result for the open flow, recomputed on every change (validate-on-save) */
let cache = { v: -1, list: [] };
export function issues() {
  if (cache.v !== CF.v) cache = { v: CF.v, list: validate(CF.state) };
  return cache.list;
}
CF.issues = issues;
CF.issuesFor = (nodeId) => issues().filter((i) => i.nodeId === nodeId);

/* ---------- tree → flow (import) ---------- */
export function treeToFlow(data, name) {
  const body = data.instructions ? data : { instructions: data.instructionTree ? data : { instructionTree: data } };
  const ins = body.instructions;
  const tree = ins.instructionTree;
  if (!tree || !Array.isArray(tree.nodes)) throw new Error('no instructionTree');
  const idOf = {};
  tree.nodes.forEach((s) => { idOf[s.id] = CF.uid('n'); });
  const nodes = [];
  const edges = [];
  const warnings = [];
  const edge = (from, port, toKey) => {
    if (idOf[toKey]) edges.push({ id: CF.uid('e'), from, port, to: idOf[toKey] });
    else warnings.push(`חץ אל [${toKey}], שלא קיים בתסריט, לא יובא.`);
  };
  tree.nodes.forEach((s) => {
    const type = s.kind === 'ask' ? 'ask' : s.kind === 'say' ? (s.id === tree.start ? 'start' : 'say') : s.kind === 'action' ? 'action' : 'end';
    const n = { id: idOf[s.id], key: s.id, type, x: 0, y: 0, title: s.goal || s.id, text: s.context || '', starter: s.starter || '', maxVisits: s.maxVisits || null };
    const arrows = s.arrows || [];
    if (type === 'start' || type === 'say') {
      n.when = (arrows[0] && arrows[0].when) || 'ממשיך';
      if (arrows[0]) edge(n.id, 'out', arrows[0].to);
      // the studio keeps one reaction per say step: report the rest instead of dropping them silently
      arrows.slice(1).forEach((a) => warnings.push(`[${s.id}] לצעד say יש כמה תגובות. נשמרה "${arrows[0].when}", והתגובה "${a.when}" (אל ${a.to}) לא יובאה.`));
    }
    if (type === 'ask') {
      n.slot = s.slot || CF.slug(s.id);
      const named = arrows.filter((a) => a.when !== 'unclear' && a.when !== 'answered');
      n.mode = arrows.some((a) => a.when === 'answered') ? 'free' : 'options';
      n.options = named.map((a) => {
        // description (the phrasings, comma separated) back into the option's examples
        const ex = splitDescription(a.description);
        const o = CF.opt(a.when, (ex.length ? ex : [a.when]).join('|'));
        edge(n.id, o.id, a.to);
        return o;
      });
      if (n.mode === 'free') edge(n.id, 'answered', arrows.find((a) => a.when === 'answered').to);
      const un = arrows.find((a) => a.when === 'unclear');
      n.fallback = !!un;
      if (un) edge(n.id, 'fallback', un.to);
    }
    if (type === 'action') {
      n.tool = s.tool || '';
      n.action = CF.actionOfTool(n.tool) || 'crm';
      arrows.forEach((a) => edge(n.id, a.when === 'failed' ? 'failed' : 'out', a.to));
    }
    nodes.push(n);
  });
  const values = Object.entries(ins.values || {}).map(([key, value]) => ({ key, value: String(value) }));
  const tools = Array.isArray(body.aiTools) && body.aiTools.length
    ? body.aiTools.map((t) => ({ name: t.name, description: t.description || '', url: t.url || '', params: Object.entries(t.parameters || {}).map(([pn, pv]) => ({ name: pn, description: (pv && pv.description) || '' })) }))
    : undefined;
  return {
    startId: idOf[tree.start] || null,
    importWarnings: warnings,
    name: name || 'תסריט מיובא',
    business: (ins.values && (ins.values.business || ins.values.clinic)) || 'העסק',
    nodes,
    edges,
    instructions: { personality: ins.personality || '', context: ins.context || '', goldenRules: ins.goldenRules || '', hotWords: ins.hotWords || '', values },
    globalArrows: (tree.globalArrows || []).map((g) => ({ id: CF.uid('g'), when: g.when, examples: splitDescription(g.description), to: idOf[g.to] || null })),
    aiTools: tools,
  };
}
export const isTreeData = (d) => !!(d && (d.instructionTree || (d.instructions && d.instructions.instructionTree) || (Array.isArray(d.nodes) && d.start && d.nodes[0] && d.nodes[0].kind)));
