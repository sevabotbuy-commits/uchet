'use strict';

/* Учёт вещей — Telegram Mini App.
   Данные: Google-таблица через Apps Script (см. apps-script/Code.gs).
   Демо без Telegram и сервера: откройте страницу с ?demo=1 */

const tg = window.Telegram && window.Telegram.WebApp;
const DEMO = new URLSearchParams(location.search).has('demo');
const STATUS = { inStock: 'В наличии', reserved: 'Бронь', sold: 'Продано' };
const TABS = [STATUS.inStock, STATUS.reserved, STATUS.sold, 'Все'];
const STALE_DAYS = 60;          // «долго лежит»
const AUTO_REFRESH_MS = 60000;  // при возврате в приложение обновлять, если данные старше минуты
const CACHE_KEY = DEMO ? 'uv.demo.cache' : 'uv.cache';
const DRAFT_KEY = DEMO ? 'uv.demo.draft' : 'uv.draft';
const DEFAULT_LISTS = {
  category: [],
  condition: ['Новое с бирками', 'Отличное', 'Хорошее', 'Есть следы носки'],
  source: ['Выкуп', 'Комиссия'],
  authenticity: ['Не проверено', 'Проверено', 'Есть сомнения'],
  status: [STATUS.inStock, STATUS.reserved, STATUS.sold],
};

const state = {
  items: [],
  lists: { ...DEFAULT_LISTS },
  tab: STATUS.inStock,
  category: '',
  query: '',
  sort: 'new',
  view: 'list',
  stack: [],          // история экранов для «Назад»
  current: null,      // открытая вещь
  photos: new Map(),  // id → dataURL | null (миниатюры)
  fullPhotos: new Map(),
  form: { mode: 'add', photo: null, removePhoto: false, dirty: false, hadPhoto: false },
  lastLoad: 0,
  loading: false,
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- утилиты

/** Создаёт элемент; текст всегда через textContent (без HTML-вставок). */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === false) return;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  });
  children.flat().forEach((c) => {
    if (c === null || c === undefined || c === false || c === '') return;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.forEach((c) => node.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return node;
}

const ICONS = {
  shirt: 'M8 3 3 6l2 4 2-1v12h10V9l2 1 2-4-5-3a4 4 0 0 1-8 0Z',
  box: 'M3 7l9-4 9 4-9 4-9-4Zm0 0v10l9 4 9-4V7M12 11v10',
};
function icon(name) {
  return svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svg('path', { d: ICONS[name] }));
}

const isNum = (v) => typeof v === 'number' && isFinite(v);
const nf = new Intl.NumberFormat('ru-RU');
const rub = (n) => (isNum(n) ? nf.format(Math.round(n)) + ' ₽' : '—');
const signedRub = (n) => (isNum(n) ? (n > 0 ? '+' : n < 0 ? '−' : '') + nf.format(Math.abs(Math.round(n))) + ' ₽' : '—');
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const days = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
const pieces = (n) => `${n} шт.`;

function isoOf(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const todayIso = () => isoOf(new Date());
/** «10.11.2026» → Date */
function parseRuDate(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s || '');
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}
const ruToIso = (s) => { const d = parseRuDate(s); return d ? isoOf(d) : ''; };
const isoToRu = (s) => (s ? s.split('-').reverse().join('.') : '');
const dayDiff = (a, b) => Math.round((b - a) / 86400000);

function profitOf(item) {
  if (!isNum(item.salePrice) || !isNum(item.buyPrice)) return null;
  return item.salePrice - item.buyPrice;
}
/** Сколько дней вещь лежит (для непроданных) или продавалась (для проданных). */
function daysHeld(item) {
  const from = parseRuDate(item.buyDate);
  if (!from) return null;
  const to = item.status === STATUS.sold ? parseRuDate(item.saleDate) : new Date();
  return to ? Math.max(0, dayDiff(from, to)) : null;
}
const isStale = (item) => item.status !== STATUS.sold && (daysHeld(item) || 0) >= STALE_DAYS;

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* нет места/запрещено */ } },
  del(key) { try { localStorage.removeItem(key); } catch (e) { /* нет */ } },
};

function toast(text, ms = 3000) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function haptic(type) {
  try {
    if (!tg || !tg.HapticFeedback) return;
    if (type === 'tap') tg.HapticFeedback.selectionChanged();
    else tg.HapticFeedback.notificationOccurred(type);
  } catch (e) { /* старый Telegram */ }
}

/** Подтверждение: в Telegram — родное окно, в браузере — confirm(). */
function ask(text) {
  return new Promise((resolve) => {
    if (tg && tg.initData && tg.showConfirm) {
      try { tg.showConfirm(text, (ok) => resolve(Boolean(ok))); return; } catch (e) { /* ниже */ }
    }
    resolve(window.confirm(text));
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- сервер

async function api(action, payload) {
  if (DEMO) return demoApi(action, payload || {});
  const url = window.APP_CONFIG && window.APP_CONFIG.API_URL;
  if (!url || !url.startsWith('https://')) throw Object.assign(new Error('Не указан адрес сервера в config.js.'), { code: 'setup' });
  let res;
  try {
    // text/plain — «простой» запрос: браузер не шлёт предварительную CORS-проверку,
    // которую Apps Script не поддерживает.
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload: payload || {}, initData: tg ? tg.initData : '' }),
    });
  } catch (e) {
    throw Object.assign(new Error('Нет связи с сервером. Проверьте интернет.'), { code: 'network' });
  }
  let body;
  try { body = await res.json(); } catch (e) {
    throw Object.assign(new Error('Сервер ответил непонятно. Проверьте развертывание Apps Script.'), { code: 'setup' });
  }
  if (!body.ok) throw Object.assign(new Error(body.error || 'Ошибка сервера.'), { code: body.code || '' });
  return body.data;
}

// ---------------------------------------------------------------- навигация

const VIEWS = ['list', 'item', 'form', 'stats'];

function show(view, { push = true } = {}) {
  if (push && state.view !== view) state.stack.push(state.view);
  if (view === 'list') state.stack = [];
  state.view = view;
  VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== view; });
  window.scrollTo(0, 0);
  if (tg && tg.BackButton) { if (view === 'list') tg.BackButton.hide(); else tg.BackButton.show(); }
  setClosingGuard(view === 'form' && state.form.dirty);
}

async function goBack() {
  if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return; }
  if (!$('#sell-sheet').hidden) { $('#sell-sheet').hidden = true; return; }
  if (state.view === 'form' && state.form.dirty && state.form.mode === 'edit') {
    if (!(await ask('Выйти без сохранения изменений?'))) return;
  }
  const prev = state.stack.pop() || 'list';
  if (prev === 'item' && state.current) openItem(state.current.id, { push: false });
  else if (prev === 'stats') { show('stats', { push: false }); renderStats(); }
  else { renderList(); show(prev, { push: false }); }
}

