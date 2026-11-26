/* Everything the builder agent can do to the app, in the AIServant vocabulary (step ids, kinds, arrows).
   Each op changes CF.state through the same functions the editor uses, and returns { ok, ... } or
   { ok: false, error } so the model can correct itself. Ops never ask for approval: the loop (builder.js)
   decides which ones need the user's OK before they run. */
import CF from './core.js';
import { buildTree, validate } from './script.js';

const KIND_OF = { start: 'say', say: 'say', ask: 'ask', action: 'action', end: 'end' };
const ID = /^[a-z][a-z0-9_]{0,31}$/;
const str = (v) => (v == null ? '' : String(v)).trim();
const byKey = (key, f = CF.state) => f.nodes.find((n) => n.key === str(key) && KIND_OF[n.type]);
const fail = (error) => ({ ok: false, error });

function startNode(f = CF.state) {
  return (f.startId && f.nodes.find((n) => n.id === f.startId)) || f.nodes.find((n) => n.type === 'start') || null;
}

/* one step as the model sees it */
export function stepView(n, f = CF.state) {
  const kind = KIND_OF[n.type];
  const s = { id: n.key, kind, goal: n.title || '', context: n.text || '' };
  if (n.starter) s.starter = n.starter;
  if (kind === 'ask') {
    s.slot = n.slot;
    if (n.mode === 'free') s.free_answer = true;
    else s.options = (n.options || []).map((o) => ({ when: o.label, examples: o.examples || [] }));
    if (n.fallback) s.unclear = true;
  }
  if (kind === 'action') s.tool = n.tool;
  if (n.maxVisits) s.max_visits = n.maxVisits;
  if (startNode(f) === n) s.start = true;
  const t = buildTree(f).nodes.find((x) => x.id === n.key);
  s.arrows = t ? t.arrows || [] : [];
  return s;
}

/* the whole flow, compact, for the system prompt and get_flow */
export function snapshot(f = CF.state) {
  const ins = f.instructions || {};
  const list = validate(f);
  return {
    flow: { name: f.name, business: f.business },
    instructions: { personality: ins.personality || '', context: ins.context || '', goldenRules: ins.goldenRules || '', hotWords: ins.hotWords || '', values: (ins.values || []).map((v) => ({ key: v.key, value: v.value })) },
    start: (startNode(f) || {}).key || null,
    steps: f.nodes.filter((n) => KIND_OF[n.type]).map((n) => stepView(n, f)),
    globalArrows: (f.globalArrows || []).map((g) => ({ when: g.when, to: (f.nodes.find((n) => n.id === g.to) || {}).key || null })),
    tools: CF.tools(f).map((t) => ({ name: t.name, description: t.description, url: t.url, params: (t.params || []).map((p) => p.name) })),
    builtinTools: CF.callableBuiltins().filter((t) => ['end_call', 'transfer_call', 'get_current_time', 'check_availability', 'book_meeting', 'cancel_booking'].includes(t)),
    issues: list.slice(0, 25).map((i) => `${i.level}: ${i.msg}`),
    errors: list.filter((i) => i.level === 'error').length,
  };
}

/* issues for the steps an op touched, so the model sees what to fix next */
function report(keys, extra) {
  const list = validate(CF.state);
  const mine = list.filter((i) => !i.key || keys.includes(i.key)).slice(0, 8).map((i) => `${i.level}: ${i.msg}`);
  return Object.assign({ ok: true, issues: mine, errors_total: list.filter((i) => i.level === 'error').length }, extra || {});
}

function setOptions(n, options) {
  const want = (options || []).map((o) => (typeof o === 'string' ? { when: o } : o)).filter((o) => str(o.when));
  for (const o of want) {
    if (CF.RESERVED.includes(str(o.when))) return `"${o.when}" is a reserved word and cannot be an option`;
  }
  const keep = [];
  for (const o of want) {
    const ex = (Array.isArray(o.examples) ? o.examples : str(o.examples).split('|')).map(str).filter(Boolean);
    const old = n.options.find((x) => x.label === str(o.when));
    if (old) { if (ex.length) old.examples = ex; keep.push(old); } else keep.push(CF.opt(str(o.when), (ex.length ? ex : [str(o.when)]).join('|')));
  }
  const ids = new Set(keep.map((o) => o.id));
  n.options.filter((o) => !ids.has(o.id)).forEach((o) => CF.removeOption(n.id, o.id));
  n.options = keep;
  return null;
}

