/* Sales call templates in AIServant's instructionTree shape.
   Node spec: ['step_id', { type, title (goal), text (context: what to get across), starter (1–3 words),
     next, …kind fields }]
   ask: slot, options [[when, 'phrasing|phrasing', toId]], or mode 'free' + answered; unclear: toId
   action: tool, next (= ok), failed
   Rules every template follows:
   - a starter is played after every arrow that reaches its step, so it fits all of them
   - a tool failure goes to a step that apologises ("סליחה,"); an action and the step after it never both have starters
   - prices and facts live in the flow context: a question without an arrow is answered from there
   - every call can reach a human, be removed from the call list, or ask to be called back (global arrows)
   - only regular aiTools: the dialer's calendar built-ins exist only on accounts with a connected calendar
   All businesses are fictional, except CallPilot (which therefore has no prices or customer claims). */
import CF from './core.js';

function fromSpec(spec) {
  const ids = {};
  const nodes = [];
  const edges = [];
  const edge = (from, port, to) => { if (to && ids[to]) edges.push({ id: CF.uid('e'), from, port, to: ids[to] }); };
  spec.nodes.forEach(([k]) => { ids[k] = CF.uid('n'); });
  spec.nodes.forEach(([k, d]) => {
    const n = { id: ids[k], key: k, type: d.type, x: 0, y: 0, title: d.title, text: d.text || '', starter: d.starter || '', maxVisits: d.maxVisits || null };
    if (d.type === 'start' || d.type === 'say') { n.when = d.when || 'ממשיך'; edge(n.id, 'out', d.next); }
    if (d.type === 'ask') {
      n.slot = d.slot;
      n.mode = d.mode || 'options';
      n.options = (d.options || []).map(([label, ex, to]) => { const o = CF.opt(label, ex); edge(n.id, o.id, to); return o; });
      if (n.mode === 'free') edge(n.id, 'answered', d.answered);
      n.fallback = !!d.unclear;
      if (d.unclear) edge(n.id, 'fallback', d.unclear);
    }
    if (d.type === 'action') {
      n.tool = d.tool;
      n.action = CF.actionOfTool(d.tool) || 'crm';
      edge(n.id, 'out', d.next);
      edge(n.id, 'failed', d.failed);
    }
    nodes.push(n);
  });
  const ins = spec.instructions;
  const toolNames = new Set(nodes.filter((n) => n.type === 'action').map((n) => n.tool));
  return {
    name: spec.name,
    business: spec.business,
    nodes,
    edges,
    instructions: {
      personality: ins.personality || '', context: ins.context || '', goldenRules: ins.goldenRules || '', hotWords: ins.hotWords || '',
      values: Object.entries(ins.values || {}).map(([key, value]) => ({ key, value })), mode: 'tree', text: '',
    },
    globalArrows: (spec.globals || GLOBALS).map(([when, ex, to]) => ({ id: CF.uid('g'), when, examples: ex.split('|'), to: ids[to] || null })),
    // the aiTools this script calls, nothing more
    aiTools: TOOLS().filter((t) => toolNames.has(t.name)),
  };
}

/* ---------- shared by every sales template ---------- */
const tool = (name, description, params) => ({ name, description, url: 'https://example.com/tools/' + name.replace(/_/g, '-'), timeoutMs: 8000, shouldInvokeAnswer: true, params: params || [] });
const p = (name, description) => ({ name, type: 'string', description, required: true });
const TOOLS = () => [
  tool('schedule_meeting', 'Books a meeting at the day and time the caller agreed to.', [p('when', 'The day and time the caller chose')]),
  tool('send_whatsapp', 'Sends the caller a WhatsApp message with the details discussed.', [p('topic', 'What the message is about')]),
  tool('update_crm', "Updates the lead's status and notes in the CRM.", [p('status', 'The new status of the lead')]),
  tool('schedule_callback', 'Creates a task to call the caller back.', [p('when', 'When the caller asked to be called back')]),
  tool('notify_rep', 'Asks a human sales rep to call the caller back today.', [p('reason', 'Why the caller wants a person')]),
  tool('do_not_call', 'Removes the caller from every call list.', []),
  tool('create_order', 'Opens an order for the product the caller agreed to.', [p('product', 'What the caller ordered')]),
  tool('reschedule_meeting', 'Moves the sales meeting to the day and time the caller asked for.', [p('when', 'The new day and time, as the caller said it')]),
  tool('cancel_meeting', 'Cancels the sales meeting.', []),
];
const GLOBALS = [
  ['רוצה נציג', 'נציג|בן אדם|מישהו אמיתי|מנהל|לדבר עם מישהו', 'notify_rep'],
  ['מבקש להסיר אותו', 'תסירו אותי|אל תתקשרו|תורידו אותי|להסיר|תמחקו את המספר', 'dnc'],
  ['מבקש שיחזרו אליו', 'תתקשרו אחר כך|לא נוח עכשיו|תחזרו אליי|אני באמצע', 'callback'],
];
const RULES = 'אל תבטיחי משהו שלא מופיע ברקע. מי שאומר שהוא לא מעוניין פעמיים, מסיימים איתו בנימוס. מי שמבקש להסיר אותו, מסירים מיד ובלי שכנוע.';
/* the steps the global arrows and tool failures lead to; ask_when and e_no only where a template uses them */
const tail = (opts) => { const m = !!(opts && opts.male); const g = (f, mm) => (m ? mm : f); return [
  ['callback', { type: 'action', title: 'תזמון שיחה חוזרת', tool: 'schedule_callback', starter: 'רשמתי,',
    text: g('להגיד שרשמת לחזור אליהם בזמן שנוח להם', 'להגיד שרשמת לחזור אליהם בזמן שנוח להם'), next: 'e_later', failed: 'e_failed' }],
  ['e_later', { type: 'end', title: 'נקבעה שיחה חוזרת', text: 'להודות ולהיפרד בנימוס' }],
  ['notify_rep', { type: 'action', title: 'בקשה לנציג', tool: 'notify_rep', starter: 'בטח,',
    text: g('להגיד שאת מעבירה את הפרטים לנציג שיחזור אליהם היום', 'להגיד שאתה מעביר את הפרטים לנציג שיחזור אליהם היום'), next: 'e_rep', failed: 'e_failed' }],
  ['e_rep', { type: 'end', title: 'נציג יחזור', text: 'להודות ולהיפרד' }],
  ['dnc', { type: 'action', title: 'הסרה מרשימת השיחות', tool: 'do_not_call', starter: 'כמובן,',
    text: 'לאשר שמסירים אותם מרשימת השיחות', next: 'e_removed', failed: 'e_removed' }],
  ['e_removed', { type: 'end', title: 'הוסר מהרשימה', text: 'להתנצל על ההפרעה ולהיפרד' }],
  ['e_failed', { type: 'end', title: 'תקלה', starter: 'סליחה,',
    text: 'להתנצל שמשהו לא עבד ולהגיד שנציג יחזור אליהם עוד היום' }],
].concat(opts && opts.askWhen ? [
  ['ask_when', { type: 'ask', title: 'מתי נוח לחזור', slot: 'callback_time', mode: 'free', starter: 'אין בעיה,',
    text: g('לשאול מתי נוח שתחזרי אליהם', 'לשאול מתי נוח שתחזור אליהם'), answered: 'callback' }],
] : []).concat(opts && opts.no ? [
  ['e_no', { type: 'end', title: 'לא מעוניין', starter: 'הבנתי,', text: 'להודות על הזמן ולהשאיר דלת פתוחה' }],
] : []); };

