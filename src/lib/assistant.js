/* The chat's built-in helper, used when there is no fast-brain key (with one, lib/builder.js runs the chat).
   Understands short Hebrew instructions and edits the diagram. Pattern matching only, no model behind it.
   Unknown input always gets a useful answer + suggestions. */
import CF from './core.js';
import chat from './chat.js';
import C from './canvas.js';
import builder from './builder.js';

const A = {};
CF.assistant = A;
export default A;

const say = (text, receipts) => chat.stream(text, { receipts });
const chips = (list) => chat.setChips(list);

const CHIPS_START = [
  'בנה סוכן מכירות של CallPilot',
  'בנה תסריט חזרה לליד חם',
  'בנה תסריט שיחה קרה לעסקים',
  'בנה תסריט פולואפ להצעת מחיר',
  'בנה תסריט החייאת לידים רדומים',
  'בנה תסריט שדרוג ללקוח קיים',
  'בנה תסריט אישור פגישת מכירה',
  'מה אתה יודע לעשות?',
];
const CHIPS_AFTER = [
  { label: 'שיחת בדיקה אמיתית', primary: true, value: 'הרץ שיחת בדיקה' },
  'הוסף שאלה על תקציב',
  'הוסף העברה לנציג',
  'סדר את הדיאגרמה',
];

