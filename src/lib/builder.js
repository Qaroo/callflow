/* The builder agent behind the AI chat, running on the "fast brain" LLM.
   It builds and edits flows through tools (agentOps.js) and uses the app like a person (computer.js): a visible
   cursor that navigates, clicks and types. It can place a real test call through AIServant after the user approves.
   Before each run the user sees the model and the estimated cost; during the run, the actual cost.
   Runs straight from the browser with the user's own key (Settings → מוח מהיר). The provider is Google's
   Generative Language API (streamGenerateContent with function calling): see stream() below and pricing.js. */
import CF from './core.js';
import chat from './chat.js';
import C from './canvas.js';
import { settings, saveSettings, brainOn } from './settings.js';
import { runOp, snapshot, focusOf, READ_ONLY, byKey } from './agentOps.js';
import { validate } from './script.js';
import { TEMPLATE_INFO } from './templates.js';
import { cost, priceFor, countTokens, listModels, usd, DEFAULT_MODEL, PROVIDER_API } from './pricing.js';
import * as pc from './computer.js';

const MAX_TURNS = 45;
const W = (ms) => CF.wait(CF.reducedMotion() ? 0 : ms);
const VIA = { via: 'מוח מהיר', viaClass: 'brain', viaIcon: 'sparkle' };
export const builderOn = () => brainOn();
export const builderModel = () => (settings.brainModel || DEFAULT_MODEL).trim();

/* ---------- state ---------- */
const st = {
  history: [], // the model's conversation contents; its parts are kept exactly as received
  run: null, // { flowId, abort, stopped, ops, calls, inTok, outTok, cost }
  pending: null, // { resolve, msg } an open question / approval card
  planApproved: new Set(), // flow ids with an approved plan
  userText: '', // everything the user typed: phone numbers for real calls must come from here
  total: { cost: 0, inTok: 0, outTok: 0 },
};
const ui = (chat.agent = { busy: false, label: '', ops: 0, cost: 0, tokens: 0, model: '' });
const touch = () => CF.emit('chat');
const digits = (s) => String(s || '').replace(/[^\d]/g, '');