/* 1. Hot lead follow-up: someone left details for a solar quote. Qualify, then book a free roof survey. */
const lead_followup = () => fromSpec({
  name: 'חזרה לליד חם',
  business: 'סולאר אופק',
  instructions: {
    personality: 'חמה ומקצועית, משפטים קצרים, מקשיבה יותר משמדברת',
    context: 'סולאר אופק מתקינה מערכות סולאריות על גגות של בתים פרטיים, בכל הארץ.\nסקר גג בבית הלקוח: חינם וללא התחייבות, כחצי שעה.\nמחירים: מערכת ביתית טיפוסית של 10 קילוואט עולה 38,000 עד 45,000 ₪, ומחזירה את עצמה בתוך 5 עד 6 שנים.\nאפשר לממן ב-60 תשלומים. אחריות על הפאנלים: 25 שנה.\nכרגע לא מתקינים על בניינים משותפים.',
    goldenRules: RULES + ' אל תציגי חיסכון מדויק בלי סקר.',
    hotWords: 'סולאר אופק, קילוואט, ממיר, מונה דו כיווני',
    values: { agent: 'נועה', business: 'סולאר אופק' },
  },
  nodes: [
    ['greet', { type: 'start', title: 'פתיחת השיחה', starter: 'היי,', when: 'מקשיב',
      text: 'להציג את עצמך כ{agent} מ{business} ולהזכיר שהשאירו פרטים לגבי מערכת סולארית', next: 'ask_time' }],
    ['ask_time', { type: 'ask', title: 'האם נוח לדבר', slot: 'can_talk', maxVisits: 3,
      text: 'לשאול אם יש להם שתי דקות',
      options: [
        ['כן', 'כן|בטח|אפשר|יאללה|בסדר|יש לי', 'ask_property'],
        ['לא עכשיו', 'לא עכשיו|עסוק|עסוקה|אחר כך|נוהג|בעבודה', 'ask_when'],
        ['מי זה', 'מי זה|מי את|מאיפה|לא השארתי|איך השגת', 'who'],
      ] }],
    ['who', { type: 'say', title: 'מי אנחנו', starter: 'אני {agent},', when: 'הבין',
      text: 'להסביר ש{business} מתקינה מערכות סולאריות לבתים, ושחזרת אליהם כי השאירו פרטים באתר', next: 'ask_time' }],
    ['ask_property', { type: 'ask', title: 'סוג הנכס', slot: 'property_type', starter: 'מעולה,',
      text: 'לשאול אם מדובר בבית פרטי עם גג משלהם או בדירה בבניין',
      options: [
        ['בית פרטי', 'בית פרטי|בית|וילה|קוטג|דו משפחתי|גג משלי', 'ask_bill'],
        ['דירה בבניין', 'דירה|בניין|גג משותף|דירת גג', 'e_not_fit'],
      ] }],
    ['ask_bill', { type: 'ask', title: 'גובה חשבון החשמל', slot: 'bill', starter: 'מצוין,',
      text: 'לשאול בערך כמה הם משלמים על חשמל לחודשיים',
      options: [
        ['עד 800 ₪', 'עד 800|500|600|700|לא הרבה|זול', 'offer_survey'],
        ['מעל 800 ₪', 'מעל 800|1000|אלף|1500|2000|הרבה|יקר', 'mark_hot'],
        ['לא יודע', 'לא יודע|לא יודעת|לא בטוח|אין לי מושג', 'offer_survey'],
      ] }],
    ['mark_hot', { type: 'action', title: 'סימון ליד חם', tool: 'update_crm', starter: 'יפה,',
      text: 'להגיד שבחשבון כזה מערכת סולארית משתלמת במיוחד', next: 'offer_survey', failed: 'offer_survey' }],
    ['offer_survey', { type: 'ask', title: 'האם לקבוע סקר גג', slot: 'survey', maxVisits: 3,
      text: 'להציע סקר גג חינם וללא התחייבות, ולשאול איזה יום מתאים השבוע',
      options: [
        ['השבוע', 'השבוע|מחר|כן|בטח|יאללה|סגור|מתאים', 'book'],
        ['שבוע הבא', 'שבוע הבא|לא השבוע|בהמשך', 'book'],
        ['לא מעוניין', 'לא מעוניין|לא תודה|לא רלוונטי|לא צריך', 'objection'],
      ] }],
    ['objection', { type: 'ask', title: 'סיבת ההתנגדות', slot: 'objection', starter: 'מבינה,',
      text: 'לשאול מה הסיבה העיקרית',
      options: [
        ['יקר', 'יקר|מחיר|כסף|לא משתלם|השקעה', 'price_value'],
        ['לא הזמן', 'לא הזמן|אחר כך|בהמשך|עמוס|לא עכשיו', 'ask_when'],
        ['לא רלוונטי', 'לא רלוונטי|כבר יש|יש לנו מערכת|לא צריך', 'e_no'],
      ] }],
    ['price_value', { type: 'ask', title: 'הערך מול המחיר', slot: 'price_reaction', starter: 'זה הוגן,',
      text: 'להסביר שהמערכת מחזירה את עצמה בתוך 5 עד 6 שנים ואפשר לממן בתשלומים, ולשאול אם שווה לבדוק בסקר חינם',
      options: [['כן, נבדוק', 'כן|בסדר|נבדוק|אוקיי|יאללה|שווה', 'book'], ['עדיין לא', 'לא|עדיין לא|לא תודה|לא מעוניין', 'e_no']] }],
    ['book', { type: 'action', title: 'קביעת סקר גג', tool: 'schedule_meeting', starter: 'מעולה,',
      text: 'להגיד שאת קובעת להם סקר גג', next: 'confirm_wa', failed: 'e_failed' }],
    ['confirm_wa', { type: 'action', title: 'אישור בוואטסאפ', tool: 'send_whatsapp',
      text: 'להגיד שאת שולחת אישור בוואטסאפ עם המועד ושם הטכנאי', next: 'e_booked', failed: 'e_booked' }],
    ['e_booked', { type: 'end', title: 'נקבע סקר גג', text: 'להודות ולהיפרד' }],
    ['e_not_fit', { type: 'end', title: 'נכס לא מתאים', starter: 'הבנתי,',
      text: 'להסביר שכרגע מתקינים רק על גגות של בתים פרטיים, ולהיפרד בנימוס' }],
  ].concat(tail({ askWhen: true, no: true })),
});