/* normalise quotes and spacing so ״ " ׳ ' all behave the same */
const clean = (s) => String(s).replace(/([א-ת])["״]([א-ת])(?![א-ת])/g, '$1״$2').replace(/[“”„]|״(?![א-ת])|(?<![א-ת])״/g, '"').replace(/[׳‘’`]/g, "'").replace(/\s+/g, ' ').trim();
const strip = (s) => String(s || '').replace(/^[\s:\-–"'״]+|[\s"'״.!?]+$/g, '').trim();

/* verbs must be whole words, so "סף" never matches inside "הוסף" and "כתוב" never inside "כתובת" */
const word = (alts) => new RegExp('(?:^|\\s)(?:' + alts + ')(?=\\s|$|[,.!?])');
const ADD = word('הוסף|תוסיף|להוסיף|הוסיפי|תוסיפי|הוספה|תכניס|הכנס|להכניס|תשים|שים|צרף|תצרף|תחבר|חבר');
const BUILD = word('בנה|תבנה|לבנות|בניית|תיצור|ליצור|צור|תכין|להכין|הכן|תייצר|ייצר|תכתוב|כתוב');
const EDIT = word('שנה|תשנה|עדכן|תעדכן|ערוך|תערוך|תחליף|החלף|תנסח|נסח');
const DEL = word('מחק|תמחק|הסר|תסיר|תוריד|הורד|למחוק');
const TIDY = word('סדר|תסדר|ארגן|תארגן|יישר|סידור');
const TEST = word('בדוק|תבדוק|בדיקה|הרץ|תריץ|להריץ|נסה|תנסה|ניסיון|חייג|תחייג|התקשר|תתקשר');
const PIECE = /(שאלה|אופציה|אפשרות|צומת|פעולה|הודעה|סיום|העברה|וואטסאפ|ווטסאפ|נציג)/;
/* checked in this order: the first match picks the template */
const TPL = {
  callpilot: /callpilot|call pilot|קולפיילוט|קול פיילוט|כולפיילוט/,
  meeting_confirm: /אישור פגיש|אישור תור|תזכורת לפגיש|תזכורת|no.?show|הברז|לא הגיע/,
  quote_followup: /הצעת מחיר|הצעה ששלח|פולואפ|פולו אפ|follow|מטבח/,
  upsell: /שדרוג|אפסייל|upsell|קרוס|לקוח קיים|לקוחות קיימים|ותיקים/,
  reactivate: /רדומ|החייא|ישנים|לידים ישנים|לא נסגרו|כושר|סטודיו|חידוש קשר/,
  cold_call: /קרה|קר(\s|$)|שיחה יוצאת|שיחות יוצאות|טלמרקטינג|מכיר|סליקה|בעל העסק|b2b|לעסקים/,
  lead_followup: /ליד|השאיר פרטים|השאירו פרטים|פנייה|סולאר|פאנל|חם|מכירות|פגיש|תור|קליני|מרפא|ייעוץ/,
};

/* ---------- greeting ---------- */
A.greet = () => {
  const S = CF.state;
  // with a fast-brain key, the builder agent runs the chat: it plans, asks, builds and can place a test call
  if (builder.on()) {
    chat.add('bot', S.nodes.length
      ? `המוח המהיר כאן. התסריט הפתוח: "${S.name}" עם ${S.nodes.length} צעדים. מה לשנות, להוסיף או לבדוק?`
      : 'המוח המהיר כאן. ספרו לי על העסק ועל השיחה שהסוכן צריך לנהל. אשאל מה שחסר, אציע תוכנית לאישור, ואבנה אותה מול העיניים שלכם: צעדים, הוראות וכלים.', { via: 'מוח מהיר', viaClass: 'brain', viaIcon: 'sparkle' });
    chips(S.nodes.length ? ['תעבור על הפתיחים', 'תוסיף טיפול בהתנגדות מחיר', 'שיחת בדיקה אמיתית'] : ['סוכן שחוזר ללידים של קליניקת שיניים', 'שיחה קרה לבעלי עסקים', 'אישור פגישות למחר']);
    return;
  }
  if (S.nodes.length) {
    chat.add('bot', `ממשיכים מאיפה שעצרת: "${S.name}" עם ${S.nodes.length} מצבים. בחרו צומת בדיאגרמה כדי שהפקודות שלי יחולו עליו, או בקשו שינוי כללי.`);
    chips(CHIPS_AFTER);
  } else {
    chat.add('bot', 'היי. תארו לי את השיחה שהבוט צריך לנהל, ואבנה אותה כתסריט של AIServant: צעדים שמחוברים בחצים.\n\nההחלטה קובעת לאיזה חץ התשובה של הלקוח שייכת. כשמגיעים לצעד, ה-starter שלו מושמע מיד והמוח המהיר כותב את ההמשך לפי ה-context.');
    chips(CHIPS_START);
  }
};

/* ---------- entry ---------- */
/* messages are queued, so a chip clicked while a reply is still streaming is never dropped */
let queue = Promise.resolve();
A.handle = (input) => {
  if (builder.on()) return builder.handle(input);
  const raw = clean(input);
  if (!raw) return queue;
  chat.add('user', String(input).trim());
  queue = queue.then(() => process(raw)).catch((err) => { console.error(err); });
  return queue;
};
async function process(raw) {
  try {
    const t = raw.toLowerCase();
    const stop = CF.chat.typing();
    await CF.wait(CF.reducedMotion() ? 0 : 380 + Math.random() * 300);
    stop();
    const cmd = t.replace(/"[^"]*"?/g, ' ').replace(/:.*$/, ' ').replace(/\s+/g, ' ').trim();
    const intent = INTENTS.find((it) => it.when(cmd));
    const keep = [help, showAgents, createAgent, undo];
    if (intent && CF.ui.view !== 'flows' && !keep.includes(intent.run)) { CF.navigate('studio'); await C.ready(); }
    if (intent) await intent.run(t, raw);
    else await fallback(t, raw);
  } catch (err) {
    console.error(err);
    await say('משהו השתבש בביצוע. נסו לנסח אחרת, או בחרו אחת ההצעות למטה.');
  }
}

/* ---------- helpers ---------- */
const selNode = () => (CF.sel && CF.sel.type === 'node' ? CF.node(CF.sel.id) : null);
function targetAsk() {
  const s = selNode();
  if (s && s.type === 'ask') return s;
  const lt = CF.lastTouched && CF.node(CF.lastTouched);
  if (lt && lt.type === 'ask') return lt;
  const all = CF.state.nodes.filter((n) => n.type === 'ask');
  return all[all.length - 1] || null;
}
function findByTitle(raw) {
  const t = raw.toLowerCase();
  return CF.state.nodes
    .filter((n) => n.title && n.title.length >= 2 && t.includes(n.title.toLowerCase()))
    .sort((a, b) => b.title.length - a.title.length)[0] || null;
}
function quoted(raw) {
  const m = raw.match(/"([^"]{2,})"/);
  return m ? m[1].trim() : null;
}
function relayout(focusId) {
  CF.layout();
  C.glide();
  CF.commit({ structural: true });
  if (focusId) {
    CF.select({ type: 'node', id: focusId });
    setTimeout(() => C.focus(focusId), 650);
  }
}
const SYN = {
  'כן': 'כן|בטח|נכון|כמובן|אפשר|בסדר',
  'לא': 'לא|ממש לא|לא תודה|לא נכון',
  'אולי': 'אולי|לא בטוח|לא יודע|תלוי',
  'לא בטוח': 'לא בטוח|לא יודע|לא יודעת|אולי|תלוי',
};
const examplesFor = (l) => SYN[l] || l;

function splitOpts(s) {
  return s.split(/\s*(?:,|،|\/|\|| או )\s*/)
    .flatMap((p) => (/ ו\S/.test(p) && p.split(' ').length <= 4 ? p.split(/ ו(?=\S)/) : [p]))
    .map(strip)
    .filter(Boolean)
    .slice(0, 6);
}

const TOPICS = [
  { re: /תקציב|כסף|מחיר/, title: 'תקציב', text: 'ומה התקציב שתכננת בערך?', options: [['עד 5,000 ₪', 'עד 5|5000|חמשת אלפים|זול|לא הרבה'], ['5,000–15,000 ₪', '10|עשרת אלפים|10000|בין|בינוני'], ['מעל 15,000 ₪', '20|עשרים|מעל|יותר|לא משנה']] },
  { re: /זמינ|מתי|שעה|מועד|נוח לך/, title: 'זמינות', text: 'באיזה חלק של היום הכי נוח לך?', options: [['בוקר', 'בוקר|בבוקר|מוקדם'], ['צהריים', 'צהריים|בצהריים|אחר הצהריים'], ['ערב', 'ערב|בערב|אחרי העבודה']] },
  { re: /ביטוח/, title: 'ביטוח', text: 'יש לך ביטוח משלים?', options: [['כן', SYN['כן']], ['לא', SYN['לא']], ['לא בטוח', SYN['לא בטוח']]] },
  { re: /אזור|עיר|מיקום|גר |גרים|מגורים/, title: 'אזור מגורים', text: 'באיזה אזור אתם גרים?', options: [['מרכז', 'מרכז|תל אביב|רמת גן|פתח תקווה'], ['צפון', 'צפון|חיפה|קריות'], ['דרום', 'דרום|באר שבע|אשדוד'], ['ירושלים', 'ירושלים|בית שמש']] },
  { re: /גיל/, title: 'טווח גיל', text: 'אפשר לשאול באיזה טווח גילאים?', options: [['עד 30', 'עד 30|20|צעיר'], ['30–50', '30|40|ארבעים|שלושים'], ['50+', '50|60|חמישים|שישים|מעל']] },
  { re: /שביעות|מרוצ|דירוג|חוויה/, title: 'שביעות רצון', text: 'מאחת עד חמש, כמה היית מרוצה מהשירות?', options: [['מרוצה מאוד', '5|חמש|מאוד|מעולה|מצוין'], ['בינוני', '3|שלוש|בסדר|ככה ככה'], ['לא מרוצה', '1|2|אחת|שתיים|לא מרוצה|גרוע']] },
  { re: /שמעת|הגעת|מקור|הכרת/, title: 'מקור הגעה', text: 'איך שמעת עלינו?', options: [['רשתות חברתיות', 'פייסבוק|אינסטגרם|טיקטוק|רשתות'], ['גוגל', 'גוגל|חיפוש|אינטרנט'], ['המלצה', 'המלצה|חבר|חברה|מישהו המליץ']] },
  { re: /ניסיון|בעבר|פעם קודמת/, title: 'ניסיון קודם', text: 'יצא לך לעשות טיפול כזה בעבר?', options: [['כן', SYN['כן']], ['לא', SYN['לא']]] },
];

function parseQuestion(raw) {
  let s = raw.replace(/^.*?(שאלה|החלטה)\s*/i, '');
  let optsPart = null;
  const om = s.match(/(?:עם\s+)?ה?(?:אופציות|אפשרויות|תשובות|אופציה|אפשרות)\s*[:\-]?\s*(.+)$/);
  if (om) { optsPart = om[1]; s = s.slice(0, om.index); }
  s = strip(s).replace(/^(על|לגבי|בנושא|שבודקת|שתבדוק|ששואלת|שואלת|נוספת|חדשה)\s+/, '').replace(/^ש(?=[א-ת])/, '');
  s = strip(s);
  const topic = TOPICS.find((tp) => tp.re.test(s));
  const asQuestion = /^(האם|מה|מתי|איך|איפה|כמה|למה|מי|באיזה|איזה|יש|אתה|את|אתם)/.test(s);
  let title;
  let text;
  let options;
  if (topic) {
    title = topic.title;
    text = asQuestion ? s.replace(/\?*$/, '?') : topic.text;
    options = topic.options;
  } else {
    const q = s || 'שאלה חדשה';
    title = q.length > 26 ? q.slice(0, 24) + '…' : q;
    text = asQuestion ? q.replace(/\?*$/, '?') : 'אפשר לשאול לגבי ' + q + '?';
    options = [['כן', SYN['כן']], ['לא', SYN['לא']]];
  }
  if (optsPart) {
    const list = splitOpts(optsPart);
    if (list.length) options = list.map((l) => [l, examplesFor(l)]);
  }
  return { title, text, options };
}

/* ---------- intents (first match wins) ---------- */
const INTENTS = [
  { when: (t) => /(עזרה|מה אתה יודע|מה את יודעת|מה אפשר|איך משתמשים|^help)/.test(t), run: help },
  { when: (t) => /סוכנים/.test(t) && /(הצג|תציג|פתח|תפתח|עבור|תעבור|לך|רשימת)/.test(t), run: showAgents },
  { when: (t) => /(חזור|תחזור|עבור|תעבור) ל?(תסריטים|עורך)/.test(t), run: showFlows },
  { when: (t) => /סוכן/.test(t) && (BUILD.test(t) || ADD.test(t)) && !Object.values(TPL).some((re) => re.test(t)), run: createAgent },
  { when: (t) => /(תסריט|פלואו|flow) (חדש|ריק)/.test(t) && !Object.values(TPL).some((re) => re.test(t)), run: newFlow },
  { when: (t) => /(פתח|תפתח|עבור ל|תעבור ל)\S*\s*(את\s+)?ה?תסריט/.test(t), run: openFlowByName },
  { when: (t) => /(נקה|תנקה|מחק הכל|מחק את הכל|התחל מחדש|דף חדש|קנבס ריק)/.test(t), run: clearAll },
  { when: (t) => /^(בטל|תבטל|אנדו|undo)( |$)|בטל את הפעולה|חזור אחורה/.test(t), run: undo },
  {
    when: (t) => (BUILD.test(t) && !PIECE.test(t)) || /(תסריט|סקריפט|תרחיש)\s+(ל|של|עבור)/.test(t) && !ADD.test(t),
    run: build,
  },
  { when: (t) => /שם העסק/.test(t), run: renameBusiness },
  { when: (t) => /(שם התסריט|קרא לתסריט|תקרא לתסריט)/.test(t), run: renameFlow },
  { when: (t) => /(starter|סטרטר)/.test(t) || (/פתיח/.test(t) && /(מיידי|לצעד|לצומת|אופציה|אפשרות|ענף|תשובה)/.test(t)), run: setStarter },
  { when: (t) => /(context|קונטקסט|הוראות|גלובלי|כללי זהב|golden)/.test(t) && /(פתח|תפתח|הצג|תציג|ערוך|תערוך)/.test(t), run: openInstructions },
  { when: (t) => /(ייצא|תייצא|ייצוא|export|makecall|json|בדוק תקינות|תקין)/.test(t), run: openExport },
  // a message that opens with an edit or delete verb goes straight to that handler
  { when: (t) => EDIT.test(t.split(' ')[0]), run: editText },
  { when: (t) => DEL.test(t.split(' ')[0]) && !/הכל/.test(t), run: remove },
  { when: (t) => ADD.test(t) && /(unclear|לא ברור)/.test(t), run: addUnclear },
  { when: (t) => ADD.test(t) && /(אופציה|אפשרות|תשובה אפשרית)/.test(t) && !/שאלה/.test(t), run: addOption },
  { when: (t) => (ADD.test(t) || BUILD.test(t)) && /(שאלה|החלטה)/.test(t), run: addQuestion },
  { when: (t) => (ADD.test(t) || BUILD.test(t)) && /(נציג|העבר|וואטסאפ|ווטסאפ|whatsapp|יומן|פגישה|crm|סטטוס|שיחה חוזרת|תזכורת|חזרה|סיום|ניתוק|לנתק|הודעה|משפט|פעולה)/.test(t), run: addPiece },
  { when: (t) => EDIT.test(t), run: editText },
  { when: (t) => DEL.test(t), run: remove },
  { when: (t) => TIDY.test(t), run: tidy },
  { when: (t) => TEST.test(t), run: test },
  { when: (t) => Object.values(TPL).some((re) => re.test(t)), run: build },
];

async function help() {
  await say('אני יודע לבנות ולערוך את עץ השיחה:\n\n• לבנות תסריט שלם מתיאור קצר\n• להוסיף שאלה עם אופציות, למשל: הוסף שאלה על תקציב עם אופציות זול, בינוני, יקר\n• להוסיף אופציה לצומת שנבחר\n• להוסיף חץ unclear לשאלה ("הוסף unclear")\n• להוסיף פעולות: יומן, וואטסאפ, CRM, העברה לנציג, שיחה חוזרת, סיום\n• לתת לצעד starter: 1 עד 3 מילים שמושמעות מיד כשמגיעים אליו. למשל: הוסף פתיח "מעולה," לצעד "הצעת פגישת ייעוץ\"\n• לפתוח את הוראות התסריט (context, כללי זהב, values, חצים גלובליים, כלים) ולייצא ל-AIServant עם בדיקת תקינות\n• לשנות נוסח, למחוק, לסדר ולשנות סף ביטחון\n• להריץ שיחת בדיקה על הדיאגרמה\n• לנהל כמה תסריטים: תסריט חדש, פתח את התסריט …\n• ליצור סוכנים: צור סוכן בשם …, הצג סוכנים. לכל סוכן חייבים בסיס ידע, תסריט, קול ואישיות\n\nכשבוחרים צומת בדיאגרמה, הפקודות חלות עליו.');
  chips(CF.state.nodes.length ? CHIPS_AFTER : CHIPS_START);
}

/* starter: 1–3 words played the moment the call reaches a step */
async function setStarter(t, raw) {
  const qs = Array.from(raw.matchAll(/"([^"]+)"/g)).map((m) => m[1].trim()).filter(Boolean);
  const starter = qs[0] || '';
  if (!starter) { await say('מה ה-starter? כתבו אותו במירכאות, למשל: הוסף פתיח "מעולה," לצעד "הצעת פגישת ייעוץ"'); return; }
  const hay = raw.split('"' + starter + '"').join(' ');
  const node = findByTitle(hay) || CF.state.nodes.find((n) => n.key && hay.includes(n.key)) || selNode() || (CF.lastTouched && CF.node(CF.lastTouched));
  if (!node) { await say('לאיזה צעד? בחרו אותו בדיאגרמה, או כתבו את השם שלו במירכאות אחרי הפתיח.'); return; }
  CF.checkpoint();
  node.starter = starter;
  CF.lastTouched = node.id;
  CF.commit();
  CF.select({ type: 'node', id: node.id });
  C.focus(node.id);
  const words = starter.split(/\s+/).length;
  await say(`כשהשיחה תגיע ל[${node.key}] "${node.title}", הבוט יגיד מיד "${starter}", והמוח המהיר ימשיך לפי ה-context של הצעד.` +
    (words > 3 ? ' שימו לב: starter צריך להיות 1 עד 3 מילים, אז הבדיקה תסמן הערה.' : ''), ['starter · ' + node.key]);
  chips([{ label: 'הרץ שיחת בדיקה', primary: true, value: 'הרץ שיחת בדיקה' }, 'בדוק תקינות']);
}

async function openInstructions(t) {
  const tab = /גלובלי/.test(t) ? 'globals' : /(כלי|tool)/.test(t) ? 'tools' : 'instructions';
  CF.openFlowPanel(tab);
  await say('פתחתי את הוראות התסריט: personality, context, כללי זהב, hotWords ו-values, וגם החצים הגלובליים והכלים.');
}
async function openExport() {
  if (!CF.state.nodes.length) { await say('אין עדיין תסריט לייצא.'); chips(CHIPS_START); return; }
  const list = CF.issues();
  const errors = list.filter((i) => i.level === 'error');
  CF.openExport();
  await say(errors.length
    ? `יש ${errors.length} בעיות ש-AIServant ידחה. הראשונה: ${errors[0].msg} לחיצה על בעיה בחלון מסמנת את הצעד.`
    : 'התסריט עובר את כל הבדיקות של AIServant. פתחתי את ה-instructions ואת גוף ה-makecall להעתקה.');
}

async function clearAll() {
  if (!CF.state.nodes.length) { await say('הקנבס כבר ריק. תארו את השיחה ואבנה אותה.'); chips(CHIPS_START); return; }
  CF.checkpoint();
  CF.state.nodes = [];
  CF.state.edges = [];
  CF.state.name = 'תסריט חדש';
  CF.select(null);
  CF.commit({ structural: true });
  await say('ניקיתי את הקנבס. אפשר להתחיל מחדש, ו-⌘Z מחזיר את מה שהיה.');
  chips(CHIPS_START);
}

async function undo() {
  if (CF.undo()) await say('ביטלתי את הפעולה האחרונה.');
  else await say('אין פעולה לבטל.');
}

async function build(t, raw) {
  const key = Object.keys(TPL).find((k) => TPL[k].test(t)) || 'lead_followup';
  const known = Object.values(TPL).some((re) => re.test(t));
  const flow = CF.templates[key]();
  const bm = raw.match(/(?:בשם|שנקרא|שנקראת|שקוראים לו|שקוראים לה)\s+"?([^",.\n]{2,28})"?/);
  if (bm) CF.renameBusiness(flow, strip(bm[1]));
  // never overwrite work: a non-empty canvas gets a new flow next to it
  const fresh = CF.state.nodes.length > 0;
  if (fresh) { CF.navigate('studio'); CF.newFlow(flow.name); }
  else CF.navigate('studio');
  await say((known ? `בונה את "${flow.name}"…` : 'לא זיהיתי סוג שיחה מוכר, אז אני בונה חזרה לליד חם, שאפשר להתאים…') + (fresh ? ' (בתסריט חדש, הקודם נשמר)' : ''));
  await C.buildAnimated(flow);
  const c = (type) => flow.nodes.filter((n) => n.type === type).length;
  const starters = flow.nodes.filter((n) => n.starter).length;
  const inline = flow.nodes.filter((n) => n.type === 'ask' && n.fallback && !flow.edges.some((e) => e.from === n.id && e.port === 'fallback')).length;
  await say(
    `העץ מוכן: ${flow.nodes.length} מצבים ו-${flow.edges.length} מעברים.\n\n` +
    `ב-${c('ask')} צמתי ההחלטה, ההחלטה בוחרת מתוך אופציות סגורות. ` +
    `ל-${starters} צעדים יש starter שמושמע מיד. שאלות שהתסריט לא מכסה נענות מה-context. ` +
    (bm ? `שם העסק בנוסחים: ${flow.business}. ` : '') +
    ((flow.globalArrows || []).length ? `${flow.globalArrows.length} חצים גלובליים תופסים בקשות כמו "רוצה נציג". ` : '') +
    'בחרו צומת כדי לערוך, או התקשרו לבדיקה.',
    [`${flow.nodes.length} צעדים`, `${c('ask')} ask`, `${starters} starters`, `${c('action')} פעולות`, `${c('end')} סיומים`]
  );
  CF.lastTouched = null;
  if (/סוכן/.test(t)) { await makeAgentFor(key, raw); return; }
  chips(CHIPS_AFTER);
}

/* an agent that matches the template: persona name, voice gender and personality. The Cartesia voice is left to the user */
const AGENT_DEFAULTS = {
  lead_followup: { name: 'נועה', role: 'חוזרת ללידים חמים וקובעת סקר', voiceGender: 'female', preset: 'warm' },
  cold_call: { name: 'שירן', role: 'שיחות קרות לבעלי עסקים', voiceGender: 'female', preset: 'sales' },
  quote_followup: { name: 'מאיה', role: 'פולואפ להצעות מחיר וסגירת פגישות', voiceGender: 'female', preset: 'pro' },
  reactivate: { name: 'עדי', role: 'מחייה לידים רדומים עם הטבה', voiceGender: 'female', preset: 'sales' },
  upsell: { name: 'רון', role: 'מציע שדרוגים ללקוחות קיימים', voiceGender: 'male', preset: 'warm' },
  meeting_confirm: { name: 'נועה', role: 'מאשרת פגישות מכירה ומצמצמת ביטולים', voiceGender: 'female', preset: 'warm' },
  callpilot: { name: 'עדי', role: 'חוזרת ללידים מהאתר וקובעת הדגמות של CallPilot', voiceGender: 'female', preset: 'sales' },
};
async function makeAgentFor(key, raw) {
  const d = AGENT_DEFAULTS[key] || AGENT_DEFAULTS.lead_followup;
  const nm = agentName(raw);
  const a = CF.agents.create({ name: nm || d.name, role: d.role, voiceGender: d.voiceGender, flowId: CF.state.id });
  CF.agents.applyPreset(a, d.preset);
  CF.save();
  CF.emit('agents');
  const hasVoice = !!CF.agents.voiceOf(a);
  await say(`יצרתי גם את הסוכן "${a.name}" וחיברתי אליו את התסריט, עם אישיות ${CF.agents.personaLabel(a)}.` +
    (hasVoice ? ' הקול הוא ברירת המחדל מההגדרות.' : ' חסר לו קול: הוסיפו Cartesia voice id באזור הסוכנים, או ברירת מחדל בהגדרות.'),
    ['+ סוכן · ' + a.name, 'תסריט ✓', hasVoice ? 'קול ✓' : 'קול: חסר', 'אישיות ✓']);
  chips([{ label: 'פתח את הסוכן', primary: true, run: () => CF.agents.open(a.id) }, 'שיחת בדיקה אמיתית', 'סדר את הדיאגרמה']);
}
function agentName(raw) {
  const m = raw.match(/(?:בשם|שנקרא|שנקראת|שקוראים לו|שקוראים לה)\s+"?([^",.\n]{2,20})"?/);
  return m ? strip(m[1]) : '';
}

async function createAgent(t, raw) {
  const nm = agentName(raw) || 'סוכן חדש';
  const hasFlow = CF.state.nodes.length > 0;
  const a = CF.agents.create({ name: nm, flowId: hasFlow ? CF.state.id : null });
  await say(`יצרתי את הסוכן "${a.name}"` + (hasFlow ? ` וחיברתי אליו את "${CF.state.name}".` : '.') +
    ` כדי שיהיה מוכן חסרים: ${CF.agents.missing(a).join(', ')}. פתחתי אותו כדי שתשלימו.`);
  CF.agents.open(a.id);
  chips(['בנה תסריט מכירה טלפונית', 'הצג סוכנים', 'חזור לתסריטים']);
}
async function showAgents() {
  CF.agents.open();
  const n = CF.ws.agents.length;
  const ready = CF.ws.agents.filter(CF.agents.ready).length;
  await say(n ? `יש ${n} סוכנים, ${ready} מהם מוכנים לשיחות.` : 'עוד אין סוכנים. לחצו "סוכן חדש", או בקשו ממני "צור סוכן בשם…".');
}
async function showFlows() {
  CF.navigate('studio');
  await say(`חזרתי לעורך. פתוח עכשיו "${CF.state.name}". כל התסריטים ברשימה ליד השם שלו בסרגל העליון.`);
}
async function newFlow(t, raw) {
  const m = raw.match(/(?:בשם|שנקרא)\s+"?([^",.\n]{2,30})"?/);
  CF.navigate('studio');
  const f = CF.newFlow(m ? strip(m[1]) : undefined);
  await say(`פתחתי תסריט חדש "${f.name}". התסריט הקודם נשמר. תארו את השיחה ואבנה אותה.`);
  chips(CHIPS_START);
}
async function openFlowByName(t, raw) {
  const q = raw.toLowerCase();
  const f = CF.ws.flows.filter((x) => x.name && q.includes(x.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
  if (!f) { await say('איזה תסריט לפתוח? אלה התסריטים שיש: ' + CF.ws.flows.map((x) => '"' + x.name + '"').join(', ') + '.'); return; }
  CF.navigate('studio');
  CF.openFlow(f.id);
  await say(`פתחתי את "${f.name}".`);
}

async function renameBusiness(t, raw) {
  const m = raw.match(/שם העסק\s*(?:ל|הוא|יהיה|:|=)?\s*(.+)$/);
  const name = m ? strip(m[1].replace(/^ל(?=\S)/, '')) : '';
  if (!name) { await say('מה שם העסק? כתבו למשל: שם העסק הוא "מרפאת הדר".'); return; }
  CF.checkpoint();
  const old = CF.state.business;
  CF.renameBusiness(CF.state, name);
  CF.commit();
  await say(`עדכנתי את שם העסק בכל הנוסחים: "${old}" הוחלף ב-"${name}".`);
}

async function renameFlow(t, raw) {
  const m = raw.match(/(?:שם התסריט|קרא לתסריט|תקרא לתסריט)\s*(?:ל|הוא|יהיה|:|=)?\s*(.+)$/);
  const name = m ? strip(m[1]) : '';
  if (!name) { await say('איך לקרוא לתסריט?'); return; }
  CF.checkpoint();
  CF.state.name = name;
  CF.commit();
  await say(`התסריט נקרא עכשיו "${name}".`);
}

async function addOption(t, raw) {
  const q = targetAsk();
  if (!q) { await say('אין עדיין צומת החלטה. בקשו קודם "הוסף שאלה…" או בנו תסריט.'); chips(CHIPS_START); return; }
  let label = quoted(raw) || raw.replace(/^.*?(אופציה|אפשרות|תשובה אפשרית)\s*/, '')
    .replace(/^(חדשה|נוספת)\s*/, '')
    .replace(/^(של|בשם|:|-)\s*/, '')
    .replace(/\s+(ל|ב)(שאלה|צומת)\b.*$/, '');
  label = strip(label) || 'אופציה חדשה';
  CF.checkpoint();
  q.options.push(CF.opt(label, examplesFor(label)));
  CF.lastTouched = q.id;
  CF.commit();
  CF.select({ type: 'node', id: q.id });
  C.focus(q.id);
  await say(`הוספתי את "${label}" לצומת "${q.title}". היציאה שלה עוד לא מחוברת: גררו ממנה לצומת הבא, או בקשו "הוסף סיום" ואחבר אותה.`, ['+ אופציה · ' + label]);
  chips(['הוסף סיום', 'הוסף העברה לנציג', 'הרץ שיחת בדיקה']);
}

async function addQuestion(t, raw) {
  const q = parseQuestion(raw);
  CF.checkpoint();
  const n = CF.addNode('ask', { title: q.title, text: 'לשאול: ' + q.text, options: q.options.map(([l, ex]) => CF.opt(l, ex)) });
  const where = CF.attachNew(n);
  CF.lastTouched = n.id;
  relayout(n.id);
  await say(
    `הוספתי צומת החלטה "${n.title}" עם ${n.options.length} אופציות` +
    (where.anchor ? (where.inserted ? `, ושילבתי אותו אחרי "${where.anchor.title}".` : `, מחובר אחרי "${where.anchor.title}".`) : '. הוא עוד לא מחובר: גררו אליו חיבור מצומת קודם.') +
    ' כל אופציה היא יציאה נפרדת. תשובה שלא מתאימה לאף אחת נענית מה-context, והשיחה נשארת בשאלה.',
    ['+ החלטה'].concat(n.options.map((o) => o.label))
  );
  chips(['הוסף אופציה "אולי"', 'הוסף unclear לשאלה הזאת', 'הוסף סיום', 'שיחת בדיקה אמיתית']);
}

/* "unclear": an optional arrow on an ask step. Without it, the reply comes from the context and the call stays on the step. */
async function addUnclear() {
  const q = targetAsk();
  if (!q) { await say('חץ unclear שייך לשאלה. בנו קודם תסריט או הוסיפו שאלה.'); return; }
  CF.checkpoint();
  CF.setFallback(q, true);
  CF.lastTouched = q.id;
  CF.commit();
  CF.select({ type: 'node', id: q.id });
  C.focus(q.id);
  await say(`הוספתי ל[${q.key}] יציאה "לא ברור" (unclear). חברו אותה לצעד שאליו עוברים כשהתשובה לא ברורה, למשל חזרה לאותה שאלה. כל עוד היא לא מחוברת, היא לא נשלחת, והסוכן עונה מה-context ונשאר בשאלה.`, ['+ unclear']);
  chips(['הרץ שיחת בדיקה', 'בדוק תקינות']);
}

async function addPiece(t, raw) {
  let type = 'action';
  let kind = null;
  if (/(נציג|העבר)/.test(t)) kind = 'transfer';
  else if (/(וואטסאפ|ווטסאפ|whatsapp)/.test(t)) kind = 'whatsapp';
  else if (/(יומן|פגישה)/.test(t)) kind = 'calendar';
  else if (/(crm|סטטוס)/.test(t)) kind = 'crm';
  else if (/(שיחה חוזרת|תזכורת|חזרה)/.test(t)) kind = 'callback';
  else if (/(סיום|ניתוק|לנתק)/.test(t)) type = 'end';
  else if (/(הודעה|משפט)/.test(t)) type = 'say';
  else kind = 'crm';

  const txt = quoted(raw) || ((raw.match(/:\s*(.{2,})$/) || [])[1] || '').trim();
  const over = {};
  if (type === 'action') {
    const a = CF.ACTIONS[kind];
    over.action = kind; over.tool = CF.TOOL_OF[kind]; over.title = a.label; over.text = 'להגיד ללקוח: ' + a.desc;
    const tools = CF.tools(CF.state);
    if (!tools.some((x) => x.name === over.tool)) tools.push(CF.DEFAULT_TOOLS().find((x) => x.name === over.tool));
  }
  // a quoted line is what to get across
  if ((type === 'end' || type === 'say') && txt) over.text = txt;

  CF.checkpoint();
  const n = CF.addNode(type, over);
  const where = CF.attachNew(n);
  CF.lastTouched = n.id;
  relayout(n.id);
  const label = type === 'action' ? CF.ACTIONS[kind].label : CF.TYPES[type].label;
  const port = where.anchor && where.port && where.anchor.type === 'ask' && where.port !== 'fallback'
    ? (where.anchor.options.find((o) => o.id === where.port) || {}).label : null;
  await say(
    `הוספתי "${label}"` +
    (where.anchor
      ? (port ? ` ליציאה "${port}" של "${where.anchor.title}".` : (where.inserted ? ` ושילבתי אחרי "${where.anchor.title}".` : ` אחרי "${where.anchor.title}".`))
      : '. לא מצאתי יציאה פנויה, אז הוא עומד לבד: גררו אליו חיבור.') +
    (type === 'say' && !txt ? ' כתבו את הנוסח בפאנל משמאל.' : ''),
    ['+ ' + label]
  );
  chips(type === 'end' ? ['הרץ שיחת בדיקה', 'סדר את הדיאגרמה'] : ['הוסף סיום', 'הרץ שיחת בדיקה']);
}

async function editText(t, raw) {
  let target = null;
  if (/פתיח/.test(t)) target = CF.state.nodes.find((n) => n.type === 'start');
  else if (/סיום/.test(t)) { const s = selNode(); target = s && s.type === 'end' ? s : CF.state.nodes.find((n) => n.type === 'end'); }
  if (!target) target = findByTitle(raw);
  if (!target && /שאלה/.test(t)) { const s = selNode(); target = s && s.type === 'ask' ? s : targetAsk(); }
  if (!target) target = selNode();
  if (!target) { await say('איזה צומת לשנות? בחרו אותו בדיאגרמה, או כתבו למשל: שנה את הפתיח ל"שלום, כאן דנה".'); return; }
  let val = quoted(raw) || ((raw.match(/:\s*(.{2,})$/) || [])[1]);
  if (!val) {
    const m = raw.match(/(?:פתיח|פתיחה|הפתיח|הפתיחה|טקסט|הטקסט|נוסח|הנוסח|משפט|המשפט|שאלה|השאלה|סיום|הסיום)\s+ל\s*(.{2,})$/) ||
      raw.match(/(?:פתיח|פתיחה|הפתיח|הפתיחה|טקסט|הטקסט|נוסח|הנוסח|משפט|המשפט|שאלה|השאלה|סיום|הסיום)\s+ל(\S.{1,})$/);
    val = m && m[1];
  }
  val = String(val || '').replace(/^[\s:\-–"'״]+|[\s"'״]+$/g, '').trim();
  if (!val) { await say(`מה הנוסח החדש ל"${target.title}"? כתבו אותו במירכאות, למשל: שנה את הנוסח ל"…"`); CF.select({ type: 'node', id: target.id }); return; }
  CF.checkpoint();
  // the user wrote a wording: it becomes the step's context
  target.text = val;
  CF.lastTouched = target.id;
  CF.commit();
  CF.select({ type: 'node', id: target.id });
  C.focus(target.id);
  await say(`עדכנתי את "${target.title}":\n"${val}"`);
}

async function remove(t, raw) {
  if (/(אופציה|אפשרות)/.test(t)) {
    const q = targetAsk();
    const o = q && q.options.filter((x) => raw.includes(x.label)).sort((a, b) => b.label.length - a.label.length)[0];
    if (!o) { await say('איזו אופציה למחוק? כתבו את השם שלה, למשל: מחק את האופציה "שבוע הבא".'); return; }
    CF.checkpoint();
    CF.removeOption(q.id, o.id);
    CF.commit();
    await say(`מחקתי את האופציה "${o.label}" מ"${q.title}".`);
    return;
  }
  const target = findByTitle(raw) || selNode();
  if (!target) { await say('איזה צומת למחוק? בחרו אותו בדיאגרמה או כתבו את השם שלו.'); return; }
  CF.checkpoint();
  CF.removeNode(target.id);
  CF.select(null);
  CF.commit({ structural: true });
  await say(`מחקתי את "${target.title}" ואת החיבורים שלו. ⌘Z מחזיר.`);
}

async function tidy() {
  if (!CF.state.nodes.length) { await say('אין עדיין מה לסדר.'); return; }
  C.tidy();
  await say('סידרתי את העץ משמאל לימין לפי סדר השיחה. לולאות חזרה מסומנות בקו מקווקו מתחת לצמתים.');
}

/* a test call is a real call: the dial window opens with the open flow */
async function test() {
  if (!CF.state.nodes.length) { await say('אין עדיין מה לבדוק. בנו תסריט קודם.'); chips(CHIPS_START); return; }
  await say('פותח את חלון החיוג: כתבו את המספר שאליו להתקשר. השיחה אמיתית והטלפון יצלצל.');
  CF.openExport('call');
}

async function fallback(t, raw) {
  if (!CF.state.nodes.length && raw.length > 12) { await build(t, raw); return; }
  await say('לא בטוח שהבנתי. אני יכול לבנות תסריט שלם, להוסיף שאלות ואופציות, לתת starters, לשנות context, לייצא ל-AIServant ולפתוח שיחת בדיקה אמיתית. נסו אחת מההצעות:');
  chips(CF.state.nodes.length ? CHIPS_AFTER.concat(['מה אתה יודע לעשות?']) : CHIPS_START);
}