function fillStep(n, a) {
  if (a.goal != null) n.title = str(a.goal);
  if (a.context != null) n.text = str(a.context);
  if (a.starter != null) n.starter = str(a.starter);
  if (a.max_visits != null) n.maxVisits = Number(a.max_visits) > 0 ? Math.round(Number(a.max_visits)) : null;
  if (n.type === 'ask') {
    if (a.slot != null && str(a.slot)) n.slot = CF.uniqueSlot(CF.slug(a.slot), CF.state, n.id);
    if (a.free_answer === true) CF.setMode(n, 'free');
    if (a.options) {
      if (n.mode === 'free' && a.free_answer !== true) CF.setMode(n, 'options');
      const e = setOptions(n, a.options);
      if (e) return e;
    }
    if (a.free_answer === false && n.mode === 'free') CF.setMode(n, 'options');
    if (a.unclear != null) CF.setFallback(n, !!a.unclear);
  }
  if (n.type === 'action' && a.tool != null) {
    const t = str(a.tool);
    if (!CF.toolExists(CF.state, t)) return `tool "${t}" does not exist. Add it with upsert_tool first, or use one of: ${CF.tools(CF.state).map((x) => x.name).concat(CF.callableBuiltins()).join(', ')}`;
    n.tool = t;
    n.action = CF.actionOfTool(t) || (t === 'transfer_call' ? 'transfer' : 'crm');
  }
  return null;
}

function makeStart(n) {
  const f = CF.state;
  f.nodes.forEach((x) => { if (x !== n && x.type === 'start') x.type = 'say'; });
  if (n.type === 'say') n.type = 'start';
  f.startId = n.id;
}