/* 2. B2B cold call: card terminals for small businesses. Reach the owner, pitch lower fees, book a rep visit. */
const cold_call = () => fromSpec({
  name: 'שיחה קרה לעסקים',
  business: 'פייקליק',
  instructions: {
    personality: 'ישירה וקצרה, אנרגטית, מכבדת את הזמן של בעל העסק',
    context: 'פייקליק מספקת מסופי סליקה לעסקים קטנים.\nההצעה: מסוף חינם, עמלת סליקה של 0.6%, בלי דמי מנוי ובלי התחייבות.\nהכסף נכנס לחשבון בתוך יום עסקים אחד.\nנציג מגיע לעסק ומחבר את המסוף בתוך שבוע.',
    goldenRules: RULES + ' מדברים רק עם בעל העסק או עם מי שמחליט.',
    hotWords: 'פייקליק, סליקה, מסוף',
    values: { agent: 'שירן', business: 'פייקליק' },
  },
  nodes: [
    ['greet', { type: 'start', title: 'פתיחת השיחה', starter: 'היי,', when: 'מקשיב',
      text: 'להציג את עצמך כ{agent} מ{business}, שמתקשרת בקצרה לגבי עמלות הסליקה של העסק', next: 'ask_owner' }],
    ['ask_owner', { type: 'ask', title: 'האם זה בעל העסק', slot: 'is_owner',
      text: 'לשאול אם הם בעלי העסק או מי שמחליט על הסליקה',
      options: [
        ['כן', 'כן|אני|מדבר|זה אני|בעלים|מנהל', 'ask_fee'],
        ['לא', 'לא|עובד|עובדת|הוא לא כאן|היא לא כאן', 'gatekeeper'],
      ] }],
    ['gatekeeper', { type: 'ask', title: 'מתי בעל העסק זמין', slot: 'owner_available', mode: 'free', starter: 'אין בעיה,',
      text: 'לשאול מתי אפשר לתפוס את בעל העסק', answered: 'callback' }],
    ['ask_fee', { type: 'ask', title: 'העמלה היום', slot: 'current_fee', starter: 'מעולה,',
      text: 'לשאול כמה עמלת סליקה הם משלמים היום, בערך',
      options: [
        ['מעל 1%', 'מעל 1|מעל אחוז|1.2|1.5|1.8|אחוז וחצי|שני אחוז|יקר|הרבה', 'save'],
        ['עד 1%', 'עד 1|0.8|0.9|0.7|פחות מאחוז|אחוז אחד|בדיוק אחוז', 'offer'],
        ['לא יודע', 'לא יודע|לא יודעת|לא בטוח|רואה החשבון', 'offer'],
      ] }],
    ['save', { type: 'say', title: 'חיסכון', starter: 'אז אצלנו', when: 'מקשיב',
      text: 'להגיד שאצלנו העמלה 0.6%, כלומר חיסכון כבר מהחודש הראשון', next: 'offer' }],
    ['offer', { type: 'ask', title: 'האם ההצעה מעניינת', slot: 'interest', maxVisits: 3,
      text: 'להציע מסוף חינם, 0.6% עמלה ובלי התחייבות, ולשאול אם לקבוע ביקור קצר של נציג',
      options: [
        ['מעוניין', 'כן|מעוניין|מעוניינת|בוא נקבע|סגור|יאללה', 'book'],
        ['צריך לחשוב', 'לחשוב|אחשוב|להתייעץ|שותף|רואה חשבון', 'send_info'],
        ['יש חוזה', 'חוזה|התחייבות|קשור|מחויב|עוד שנה', 'contract'],
        ['לא מעוניין', 'לא מעוניין|לא תודה|לא רלוונטי|מרוצה', 'e_no'],
      ] }],
    ['contract', { type: 'ask', title: 'מתי החוזה נגמר', slot: 'contract_end', mode: 'free', starter: 'הבנתי,',
      text: 'לשאול מתי החוזה הנוכחי נגמר, כדי לחזור אליהם לקראת הסוף', answered: 'callback' }],
    ['book', { type: 'action', title: 'קביעת ביקור נציג', tool: 'schedule_meeting', starter: 'מצוין,',
      text: 'להגיד שאת קובעת ביקור קצר של נציג בעסק', next: 'confirm_wa', failed: 'e_failed' }],
    ['confirm_wa', { type: 'action', title: 'אישור בוואטסאפ', tool: 'send_whatsapp',
      text: 'להגיד שאת שולחת אישור בוואטסאפ עם המועד', next: 'e_booked', failed: 'e_booked' }],
    ['e_booked', { type: 'end', title: 'נקבע ביקור', text: 'להודות ולהיפרד' }],
    ['send_info', { type: 'action', title: 'שליחת פרטים', tool: 'send_whatsapp', starter: 'בטח,',
      text: 'להגיד שאת שולחת את הפרטים בוואטסאפ כדי שיוכלו להתייעץ', next: 'e_think', failed: 'e_think' }],
    ['e_think', { type: 'end', title: 'בשיקול', text: 'להגיד שתחזרי אליהם בעוד כמה ימים ולהיפרד' }],
  ].concat(tail({ no: true })),
});