function setClosingGuard(on) {
  try {
    if (!tg || !tg.initData) return;
    if (on) tg.enableClosingConfirmation(); else tg.disableClosingConfirmation();
  } catch (e) { /* старый Telegram */ }
}

// ---------------------------------------------------------------- загрузка

function setLoading(on) {
  state.loading = on;
  $('#btn-refresh').classList.toggle('spin', on);
}

async function loadItems({ silent = false } = {}) {
  if (state.loading) return;
  setLoading(true);
  if (!silent && !state.items.length) $('#list-note').textContent = 'Загрузка…';
  try {
    state.items = await api('list');
    state.lastLoad = Date.now();
    storage.set(CACHE_KEY, { items: state.items, lists: state.lists, at: state.lastLoad });
    // Миниатюры могли поменяться — забываем те, у которых больше нет фото.
    state.items.forEach((i) => { if (!i.hasPhoto) { state.photos.delete(i.id); state.fullPhotos.delete(i.id); } });
    refreshCurrentView();
  } finally {
    setLoading(false);
  }
}

function refreshCurrentView() {
  if (state.view === 'list') renderList();
  else if (state.view === 'stats') renderStats();
  else if (state.view === 'item' && state.current) {
    const fresh = state.items.find((i) => i.id === state.current.id);
    if (fresh) openItem(fresh.id, { push: false }); else { toast('Вещь удалили'); show('list'); renderList(); }
  }
}

/** Ошибки «вещь изменили/удалили» — обновляем данные и показываем свежую версию. */
async function handleWriteError(e, errBox) {
  haptic('error');
  if (e.code === 'conflict' || e.code === 'notfound') {
    toast(e.message, 4500);
    $('#sell-sheet').hidden = true;
    try { await loadItems({ silent: true }); } catch (err) { /* покажем старое */ }
    if (state.view === 'form') {
      state.form.dirty = false;
      const fresh = state.current && state.items.find((i) => i.id === state.current.id);
      state.stack = ['list'];
      if (fresh) openItem(fresh.id, { push: false }); else show('list');
    }
    return;
  }
  if (errBox) errBox.textContent = e.message; else toast(e.message, 4500);
}

// ---------------------------------------------------------------- список

function renderTabs() {
  $('#status-tabs').replaceChildren(...TABS.map((t) => {
    const n = t === 'Все' ? state.items.length : state.items.filter((i) => i.status === t).length;
    return el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.tab === t),
      onclick: () => { state.tab = t; haptic('tap'); renderList(); },
    }, t, n ? el('span', { class: 'count' }, n) : null);
  }));
}

function renderChips() {
  const pool = state.tab === 'Все' ? state.items : state.items.filter((i) => i.status === state.tab);
  const cats = [...new Set(pool.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  if (state.category && !cats.includes(state.category)) cats.unshift(state.category);
  const box = $('#cat-chips');
  box.hidden = cats.length < 2 && !state.category;
  box.replaceChildren(...['', ...cats].map((c) => el('button', {
    type: 'button', 'aria-pressed': String(state.category === c),
    onclick: () => { state.category = c; haptic('tap'); renderList(); },
  }, c || 'Все категории')));
}

function monthSales(offset = 0) {
  const now = new Date();
  const ref = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return state.items.filter((i) => {
    const d = parseRuDate(i.saleDate);
    return i.status === STATUS.sold && d && d.getMonth() === ref.getMonth() && d.getFullYear() === ref.getFullYear();
  });
}

function renderSummary() {
  const inStock = state.items.filter((i) => i.status !== STATUS.sold);
  const stockCost = inStock.reduce((s, i) => s + (i.buyPrice || 0), 0);
  const sold = monthSales();
  const profit = sold.reduce((s, i) => s + (profitOf(i) || 0), 0);
  $('#summary').replaceChildren(
    'На руках ', el('b', {}, pieces(inStock.length)), ' на ', el('b', {}, rub(stockCost)), el('br'),
    'В этом месяце продано ', el('b', {}, pieces(sold.length)), ', прибыль ',
    el('b', { class: profit < 0 ? 'profit-minus' : '' }, signedRub(profit)), '  ›',
  );
}

const SORTS = {
  new: (a, b) => b._idx - a._idx,
  old: (a, b) => a._idx - b._idx,
  priceDesc: (a, b) => priceOf(b) - priceOf(a),
  priceAsc: (a, b) => priceOf(a) - priceOf(b),
  stale: (a, b) => (daysHeld(b) || 0) - (daysHeld(a) || 0),
};
function priceOf(i) {
  const v = i.status === STATUS.sold ? i.salePrice : i.planPrice;
  return isNum(v) ? v : -1;
}

function filtered() {
  const words = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return state.items
    .map((i, idx) => Object.assign({}, i, { _idx: idx }))
    .filter((i) => {
      if (state.tab !== 'Все' && i.status !== state.tab) return false;
      if (state.category && i.category !== state.category) return false;
      if (!words.length) return true;
      const hay = [i.title, i.brand, i.size, i.category, i.notes, i.id, i.consignor, i.seller].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort(SORTS[state.sort] || SORTS.new);
}

function itemRow(item, onClick) {
  const thumb = el('div', { class: 'thumb' + (item.hasPhoto ? ' loading' : '') }, item.hasPhoto ? null : icon('shirt'));
  if (item.hasPhoto) lazyPhoto(item.id, thumb);
  const p = profitOf(item);
  const tags = [];
  if (item.status === STATUS.reserved) tags.push(el('span', { class: 'badge warn' }, 'Бронь'));
  if (item.source === 'Комиссия') tags.push(el('span', { class: 'badge info' }, 'Комиссия'));
  if (isStale(item)) tags.push(el('span', { class: 'badge' }, `${daysHeld(item)} дн.`));
  if (item.authenticity === 'Есть сомнения') tags.push(el('span', { class: 'badge warn' }, 'Сомнения'));
  const price = item.status === STATUS.sold
    ? [rub(item.salePrice), p !== null ? el('small', { class: p >= 0 ? 'profit-plus' : 'profit-minus' }, signedRub(p)) : null]
    : [rub(item.planPrice), isNum(item.buyPrice) ? el('small', { class: 'muted-small' }, 'закуп ' + nf.format(item.buyPrice)) : null];
  return el('li', { class: 'item', onclick: onClick || (() => openItem(item.id)) },
    thumb,
    el('div', { class: 'item-main' },
      el('div', { class: 'item-title' }, item.title || 'Без названия'),
      el('div', { class: 'item-sub' }, [item.brand, item.size, item.category].filter(Boolean).join(' · ') || '—'),
      tags.length ? el('div', { class: 'item-tags' }, tags) : null),
    el('div', { class: 'item-price' }, price));
}

function renderList() {
  renderTabs();
  renderChips();
  renderSummary();
  const list = filtered();
  const note = $('#list-note');
  const box = $('#items');

  if (!list.length) {
    note.textContent = '';
    const empty = state.items.length
      ? el('div', { class: 'empty' }, icon('box'), el('p', {}, 'Ничего не найдено'),
        (state.query || state.category) ? el('button', { type: 'button', onclick: resetFilters }, 'Сбросить фильтры') : null)
      : el('div', { class: 'empty' }, icon('box'), el('p', {}, 'Вещей пока нет'),
        el('button', { type: 'button', class: 'primary', onclick: () => openForm('add') }, 'Добавить первую'));
    box.replaceChildren(el('li', {}, empty));
    return;
  }
  if (state.tab === STATUS.sold) {
    const total = list.reduce((s, i) => s + (profitOf(i) || 0), 0);
    const revenue = list.reduce((s, i) => s + (i.salePrice || 0), 0);
    note.textContent = `${pieces(list.length)} на ${rub(revenue)}, прибыль ${signedRub(total)}`;
  } else {
    const plan = list.reduce((s, i) => s + (i.planPrice || 0), 0);
    note.textContent = list.length > 1 ? `${pieces(list.length)}, план продаж ${rub(plan)}` : '';
  }
  box.replaceChildren(...list.map((item) => itemRow(item)));
}

function resetFilters() {
  state.query = '';
  state.category = '';
  $('#search').value = '';
  renderList();
}

// ---------------------------------------------------------------- фото

// Миниатюры грузим по одному запросу на вещь, не больше 3 одновременно.
const photoQueue = [];
let photoActive = 0;
// Миниатюры строк списка запрашиваем, только когда строка подъезжает к экрану.
const photoObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      photoObserver.unobserve(e.target);
      queuePhoto(e.target.dataset.photo, e.target);
    });
  }, { rootMargin: '300px 0px' })
  : null;