/* ---------- tools the model sees ---------- */
const T = (type, description, extra) => Object.assign({ type, description }, extra || {});
const S = (description) => T('STRING', description);
const OBJ = (properties, required, description) => ({ type: 'OBJECT', properties, required: required || [], description });
const OPTION = OBJ({ when: S('the answer name, in Hebrew, e.g. "מעוניין"'), examples: T('ARRAY', 'how customers actually say it (3–6 phrasings)', { items: S('') }) }, ['when']);
const STEP_FIELDS = {
  goal: S('short goal of the step, Hebrew'),
  context: S('what the reply at this step must convey: facts, prices, what to ask. Hebrew. The reply model words it live'),
  starter: S('1–3 words played instantly when the call reaches the step, e.g. "מעולה," "רגע," "הבנתי,". Must fit EVERY arrow that leads here. Empty for none'),
  slot: S('ask only: snake_case name the answer is saved under'),
  tool: S('action only: the tool name to call'),
  options: T('ARRAY', 'ask only: the named answers (each becomes an arrow)', { items: OPTION }),
  free_answer: T('BOOLEAN', 'ask only: true = any answer continues via one "answered" arrow (e.g. a name, a date)'),
  unclear: T('BOOLEAN', 'ask only: add an "unclear" arrow (connect it with connect when="unclear")'),
  max_visits: T('INTEGER', 'how many times the call may enter this step (loops), optional'),
  start: T('BOOLEAN', 'true = this is the first step of the call'),
};
const DECLS = [
  // talking to the user
  { name: 'ask_user', description: 'Ask the user a question and WAIT for the answer. Use for missing business facts, choices, and to suggest additions. Prefer 2–4 short clickable options.',
    parameters: OBJ({ question: S('the question, Hebrew, short'), options: T('ARRAY', 'suggested answers the user can click', { items: S('') }) }, ['question']) },
  { name: 'propose_plan', description: 'Show the user your plan and WAIT for approval. Required before building a new flow or making big changes. If not approved, adapt to the feedback and propose again.',
    parameters: OBJ({ title: S('short title'), summary: S('2–3 sentences: who is called, the goal, the main path'), steps: T('ARRAY', 'the steps you will build, in call order, one short Hebrew line each', { items: S('') }) }, ['title', 'steps']) },
  // the flow
  { name: 'get_flow', description: 'Read the current flow (steps, arrows, instructions, tools, issues). The system prompt already has a fresh copy; use this after many edits.' },
  { name: 'load_template', description: 'Start from a ready sales template (replaces the open flow; the user must approve if it is not empty). Then adapt it.',
    parameters: OBJ({ template: S('template key: ' + TEMPLATE_INFO.map((t) => `${t.key} (${t.title})`).join(', ')), business: S('the business name to put in the texts') }, ['template']) },
  { name: 'new_flow', description: 'Create a new empty flow next to the existing ones and open it.', parameters: OBJ({ name: S('flow name, Hebrew'), business: S('business name') }, ['name']) },
  { name: 'set_flow_info', description: 'Rename the flow and/or the business (business renames also update the texts).', parameters: OBJ({ name: S('flow name'), business: S('business name') }) },
  { name: 'set_instructions', description: 'Set the flow-wide instructions sent to AIServant. Only the fields you pass change.',
    parameters: OBJ({
      personality: S('who the agent is and how it speaks (Hebrew)'),
      context: S('facts for the whole call: offer, prices, hours, address, policies (Hebrew). Off-script questions are answered from here'),
      goldenRules: S('hard rules, one per line (Hebrew)'),
      hotWords: S('comma-separated names/brands/terms for speech recognition'),
      values: T('ARRAY', 'placeholders used as {key} in texts', { items: OBJ({ key: S('snake_case'), value: S('value') }, ['key', 'value']) }),
    }) },
  { name: 'add_step', description: 'Add a step. Optionally connect an existing step to it in the same call (from + from_when).',
    parameters: OBJ(Object.assign({ id: S('unique snake_case English id, e.g. ask_budget'), kind: S('say | ask | action | end'), from: S('optional: id of an existing step whose arrow should lead here'), from_when: S('the arrow name on that step (option name, "answered", "unclear", "ok", "failed", or a say reaction like "ממשיך")') }, STEP_FIELDS), ['id', 'kind', 'goal', 'context']) },
  { name: 'update_step', description: 'Change fields of a step. options REPLACES the option list (arrows of options you keep by name stay connected).',
    parameters: OBJ(Object.assign({ id: S('the step id'), new_id: S('rename the id') }, STEP_FIELDS), ['id']) },
  { name: 'connect', description: 'Add or move an arrow: from step, on answer `when`, to step. ask: an option name (created if missing), "answered" or "unclear". action: "ok" or "failed". say: a short reaction like "ממשיך". end steps have no arrows.',
    parameters: OBJ({ from: S('step id'), when: S('arrow name'), to: S('step id'), examples: T('ARRAY', 'phrasings, when this creates a new option', { items: S('') }) }, ['from', 'when', 'to']) },
  { name: 'disconnect', description: 'Remove an arrow.', parameters: OBJ({ from: S('step id'), when: S('arrow name'), remove_option: T('BOOLEAN', 'ask only: also remove the option') }, ['from', 'when']) },
  { name: 'delete_step', description: 'Delete a step and its arrows. The user is asked to approve first.', parameters: OBJ({ id: S('step id'), reason: S('why, in Hebrew, shown to the user') }, ['id']) },
  { name: 'set_global_arrows', description: 'Replace the global arrows: requests that can come at any point (e.g. "רוצה נציג", "תסירו אותי").',
    parameters: OBJ({ arrows: T('ARRAY', 'global arrows', { items: OBJ({ when: S('the request, Hebrew'), to: S('step id') }, ['when', 'to']) }) }, ['arrows']) },
  { name: 'upsert_tool', description: 'Add or update a webhook tool (aiTools) an action step can call.',
    parameters: OBJ({ name: S('English snake_case'), description: S('what it does, English, for the model'), url: S('https URL (example.com placeholders work only for testing)'), timeout_ms: T('INTEGER', 'default 8000'),
      params: T('ARRAY', 'parameters the call fills in', { items: OBJ({ name: S('snake_case'), type: S('string | number | boolean'), description: S('what it is'), required: T('BOOLEAN', '') }, ['name']) }) }, ['name', 'description']) },
  { name: 'remove_tool', description: 'Remove a webhook tool. The user is asked to approve if a step uses it.', parameters: OBJ({ name: S('tool name') }, ['name']) },
  { name: 'validate', description: 'Run the AIServant checks. Fix every error before you finish.' },
  { name: 'tidy_layout', description: 'Re-arrange the diagram.' },
  // the screen: mouse and keyboard
  { name: 'read_screen', description: 'See what is on screen now: the page, an open window, and the clickable elements and fields with refs (r1, r2…). Refs change after every read.' },
  { name: 'navigate', description: 'Go to a page of the app by clicking the top bar: studio (the flow editor), agents, voices (the voice library: starters and reactions).', parameters: OBJ({ page: S('studio | agents | voices') }, ['page']) },
  { name: 'click', description: 'Move the mouse to an element from read_screen and click it. Clicking something that deletes or resets asks the user first.', parameters: OBJ({ ref: S('ref from read_screen'), why: S('short reason, Hebrew, shown to the user') }, ['ref']) },
  { name: 'type', description: 'Click a field from read_screen and type into it (replaces its text). For a select, pass the option text.', parameters: OBJ({ ref: S('ref from read_screen'), text: S('what to type'), submit: T('BOOLEAN', 'press Enter afterwards') }, ['ref', 'text']) },
  { name: 'open_step', description: 'Click a step on the diagram to open it in the side editor, so the user sees it.', parameters: OBJ({ id: S('step id') }, ['id']) },
  // calls
  { name: 'real_call', description: 'Place a REAL phone call with the open flow through AIServant (the phone rings). Only to a number the user typed in this chat; the user must approve. Fix all validation errors first.',
    parameters: OBJ({ to: S('the phone number the user gave'), lead_name: S('the name of the person called, if known'), hot_words: S('optional comma-separated words to add for this call') }, ['to']) },
  { name: 'get_call_result', description: 'Read a real call\'s live status, transcript, summary and where it went in the script (current_step, path, slots, tools, script_result, turns the decision model was unsure of), by callId. Calls take a while; check again later if still in progress.', parameters: OBJ({ call_id: S('callId from real_call') }, ['call_id']) },
  { name: 'check_balance', description: 'The account\'s remaining AI minutes on AIServant.' },
];