/* 3. Quote follow-up: a kitchen quote was sent. Find out where they stand, handle price, book the signing meeting. */
const quote_followup = () => fromSpec({
  name: 'פולואפ להצעת מחיר',
  business: 'מטבחי אלון',
  instructions: {
    personality: 'אדיבה ובטוחה, לא לוחצת, מקשיבה להתלבטות',
    context: 'מטבחי אלון מתכננת ומייצרת מטבחים בהתאמה אישית.\nההצעה שנשלחה: {quote_amount}, נשלחה {quote_date}.\nאחריות של 10 שנים על הגופים ועל הפרזול. זמן ייצור: 6 שבועות מהחתימה.\nהנחה של 7% למי שחותם עד סוף החודש.',
    goldenRules: RULES + ' אל תתני הנחה מעבר ל-7%.',
    hotWords: 'מטבחי אלון, פרזול, קוורץ',
    values: { agent: 'מאיה', business: 'מטבחי אלון', quote_amount: '48,000 ₪', quote_date: 'ביום ראשון' },
  },
  nodes: [
    ['greet', { type: 'start', title: 'פתיחת השיחה', starter: 'היי,', when: 'מקשיב',
      text: 'להציג את עצמך כ{agent} מ{business} ולהזכיר את הצעת המחיר ששלחתם {quote_date}', next: 'ask_seen' }],
    ['ask_seen', { type: 'ask', title: 'האם ראו את ההצעה', slot: 'quote_seen',
      text: 'לשאול אם יצא להם לעבור על ההצעה',
      options: [
        ['ראיתי', 'כן|ראיתי|עברתי|קראתי|הסתכלתי', 'ask_thoughts'],
        ['לא ראיתי', 'לא|לא ראיתי|לא הגיע|לא יצא לי|איפה', 'resend'],
      ] }],
    ['resend', { type: 'action', title: 'שליחה חוזרת', tool: 'send_whatsapp', starter: 'בטח,',
      text: 'להגיד שאת שולחת שוב את ההצעה בוואטסאפ', next: 'e_resent', failed: 'e_failed' }],
    ['e_resent', { type: 'end', title: 'ההצעה נשלחה שוב', text: 'להגיד שתחזרי מחר לשמוע מה הם חושבים' }],
    ['ask_thoughts', { type: 'ask', title: 'מה דעתם על ההצעה', slot: 'quote_reaction', starter: 'מעולה,',
      text: 'לשאול מה הם חושבים על ההצעה',
      options: [
        ['מתאים', 'מתאים|אהבתי|נראה טוב|בסדר|מעוניין|בוא נתקדם', 'book'],
        ['יקר', 'יקר|מחיר|הרבה|יותר זול|תקציב', 'discount'],
        ['משווה הצעות', 'משווה|עוד הצעות|בודק|מתלבט|עוד ספק', 'compare'],
        ['לא מתאים', 'לא מתאים|לא מעוניין|החלטנו אחרת|הלכנו למישהו', 'e_no'],
      ] }],
    ['discount', { type: 'ask', title: 'הנחה לסגירה', slot: 'discount', starter: 'אני מבינה,',
      text: 'להציע 7% הנחה למי שחותם עד סוף החודש, ולשאול אם זה עוזר',
      options: [['מקבל', 'כן|מקבל|מקבלת|סגור|זה עוזר|יאללה', 'book'], ['עדיין יקר', 'לא|עדיין יקר|עדיין לא|לא מספיק', 'e_no']] }],
    ['compare', { type: 'ask', title: 'השוואה מול ספקים', slot: 'comparing', starter: 'הגיוני לגמרי,',
      text: 'להגיד שכדאי להשוות גם אחריות וזמן ייצור, להזכיר 10 שנות אחריות ו-6 שבועות ייצור, ולשאול אם לקבוע פגישה בתצוגה',
      options: [['בוא נקבע', 'כן|בוא נקבע|בסדר|אוקיי|יאללה', 'book'], ['צריך זמן', 'צריך זמן|עוד לא|אחשוב|אחר כך', 'ask_decision']] }],
    ['ask_decision', { type: 'ask', title: 'מתי יחליטו', slot: 'decision_date', mode: 'free', starter: 'בטח,',
      text: 'לשאול עד מתי הם מתכננים להחליט', answered: 'callback' }],
    ['book', { type: 'action', title: 'קביעת פגישת חתימה', tool: 'schedule_meeting', starter: 'מצוין,',
      text: 'להגיד שאת קובעת פגישה בתצוגה לסגירת הפרטים', next: 'confirm_wa', failed: 'e_failed' }],
    ['confirm_wa', { type: 'action', title: 'אישור בוואטסאפ', tool: 'send_whatsapp',
      text: 'להגיד שאת שולחת אישור עם הכתובת והמועד', next: 'e_booked', failed: 'e_booked' }],
    ['e_booked', { type: 'end', title: 'נקבעה פגישת חתימה', text: 'להודות ולהיפרד' }],
  ].concat(tail({ no: true })),
});