function lazyPhoto(id, box) {
  box.dataset.photo = id;
  if (state.photos.has(id) || !photoObserver) queuePhoto(id, box);
  else photoObserver.observe(box);
}

function queuePhoto(id, box) {
  box.dataset.photo = id;
  if (state.photos.has(id)) { putPhoto(box, state.photos.get(id)); return; }
  if (!photoQueue.some((q) => q.id === id)) photoQueue.push({ id });
  pumpPhotos();
}
function putPhoto(box, src) {
  box.classList.remove('loading');
  if (src) box.replaceChildren(el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }));
  else box.replaceChildren(icon('shirt'));
}
function paintPhoto(id, src) {
  document.querySelectorAll(`[data-photo="${CSS.escape(id)}"]`).forEach((b) => {
    // Крупное фото карточки не заменяем миниатюрой, если оно уже есть.
    if (b.id === 'item-photo' && state.fullPhotos.get(id)) return;
    putPhoto(b, src);
  });
}
function pumpPhotos() {
  while (photoActive < 3 && photoQueue.length) {
    const { id } = photoQueue.shift();
    if (state.photos.has(id)) { paintPhoto(id, state.photos.get(id)); continue; }
    photoActive++;
    api('photo', { id })
      .then((ph) => (ph ? `data:${ph.mime};base64,${ph.base64}` : null))
      .catch(() => null)
      .then((src) => {
        state.photos.set(id, src);
        paintPhoto(id, src);
        photoActive--;
        pumpPhotos();
      });
  }
}
async function loadFullPhoto(id) {
  if (state.fullPhotos.has(id)) return state.fullPhotos.get(id);
  try {
    const ph = await api('photo', { id, size: 'full' });
    const src = ph ? `data:${ph.mime};base64,${ph.base64}` : null;
    state.fullPhotos.set(id, src);
    return src;
  } catch (e) { return null; }
}

function openLightbox() {
  const item = state.current;
  if (!item || !item.hasPhoto) return;
  const lb = $('#lightbox');
  const src = state.fullPhotos.get(item.id) || state.photos.get(item.id);
  lb.replaceChildren(src ? el('img', { src, alt: item.title }) : el('p', {}, 'Загрузка…'));
  lb.hidden = false;
  loadFullPhoto(item.id).then((full) => { if (full && !lb.hidden) lb.replaceChildren(el('img', { src: full, alt: item.title })); });
}

// ---------------------------------------------------------------- карточка

const ITEM_FIELDS = [
  ['category', 'Категория'], ['brand', 'Бренд'], ['size', 'Размер'], ['condition', 'Состояние'],
  ['authenticity', 'Подлинность'], ['source', 'Источник'], ['consignor', 'Комитент'],
  ['buyPrice', 'Закуп', rub], ['buyDate', 'Дата закупа'], ['seller', 'У кого куплено'], ['buyDoc', 'Документ'],
  ['planPrice', 'План продажи', rub], ['salePrice', 'Продано за', rub], ['saleDate', 'Дата продажи'],
  ['notes', 'Заметки'], ['addedBy', 'Добавил'], ['changedBy', 'Изменил'], ['changedAt', 'Изменено'], ['id', 'ID'],
];
const STATUS_CLASS = { [STATUS.inStock]: 's-instock', [STATUS.reserved]: 's-reserved', [STATUS.sold]: 's-sold' };

function openItem(id, opts) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  state.current = item;
  $('#item-title').textContent = item.title || 'Без названия';
  const st = $('#item-status');
  st.textContent = item.status || '—';
  st.className = 'status ' + (STATUS_CLASS[item.status] || '');

  const photo = $('#item-photo');
  photo.dataset.photo = item.id;
  photo.disabled = !item.hasPhoto;
  photo.classList.toggle('no-photo', !item.hasPhoto);
  photo.classList.toggle('loading', item.hasPhoto);
  photo.replaceChildren(item.hasPhoto ? '' : icon('shirt'));
  if (item.hasPhoto) {
    const full = state.fullPhotos.get(item.id);
    const thumb = state.photos.get(item.id);
    if (full) putPhoto(photo, full);
    else {
      if (thumb) putPhoto(photo, thumb); // пока грузится крупное — показываем миниатюру
      loadFullPhoto(item.id).then((src) => {
        if (state.current && state.current.id === item.id && state.view === 'item') {
          if (src) putPhoto(photo, src);
          else if (!thumb) putPhoto(photo, null);
        }
      });
    }
  }

  const p = profitOf(item);
  const big = $('#item-price');
  if (item.status === STATUS.sold) {
    big.replaceChildren(rub(item.salePrice), p !== null ? el('small', { class: p >= 0 ? 'profit-plus' : 'profit-minus' }, signedRub(p)) : null);
  } else {
    const margin = isNum(item.planPrice) && isNum(item.buyPrice) ? item.planPrice - item.buyPrice : null;
    big.replaceChildren(rub(item.planPrice), margin !== null ? el('small', { class: 'muted-inline' }, `наценка ${signedRub(margin)}`) : null);
  }

  const rows = [];
  ITEM_FIELDS.forEach(([key, label, fmt]) => {
    const v = item[key];
    if (v === '' || v === null || v === undefined) return;
    rows.push(el('dt', {}, label), el('dd', {}, fmt ? fmt(v) : v));
  });
  const held = daysHeld(item);
  if (held !== null) {
    rows.splice(rows.length - 2, 0, el('dt', {}, item.status === STATUS.sold ? 'Продавалась' : 'Лежит'),
      el('dd', { class: isStale(item) ? 'profit-minus' : '' }, days(held)));
  }
  $('#item-fields').replaceChildren(...rows);

  const actions = [];
  if (item.status !== STATUS.sold) actions.push(el('button', { type: 'button', class: 'primary', onclick: openSell }, 'Продано'));
  if (item.status === STATUS.inStock) actions.push(el('button', { type: 'button', onclick: () => changeStatus(STATUS.reserved) }, 'В бронь'));
  if (item.status === STATUS.reserved) actions.push(el('button', { type: 'button', onclick: () => changeStatus(STATUS.inStock) }, 'Снять бронь'));
  if (item.status === STATUS.sold) actions.push(el('button', { type: 'button', onclick: () => changeStatus(STATUS.inStock) }, 'Вернуть в наличие'));
  if (isStale(item) && isNum(item.planPrice) && item.planPrice >= 1000) {
    actions.push(el('button', { type: 'button', class: 'wide-row', onclick: discount10 }, `Скинуть 10% → ${rub(discounted(item.planPrice))}`));
  }
  $('#item-actions').replaceChildren(...actions);
  show('item', opts);
}