/* ---------- system prompt ---------- */
function systemPrompt() {
  const snap = snapshot();
  const sel = CF.sel && CF.sel.type === 'node' ? CF.node(CF.sel.id) : null;
  const others = CF.ws.flows.filter((f) => f.id !== CF.state.id).map((f) => f.name);
  const agents = (CF.ws.agents || []).map((a) => a.name);
  return `You are the builder agent of Call Flow Studio. You build phone-call scripts for AIServant, an AI phone agent that speaks Hebrew, and you use the app like a person: the user sees your mouse move, click and type, and every change appear on the diagram live.

Talk to the user in Hebrew: short, warm, practical. Don't narrate each tool call (the UI shows them); a sentence before a batch of work and a short summary after is enough.

HOW YOU WORK
1. Understand. If something you need is missing (what the business sells, who is called and why, the goal of the call, prices/offer, what happens on success), ask with ask_user. 1–2 questions at a time, with clickable options when possible. Don't ask what you can reasonably assume; say what you assumed.
2. Plan. Before building a new flow or any big change, call propose_plan and wait. If the user wants changes, adapt and propose again. Small edits the user explicitly asked for need no plan.
3. Build in call order: set_flow_info and set_instructions first, then steps from the first to the endings, connecting as you go (add_step with from/from_when), then global arrows, then validate. Mid-build "no outgoing arrow" / "unreachable" errors are expected; they must all be gone at the end.
4. Validate and fix every error. Warnings about starters matter too.
5. Finish with 2–4 lines: what was built. Then suggest additions with ask_user (e.g. objection handling, a WhatsApp summary, a callback path) as options, and offer a real test call.
6. Testing is a real call: ask the user for the phone number with ask_user, then real_call, and later get_call_result to read the transcript and the path; fix what broke.
If a ready template is a close fit, load_template and adapt it instead of building from scratch.

USING THE APP
- The flow tools (add_step, connect…) edit the open flow directly and the diagram updates; prefer them for building.
- For anything else in the app (agents, the voice library, export, opening panels) use navigate / read_screen / click / type, like a person. Always read_screen before click or type, and again after the page changes.
- Settings and the API key are off limits.
- Real calls cost the user money and ring a real phone: only via real_call, only to a number the user typed in this chat, and only when the user asked for it. After a real call, use get_call_result to read the transcript and suggest improvements.

THE SCRIPT FORMAT (AIServant instructionTree)
- Steps: say (the agent says something and continues; one arrow named by the expected reaction, e.g. "ממשיך"), ask (a question; named options as arrows, or free_answer with one "answered" arrow; optional "unclear" arrow), action (calls a tool; arrows "ok" and "failed"), end (closing line, no arrows).
- Every step: unique snake_case id, goal, context. The context says what the reply must convey; the reply model words it live. Put facts there, not scripts.
- starter: 1–3 words, played instantly when the call reaches the step, hiding the reply model's latency. It must fit every arrow that leads to the step: no "מעולה," after a refusal, a failure or a global arrow; no "אין בעיה," after a yes; after a failed action use "סליחה,"; don't put starters on two steps back to back after an action. Not a question.
- ask options: 2–4 distinct answers, each with 3–6 real Hebrew phrasings in examples. Reserved words can't be option names: answered, unclear, ok, failed, none.
- Questions with no arrow are answered from the flow context and the call stays on the step, so the context must hold the facts customers ask about.
- action tools: a tool from the flow's tools, or a callable built-in (${snap.builtinTools.join(', ')}). Calendar built-ins exist only when a calendar is connected. New webhooks: upsert_tool (real URLs come from the user; example.com placeholders fail in a real call).
- Global arrows catch requests at any point: "רוצה נציג", "תסירו אותי", "תתקשרו אחר כך". Their target steps' starters must fit that.
- Every step must be reachable from the start step or a global arrow. Exactly one start.

RULES
- Never invent facts about the business (prices, addresses, offers). Ask, or leave a clear placeholder value and tell the user.
- Deleting, resetting, loading a template over existing work and real calls need the user's approval: the app asks for you. If the user declines, adapt.

${others.length ? `Other flows: ${others.join(', ')}.\n` : ''}${agents.length ? `Agents: ${agents.join(', ')}.\n` : ''}${sel && sel.key ? `The user has selected step [${sel.key}] on the diagram; "this step" means it.\n` : ''}Current page: ${CF.ui.view === 'flows' ? 'studio' : CF.ui.view}.
THE OPEN FLOW NOW (fresh on every turn):
${JSON.stringify(snap)}`;
}
const request = () => ({ systemInstruction: { parts: [{ text: systemPrompt() }] }, contents: st.history, tools: [{ functionDeclarations: DECLS }] });