/* 4. Dormant leads: people who asked months ago and never joined. New offer, free trial, or keep warm on WhatsApp. */
const reactivate = () => fromSpec({
  name: 'החייאת לידים רדומים',
  business: 'סטודיו גל',
  instructions: {
    personality: 'אנרגטית וחברית, קלילה, בלי לחץ',
    context: 'סטודיו גל הוא סטודיו לאימונים בקבוצות קטנות.\nההטבה עכשיו: אימון ניסיון חינם, וחודש ראשון ב-99 ₪ במקום 349 ₪.\nאימונים כל יום בין 6:00 ל-21:00. עד 8 מתאמנים בקבוצה.',
    goldenRules: RULES,
    hotWords: 'סטודיו גל, פילאטיס, TRX',
    values: { agent: 'עדי', business: 'סטודיו גל' },
  },
  nodes: [
    ['greet', { type: 'start', title: 'פתיחת השיחה', starter: 'היי,', when: 'מקשיב',
      text: 'להציג את עצמך כ{agent} מ{business} ולהזכיר שהתעניינו אצלכם לפני כמה חודשים', next: 'ask_still' }],
    ['ask_still', { type: 'ask', title: 'האם עדיין רלוונטי', slot: 'still_interested',
      text: 'לשאול אם זה עדיין רלוונטי עבורם',
      options: [
        ['כן', 'כן|בטח|עדיין|רלוונטי|אולי', 'offer'],
        ['כבר מתאמן', 'כבר מתאמן|כבר מתאמנת|נרשמתי|הסתדרתי|מקום אחר', 'e_other'],
        ['לא עכשיו', 'לא עכשיו|אחר כך|עמוס|בהמשך', 'nurture'],
        ['לא מעוניין', 'לא מעוניין|לא תודה|לא רלוונטי', 'e_no'],
      ] }],
    ['offer', { type: 'ask', title: 'אימון ניסיון', slot: 'trial', starter: 'מעולה,', maxVisits: 3,
      text: 'לספר על אימון ניסיון חינם וחודש ראשון ב-99 ₪, ולשאול אם לשריין אימון ניסיון',
      options: [
        ['כן', 'כן|בטח|יאללה|סגור|בוא|אשמח', 'book'],
        ['לא בטוח', 'לא בטוח|לא יודע|לא יודעת|צריך לחשוב|מתלבט', 'hesitate'],
        ['לא', 'לא|לא תודה|לא מעוניין', 'nurture'],
      ] }],
    ['hesitate', { type: 'ask', title: 'התלבטות', slot: 'hesitation', starter: 'זה בסדר,',
      text: 'להרגיע שאימון הניסיון חינם ובלי התחייבות, ולשאול שוב אם לנסות',
      options: [['בוא ננסה', 'כן|בוא ננסה|בסדר|אוקיי|יאללה', 'book'], ['לא', 'לא|לא תודה|עדיין לא', 'nurture']] }],
    ['book', { type: 'action', title: 'שריון אימון ניסיון', tool: 'schedule_meeting', starter: 'מצוין,',
      text: 'להגיד שאת משריינת להם אימון ניסיון', next: 'confirm_wa', failed: 'e_failed' }],
    ['confirm_wa', { type: 'action', title: 'אישור בוואטסאפ', tool: 'send_whatsapp',
      text: 'להגיד שאת שולחת אישור עם השעה והכתובת', next: 'e_booked', failed: 'e_booked' }],
    ['e_booked', { type: 'end', title: 'נקבע אימון ניסיון', text: 'להודות ולהיפרד באנרגיה' }],
    ['nurture', { type: 'action', title: 'שליחת ההטבה', tool: 'send_whatsapp', starter: 'אין בעיה,',
      text: 'להגיד שאת שולחת את ההטבה בוואטסאפ, למקרה שירצו בהמשך', next: 'e_nurture', failed: 'e_nurture' }],
    ['e_nurture', { type: 'end', title: 'נשלחה הטבה', text: 'להודות ולהיפרד' }],
    ['e_other', { type: 'end', title: 'מתאמן במקום אחר', starter: 'שמחה לשמוע,',
      text: 'לאחל הצלחה ולהגיד שהם תמיד מוזמנים' }],
  ].concat(tail({ no: true })),
});

