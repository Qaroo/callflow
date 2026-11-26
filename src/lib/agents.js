/* Agents: who talks on the phone. An agent runs one flow (script), with a Cartesia voice and a personality.
   What reaches a call (script.js → buildMakeCall): the flow, cartesiaSettings { voice, voiceGender }, and the
   personality written out as text (when the flow's own `personality` instruction is empty). */
import CF from './core.js';

const AG = {};
CF.agents = AG;
export default AG;

AG.PRESETS = {
  pro:   { label: 'מקצועי', formal: 75, concise: 65, energy: 40, traits: ['ענייני', 'אמין'] },
  warm:  { label: 'חם', formal: 35, concise: 45, energy: 55, traits: ['אמפתי', 'סבלני'] },
  sales: { label: 'מכירתי', formal: 40, concise: 60, energy: 80, traits: ['משכנע', 'אנרגטי'] },
  calm:  { label: 'רגוע', formal: 55, concise: 50, energy: 25, traits: ['סבלני', 'מרגיע'] },
};
AG.TRAITS = ['אמפתי', 'ישיר', 'סבלני', 'משכנע', 'ענייני', 'אנרגטי', 'הומור קל', 'מרגיע', 'אמין'];
const COLORS = ['#5856D6', '#007AFF', '#AF52DE', '#FF9500', '#34C759', '#30B0C7', '#FF2D55'];
AG.REQS = [
  { key: 'flow', label: 'תסריט שיחה', icon: 'flow' },
  { key: 'voice', label: 'קול', icon: 'wave' },
  { key: 'persona', label: 'אישיות', icon: 'sliders' },
];

AG.list = () => CF.ws.agents;
AG.get = (id) => CF.ws.agents.find((a) => a.id === id);
AG.forFlow = (flowId) => CF.ws.agents.find((a) => a.flowId === flowId) || null;
/* the Cartesia voice a call with this agent uses: its own, or the default from Settings */
AG.voiceOf = (a) => ((a && a.cartesiaVoiceId) || (CF.settings && CF.settings.voiceId) || '').trim();

AG.current = null;
AG.confirmDel = null;

const persist = () => { CF.save(); CF.emit('agents'); };
AG.persist = persist;

AG.create = (over) => {
  const n = CF.ws.agents.length;
  const a = Object.assign({
    id: CF.uid('a'),
    name: 'סוכן חדש',
    role: '',
    color: COLORS[n % COLORS.length],
    flowId: null,
    cartesiaVoiceId: '',    // the call voice (makecall cartesiaSettings.voice); empty = the Settings default, then the server's
    voiceGender: '',        // 'female' | 'male'
    personality: { preset: null, formal: 50, concise: 50, energy: 50, traits: [], prompt: '' },
    createdAt: Date.now(),
  }, over || {});
  CF.ws.agents.push(a);
  persist();
  return a;
};
AG.remove = (id) => { CF.ws.agents = CF.ws.agents.filter((a) => a.id !== id); if (AG.current === id) AG.current = null; persist(); };
AG.duplicate = (id) => {
  const src = AG.get(id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = CF.uid('a');
  copy.name = src.name + ' (עותק)';
  copy.createdAt = Date.now();
  CF.ws.agents.push(copy);
  persist();
  return copy;
};
AG.applyPreset = (a, key) => {
  const p = AG.PRESETS[key];
  if (!p) return;
  Object.assign(a.personality, { preset: key, formal: p.formal, concise: p.concise, energy: p.energy, traits: p.traits.slice() });
};

AG.checks = (a) => {
  const f = a.flowId && CF.flowById(a.flowId);
  const p = a.personality || {};
  return {
    flow: !!(f && f.nodes.length),
    voice: !!AG.voiceOf(a),
    persona: !!(p.preset || (p.traits && p.traits.length) || (p.prompt && p.prompt.trim().length >= 10)),
  };
};
AG.missing = (a) => {
  const c = AG.checks(a);
  return AG.REQS.filter((r) => !c[r.key]).map((r) => r.label);
};
AG.ready = (a) => AG.missing(a).length === 0;
AG.personaLabel = (a) => {
  const p = a.personality || {};
  if (p.preset && AG.PRESETS[p.preset]) return AG.PRESETS[p.preset].label;
  if (p.traits && p.traits.length) return p.traits.slice(0, 2).join(', ');
  return 'מותאמת אישית';
};
AG.initials = (a) => (a.name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('');

AG.open = (id) => { if (id) AG.current = id; CF.navigate('agents'); CF.emit('agents'); };

/* a real test call as this agent: its flow opens, then the dial window */
AG.test = (id) => {
  const a = AG.get(id);
  if (!a || !a.flowId) return;
  CF.openFlow(a.flowId);
  CF.navigate('flows');
  setTimeout(() => CF.openExport('call'), 160);
};
