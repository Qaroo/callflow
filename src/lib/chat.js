/* Chat store for the AI chat: one log, chips (suggested replies), typing rows, streaming.
   Messages are plain data; components/Chat.jsx decides how each kind looks. */
import CF from './core.js';

const chat = {
  log: [],
  chips: [],
};
CF.chat = chat;
export default chat;

const touch = () => CF.emit('chat');
let mid = 0;

/* role: 'bot' | 'user' | 'sys' | 'card' | 'typing'.  card messages carry { card: { kind, ...data } } */
chat.add = (role, content, opts) => {
  opts = opts || {};
  const msg = { id: ++mid, role, via: opts.via || null, viaClass: opts.viaClass || '', viaIcon: opts.viaIcon || null, receipts: opts.receipts || null };
  if (role === 'card') msg.card = content;
  else msg.text = content == null ? '' : String(content);
  chat.log.push(msg);
  touch();
  return msg;
};
chat.update = () => touch();

chat.stream = async (text, opts) => {
  opts = opts || {};
  const msg = chat.add('bot', '', Object.assign({}, opts, { receipts: null }));
  if (CF.reducedMotion()) {
    msg.text = text;
  } else {
    const parts = text.split(/(\s+)/);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc += parts[i];
      if (i % 2 === 0) { msg.text = acc; touch(); await CF.wait(14); }
    }
    msg.text = text;
  }
  if (opts.receipts && opts.receipts.length) msg.receipts = opts.receipts;
  touch();
  return msg;
};

chat.typing = (via) => {
  const msg = chat.add('typing', '', { via, viaClass: 'brain', viaIcon: via ? 'sparkle' : null });
  return () => {
    chat.log = chat.log.filter((x) => x !== msg);
    touch();
  };
};

chat.clear = () => { chat.log = []; touch(); };

chat.setChips = (list) => { chat.chips = list || []; touch(); };

chat.submit = (text) => CF.assistant.handle(text);

chat.open = () => { CF.ui.chatOpen = true; CF.emit('chatOpen'); };
chat.close = () => { CF.ui.chatOpen = false; CF.emit('chatOpen'); };