/* 5. Upsell to an existing customer: check satisfaction first, then offer an upgrade with a free first month. */
const upsell = () => fromSpec({
  name: 'שדרוג ללקוח קיים',
  business: 'נטקום',
  instructions: {
    personality: 'חם ושירותי, מודה ללקוח על הנאמנות, ממוקד',
    context: 'נטקום היא ספקית אינטרנט בסיבים. הלקוח מנוי היום על 500 מגה.\nההטבה ללקוחות קיימים: שדרוג ל-1000 מגה עם נתב Mesh בתוספת 20 ₪ לחודש בשנה הראשונה.\nהחודש הראשון של השדרוג חינם, ואפשר לחזור לחבילה הקודמת בכל רגע.',
    goldenRules: 'אל תבטיח משהו שלא מופיע ברקע. מי שאומר שהוא לא מעוניין פעמיים, מסיימים איתו בנימוס. מי שמבקש להסיר אותו, מסירים מיד ובלי שכנוע. לקוח עם תקלה פתוחה לא מקבל הצעה: קודם מטפלים בתקלה.',
    hotWords: 'נטקום, Mesh, מגה',
    values: { agent: 'רון', business: 'נטקום' },
  },
  nodes: [
    ['greet', { type: 'start', title: 'פתיחת השיחה', starter: 'היי,', when: 'מקשיב',
      text: 'להציג את עצמך כ{agent} מ{business}, ולהגיד שאתה מתקשר ללקוחות ותיקים עם הטבה', next: 'ask_satisfied' }],
    ['ask_satisfied', { type: 'ask', title: 'שביעות רצון', slot: 'satisfaction',
      text: 'לשאול איך האינטרנט עובד להם בזמן האחרון',
      options: [
        ['מרוצה', 'מצוין|מעולה|טוב|מרוצה|עובד', 'offer'],
        ['בסדר', 'בסדר|סביר|ככה ככה|נורמלי', 'offer'],
        ['יש תקלות', 'תקלות|נופל|איטי|בעיות|לא עובד|מתנתק', 'issue'],
      ] }],
    ['issue', { type: 'ask', title: 'פירוט התקלה', slot: 'issue', mode: 'free', starter: 'מצטער לשמוע,',
      text: 'לשאול מה בדיוק קורה', answered: 'ticket' }],
    ['ticket', { type: 'action', title: 'פתיחת קריאת שירות', tool: 'update_crm', starter: 'רשמתי,',
      text: 'להגיד שפתחת קריאת שירות וטכנאי יחזור אליהם היום', next: 'e_ticket', failed: 'e_failed' }],
    ['e_ticket', { type: 'end', title: 'נפתחה קריאת שירות', text: 'להתנצל על אי הנוחות ולהיפרד' }],
    ['offer', { type: 'ask', title: 'הצעת השדרוג', slot: 'upgrade', starter: 'אז,', maxVisits: 3,
      text: 'להציע שדרוג ל-1000 מגה עם נתב Mesh בתוספת 20 ₪ לחודש, עם חודש ראשון חינם, ולשאול אם לשדרג',
      options: [
        ['כן', 'כן|בטח|יאללה|סגור|מעולה|לשדרג', 'upgrade'],
        ['יקר', 'יקר|הרבה|לא משתלם|כסף', 'trial'],
        ['לא צריך', 'לא צריך|מספיק לי|לא תודה|טוב לי ככה', 'e_keep'],
      ] }],
    ['trial', { type: 'ask', title: 'חודש ניסיון', slot: 'trial', starter: 'אני מבין,',
      text: 'להזכיר שהחודש הראשון חינם ואפשר לחזור בכל רגע, ולשאול אם לנסות',
      options: [['כן', 'כן|בסדר|ננסה|אוקיי|יאללה', 'upgrade'], ['לא', 'לא|לא תודה|עדיין לא', 'e_keep']] }],
    ['upgrade', { type: 'action', title: 'ביצוע השדרוג', tool: 'create_order', starter: 'מעולה,',
      text: 'להגיד שאתה מבצע את השדרוג', next: 'e_upgraded', failed: 'e_failed' }],
    ['e_upgraded', { type: 'end', title: 'שודרג', text: 'להגיד שהנתב החדש יישלח בתוך כמה ימים, ולהודות' }],
    ['e_keep', { type: 'end', title: 'נשאר בחבילה', starter: 'בסדר גמור,', text: 'להודות שהם לקוחות ולהיפרד' }],
  ].concat(tail({ male: true })),
});

/* 6. Sales meeting confirmation: fewer no-shows. Confirm, move, or save a cancellation with an online meeting.
   Modeled on the format doc's full example. */