/* ---------- the model: streaming, function calling ---------- */
async function stream(model, onText, signal) {
  const url = `${PROVIDER_API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.brainKey.trim() },
    body: JSON.stringify(Object.assign(request(), { generationConfig: { temperature: 0.4, maxOutputTokens: 8192 } })),
  });
  if (!res.ok || !res.body) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j.error && j.error.message) msg = `${res.status}: ${j.error.message}`; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const parts = [];
  let text = '';
  let finish = '';
  let usage = null;
  const eat = (line) => {
    if (!line.startsWith('data:')) return;
    let j;
    try { j = JSON.parse(line.slice(5)); } catch (e) { return; }
    if (j.error) throw new Error(j.error.message || 'model error');
    if (j.usageMetadata) usage = j.usageMetadata;
    const cand = j.candidates && j.candidates[0];
    if (!cand) return;
    if (cand.finishReason) finish = cand.finishReason;
    for (const p of (cand.content && cand.content.parts) || []) {
      parts.push(p); // exactly as received (thought signatures included)
      if (typeof p.text === 'string' && !p.thought) { text += p.text; onText(text); }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); eat(line); }
  }
  if (buf.trim()) eat(buf.trim());
  return { parts, text, finish, usage };
}

function meter(run, model, usage) {
  if (!usage) return;
  const inTok = usage.promptTokenCount || 0;
  const outTok = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  const c = cost(model, inTok, outTok) || 0;
  run.calls++; run.inTok += inTok; run.outTok += outTok; run.cost += c;
  st.total.inTok += inTok; st.total.outTok += outTok; st.total.cost += c;
  Object.assign(ui, { cost: run.cost, tokens: run.inTok + run.outTok });
}

/* user turns are merged, so a turn never follows a turn of the same role */
function pushUser(parts) {
  const last = st.history[st.history.length - 1];
  if (last && last.role === 'user') last.parts = last.parts.concat(parts);
  else st.history.push({ role: 'user', parts });
}
/* keep the history bounded: cut at a plain user message, never between a call and its response */
function trim() {
  if (st.history.length <= 70) return;
  for (let i = st.history.length - 56; i < st.history.length; i++) {
    const c = st.history[i];
    if (c.role === 'user' && c.parts.every((p) => typeof p.text === 'string')) { st.history = st.history.slice(i); return; }
  }
}

/* ---------- the cost estimate, before a run ---------- */
export async function estimate(model, text) {
  let base;
  let counted = true;
  try { base = await countTokens(model, request()); } catch (e) { counted = false; base = Math.round(JSON.stringify(request()).length / 3.2); }
  const big = !CF.state.nodes.length || /בנה|תבנה|לבנות|צור|תיצור|חדש|מאפס|תסריט ל|build|create/i.test(text);
  const testing = /בדיקה|תבדוק|test|שיחה אמיתית|תתקשר|חייג/i.test(text);
  const turns = big ? [14, 38] : testing ? [8, 22] : [2, 10];
  const sum = (n, out) => { let i = 0; let o = 0; for (let k = 0; k < n; k++) { i += base + k * 750; o += out; } return { i, o }; };
  const lo = sum(turns[0], 300);
  const hi = sum(turns[1], 1400);
  const p = priceFor(model);
  return {
    model, base, counted, turns, price: p,
    tokens: [lo.i + lo.o, hi.i + hi.o],
    cost: p ? [cost(model, lo.i / turns[0], lo.o / turns[0]) * turns[0], cost(model, hi.i / turns[1], hi.o / turns[1]) * turns[1]] : null,
  };
}
export const models = () => listModels();

/* ---------- chat cards ---------- */
const OP_LABEL = {
  get_flow: 'קורא את התסריט', set_flow_info: 'שם התסריט והעסק', set_instructions: 'הוראות התסריט', add_step: 'צעד חדש', update_step: 'עדכון צעד',
  connect: 'חץ', disconnect: 'הסרת חץ', delete_step: 'מחיקת צעד', set_global_arrows: 'חצים גלובליים', upsert_tool: 'כלי', remove_tool: 'הסרת כלי',
  validate: 'בדיקת תקינות', tidy_layout: 'סידור הדיאגרמה', new_flow: 'תסריט חדש', load_template: 'תבנית',
  read_screen: 'מסתכל על המסך', navigate: 'מעבר עמוד', click: 'לחיצה', type: 'הקלדה', open_step: 'פותח צעד',
  real_call: 'שיחה אמיתית', get_call_result: 'תוצאות השיחה', check_balance: 'יתרת דקות',
};
const OP_ICON = { add_step: 'plus', update_step: 'edit', connect: 'link', disconnect: 'unlink', delete_step: 'trash', set_instructions: 'doc', set_global_arrows: 'globe', upsert_tool: 'bolt', remove_tool: 'bolt', validate: 'check', load_template: 'flow', new_flow: 'flow', set_flow_info: 'edit', get_flow: 'eye', tidy_layout: 'flow',
  read_screen: 'eye', navigate: 'arrowLeft', click: 'cursor', type: 'keyboard', open_step: 'eye', real_call: 'phone', get_call_result: 'doc', check_balance: 'database' };
const KIND_HE = { say: 'הודעה', ask: 'שאלה', action: 'פעולה', end: 'סיום' };

function opDetail(name, a, r) {
  switch (name) {
    case 'add_step': return `[${a.id}] ${KIND_HE[a.kind] || a.kind} · ${a.goal || ''}${a.starter ? ` · "${a.starter}"` : ''}`;
    case 'update_step': return `[${a.id}] ${Object.keys(a).filter((k) => k !== 'id').join(', ')}`;
    case 'connect': return `[${a.from}] —${a.when || ''}→ [${a.to}]`;
    case 'disconnect': return `[${a.from}] ✕ ${a.when || ''}`;
    case 'delete_step': case 'open_step': return `[${a.id}]`;
    case 'set_instructions': return Object.keys(a).join(', ');
    case 'set_global_arrows': return (a.arrows || []).map((g) => g.when).join(' · ');
    case 'upsert_tool': case 'remove_tool': return a.name;
    case 'set_flow_info': return [a.name, a.business].filter(Boolean).join(' · ');
    case 'validate': return r && r.ok ? (r.errors.length ? `${r.errors.length} שגיאות` : 'אין שגיאות') : '';
    case 'load_template': return a.template;
    case 'new_flow': return a.name;
    case 'navigate': return a.page;
    case 'click': return (r && r.clicked) || a.why || a.ref;
    case 'type': return `"${String(a.text || '').slice(0, 40)}"`;
    case 'real_call': return a.to;
    case 'get_call_result': return a.call_id;
    default: return '';
  }
}

function waitForUser(card) {
  if (CF.ui.view !== 'flows' && CF.ui.view !== 'agents') CF.navigate('studio');
  if (!CF.ui.chatOpen) chat.open();
  return new Promise((resolve) => {
    const msg = chat.add('card', card);
    st.pending = {
      msg,
      resolve: (answer) => {
        st.pending = null;
        card.answered = answer;
        touch();
        resolve(answer);
      },
    };
    ui.label = card.kind === 'ask' ? 'מחכה לתשובה שלך' : 'מחכה לאישור שלך';
    touch();
  });
}
/* called by the chat cards' buttons */
export function answer(value) {
  if (!st.pending) return;
  if (value && typeof value.text === 'string') st.userText += ' ' + value.text;
  st.pending.resolve(value);
}

/* ---------- approvals the client enforces, whatever the model says ---------- */
async function gate(name, a) {
  const f = CF.state;
  if ((name === 'add_step' || name === 'load_template') && !f.nodes.length && !st.planApproved.has(f.id)) {
    return { ok: false, error: 'This flow is empty: call propose_plan first and wait for the user to approve it.' };
  }
  let ask = null;
  if (name === 'delete_step') {
    const n = byKey(a.id);
    if (n) ask = { title: `למחוק את הצעד [${n.key}]?`, summary: (a.reason ? a.reason + '\n' : '') + `"${n.title}" והחצים שלו יימחקו.`, danger: true };
  }
  if (name === 'remove_tool') {
    const users = f.nodes.filter((n) => n.type === 'action' && n.tool === a.name).map((n) => n.key);
    if (users.length) ask = { title: `להסיר את הכלי ${a.name}?`, summary: `הצעדים ${users.map((k) => `[${k}]`).join(', ')} קוראים לו.`, danger: true };
  }
  if (name === 'load_template' && f.nodes.length) ask = { title: 'להחליף את התסריט הפתוח בתבנית?', summary: `"${f.name}" (${f.nodes.length} צעדים) יוחלף בתבנית ${a.template}. אפשר לבטל עם "בטל".`, danger: true };
  if (name === 'click') {
    const d = pc.describeRef(a.ref);
    if (d && d.destructive) ask = { title: `ללחוץ על "${d.label}"?`, summary: (a.why ? a.why + '\n' : '') + 'זו פעולה שמוחקת או מאפסת משהו.', danger: true };
  }
  if (name === 'real_call') {
    const to = digits(a.to);
    if (to.length < 9 || !digits(st.userText).includes(to)) return { ok: false, error: 'You may only call a number the user typed in this chat. Ask the user for the number with ask_user.' };
    const errs = validate(f).filter((i) => i.level === 'error');
    if (errs.length) return { ok: false, error: `The flow has ${errs.length} errors AIServant would reject. Fix them first: ` + errs.slice(0, 5).map((e) => e.msg).join(' | ') };
    let bal = '';
    try { const r = await fetch('./local-api/balance'); const j = await r.json(); bal = j.error ? '' : JSON.stringify(j).slice(0, 120); } catch (e) { /* no local server */ }
    ask = {
      title: `לחייג עכשיו ל-${a.to}?`, danger: true, call: true,
      summary: `שיחה אמיתית עם התסריט "${f.name}". הטלפון במספר הזה יצלצל, והשיחה יורדת מהדקות של החשבון ב-AIServant.` + (a.lead_name ? `\nשם הליד: ${a.lead_name}` : ''),
      balance: bal,
    };
  }
  if (!ask) return null;
  const r = await waitForUser(Object.assign({ kind: 'approve' }, ask));
  if (r && r.cancelled) return { ok: false, cancelled: true };
  if (r && r.approved) return null;
  return { ok: false, rejected: true, feedback: (r && r.feedback) || 'the user declined' };
}

/* ---------- real calls through AIServant (approved in gate) ---------- */
async function realCall(a) {
  const before = (CF.lastDial && CF.lastDial.at) || 0;
  CF.openExport('call');
  await W(600);
  const dial = document.querySelector('.modal .dial');
  if (!dial) return { ok: false, error: 'the dial panel did not open' };
  await pc.typeInto(dial.querySelector('input[inputmode=tel]'), digits(a.to));
  if (a.lead_name) await pc.typeInto(dial.querySelectorAll('.dial-row input')[1], String(a.lead_name));
  if (a.hot_words) await pc.typeInto(dial.querySelector('textarea'), String(a.hot_words), { append: true });
  const btn = dial.querySelector('.dial-btn');
  if (!btn || btn.disabled) return { ok: false, error: 'the dial button is disabled (fix validation errors)' };
  await pc.clickEl(btn); // arm
  await W(250);
  await pc.clickEl(btn); // dial
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !(CF.lastDial && CF.lastDial.at > before)) await CF.wait(200);
  const r = CF.lastDial && CF.lastDial.at > before ? CF.lastDial : null;
  await W(1200);
  if (!r) return { ok: false, error: 'no answer from the call server within 20s' };
  return { ok: r.ok, status: r.status, call_id: r.json && r.json.callId, message: r.ok ? 'the call was placed; the phone is ringing' : r.message };
}
async function callResult(id) {
  // the live record (server/live-calls.js) has the status, transcript and the script's steps, slots and tools
  try {
    const lr = await fetch('./local-api/live/' + encodeURIComponent(String(id || '').trim()));
    if (lr.ok) {
      const d = await lr.json();
      const lowTurns = (d.moves || []).filter((m) => m.Likelihood != null && m.Likelihood < 0.6).map((m) => ({ step: m.From, pick: m.Pick, likelihood: m.Likelihood }));
      return { ok: true, result: {
        status: d.info && d.info.status, end_reason: d.info && d.info.endReason, duration_s: d.info && d.info.duration, answered: d.info && d.info.answered,
        live: !!d.watching, current_step: d.step || null, path: d.path || [], slots: d.slots || {}, tools: d.tools || [],
        script_result: d.result || null, unsure_turns: lowTurns.slice(-10), turns_read: (d.moves || []).length,
        summary: (d.reports || []).map((x) => x.report).filter(Boolean).slice(-1)[0] || null,
        transcript: (d.transcripts || []).slice(-60).map((t) => (t.speaker === 'customer' ? 'customer: ' : 'agent: ') + t.text),
        note: d.moves && d.moves.length ? undefined : 'no script_moved events were received for this call (listen socket state: ' + ((d.socket && d.socket.state) || 'unknown') + ')',
      } };
    }
  } catch (e) { /* fall back to the plain call record */ }
  try {
    const r = await fetch('./local-api/call/' + encodeURIComponent(String(id || '').trim()));
    const t = await r.text();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${t.slice(0, 300)}` };
    return { ok: true, result: t.length > 9000 ? t.slice(0, 9000) + '…(truncated)' : JSON.parse(t) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/* ---------- running one tool call ---------- */
async function execute(fc, run) {
  const name = fc.name;
  const a = fc.args || {};
  if (name === 'ask_user') {
    const r = await waitForUser({ kind: 'ask', question: String(a.question || ''), options: (a.options || []).map(String).slice(0, 6) });
    return r && r.cancelled ? { cancelled: true } : { answer: r.text };
  }
  if (name === 'propose_plan') {
    const r = await waitForUser({ kind: 'approve', plan: true, title: String(a.title || 'התוכנית'), summary: String(a.summary || ''), steps: (a.steps || []).map(String) });
    if (r && r.cancelled) return { cancelled: true };
    if (r && r.approved) { st.planApproved.add(CF.state.id); return { approved: true, note: r.feedback || undefined }; }
    return { approved: false, feedback: (r && r.feedback) || 'not approved' };
  }

  const blocked = await gate(name, a);
  if (blocked) {
    chat.add('card', { kind: 'op', icon: OP_ICON[name] || 'bolt', label: OP_LABEL[name] || name, detail: opDetail(name, a), status: blocked.rejected ? 'rejected' : 'err', note: blocked.feedback || (blocked.cancelled ? 'בוטל' : blocked.error) });
    return blocked;
  }
  if (run.stopped) return { cancelled: true };

  const card = { kind: 'op', icon: OP_ICON[name] || 'bolt', label: OP_LABEL[name] || name, detail: opDetail(name, a), status: 'run' };
  chat.add('card', card);
  run.ops++;
  Object.assign(ui, { ops: run.ops, label: card.label });
  touch();

  let r;
  try {
    switch (name) {
      case 'load_template': {
        const make = CF.templates[a.template];
        if (!make) { r = { ok: false, error: 'unknown template; use one of ' + TEMPLATE_INFO.map((t) => t.key).join(', ') }; break; }
        const flow = make();
        if (a.business) CF.renameBusiness(flow, String(a.business));
        await C.buildAnimated(flow);
        st.planApproved.add(CF.state.id);
        r = Object.assign({ ok: true }, snapshot());
        break;
      }
      case 'read_screen': r = pc.readScreen(); break;
      case 'navigate': r = await pc.navigate(String(a.page || '')); break;
      case 'click': r = await pc.click(String(a.ref || '')); break;
      case 'type': r = await pc.type(String(a.ref || ''), String(a.text || ''), !!a.submit); break;
      case 'open_step': {
        const n = byKey(a.id);
        if (!n) { r = { ok: false, error: `no step "${a.id}"` }; break; }
        if (CF.ui.view !== 'flows') await pc.navigate('studio');
        C.focus(n.id);
        await W(450);
        const el = C.nodeEls.get(n.id);
        if (el) { await pc.moveTo(el); CF.select({ type: 'node', id: n.id }); }
        r = { ok: true };
        break;
      }
      case 'real_call': r = await realCall(a); break;
      case 'get_call_result': r = await callResult(a.call_id); break;
      case 'check_balance': {
        try { const x = await fetch('./local-api/balance'); r = Object.assign({ ok: x.ok }, await x.json()); } catch (e) { r = { ok: false, error: 'no local server' }; }
        break;
      }
      default: r = runOp(name, a);
    }
  } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (name === 'new_flow' && r.ok) run.flowId = CF.state.id;
  if (name === 'click' && r.ok) run.flowId = CF.state.id; // the user's UI may open another flow

  card.status = r.ok ? 'ok' : 'err';
  if (!r.ok) card.note = r.error;
  else card.detail = opDetail(name, a, r) || card.detail;
  if (name === 'real_call' && r.ok) card.note = 'callId ' + (r.call_id || '—');
  touch();

  // flow edits: re-layout, then the mouse goes to what changed
  if (r.ok && !READ_ONLY.has(name) && OPS_FLOW.has(name)) {
    CF.layout();
    C.glide();
    CF.commit({ structural: true });
    const id = focusOf(name, a, r);
    C.agentFocus = id;
    C.render();
    if (id) {
      C.focus(id);
      await W(420);
      const el = C.nodeEls.get(id);
      if (el) await pc.moveTo(el);
    } else await W(200);
  }
  return r;
}
const OPS_FLOW = new Set(['set_flow_info', 'set_instructions', 'add_step', 'update_step', 'connect', 'disconnect', 'delete_step', 'set_global_arrows', 'upsert_tool', 'remove_tool', 'tidy_layout', 'new_flow']);

/* ---------- the loop ---------- */
async function loop(run) {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (run.stopped) return;
    trim();
    ui.label = 'המוח המהיר חושב…';
    touch();
    const stopTyping = chat.typing('מוח מהיר');
    let bubble = null;
    let res;
    try {
      res = await stream(run.model, (text) => {
        if (!bubble) { stopTyping(); bubble = chat.add('bot', '', VIA); }
        bubble.text = text;
        touch();
      }, run.abort.signal);
    } finally { stopTyping(); }
    meter(run, run.model, res.usage);
    touch();
    st.history.push({ role: 'model', parts: res.parts.length ? res.parts : [{ text: '' }] });
    const calls = res.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      if (!res.text.trim()) chat.add('bot', res.finish && res.finish !== 'STOP' ? `המוח המהיר עצר בלי תשובה (${res.finish}).` : 'סיימתי.', VIA);
      return;
    }
    // every call in the turn gets a response, in order, in one turn, even when stopped or rejected
    const responses = [];
    for (const fc of calls) {
      let out;
      if (run.stopped || CF.state.id !== run.flowId) { out = { cancelled: true, reason: run.stopped ? 'the user stopped you' : 'the user switched to another flow' }; run.stopped = true; }
      else out = await execute(fc, run);
      const fr = { name: fc.name, response: out };
      if (fc.id) fr.id = fc.id;
      responses.push({ functionResponse: fr });
    }
    pushUser(responses);
    if (run.stopped) return;
  }
  chat.add('bot', `עצרתי אחרי ${MAX_TURNS} סבבים כדי לא לרוץ בלי סוף. כתבו "המשך" כדי שאמשיך מאותה נקודה.`, VIA);
}