/** −10% с округлением вниз до сотни. */
const discounted = (price) => Math.floor((price * 0.9) / 100) * 100;

async function discount10() {
  const item = state.current;
  const next = discounted(item.planPrice);
  const margin = isNum(item.buyPrice) ? ` Наценка станет ${signedRub(next - item.buyPrice)}.` : '';
  if (!(await ask(`Снизить плановую цену с ${rub(item.planPrice)} до ${rub(next)}?${margin}`))) return;
  try {
    await api('update', { id: item.id, version: item.changedAt, planPrice: next });
    haptic('success');
    toast(`Новая цена: ${rub(next)}`);
    await loadItems({ silent: true });
  } catch (e) { handleWriteError(e); }
}

async function changeStatus(status) {
  const item = state.current;
  if (item.status === STATUS.sold && !(await ask('Вернуть вещь в наличие? Цена и дата продажи сотрутся.'))) return;
  try {
    await api('setStatus', { id: item.id, status, version: item.changedAt });
    haptic('success');
    toast(`Статус: ${status}`);
    await loadItems({ silent: true });
  } catch (e) { handleWriteError(e); }
}

function adText(item) {
  const lines = [item.title];
  const meta = [item.brand, item.size ? `размер ${item.size}` : ''].filter(Boolean).join(', ');
  if (meta) lines.push(meta);
  if (item.condition) lines.push(`Состояние: ${item.condition.toLowerCase()}`);
  if (item.authenticity === 'Проверено') lines.push('Оригинал, подлинность проверена ✅');
  if (isNum(item.planPrice)) lines.push(`Цена: ${rub(item.planPrice)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- продажа

function openSell() {
  const f = $('#sell-form');
  f.reset();
  f.salePrice.value = isNum(state.current.planPrice) ? state.current.planPrice : '';
  f.saleDate.value = todayIso();
  $('#sell-title').textContent = state.current.title;
  $('#sell-error').textContent = '';
  updateSellProfit();
  $('#sell-sheet').hidden = false;
  setTimeout(() => f.salePrice.focus(), 50);
}

function updateSellProfit() {
  const raw = $('#sell-form').salePrice.value;
  const buy = state.current && state.current.buyPrice;
  const hint = $('#sell-profit');
  hint.className = 'hint';
  if (raw === '' || !isNum(buy)) { hint.textContent = isNum(buy) ? '' : 'Закуп не указан — прибыль не посчитается.'; return; }
  const p = Number(raw) - buy;
  hint.textContent = `Прибыль: ${signedRub(p)} (закуп ${rub(buy)})`;
  hint.classList.add(p >= 0 ? 'profit-plus' : 'profit-minus');
}

async function submitSell(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  if (f.salePrice.value === '' || Number(f.salePrice.value) < 0) {
    $('#sell-error').textContent = 'Укажите цену продажи.'; f.salePrice.focus(); return;
  }
  btn.disabled = true;
  try {
    const item = state.current;
    await api('sell', { id: item.id, salePrice: Number(f.salePrice.value), saleDate: f.saleDate.value, version: item.changedAt });
    haptic('success');
    $('#sell-sheet').hidden = true;
    toast('Продано ✓');
    await loadItems({ silent: true });
  } catch (err) {
    handleWriteError(err, $('#sell-error'));
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------- форма (добавить / изменить)

const FORM_FIELDS = ['title', 'category', 'brand', 'size', 'condition', 'source', 'authenticity', 'consignor',
  'buyPrice', 'buyDate', 'seller', 'buyDoc', 'planPrice', 'notes'];
const CLONE_FIELDS = ['title', 'category', 'brand', 'condition', 'source', 'authenticity', 'consignor',
  'buyPrice', 'seller', 'buyDoc', 'planPrice'];

function fillSelects() {
  document.querySelectorAll('select[data-list]').forEach((sel) => {
    const values = state.lists[sel.dataset.list] || [];
    const keep = sel.value;
    sel.replaceChildren(
      ...(sel.dataset.list === 'status' ? [] : [el('option', { value: '' }, '—')]),
      ...values.map((v) => el('option', { value: v }, v)),
    );
    sel.value = keep;
  });
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  $('#dl-category').replaceChildren(...uniq([...(state.lists.category || []), ...state.items.map((i) => i.category)])
    .map((c) => el('option', { value: c })));
  $('#dl-brand').replaceChildren(...uniq(state.items.map((i) => i.brand)).map((c) => el('option', { value: c })));
}

/** Ставит значение и в select добавляет вариант, если его нет в списке (данные из AppSheet). */
function setField(f, name, value) {
  const input = f.elements[name];
  if (!input) return;
  const v = value === null || value === undefined ? '' : String(value);
  if (input.tagName === 'SELECT' && v && ![...input.options].some((o) => o.value === v)) input.append(el('option', { value: v }, v));
  input.value = v;
}

/** src — картинка; exists — фото есть на сервере, но ещё не загружено. */
function setFormPhoto(src, exists) {
  const preview = $('#photo-preview');
  const input = $('#photo-input');
  preview.classList.toggle('has-photo', Boolean(src));
  let content;
  if (src) content = el('img', { src, alt: 'Фото вещи' });
  else if (exists) content = el('span', {}, '🖼 Фото есть — нажмите, чтобы заменить');
  else content = el('span', {}, '📷 Добавить фото');
  preview.replaceChildren(input, content);
  $('#photo-remove').hidden = !(src || exists);
}

function openForm(mode, source) {
  const f = $('#item-form');
  f.reset();
  fillSelects();
  state.form = { mode, photo: null, removePhoto: false, dirty: false, hadPhoto: false };
  $('#form-error').textContent = '';
  $('#btn-delete').hidden = mode !== 'edit';
  $('#sale-fields').hidden = mode !== 'edit';
  $('#form-title').textContent = mode === 'edit' ? 'Изменить вещь' : 'Новая вещь';
  setFormPhoto(null);

  if (mode === 'edit') {
    const item = state.current;
    FORM_FIELDS.forEach((k) => setField(f, k, item[k]));
    setField(f, 'buyDate', ruToIso(item.buyDate));
    setField(f, 'status', item.status);
    setField(f, 'salePrice', item.salePrice);
    setField(f, 'saleDate', ruToIso(item.saleDate) || todayIso());
    state.form.hadPhoto = item.hasPhoto;
    if (item.hasPhoto) {
      const src = state.fullPhotos.get(item.id) || state.photos.get(item.id);
      setFormPhoto(src, true);
      if (!src) {
        loadFullPhoto(item.id).then((full) => {
          // Подставляем, только если пользователь ещё не выбрал новое и не убрал фото.
          if (full && state.view === 'form' && !state.form.photo && !state.form.removePhoto) setFormPhoto(full, true);
        });
      }
    }
  } else {
    const saved = !source && storage.get(DRAFT_KEY);
    const draft = saved && ['title', 'brand', 'notes', 'buyPrice', 'planPrice'].some((k) => saved[k]) ? saved : null;
    const base = source || draft || {};
    (source ? CLONE_FIELDS : FORM_FIELDS).forEach((k) => setField(f, k, base[k]));
    if (draft && !source) toast('Восстановлен черновик');
    if (!f.buyDate.value) f.buyDate.value = todayIso();
    if (!f.source.value && state.lists.source.includes('Выкуп')) f.source.value = 'Выкуп';
    if (!f.authenticity.value && state.lists.authenticity.includes('Не проверено')) f.authenticity.value = 'Не проверено';
    if (!f.category.value && state.category) f.category.value = state.category;
  }
  syncFormExtras();
  show('form');
  if (mode === 'add' && !f.title.value) setTimeout(() => f.title.focus(), 80);
}

function syncFormExtras() {
  const f = $('#item-form');
  $('#consignor-field').hidden = f.source.value !== 'Комиссия' && !f.consignor.value;
  $('#sale-row').hidden = f.status.value !== STATUS.sold;
  const buy = f.buyPrice.value === '' ? null : Number(f.buyPrice.value);
  const plan = f.planPrice.value === '' ? null : Number(f.planPrice.value);
  const hint = $('#markup-hint');
  if (isNum(buy) && isNum(plan) && buy > 0) {
    const m = plan - buy;
    hint.textContent = `Наценка ${signedRub(m)} (${Math.round((m / buy) * 100)}%)`;
  } else hint.textContent = '';
}

function onFormInput() {
  state.form.dirty = true;
  setClosingGuard(true);
  syncFormExtras();
  if (state.form.mode === 'add') {
    const f = $('#item-form');
    const draft = {};
    FORM_FIELDS.forEach((k) => { draft[k] = f.elements[k].value; });
    storage.set(DRAFT_KEY, draft);
  }
}

/** Уменьшает фото до 1600 px по длинной стороне и сжимает в JPEG (~250–450 КБ). */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Не удалось открыть фото. Попробуйте другой файл.'));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // прозрачный PNG → белый фон, а не чёрный
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    return { mime: 'image/jpeg', base64: dataUrl.split(',')[1], dataUrl };
  } finally { URL.revokeObjectURL(url); }
}

async function onPhotoPicked(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const preview = $('#photo-preview');
  preview.classList.add('loading');
  try {
    const ph = await compressImage(file);
    state.form.photo = { mime: ph.mime, base64: ph.base64, dataUrl: ph.dataUrl };
    state.form.removePhoto = false;
    state.form.dirty = true;
    setFormPhoto(ph.dataUrl);
  } catch (err) {
    toast(err.message);
  } finally {
    preview.classList.remove('loading');
    e.target.value = '';
  }
}

function onPhotoRemove() {
  state.form.photo = null;
  state.form.removePhoto = state.form.hadPhoto;
  state.form.dirty = true;
  setFormPhoto(null);
}

function collectForm() {
  const f = $('#item-form');
  const data = {};
  FORM_FIELDS.forEach((k) => { data[k] = f.elements[k].value.trim(); });
  if (state.form.mode === 'edit') {
    data.status = f.status.value;
    data.salePrice = data.status === STATUS.sold ? f.salePrice.value : '';
    data.saleDate = data.status === STATUS.sold ? f.saleDate.value : '';
  }
  return data;
}

async function submitForm(e) {
  e.preventDefault();
  const f = e.target;
  const err = $('#form-error');
  const data = collectForm();
  err.textContent = '';
  if (!data.title) { err.textContent = 'Укажите название.'; f.title.focus(); return; }
  if (data.status === STATUS.sold && data.salePrice === '') { err.textContent = 'Укажите цену продажи.'; f.salePrice.focus(); return; }
  for (const k of ['buyPrice', 'planPrice', 'salePrice']) {
    if (data[k] !== undefined && data[k] !== '' && !(Number(data[k]) >= 0)) { err.textContent = 'Проверьте цены.'; f.elements[k].focus(); return; }
  }

  const btn = $('#form-submit');
  btn.disabled = true;
  btn.textContent = state.form.photo ? 'Загружаю фото…' : 'Сохраняю…';
  const photo = state.form.photo ? { mime: state.form.photo.mime, base64: state.form.photo.base64 } : undefined;
  try {
    if (state.form.mode === 'edit') {
      const item = state.current;
      await api('update', Object.assign(data, { id: item.id, version: item.changedAt, photo, removePhoto: state.form.removePhoto }));
      if (photo) { state.photos.set(item.id, state.form.photo.dataUrl); state.fullPhotos.set(item.id, state.form.photo.dataUrl); }
      if (state.form.removePhoto) { state.photos.delete(item.id); state.fullPhotos.delete(item.id); }
      state.form.dirty = false;
      haptic('success');
      toast('Сохранено ✓');
      await loadItems({ silent: true });
      openItem(item.id, { push: false });
      state.stack = ['list'];
    } else {
      const res = await api('add', Object.assign(data, { photo }));
      if (photo) { state.photos.set(res.id, state.form.photo.dataUrl); state.fullPhotos.set(res.id, state.form.photo.dataUrl); }
      state.form.dirty = false;
      storage.del(DRAFT_KEY);
      haptic('success');
      toast('Вещь добавлена ✓');
      state.tab = STATUS.inStock;
      state.query = '';
      $('#search').value = '';
      show('list');
      await loadItems({ silent: true });
    }
  } catch (ex) {
    handleWriteError(ex, err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить';
  }
}

async function deleteCurrent() {
  const item = state.current;
  if (!(await ask(`Удалить «${item.title}» из таблицы? Фото уйдёт в корзину Google Диска.`))) return;
  try {
    await api('delete', { id: item.id, version: item.changedAt });
    state.form.dirty = false;
    haptic('success');
    toast('Удалено');
    show('list');
    await loadItems({ silent: true });
  } catch (e) { handleWriteError(e, $('#form-error')); }
}

// ---------------------------------------------------------------- статистика

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function tile(label, value, sub, cls) {
  return el('div', { class: 'tile' },
    el('div', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value ' + (cls || '') }, value),
    sub ? el('div', { class: 'tile-sub' }, sub) : null);
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function openStats() {
  show('stats');
  renderStats();
}

function renderStats() {
  const onHand = state.items.filter((i) => i.status !== STATUS.sold);
  const sold = state.items.filter((i) => i.status === STATUS.sold);
  const stockCost = onHand.reduce((s, i) => s + (i.buyPrice || 0), 0);
  const planSum = onHand.reduce((s, i) => s + (i.planPrice || 0), 0);
  const potential = onHand.reduce((s, i) => s + (isNum(i.planPrice) && isNum(i.buyPrice) ? i.planPrice - i.buyPrice : 0), 0);
  const thisM = monthSales(0);
  const prevM = monthSales(1);
  const profitThis = thisM.reduce((s, i) => s + (profitOf(i) || 0), 0);
  const profitPrev = prevM.reduce((s, i) => s + (profitOf(i) || 0), 0);
  const sellDays = sold.map(daysHeld).filter((d) => d !== null);
  const withMargin = sold.filter((i) => isNum(i.buyPrice) && i.buyPrice > 0 && isNum(i.salePrice));
  const avgMarkup = withMargin.length
    ? Math.round(withMargin.reduce((s, i) => s + (i.salePrice - i.buyPrice) / i.buyPrice, 0) / withMargin.length * 100) : null;
  const totalProfit = sold.reduce((s, i) => s + (profitOf(i) || 0), 0);
  const delta = profitThis - profitPrev;

  $('#stats-tiles').replaceChildren(
    tile('На руках', pieces(onHand.length), `закуп ${rub(stockCost)}`),
    tile('План продаж', rub(planSum), `наценка ${signedRub(potential)}`),
    tile('Продано за месяц', pieces(thisM.length), `выручка ${rub(thisM.reduce((s, i) => s + (i.salePrice || 0), 0))}`),
    tile('Прибыль за месяц', signedRub(profitThis), prevM.length || profitPrev ? `${delta >= 0 ? '▲' : '▼'} ${signedRub(delta)} к прошлому` : 'прошлый месяц — нет продаж',
      profitThis < 0 ? 'profit-minus' : ''),
    tile('Срок продажи', sellDays.length ? days(median(sellDays)) : '—', sellDays.length ? 'медиана от закупа' : 'нет данных'),
    tile('Средняя наценка', avgMarkup === null ? '—' : `${avgMarkup}%`, `прибыль всего ${signedRub(totalProfit)}`),
  );

  // Последние 6 месяцев
  const now = new Date();
  const months = [];
  for (let k = 5; k >= 0; k--) {
    const ref = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const list = sold.filter((i) => {
      const d = parseRuDate(i.saleDate);
      return d && d.getMonth() === ref.getMonth() && d.getFullYear() === ref.getFullYear();
    });
    months.push({
      label: MONTHS[ref.getMonth()],
      full: `${MONTHS_FULL[ref.getMonth()]} ${ref.getFullYear()}`,
      count: list.length,
      revenue: list.reduce((s, i) => s + (i.salePrice || 0), 0),
      profit: list.reduce((s, i) => s + (profitOf(i) || 0), 0),
    });
  }
  renderChart(months);
  $('#stats-months').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Месяц'), el('th', {}, 'Продано'), el('th', {}, 'Выручка'), el('th', {}, 'Прибыль'))),
    el('tbody', {}, months.slice().reverse().map((m) => el('tr', {},
      el('td', {}, m.full), el('td', {}, m.count), el('td', {}, rub(m.revenue)),
      el('td', { class: m.profit < 0 ? 'profit-minus' : '' }, signedRub(m.profit)))))));

  // По категориям
  const byCat = new Map();
  sold.forEach((i) => {
    const k = i.category || 'Без категории';
    const c = byCat.get(k) || { count: 0, profit: 0, days: [] };
    c.count++;
    c.profit += profitOf(i) || 0;
    const d = daysHeld(i);
    if (d !== null) c.days.push(d);
    byCat.set(k, c);
  });
  const cats = [...byCat.entries()].sort((a, b) => b[1].profit - a[1].profit);
  $('#stats-cats').replaceChildren(cats.length ? el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Категория'), el('th', {}, 'Шт.'), el('th', {}, 'Прибыль'), el('th', {}, 'Срок'))),
    el('tbody', {}, cats.map(([name, c]) => el('tr', {},
      el('td', {}, name), el('td', {}, c.count),
      el('td', { class: c.profit < 0 ? 'profit-minus' : '' }, signedRub(c.profit)),
      el('td', {}, c.days.length ? `${median(c.days)} дн.` : '—')))))
    : el('p', { class: 'muted' }, 'Пока нет продаж.'));

  const stale = onHand.filter(isStale).sort((a, b) => (daysHeld(b) || 0) - (daysHeld(a) || 0));
  $('#stats-stale').replaceChildren(...(stale.length
    ? stale.map((i) => itemRow(i))
    : [el('li', { class: 'muted' }, `Нет вещей, которые лежат дольше ${STALE_DAYS} дней 👍`)]));
}

/** Столбики прибыли по месяцам (одна серия, без легенды; значения — в таблице ниже и по нажатию). */
function renderChart(months) {
  const box = $('#stats-chart');
  const W = Math.max(260, box.clientWidth - 20);
  const H = 170, top = 22, bottom = 24;
  const vals = months.map((m) => m.profit);
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const span = max - min || 1;
  const y = (v) => top + (max - v) / span * (H - top - bottom);
  const slot = W / months.length;
  const bw = Math.min(34, slot * 0.56);
  const r = 4;
  const nodes = [];

  // Сетка: ноль + верхняя линия
  nodes.push(svg('line', { class: 'zero', x1: 0, x2: W, y1: y(0), y2: y(0) }));
  if (max > 0) {
    nodes.push(svg('line', { class: 'grid', x1: 0, x2: W, y1: y(max), y2: y(max) }));
    nodes.push(svg('text', { class: 'axis-label', x: 0, y: y(max) - 6 }, signedRub(max)));
  }

  const tip = el('div', { class: 'chart-tip', hidden: true });
  const bars = [];
  months.forEach((m, i) => {
    const cx = slot * i + slot / 2;
    const x = cx - bw / 2;
    const y0 = y(0), y1 = y(m.profit);
    const h = Math.abs(y1 - y0);
    let d = '';
    if (h >= 1) {
      const rr = Math.min(r, h, bw / 2);
      d = m.profit >= 0
        ? `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + bw - rr}Q${x + bw},${y1} ${x + bw},${y1 + rr}V${y0}Z`
        : `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + bw - rr}Q${x + bw},${y1} ${x + bw},${y1 - rr}V${y0}Z`;
    }
    const bar = svg('path', { class: 'bar' + (m.profit < 0 ? ' neg' : ''), d });
    bars.push(bar);
    const showTip = () => {
      bars.forEach((b) => b.classList.remove('active'));
      bar.classList.add('active');
      tip.textContent = `${m.full}: ${signedRub(m.profit)} · ${pieces(m.count)}`;
      tip.hidden = false;
      const left = Math.min(Math.max(cx + 10, 90), W - 70);
      tip.style.left = left + 'px';
    };
    nodes.push(svg('rect', { class: 'hit', x: slot * i, y: 0, width: slot, height: H, onclick: showTip, onpointerenter: showTip }));
    nodes.push(bar);
    nodes.push(svg('text', { class: 'axis-label', x: cx, y: H - 6, 'text-anchor': 'middle' }, m.label));
  });
  const last = months[months.length - 1];
  if (last.profit !== 0) {
    const ly = last.profit >= 0 ? y(last.profit) - 6 : y(last.profit) + 14;
    nodes.push(svg('text', { class: 'axis-label', x: slot * (months.length - 0.5), y: ly, 'text-anchor': 'middle' }, nf.format(last.profit)));
  }
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Прибыль по месяцам за полгода; значения — в таблице ниже' }, ...nodes);
  chart.addEventListener('pointerleave', () => { tip.hidden = true; bars.forEach((b) => b.classList.remove('active')); });
  box.replaceChildren(chart, tip);
}

// ---------------------------------------------------------------- демо-режим

const demoDb = (() => {
  const d = (offset) => { const x = new Date(); x.setDate(x.getDate() - offset); return x.toLocaleDateString('ru-RU'); };
  const stamp = () => new Date().toLocaleString('ru-RU').replace(',', '');
  const base = { addedBy: 'Демо', changedBy: 'Демо', changedAt: stamp(), hasPhoto: true };
  return {
    stamp,
    photos: new Map(), // id → { mime, base64 } — загруженные в демо фото
    items: [
      { ...base, id: 'd0000001', title: 'Пуховик The North Face Nuptse', category: 'Куртки', brand: 'The North Face', size: 'M', condition: 'Хорошее', source: 'Выкуп', buyPrice: 9000, buyDate: d(140), planPrice: 17000, status: 'Продано', salePrice: 16000, saleDate: d(110), authenticity: 'Проверено' },
      { ...base, id: 'd0000002', title: 'Кроссовки Nike Dunk Low', category: 'Обувь', brand: 'Nike', size: '42', condition: 'Новое с бирками', source: 'Выкуп', buyPrice: 9000, buyDate: d(75), planPrice: 15000, status: 'Продано', salePrice: 14500, saleDate: d(40), authenticity: 'Проверено' },
      { ...base, id: 'd0000003', title: 'Ремень Gucci GG', category: 'Аксессуары', brand: 'Gucci', size: '90', condition: 'Отличное', source: 'Выкуп', buyPrice: 22000, buyDate: d(95), planPrice: 34000, status: 'В наличии', authenticity: 'Есть сомнения', hasPhoto: false },
      { ...base, id: 'd0000004', title: 'Худи Supreme Box Logo', category: 'Худи', brand: 'Supreme', size: 'M', condition: 'Хорошее', source: 'Комиссия', consignor: 'Иван', buyPrice: null, buyDate: d(20), planPrice: 25000, status: 'Бронь', authenticity: 'Не проверено' },
      { ...base, id: 'd0000005', title: 'Сумка Prada Re-Edition', category: 'Сумки', brand: 'Prada', size: '', condition: 'Отличное', source: 'Выкуп', buyPrice: 48000, buyDate: d(18), planPrice: 70000, status: 'Продано', salePrice: 52000, saleDate: d(3), authenticity: 'Проверено' },
      { ...base, id: 'd0000006', title: 'Куртка Stone Island Soft Shell', category: 'Куртки', brand: 'Stone Island', size: 'L', condition: 'Отличное', source: 'Выкуп', buyPrice: 18000, buyDate: d(9), planPrice: 32000, status: 'В наличии', seller: 'Avito', authenticity: 'Проверено' },
      { ...base, id: 'd0000007', title: 'Футболка Comme des Garçons Play', category: 'Футболки', brand: 'CDG', size: 'S', condition: 'Новое с бирками', source: 'Выкуп', buyPrice: 4000, buyDate: d(2), planPrice: 8500, status: 'В наличии', authenticity: 'Проверено' },
    ],
  };
})();

/** Картинка-заглушка для демо: цветной фон и бренд. */
function demoPhoto(item) {
  const c = document.createElement('canvas');
  c.width = 480; c.height = 480;
  const x = c.getContext('2d');
  let h = 0;
  for (const ch of item.id + item.brand) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const g = x.createLinearGradient(0, 0, 480, 480);
  g.addColorStop(0, `hsl(${h} 32% 82%)`);
  g.addColorStop(1, `hsl(${(h + 40) % 360} 28% 62%)`);
  x.fillStyle = g;
  x.fillRect(0, 0, 480, 480);
  x.fillStyle = 'rgba(255,255,255,.88)';
  x.font = '600 44px -apple-system, Segoe UI, sans-serif';
  x.textAlign = 'center';
  x.fillText(item.brand || item.title.split(' ')[0], 240, 256);
  return { mime: 'image/jpeg', base64: c.toDataURL('image/jpeg', 0.8).split(',')[1] };
}

async function demoApi(action, p) {
  await new Promise((r) => setTimeout(r, 200));
  const find = (id) => {
    const it = demoDb.items.find((i) => i.id === id);
    if (!it) throw Object.assign(new Error('Вещь не найдена — возможно, её удалили. Обновите список.'), { code: 'notfound' });
    if (p.version && p.version !== it.changedAt) throw Object.assign(new Error('Вещь только что изменили. Данные обновлены — проверьте и повторите.'), { code: 'conflict' });
    return it;
  };
  const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
  const touch = (it) => { it.changedBy = 'Демо'; it.changedAt = demoDb.stamp() + '.' + Math.random().toString().slice(2, 5); };
  switch (action) {
    case 'meta': return { user: { id: 0, name: 'Демо' }, lists: { ...DEFAULT_LISTS, category: ['Куртки', 'Худи', 'Обувь', 'Сумки', 'Аксессуары', 'Футболки'] } };
    case 'list': return JSON.parse(JSON.stringify(demoDb.items));
    case 'photo': {
      const it = demoDb.items.find((i) => i.id === p.id);
      if (!it || !it.hasPhoto) return null;
      return demoDb.photos.get(p.id) || demoPhoto(it);
    }
    case 'add': {
      const id = Math.random().toString(16).slice(2, 10);
      const it = { ...p, id, buyPrice: num(p.buyPrice), planPrice: num(p.planPrice), buyDate: isoToRu(p.buyDate),
        status: STATUS.inStock, hasPhoto: Boolean(p.photo), addedBy: 'Демо' };
      if (p.photo) demoDb.photos.set(id, p.photo);
      delete it.photo;
      touch(it);
      demoDb.items.push(it);
      return { id };
    }
    case 'update': {
      const it = find(p.id);
      const patch = { ...p };
      ['id', 'version', 'photo', 'removePhoto'].forEach((k) => delete patch[k]);
      if (p.photo) { demoDb.photos.set(p.id, p.photo); it.hasPhoto = true; }
      if (p.removePhoto) { demoDb.photos.delete(p.id); it.hasPhoto = false; }
      // Как на сервере: меняем только присланные поля.
      ['buyPrice', 'planPrice', 'salePrice'].forEach((k) => { if (k in patch) patch[k] = num(patch[k]); });
      ['buyDate', 'saleDate'].forEach((k) => { if (k in patch) patch[k] = isoToRu(patch[k]); });
      Object.assign(it, patch);
      if (it.status !== STATUS.sold) { it.salePrice = null; it.saleDate = ''; }
      touch(it);
      return { id: p.id };
    }
    case 'sell': { const it = find(p.id); Object.assign(it, { status: STATUS.sold, salePrice: p.salePrice, saleDate: isoToRu(p.saleDate) }); touch(it); return { id: p.id }; }
    case 'setStatus': { const it = find(p.id); Object.assign(it, { status: p.status, salePrice: null, saleDate: '' }); touch(it); return { id: p.id }; }
    case 'delete': { find(p.id); demoDb.items = demoDb.items.filter((i) => i.id !== p.id); return { id: p.id }; }
    default: throw new Error('Неизвестное действие');
  }
}

// ---------------------------------------------------------------- запуск

function bindEvents() {
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; renderList(); }, 120);
  });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; storage.set('uv.sort', state.sort); renderList(); });
  $('#btn-add').addEventListener('click', () => openForm('add'));
  $('#btn-refresh').addEventListener('click', () => loadItems().then(() => toast('Обновлено')).catch((e) => toast(e.message)));
  $('#btn-stats').addEventListener('click', openStats);
  $('#summary').addEventListener('click', openStats);
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', goBack));

  $('#item-photo').addEventListener('click', openLightbox);
  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
  $('#btn-edit').addEventListener('click', () => openForm('edit'));
  $('#btn-clone').addEventListener('click', () => openForm('add', state.current));
  $('#btn-copy-ad').addEventListener('click', async () => {
    const text = adText(state.current);
    const ok = await copyText(text);
    // В Telegram — предлагаем сразу переслать текст в любой чат.
    if (tg && tg.initData && tg.showPopup && tg.openTelegramLink) {
      try {
        tg.showPopup({
          title: ok ? 'Текст скопирован' : 'Текст объявления',
          message: text.slice(0, 250),
          buttons: [{ id: 'share', type: 'default', text: 'Переслать в чат' }, { type: 'close' }],
        }, (id) => {
          if (id === 'share') tg.openTelegramLink('https://t.me/share/url?url=%20&text=' + encodeURIComponent(text));
        });
        return;
      } catch (e) { /* старый Telegram — просто уведомление ниже */ }
    }
    toast(ok ? 'Текст объявления скопирован' : 'Не удалось скопировать');
  });

  const f = $('#item-form');
  f.addEventListener('submit', submitForm);
  f.addEventListener('input', onFormInput);
  f.addEventListener('change', onFormInput);
  $('#photo-input').addEventListener('change', onPhotoPicked);
  $('#photo-remove').addEventListener('click', onPhotoRemove);
  $('#btn-delete').addEventListener('click', deleteCurrent);

  $('#sell-form').addEventListener('submit', submitSell);
  $('#sell-form').salePrice.addEventListener('input', updateSellProfit);
  $('#sell-cancel').addEventListener('click', () => { $('#sell-sheet').hidden = true; });
  $('#sell-sheet').addEventListener('click', (e) => { if (e.target.id === 'sell-sheet') e.target.hidden = true; });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') goBack(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastLoad > AUTO_REFRESH_MS && state.view !== 'form') {
      loadItems({ silent: true }).catch(() => {});
    }
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.view === 'stats') renderStats(); }, 150);
  });
}

function showFatal(message) {
  document.body.classList.add('fatal');
  $('#items').replaceChildren(el('li', {}, el('div', { class: 'empty' }, icon('box'), el('p', {}, message))));
  $('#list-note').textContent = '';
  $('#btn-add').hidden = true;
}

async function init() {
  if (tg && tg.initData) {
    document.documentElement.classList.add('tg');
    if (tg.colorScheme === 'dark') document.documentElement.classList.add('tg-dark');
    tg.onEvent && tg.onEvent('themeChanged', () => document.documentElement.classList.toggle('tg-dark', tg.colorScheme === 'dark'));
    tg.ready();
    tg.expand();
    tg.BackButton.onClick(goBack);
  }
  bindEvents();
  const savedSort = storage.get('uv.sort');
  if (savedSort && SORTS[savedSort]) { state.sort = savedSort; $('#sort').value = savedSort; }

  if (!DEMO && !(tg && tg.initData)) {
    renderSummary();
    showFatal('Откройте приложение через бота в Telegram. Посмотреть без Telegram: добавьте ?demo=1 к адресу.');
    return;
  }

  // Мгновенный показ из кеша, потом свежие данные.
  const cached = storage.get(CACHE_KEY);
  if (cached && Array.isArray(cached.items)) {
    state.items = cached.items;
    if (cached.lists) state.lists = { ...DEFAULT_LISTS, ...cached.lists };
    renderList();
    $('#list-note').textContent = 'Обновляю…';
  }
  try {
    const [meta] = await Promise.all([api('meta'), loadItems({ silent: Boolean(cached) })]);
    state.lists = { ...DEFAULT_LISTS, ...meta.lists };
    storage.set(CACHE_KEY, { items: state.items, lists: state.lists, at: state.lastLoad });
    renderList();
  } catch (e) {
    if (state.items.length && e.code === 'network') {
      toast('Нет связи — показаны сохранённые данные', 4500);
      $('#list-note').textContent = 'Нет связи — данные могут быть устаревшими.';
    } else {
      state.items = [];
      storage.del(CACHE_KEY);
      showFatal(e.message);
    }
  }
}

init();