const meeting_confirm = () => fromSpec({
  name: 'אישור פגישת מכירה',
  business: 'סולאר אופק',
  instructions: {
    personality: 'חמה, משפטים קצרים, אף פעם לא לוחצת',
    context: '{business} קבעה עם הלקוח פגישה עם {rep} ב{meeting_date} בשעה {meeting_time}.\nאפשר להזיז לכל יום חול בין 8:00 ל-18:00. אפשר גם פגישה אונליין בזום, באותו אורך.',
    goldenRules: RULES,
    hotWords: 'סולאר אופק, זום',
    values: { agent: 'נועה', business: 'סולאר אופק', rep: 'אבי', meeting_date: 'יום שלישי', meeting_time: '10:00' },
  },
  nodes: [
    ['greet', { type: 'start', title: 'פתיחת השיחה', starter: 'שלום,', when: 'מקשיב',
      text: 'להציג את עצמך כ{agent} מ{business}, שמתקשרת לגבי הפגישה עם {rep} ב{meeting_date}', next: 'confirm' }],
    ['confirm', { type: 'ask', title: 'האם הפגישה בתוקף', slot: 'confirmed', maxVisits: 2,
      text: 'לשאול אם הפגישה ב{meeting_date} בשעה {meeting_time} עדיין מתאימה',
      options: [
        ['כן', 'כן|מתאים|בטח|סגור|אני שם|נתראה', 'e_kept'],
        ['להזיז', 'להזיז|לשנות|מועד אחר|יום אחר|לדחות', 'pick_date'],
        ['לבטל', 'לבטל|תבטלי|לא אגיע|לא מתאים|לא מעוניין', 'save_meeting'],
      ],
      unclear: 'confirm' }],
    ['pick_date', { type: 'ask', title: 'המועד החדש', slot: 'new_date', mode: 'free', starter: 'בטח,',
      text: 'לשאול איזה יום ושעה מתאימים יותר', answered: 'move', unclear: 'e_rep_later' }],
    ['move', { type: 'action', title: 'הזזת הפגישה', tool: 'reschedule_meeting', starter: 'בסדר גמור,',
      text: 'להגיד שאת מזיזה את הפגישה', next: 'e_moved', failed: 'e_failed' }],
    ['save_meeting', { type: 'ask', title: 'הצעת פגישה אונליין', slot: 'online', starter: 'חבל,',
      text: 'להציע במקום זה פגישה אונליין בזום, באותו אורך, ולשאול אם זה מתאים',
      options: [['אונליין מתאים', 'כן|זום|אונליין|מתאים|בסדר', 'move_online'], ['לבטל', 'לא|לבטל|לא מעוניין|לא צריך', 'cancel']] }],
    ['move_online', { type: 'action', title: 'מעבר לזום', tool: 'reschedule_meeting', starter: 'מעולה,',
      text: 'להגיד שאת מעבירה את הפגישה לזום ושולחת קישור', next: 'e_online', failed: 'e_failed' }],
    ['cancel', { type: 'action', title: 'ביטול הפגישה', tool: 'cancel_meeting', starter: 'בסדר,',
      text: 'לאשר שאת מבטלת את הפגישה', next: 'e_cancelled', failed: 'e_failed' }],
    ['e_kept', { type: 'end', title: 'הפגישה בתוקף', starter: 'מעולה,', text: 'להודות ולחזור על היום והשעה' }],
    ['e_moved', { type: 'end', title: 'הפגישה הוזזה', text: 'להודות ולהגיד שיגיע אישור עם המועד החדש' }],
    ['e_online', { type: 'end', title: 'עבר לזום', text: 'להודות ולהיפרד' }],
    ['e_cancelled', { type: 'end', title: 'הפגישה בוטלה', text: 'לאשר את הביטול ולהשאיר דלת פתוחה' }],
    ['e_rep_later', { type: 'end', title: 'נציג יתאם', text: 'להגיד שנציג יחזור אליהם לתאם מועד' }],
  ].concat(tail()),
});

/* 7. CallPilot's own sales agent: calls an inbound lead, finds the need, books a demo.
   No prices or customer claims: this is a real company, so nothing is invented. */
