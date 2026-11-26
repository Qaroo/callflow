/* The builder agent's mouse and keyboard: a visible cursor that moves to real elements, clicks them and types
   into them, so the user sees the builder agent use the app like a person. read_screen lists what is on screen with refs;
   click/type act on a ref. A few things are off limits: the settings (the API key), the chat itself (it has
   its own tools), and the real-call button (only the real_call tool dials, after the user approves). */
import CF from './core.js';

const cur = (CF.cursor = { x: -60, y: -60, on: false, clicking: false, label: 'מוח מהיר', typing: false });
const touch = () => CF.emit('cursor');
const W = (ms) => CF.wait(CF.reducedMotion() ? 0 : ms);

export function showCursor(on) {
  if (on && !cur.on) {
    cur.on = true;
    // enter from the bottom corner of the chat
    const chatEl = document.getElementById('chat');
    const r = chatEl ? chatEl.getBoundingClientRect() : { left: 40, top: window.innerHeight - 80 };
    cur.x = r.left + 30; cur.y = r.top + 30;
  }
  if (!on) cur.on = false;
  touch();
}

export async function moveTo(target) {
  let x;
  let y;
  if (target && target.getBoundingClientRect) {
    if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = target.getBoundingClientRect();
    x = r.left + Math.min(r.width / 2, 60);
    y = r.top + Math.min(r.height / 2, 22);
  } else if (target) ({ x, y } = target);
  else return;
  showCursor(true);
  const d = Math.hypot(x - cur.x, y - cur.y);
  cur.x = x; cur.y = y;
  cur.dur = Math.round(Math.min(700, 220 + d * 0.6));
  touch();
  await W(cur.dur + 40);
}

async function press() {
  cur.clicking = true; touch();
  await W(160);
  cur.clicking = false; touch();
}

/* ---------- what is on screen ---------- */
const BLOCK = (el) => !!(
  el.closest('#chat') || el.closest('#agent-cursor') ||
  el.closest('.modal[aria-label="הגדרות"]') || el.matches('[aria-label="הגדרות"], [title="הגדרות"]') ||
  el.closest('.dial') || el.matches('input[type=password]')
);
const DIAL = (el) => !!(el.closest('.dial-btn') || el.closest('.dial'));
const visible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
};
const labelOf = (el) => {
  const t = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 60);
};
let refs = new Map();

export function readScreen() {
  refs = new Map();
  let i = 0;
  const els = [];
  document.querySelectorAll('a[href], button, input, textarea, select, [role=tab], [role=button], .node').forEach((el) => {
    if (i >= 90 || el.disabled || !visible(el) || BLOCK(el)) return;
    const ref = 'r' + (++i);
    refs.set(ref, el);
    const tag = el.classList.contains('node') ? 'step' : el.tagName.toLowerCase();
    const item = { ref, kind: tag === 'a' ? 'link' : tag === 'textarea' ? 'input' : tag, label: labelOf(el) };
    if (tag === 'step') item.label = ((el.querySelector('.n-key, .key') || {}).innerText || '') + ' ' + labelOf(el).slice(0, 40);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') item.value = String(el.value || '').slice(0, 60);
    if (el.getAttribute('aria-selected') === 'true' || el.classList.contains('on')) item.selected = true;
    els.push(item);
  });
  const modal = document.querySelector('.modal[role=dialog]');
  const heads = Array.from(document.querySelectorAll('h1, h2, h3')).filter(visible).map((h) => h.innerText.trim()).filter(Boolean).slice(0, 8);
  return { ok: true, page: CF.ui.view, modal: modal ? modal.getAttribute('aria-label') : null, headings: heads, elements: els };
}

const DESTRUCTIVE = /מחק|מחיקה|delete|remove|נקה|איפוס|אפס|reset|הסר|clear/i;
export function describeRef(ref) {
  const el = refs.get(ref);
  if (!el || !document.contains(el)) return null;
  return { el, label: labelOf(el), destructive: DESTRUCTIVE.test(labelOf(el)), dial: DIAL(el), blocked: BLOCK(el) };
}

export async function click(ref) {
  const d = describeRef(ref);
  if (!d) return { ok: false, error: `ref ${ref} is not on screen anymore. Call read_screen again.` };
  if (d.dial) return { ok: false, error: 'real calls go only through the real_call tool' };
  if (d.blocked) return { ok: false, error: 'that element is off limits for the agent' };
  await moveTo(d.el);
  await press();
  d.el.click();
  await W(350);
  return { ok: true, clicked: d.label, page: CF.ui.view, modal: (document.querySelector('.modal[role=dialog]') || { getAttribute: () => null }).getAttribute('aria-label') };
}

/* React-controlled fields: set through the native setter, then fire input */
function setValue(el, v) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
export async function typeInto(el, text, opts) {
  opts = opts || {};
  await moveTo(el);
  await press();
  el.focus({ preventScroll: true });
  if (el.tagName === 'SELECT') {
    const o = Array.from(el.options).find((x) => x.value === text || x.text.trim() === text);
    if (!o) return { ok: false, error: 'no such option. Options: ' + Array.from(el.options).map((x) => x.text.trim()).join(', ') };
    setValue(el, o.value);
    return { ok: true };
  }
  cur.typing = true; touch();
  let v = opts.append ? el.value : '';
  if (!opts.append) setValue(el, '');
  const step = text.length > 80 ? Math.ceil(text.length / 40) : 1; // long texts type in chunks
  for (let i = 0; i < text.length; i += step) {
    v += text.slice(i, i + step);
    setValue(el, v);
    await W(step > 1 ? 30 : 38);
  }
  cur.typing = false; touch();
  if (opts.submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    if (el.form && el.form.requestSubmit && el.tagName === 'INPUT') el.form.requestSubmit();
  }
  return { ok: true };
}
export async function type(ref, text, submit) {
  const d = describeRef(ref);
  if (!d) return { ok: false, error: `ref ${ref} is not on screen anymore. Call read_screen again.` };
  if (d.blocked || d.dial) return { ok: false, error: 'that field is off limits for the agent' };
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(d.el.tagName)) return { ok: false, error: 'that is not a text field' };
  const r = await typeInto(d.el, String(text), { submit });
  return Object.assign(r, { field: d.label });
}

export async function clickEl(el) { await moveTo(el); await press(); el.click(); await W(300); }

/* navigate through the top bar or the menu, like a person would */
export async function navigate(page) {
  const hash = { studio: '#/studio', agents: '#/agents', voices: '#/voices' }[page];
  if (!hash) return { ok: false, error: 'page must be studio, agents or voices' };
  const link = Array.from(document.querySelectorAll(`a[href="${hash}"]`)).find(visible);
  if (link) await clickEl(link);
  else CF.navigate(page === 'studio' ? 'flows' : page);
  await W(400);
  return { ok: true, page: CF.ui.view };
}