export async function handle(text) {
  const t = String(text || '').trim();
  if (!t) return;
  // an open question or approval card: typed text answers it
  if (st.pending) {
    chat.add('user', t);
    st.userText += ' ' + t;
    const card = st.pending.msg.card;
    st.pending.resolve(card.kind === 'ask' ? { text: t } : card.kind === 'preflight' ? { approved: /^(כן|הפעל|יאללה|ok|אוקיי|קדימה)/i.test(t) } : { approved: /^(כן|מאשר|מאשרת|אשר|יאללה|סבבה|ok|אוקיי|בסדר|קדימה)/i.test(t), feedback: t });
    return;
  }
  if (st.run) stop('new message');
  chat.add('user', t);
  st.userText += ' ' + t;
  if (CF.ui.view !== 'flows') { CF.navigate('studio'); await C.ready(); }
  chat.setChips([]);
  pushUser([{ text: t }]);

  // the price, before anything runs
  let model = builderModel();
  const est = await estimate(model, t).catch(() => null);
  const auto = Number(settings.brainAutoUnder) || 0;
  if (!(est && est.cost && auto && est.cost[1] <= auto)) {
    const ok = await waitForUser({ kind: 'preflight', text: t, model, est });
    if (!ok || !ok.approved) {
      // the request never ran: take it back out of the history
      const last = st.history[st.history.length - 1];
      if (last && last.role === 'user') { last.parts = last.parts.filter((p) => p.text !== t); if (!last.parts.length) st.history.pop(); }
      chat.add('sys', 'לא הופעל. שום דבר לא נשלח למוח המהיר.');
      return;
    }
    model = ok.model || model;
    if (ok.model && ok.model !== settings.brainModel) saveSettings({ brainModel: ok.model });
    if (ok.auto != null) saveSettings({ brainAutoUnder: ok.auto });
  } else chat.add('sys', `ההערכה (\u2066${usd(est.cost[0])}–${usd(est.cost[1])}\u2069, \u2066${model}\u2069) מתחת לסף שאישרת, אז מתחיל.`);

  const run = { flowId: CF.state.id, model, abort: new AbortController(), stopped: false, ops: 0, calls: 0, inTok: 0, outTok: 0, cost: 0 };
  st.run = run;
  CF.checkpoint(); // one undo reverts the whole run's flow edits
  Object.assign(ui, { busy: true, label: 'המוח המהיר חושב…', ops: 0, cost: 0, tokens: 0, model });
  pc.showCursor(true);
  touch();
  try {
    await loop(run);
  } catch (e) {
    if (!run.stopped) {
      const m = String((e && e.message) || e);
      chat.add('bot', 'המוח המהיר החזיר שגיאה: ' + m + (/API key|401|403|PERMISSION/i.test(m) ? '\nבדקו את המפתח בהגדרות.' : /not found|404/i.test(m) ? `\nהמודל "${model}" לא זמין למפתח הזה. בחרו מודל אחר.` : /429|quota|RESOURCE_EXHAUSTED/i.test(m) ? '\nנגמרה המכסה או שיש יותר מדי בקשות. נסו שוב עוד רגע.' : ''));
    }
  } finally {
    if (st.run === run) st.run = null;
    C.agentFocus = null;
    C.render();
    if (run.ops && CF.ui.view === 'flows' && CF.state.nodes.length) C.fit(true);
    pc.showCursor(false);
    Object.assign(ui, { busy: false, label: '' });
    if (run.calls) chat.add('card', { kind: 'cost', model, calls: run.calls, inTok: run.inTok, outTok: run.outTok, cost: run.cost, total: st.total.cost, priced: !!priceFor(model) });
    if (run.ops) chat.setChips([{ label: `בטל את השינויים של הסבב`, run: () => { CF.undo(); CF.toast('בוטל'); } }, 'שיחת בדיקה אמיתית']);
    touch();
  }
}

export function stop(why) {
  const run = st.run;
  if (!run) return;
  run.stopped = true;
  try { run.abort.abort(); } catch (e) { /* done */ }
  if (st.pending) st.pending.resolve({ cancelled: true });
  if (why !== 'new message') chat.add('sys', 'עצרת את המוח המהיר. מה שכבר נבנה נשאר.');
  touch();
}

export function reset() {
  stop('reset');
  st.history = [];
  st.planApproved.clear();
  chat.clear();
  chat.add('bot', 'התחלנו שיחה חדשה. ספרו לי מה לבנות.', VIA);
}

const builder = { handle, stop, answer, reset, on: builderOn, model: builderModel, estimate, models, state: st, total: st.total };
CF.builder = builder;
export default builder;