const callpilot = () => fromSpec({
  name: 'סוכן מכירות CallPilot',
  business: 'CallPilot',
  instructions: {
    personality: 'אנרגטית, ממוקדת ומקשיבה, משפטים קצרים',
    context: 'CallPilot בונה לעסקים סוכני AI לשיחות טלפון: מענה לשיחות נכנסות, שיחות יוצאות ללידים, תיאום פגישות ישירות ביומן, ואישורים ותזכורות בוואטסאפ.\nהמחיר נקבע לפי נפח השיחות ומה שהסוכן צריך לעשות, ובהדגמה בונים הצעה מדויקת לעסק.',
    goldenRules: RULES + ' אל תמציאי מחירים, לקוחות או התחייבויות. אם שואלים על מחיר, מסבירים שבהדגמה בונים הצעה מדויקת.',
    hotWords: 'CallPilot, קולפיילוט, וואטסאפ, CRM',
    values: { agent: 'עדי', business: 'CallPilot' },
  },
  nodes: [
    ['greet', { type: 'start', title: 'פתיחת השיחה', starter: 'היי,', when: 'מקשיב',
      text: 'להציג את עצמך כ{agent} מ-{business} ולהזכיר שהשאירו פרטים באתר לגבי סוכן AI לשיחות טלפון', next: 'ask_time' }],
    ['ask_time', { type: 'ask', title: 'האם יש שתי דקות', slot: 'can_talk', maxVisits: 3,
      text: 'לשאול אם יש להם שתי דקות',
      options: [
        ['כן', 'כן|בטח|יאללה|אפשר|בסדר|יש לי', 'ask_need'],
        ['לא עכשיו', 'לא עכשיו|עסוק|עסוקה|אחר כך|בפגישה|נוהג', 'ask_when'],
        ['מי זה', 'מי זה|מי את|מה זה|מאיפה|לא השארתי|איזה חברה', 'who'],
      ] }],
    ['who', { type: 'say', title: 'מי אנחנו', starter: 'אני {agent},', when: 'הבין',
      text: 'להסביר ש{business} בונה לעסקים סוכני AI שעונים לטלפון, מתקשרים ללידים ומתאמים פגישות', next: 'ask_time' }],
    ['ask_need', { type: 'ask', title: 'מה הצורך', slot: 'need', starter: 'מעולה,',
      text: 'לשאול מה הכי מעסיק אותם היום בטלפון',
      options: [
        ['שיחות שלא נענות', 'לא עונים|מפספסים|שיחות שלא נענות|אין מי שיענה|מענה|שיחות נכנסות|בלילה', 'pitch_inbound'],
        ['חזרה ללידים', 'לידים|חזרה ללידים|לא מספיקים לחזור|פייסבוק|קמפיין|שיחות יוצאות', 'pitch_leads'],
        ['תיאום פגישות', 'פגישות|תורים|יומן|תיאום|לקבוע', 'pitch_meetings'],
      ] }],
    ['pitch_inbound', { type: 'say', title: 'מענה לשיחות נכנסות', starter: 'בשביל זה בדיוק', when: 'מקשיב',
      text: 'להסביר שהסוכן עונה לכל שיחה, גם בלילה ובסוף השבוע, ומעביר אליהם רק את מה שדורש אותם', next: 'ask_demo' }],
    ['pitch_leads', { type: 'say', title: 'חזרה אוטומטית ללידים', starter: 'זה בדיוק', when: 'מקשיב',
      text: 'להסביר שהסוכן מתקשר לכל ליד תוך דקות, שואל את שאלות הסינון שלהם ומעדכן את הסטטוס', next: 'ask_demo' }],
    ['pitch_meetings', { type: 'say', title: 'תיאום פגישות', starter: 'בשביל זה', when: 'מקשיב',
      text: 'להסביר שהסוכן קובע פגישות ישירות ביומן ושולח אישור ותזכורת בוואטסאפ', next: 'ask_demo' }],
    ['ask_demo', { type: 'ask', title: 'האם לקבוע הדגמה', slot: 'demo', maxVisits: 3,
      text: 'להציע הדגמה של 20 דקות שבה בונים סוכן על התסריט של העסק, ולשאול מתי נוח',
      options: [
        ['השבוע', 'השבוע|מחר|כן|בטח|יאללה|סגור|מתאים', 'book'],
        ['שבוע הבא', 'שבוע הבא|בהמשך|לא השבוע', 'book'],
        ['לא מעוניין', 'לא מעוניין|לא רלוונטי|לא תודה|יש לנו כבר|לא צריך', 'objection'],
      ] }],
    ['objection', { type: 'ask', title: 'סיבת ההתנגדות', slot: 'objection', starter: 'מבינה,',
      text: 'לשאול מה הסיבה העיקרית',
      options: [
        ['כבר יש פתרון', 'יש לנו|כבר יש|עובדים עם|מוקד|מזכירה', 'side_by_side'],
        ['לא הזמן', 'לא הזמן|אחר כך|בהמשך|עמוס|לא עכשיו', 'ask_when'],
        ['לא רלוונטי', 'לא רלוונטי|לא צריך|לא מתאים|קטן מדי', 'e_no'],
      ] }],
    ['side_by_side', { type: 'ask', title: 'לצד מה שקיים', slot: 'side_by_side', starter: 'שווה לדעת,',
      text: 'להגיד שהסוכן עובד לצד מה שיש להם, לוקח את השעות בלי מענה ואת החזרה ללידים, ולהציע הדגמה קצרה בלי התחייבות',
      options: [['בוא נקבע', 'כן|בוא|נקבע|בסדר|אוקיי|יאללה', 'book'], ['לא תודה', 'לא|לא תודה|לא צריך', 'e_no']] }],
    ['book', { type: 'action', title: 'קביעת הדגמה', tool: 'schedule_meeting', starter: 'מעולה,',
      text: 'להגיד שאת קובעת הדגמה של 20 דקות', next: 'confirm_wa', failed: 'e_failed' }],
    ['confirm_wa', { type: 'action', title: 'אישור בוואטסאפ', tool: 'send_whatsapp',
      text: 'להגיד שאת שולחת בוואטסאפ אישור עם קישור לפגישה', next: 'e_booked', failed: 'e_booked' }],
    ['e_booked', { type: 'end', title: 'נקבעה הדגמה', text: 'להגיד שמחכים לראות אותם בהדגמה' }],
  ].concat(tail({ askWhen: true, no: true })),
});

export const templates = { lead_followup, cold_call, quote_followup, reactivate, upsell, meeting_confirm, callpilot };
/* what each template is, for the builder agent and the empty canvas */
export const TEMPLATE_INFO = [
  { key: 'lead_followup', icon: 'phone', c: '--green', title: 'חזרה לליד חם', sub: 'מתקשר למי שהשאיר פרטים, מסנן וקובע פגישה.', prompt: 'בנה תסריט חזרה לליד חם' },
  { key: 'cold_call', icon: 'bolt', c: '--purple', title: 'שיחה קרה לעסקים', sub: 'מגיע לבעל העסק, מציג חיסכון וקובע ביקור.', prompt: 'בנה תסריט שיחה קרה לעסקים' },
  { key: 'quote_followup', icon: 'message', c: '--orange', title: 'פולואפ להצעת מחיר', sub: 'בודק איפה הלקוח עומד, מטפל במחיר וסוגר פגישה.', prompt: 'בנה תסריט פולואפ להצעת מחיר' },
  { key: 'reactivate', icon: 'loop', c: '--teal', title: 'החייאת לידים רדומים', sub: 'חוזר ללידים ישנים עם הטבה ואימון ניסיון.', prompt: 'בנה תסריט החייאת לידים רדומים' },
  { key: 'upsell', icon: 'database', c: '--blue', title: 'שדרוג ללקוח קיים', sub: 'בודק שביעות רצון, ואז מציע שדרוג עם חודש חינם.', prompt: 'בנה תסריט שדרוג ללקוח קיים' },
  { key: 'meeting_confirm', icon: 'calendar', c: '--red', title: 'אישור פגישת מכירה', sub: 'מאשר, מזיז, או מציל ביטול עם פגישה בזום.', prompt: 'בנה תסריט אישור פגישת מכירה' },
  { key: 'callpilot', icon: 'headset', c: '--indigo', title: 'סוכן מכירות CallPilot', sub: 'מבין את הצורך וקובע הדגמה. בלי מחירים מומצאים.', prompt: 'בנה סוכן מכירות של CallPilot' },
];
CF.templates = templates;
CF.TEMPLATE_INFO = TEMPLATE_INFO;