/* ---------- ops ---------- */
const OPS = {
  get_flow: () => Object.assign({ ok: true }, snapshot()),

  set_flow_info(a) {
    if (a.name != null && str(a.name)) CF.state.name = str(a.name);
    if (a.business != null && str(a.business)) CF.renameBusiness(CF.state, str(a.business));
    CF.syncActive();
    CF.emit('flows');
    return { ok: true, flow: { name: CF.state.name, business: CF.state.business } };
  },

  set_instructions(a) {
    const ins = CF.state.instructions;
    ['personality', 'context', 'goldenRules', 'hotWords'].forEach((k) => { if (a[k] != null) ins[k] = String(a[k]).trim(); });
    if (Array.isArray(a.values)) ins.values = a.values.filter((v) => v && str(v.key)).map((v) => ({ key: CF.slug(v.key) || str(v.key), value: str(v.value) }));
    ins.mode = 'tree';
    return report([], { instructions: { personality: ins.personality, context: ins.context.slice(0, 200), goldenRules: ins.goldenRules.slice(0, 200), hotWords: ins.hotWords, values: ins.values } });
  },

  add_step(a) {
    const kind = str(a.kind);
    const type = { say: 'say', ask: 'ask', action: 'action', end: 'end' }[kind];
    if (!type) return fail('kind must be say, ask, action or end');
    const key = CF.slug(a.id);
    if (!ID.test(key)) return fail('id must be short snake_case English, starting with a letter (e.g. ask_budget)');
    if (byKey(key)) return fail(`a step with id "${key}" already exists. Use update_step, or another id`);
    if (!str(a.goal)) return fail('goal is required');
    if (!str(a.context)) return fail('context is required: what the reply at this step must convey');
    if (type === 'action' && !str(a.tool)) return fail('an action step needs a tool');
    if (type === 'ask' && !a.free_answer && !(a.options && a.options.length)) return fail('an ask step needs options (named answers) or free_answer: true');
    const n = CF.makeNode(type, { key, title: str(a.goal), text: str(a.context), starter: '' });
    if (type === 'ask') { n.options = []; n.slot = CF.uniqueSlot(CF.slug(a.slot || key.replace(/^ask_/, '')) || key, CF.state, n.id); }
    CF.state.nodes.push(n);
    const err = fillStep(n, Object.assign({}, a, { slot: type === 'ask' ? (a.slot || null) : null }));
    if (err) { CF.removeNode(n.id); return fail(err); }
    const isFirst = !startNode();
    if (a.start || (isFirst && type === 'say')) makeStart(n);
    else if (isFirst) CF.state.startId = n.id;
    let link = null;
    if (a.from) {
      link = OPS.connect({ from: a.from, when: a.from_when || a.when_from || '', to: key }, true);
      if (!link.ok) return Object.assign(report([key], { step: stepView(n), nodeId: n.id }), { warning: 'step added, but the arrow from ' + a.from + ' failed: ' + link.error });
    }
    return report([key, str(a.from)].filter(Boolean), { step: stepView(n), nodeId: n.id });
  },

  update_step(a) {
    const n = byKey(a.id);
    if (!n) return fail(`no step "${a.id}"`);
    if (a.new_id != null && str(a.new_id) && CF.slug(a.new_id) !== n.key) {
      const nk = CF.slug(a.new_id);
      if (!ID.test(nk)) return fail('new_id must be short snake_case English');
      if (byKey(nk)) return fail(`id "${nk}" is taken`);
      n.key = nk;
    }
    const err = fillStep(n, a);
    if (err) return fail(err);
    if (a.start === true) makeStart(n);
    return report([n.key], { step: stepView(n), nodeId: n.id });
  },

  connect(a, quiet) {
    const from = byKey(a.from);
    const to = byKey(a.to);
    if (!from) return fail(`no step "${a.from}"`);
    if (!to) return fail(`no step "${a.to}"`);
    const when = str(a.when);
    let port = null;
    if (from.type === 'end') return fail('an end step has no arrows');
    if (from.type === 'start' || from.type === 'say') {
      if (CF.RESERVED.includes(when)) return fail(`"${when}" is reserved; a say step's arrow is a short reaction like "ממשיך"`);
      if (when) from.when = when;
      port = 'out';
    } else if (from.type === 'action') {
      if (when === 'ok' || when === '' ) port = 'out';
      else if (when === 'failed') port = 'failed';
      else return fail('an action step has only "ok" and "failed" arrows');
    } else if (from.type === 'ask') {
      if (when === 'answered') { if (from.mode !== 'free') CF.setMode(from, 'free'); port = 'answered'; }
      else if (when === 'unclear') { CF.setFallback(from, true); port = 'fallback'; }
      else {
        if (!when) return fail('when is required for an ask step: the option name, "answered" or "unclear"');
        if (CF.RESERVED.includes(when)) return fail(`"${when}" is reserved`);
        if (from.mode === 'free') return fail(`[${from.key}] takes a free answer ("answered"). To use named options, call update_step with options first`);
        let o = from.options.find((x) => x.label === when);
        if (!o) { o = CF.opt(when, (a.examples && a.examples.length ? a.examples : [when]).join('|')); from.options.push(o); }
        port = o.id;
      }
    }
    if (from.id === to.id) {
      // a step may loop to itself (e.g. "unclear" → ask again); the editor's connect refuses that, so add it here
      CF.state.edges = CF.state.edges.filter((e) => !(e.from === from.id && e.port === port));
      CF.state.edges.push({ id: CF.uid('e'), from: from.id, port, to: to.id });
    } else CF.connect(from.id, port, to.id);
    if (quiet) return { ok: true };
    return report([from.key, to.key], { arrow: { from: from.key, when: when || (from.type === 'action' ? 'ok' : from.when), to: to.key }, nodeId: to.id, fromId: from.id });
  },

  disconnect(a) {
    const from = byKey(a.from);
    if (!from) return fail(`no step "${a.from}"`);
    const when = str(a.when);
    let port = 'out';
    if (from.type === 'ask') port = when === 'answered' ? 'answered' : when === 'unclear' ? 'fallback' : ((from.options.find((o) => o.label === when) || {}).id || null);
    if (from.type === 'action') port = when === 'failed' ? 'failed' : 'out';
    const e = port && CF.outEdge(from.id, port);
    if (!e) return fail(`[${from.key}] has no arrow "${when}"`);
    CF.removeEdge(e.id);
    if (from.type === 'ask' && a.remove_option && port !== 'answered' && port !== 'fallback') CF.removeOption(from.id, port);
    if (from.type === 'ask' && port === 'fallback') CF.setFallback(from, false);
    return report([from.key], { nodeId: from.id });
  },

  delete_step(a) {
    const n = byKey(a.id);
    if (!n) return fail(`no step "${a.id}"`);
    const wasStart = startNode() === n;
    CF.removeNode(n.id);
    if (wasStart) CF.state.startId = null;
    return report([], { deleted: a.id, warning: wasStart ? 'that was the start step: mark another step with start: true' : undefined });
  },

  set_global_arrows(a) {
    const list = Array.isArray(a.arrows) ? a.arrows : [];
    const out = [];
    for (const g of list) {
      if (!str(g.when)) continue;
      const t = byKey(g.to);
      if (!t) return fail(`global arrow "${g.when}": no step "${g.to}"`);
      out.push({ id: CF.uid('g'), when: str(g.when), examples: [], to: t.id });
    }
    CF.state.globalArrows = out;
    return report([], { globalArrows: out.map((g) => ({ when: g.when, to: byKey(list.find((x) => str(x.when) === g.when).to).key })) });
  },

  upsert_tool(a) {
    const name = str(a.name);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) return fail('tool name: English letters, digits and _, starting with a letter');
    if (CF.BUILTIN_TOOLS.includes(name)) return fail(`${name} is a dialer built-in; an action step can call it directly (if callable on this account) without adding it`);
    const list = CF.tools(CF.state);
    let t = list.find((x) => x.name === name);
    if (!t) { t = { name, description: '', url: '', timeoutMs: 8000, shouldInvokeAnswer: true, params: [] }; list.push(t); }
    if (a.description != null) t.description = str(a.description);
    if (a.url != null) t.url = str(a.url);
    if (a.timeout_ms != null) t.timeoutMs = Number(a.timeout_ms) || 8000;
    if (Array.isArray(a.params)) t.params = a.params.filter((p) => p && str(p.name)).map((p) => ({ name: str(p.name), type: ['string', 'number', 'boolean'].includes(p.type) ? p.type : 'string', description: str(p.description), required: p.required !== false }));
    return report([], { tool: { name: t.name, description: t.description, url: t.url, params: t.params.map((p) => p.name) } });
  },

  remove_tool(a) {
    const name = str(a.name);
    const list = CF.tools(CF.state);
    if (!list.some((t) => t.name === name)) return fail(`no tool "${name}"`);
    CF.state.aiTools = list.filter((t) => t.name !== name);
    return report([], { removed: name });
  },

  validate: () => {
    const list = validate(CF.state);
    return { ok: true, errors: list.filter((i) => i.level === 'error').map((i) => i.msg), warnings: list.filter((i) => i.level === 'warn').map((i) => i.msg).slice(0, 15) };
  },

  new_flow(a) {
    const f = CF.newFlow(str(a.name) || 'תסריט חדש');
    f.nodes = [];
    f.edges = [];
    if (str(a.business)) f.business = str(a.business);
    return { ok: true, flow: { name: f.name, business: f.business }, flowId: f.id };
  },

  tidy_layout: () => ({ ok: true }),
};

/* which steps an op is about, for the canvas highlight */
export function focusOf(name, args, res) {
  if (!res || !res.ok) return null;
  if (res.nodeId) return res.nodeId;
  const n = args && (args.id || args.to || args.from) && byKey(args.id || args.to || args.from);
  return n ? n.id : null;
}

/* ops that only read */
export const READ_ONLY = new Set(['get_flow', 'validate']);

export function runOp(name, args) {
  const op = OPS[name];
  if (!op) return fail(`unknown tool ${name}`);
  try { return op(args || {}); } catch (e) { return fail(String((e && e.message) || e)); }
}

export { byKey, startNode };
CF.agentOps = { runOp, snapshot, stepView, byKey, buildTree, validate };
