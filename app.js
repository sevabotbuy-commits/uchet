'use strict';

/* Учёт вещей — Telegram Mini App.
   Данные: Google-таблица через Apps Script (см. apps-script/Code.gs).
   Демо без Telegram и сервера: откройте страницу с ?demo=1 */

const tg = window.Telegram && window.Telegram.WebApp;
const DEMO = new URLSearchParams(location.search).has('demo');
const STATUS = { inTransit: 'В пути', inStock: 'В наличии', reserved: 'Бронь', sold: 'Продано' };
const TABS = [STATUS.inTransit, STATUS.inStock, STATUS.reserved, STATUS.sold, 'Все'];
const STALE_DAYS = 60;          // «долго лежит»
const AUTO_REFRESH_MS = 60000;  // при возврате в приложение обновлять, если данные старше минуты
const CACHE_KEY = DEMO ? 'uv.demo.cache' : 'uv.cache';
const DRAFT_KEY = DEMO ? 'uv.demo.draft' : 'uv.draft';
const DEFAULT_LISTS = {
  category: [],
  condition: ['Новое с бирками', 'Отличное', 'Хорошее', 'Есть следы носки'],
  source: ['Выкуп', 'Комиссия'],
  authenticity: ['Не проверено', 'Проверено', 'Есть сомнения'],
  status: [STATUS.inTransit, STATUS.inStock, STATUS.reserved, STATUS.sold],
  country: ['США', 'Европа', 'Китай', 'Корея', 'Япония'],
};

const state = {
  items: [],
  lists: { ...DEFAULT_LISTS },
  user: null,         // { id, name } — кто открыл приложение
  partners: [],       // имена партнёров для «Кто платил» / «Деньги получил»
  statsTab: 'general',
  partnerPeriod: 'month',
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

const COMMISSION = 'Комиссия';
const isCommission = (item) => item.source === COMMISSION;
/** Наша комиссия с суммы (цены продажи или плановой). null — процент не указан. */
function commissionFrom(item, price) {
  if (!isNum(price) || !isNum(item.commissionPct)) return null;
  return Math.round((price * item.commissionPct) / 100);
}
/** Прибыль проданной вещи: комиссионной — наша комиссия, выкупленной — продажа минус закупка. */
function profitOf(item) {
  if (!isNum(item.salePrice)) return null;
  if (isCommission(item)) return commissionFrom(item, item.salePrice);
  if (!isNum(item.buyPrice)) return null;
  return item.salePrice - item.buyPrice;
}
/** Ожидаемый доход с плановой цены (наценка или комиссия). */
function plannedGain(item) {
  if (isCommission(item)) return commissionFrom(item, item.planPrice);
  return isNum(item.planPrice) && isNum(item.buyPrice) ? item.planPrice - item.buyPrice : null;
}

const COUNTRY_FLAGS = { 'США': '🇺🇸', 'Европа': '🇪🇺', 'Китай': '🇨🇳', 'Корея': '🇰🇷', 'Япония': '🇯🇵' };
const withFlag = (c) => (c ? `${COUNTRY_FLAGS[c] ? COUNTRY_FLAGS[c] + ' ' : ''}${c}` : '');
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

function saveCache() {
  storage.set(CACHE_KEY, { items: state.items, lists: state.lists, user: state.user, partners: state.partners, at: state.lastLoad });
}

async function loadItems({ silent = false } = {}) {
  if (state.loading) return;
  setLoading(true);
  if (!silent && !state.items.length) $('#list-note').textContent = 'Загрузка…';
  try {
    state.items = await api('list');
    state.lastLoad = Date.now();
    saveCache();
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
  const unsold = state.items.filter((i) => i.status !== STATUS.sold);
  const transit = unsold.filter((i) => i.status === STATUS.inTransit).length;
  const invested = unsold.reduce((s, i) => s + (i.buyPrice || 0), 0);
  const sold = monthSales();
  const profit = sold.reduce((s, i) => s + (profitOf(i) || 0), 0);
  $('#summary').replaceChildren(
    'Не продано ', el('b', {}, pieces(unsold.length)),
    ...(transit ? [' (в пути ', el('b', {}, transit), ')'] : []),
    ', вложено ', el('b', {}, rub(invested)), el('br'),
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
      const hay = [i.title, i.brand, i.size, i.category, i.notes, i.id, i.consignor, i.seller, i.buyer, i.soldBy]
        .join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort(SORTS[state.sort] || SORTS.new);
}

function itemRow(item, onClick, swipeable) {
  const thumb = el('div', { class: 'thumb' + (item.hasPhoto ? ' loading' : '') }, item.hasPhoto ? null : icon('shirt'));
  if (item.hasPhoto) lazyPhoto(item.id, thumb);
  const p = profitOf(item);
  const tags = [];
  if (item.status === STATUS.inTransit && state.tab !== STATUS.inTransit) tags.push(el('span', { class: 'badge info' }, 'В пути'));
  if (item.status === STATUS.reserved) tags.push(el('span', { class: 'badge warn' }, 'Бронь'));
  if (isCommission(item)) {
    tags.push(el('span', { class: 'badge info' }, isNum(item.commissionPct) ? `Комиссия ${item.commissionPct}%` : 'Комиссия'));
  }
  if (isStale(item)) tags.push(el('span', { class: 'badge' }, `${daysHeld(item)} дн.`));
  if (item.authenticity === 'Есть сомнения') tags.push(el('span', { class: 'badge warn' }, 'Сомнения'));
  let sub;
  if (item.status === STATUS.sold) {
    sub = p !== null ? el('small', { class: p >= 0 ? 'profit-plus' : 'profit-minus' }, signedRub(p)) : null;
  } else if (isCommission(item)) {
    const c = commissionFrom(item, item.planPrice);
    sub = c !== null ? el('small', { class: 'muted-small' }, 'наши ' + nf.format(c)) : null;
  } else {
    sub = isNum(item.buyPrice) ? el('small', { class: 'muted-small' }, 'закуп ' + nf.format(item.buyPrice)) : null;
  }
  const flag = COUNTRY_FLAGS[item.country] ? COUNTRY_FLAGS[item.country] + ' ' : '';
  const content = el('div', { class: 'item' },
    thumb,
    el('div', { class: 'item-main' },
      el('div', { class: 'item-title' }, item.title || 'Без названия'),
      el('div', { class: 'item-sub' }, flag + ([item.brand, item.size, item.category].filter(Boolean).join(' · ') || '—')),
      tags.length ? el('div', { class: 'item-tags' }, tags) : null),
    el('div', { class: 'item-price' }, rub(item.status === STATUS.sold ? item.salePrice : item.planPrice), sub));
  const row = el('li', { class: 'swipe-row' }, content);
  content.addEventListener('click', () => {
    if (row.dataset.swiped) return;              // это был свайп, а не нажатие
    if (row.classList.contains('open')) { closeSwipe(row); return; }
    (onClick || (() => openItem(item.id)))();
  });
  if (swipeable) {
    const del = el('button', { type: 'button', class: 'swipe-delete', 'aria-label': 'Удалить ' + item.title, onclick: () => deleteItem(item) }, 'Удалить');
    row.prepend(del);
    enableSwipe(row, content);
  }
  return row;
}

// ---------------------------------------------------------------- свайп влево → «Удалить»

const SWIPE_OPEN = 88; // ширина красной кнопки
let openSwipeRow = null;

function closeSwipe(row) {
  if (!row) return;
  row.classList.remove('open');
  row.querySelector('.item').style.transform = '';
  if (openSwipeRow === row) openSwipeRow = null;
}

function enableSwipe(row, content) {
  let startX = 0, startY = 0, dx = 0, base = 0, tracking = false, decided = false, horizontal = false;
  content.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; dx = 0;
    base = row.classList.contains('open') ? -SWIPE_OPEN : 0;
    tracking = true; decided = false; horizontal = false;
  });
  content.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      horizontal = Math.abs(mx) > Math.abs(my);
      if (!horizontal) { tracking = false; return; } // вертикально — обычная прокрутка
      try { content.setPointerCapture(e.pointerId); } catch (err) { /* синтетические события */ }
      if (openSwipeRow && openSwipeRow !== row) closeSwipe(openSwipeRow);
      row.dataset.swiped = '1';
      content.style.transition = 'none';
    }
    dx = Math.min(0, Math.max(-SWIPE_OPEN * 1.5, base + mx));
    content.style.transform = `translateX(${dx}px)`;
  });
  const finish = () => {
    if (!tracking) return;
    tracking = false;
    if (!horizontal) return;
    content.style.transition = '';
    if (dx < -SWIPE_OPEN / 2) {
      row.classList.add('open');
      content.style.transform = `translateX(${-SWIPE_OPEN}px)`;
      openSwipeRow = row;
      haptic('tap');
    } else closeSwipe(row);
    setTimeout(() => { delete row.dataset.swiped; }, 0); // гасим «клик» после свайпа
  };
  content.addEventListener('pointerup', finish);
  content.addEventListener('pointercancel', finish);
}

/** Удаление вещи (из свайпа, карточки или формы) с подтверждением. */
async function deleteItem(item) {
  if (!(await ask(`Удалить «${item.title}» из таблицы? Фото уйдёт в корзину Google Диска.`))) {
    closeSwipe(openSwipeRow);
    return false;
  }
  try {
    await api('delete', { id: item.id, version: item.changedAt });
    state.form.dirty = false;
    haptic('success');
    toast('Удалено');
    if (state.view !== 'list') show('list');
    await loadItems({ silent: true });
    return true;
  } catch (e) {
    handleWriteError(e, state.view === 'form' ? $('#form-error') : null);
    return false;
  }
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
  openSwipeRow = null;
  box.replaceChildren(...list.map((item) => itemRow(item, null, true)));
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
  ['country', 'Страна', withFlag], ['authenticity', 'Подлинность'], ['source', 'Источник'], ['consignor', 'Комитент'],
  ['commissionPct', 'Комиссия', (v) => `${v}%`],
  ['buyPrice', 'Закуп', rub], ['buyDate', 'Дата закупа'], ['buyer', 'Кто платил'], ['seller', 'У кого куплено'],
  ['buyDoc', 'Документ'], ['planPrice', 'План продажи', rub], ['salePrice', 'Продано за', rub], ['saleDate', 'Дата продажи'],
  ['soldBy', 'Деньги получил'], ['notes', 'Заметки'], ['addedBy', 'Добавил'], ['changedBy', 'Изменил'],
  ['changedAt', 'Изменено'], ['id', 'ID'],
];
const STATUS_CLASS = {
  [STATUS.inTransit]: 's-transit', [STATUS.inStock]: 's-instock', [STATUS.reserved]: 's-reserved', [STATUS.sold]: 's-sold',
};

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
    const gain = plannedGain(item);
    const label = isCommission(item) ? 'наша комиссия' : 'наценка';
    big.replaceChildren(rub(item.planPrice), gain !== null ? el('small', { class: 'muted-inline' }, `${label} ${signedRub(gain)}`) : null);
  }

  const rows = [];
  ITEM_FIELDS.forEach(([key, label, fmt]) => {
    const v = item[key];
    if (v === '' || v === null || v === undefined) return;
    rows.push(el('dt', {}, label), el('dd', {}, fmt ? fmt(v) : v));
  });
  if (isCommission(item)) {
    // Сколько отдать комитенту: от цены продажи, а пока не продано — от плановой.
    const base = item.status === STATUS.sold ? item.salePrice : item.planPrice;
    const ours = commissionFrom(item, base);
    if (ours !== null) {
      rows.push(el('dt', {}, item.status === STATUS.sold ? 'Комитенту' : 'Комитенту (план)'), el('dd', {}, rub(base - ours)));
    }
  }
  const held = daysHeld(item);
  if (held !== null) {
    rows.splice(rows.length - 2, 0, el('dt', {}, item.status === STATUS.sold ? 'Продавалась' : 'Лежит'),
      el('dd', { class: isStale(item) ? 'profit-minus' : '' }, days(held)));
  }
  $('#item-fields').replaceChildren(...rows);

  const actions = [];
  const btn = (text, onclick, cls) => el('button', { type: 'button', class: cls, onclick }, text);
  if (item.status === STATUS.inTransit) {
    // Главное действие для едущей вещи — отметить получение; продать/забронировать можно и заранее.
    actions.push(btn('Получена', () => changeStatus(STATUS.inStock), 'primary wide-row'));
    actions.push(btn('Продано', openSell), btn('В бронь', () => changeStatus(STATUS.reserved)));
  }
  if (item.status === STATUS.inStock || item.status === STATUS.reserved) actions.push(btn('Продано', openSell, 'primary'));
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
    toast(item.status === STATUS.inTransit && status === STATUS.inStock ? 'Получена — теперь в наличии ✓' : `Статус: ${status}`);
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
  fillPartnerSelect(f.soldBy, myName());
  $('#sell-title').textContent = state.current.title;
  $('#sell-error').textContent = '';
  updateSellProfit();
  $('#sell-sheet').hidden = false;
  setTimeout(() => f.salePrice.focus(), 50);
}

function updateSellProfit() {
  const raw = $('#sell-form').salePrice.value;
  const item = state.current;
  const buy = item && item.buyPrice;
  const hint = $('#sell-profit');
  hint.className = 'hint';
  if (item && isCommission(item)) {
    if (!isNum(item.commissionPct)) { hint.textContent = 'Процент комиссии не указан — прибыль не посчитается.'; return; }
    if (raw === '') { hint.textContent = ''; return; }
    const ours = commissionFrom(item, Number(raw));
    hint.textContent = `Наша комиссия ${item.commissionPct}%: ${signedRub(ours)}, комитенту ${rub(Number(raw) - ours)}`;
    hint.classList.add('profit-plus');
    return;
  }
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
    await api('sell', {
      id: item.id, salePrice: Number(f.salePrice.value), saleDate: f.saleDate.value,
      soldBy: f.soldBy.value, version: item.changedAt,
    });
    haptic('success');
    $('#sell-sheet').hidden = true;
    toast('Продано ✓');
    await loadItems({ silent: true });
  } catch (err) {
    handleWriteError(err, $('#sell-error'));
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------- форма (добавить / изменить)

const FORM_FIELDS = ['title', 'category', 'brand', 'size', 'condition', 'country', 'source', 'authenticity', 'consignor',
  'commissionPct', 'buyPrice', 'buyDate', 'buyer', 'seller', 'buyDoc', 'planPrice', 'notes'];
const CLONE_FIELDS = ['title', 'category', 'brand', 'condition', 'country', 'source', 'authenticity', 'consignor',
  'commissionPct', 'buyPrice', 'buyer', 'seller', 'buyDoc', 'planPrice'];
// Поля закупки — у комиссионных вещей их нет.
const BUY_ONLY_FIELDS = ['buyPrice', 'buyer', 'seller'];

const myName = () => (state.user && state.user.name) || '';
/** Партнёры для выпадающих списков: я первым, затем остальные. */
function partnerList() {
  const all = [myName(), ...state.partners].filter(Boolean);
  return all.filter((n, i) => all.indexOf(n) === i);
}
function fillPartnerSelect(sel, value) {
  sel.replaceChildren(el('option', { value: '' }, '— не указано'), ...partnerList().map((n) => el('option', { value: n }, n)));
  setField(sel.form, sel.name, value);
}

function fillSelects() {
  document.querySelectorAll('select[data-list]').forEach((sel) => {
    const values = sel.dataset.list === 'partners' ? partnerList() : (state.lists[sel.dataset.list] || []);
    const keep = sel.value;
    sel.replaceChildren(
      el('option', { value: '' }, sel.dataset.list === 'partners' ? '— не указано' : '—'),
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
  $('#form-title').textContent = mode === 'edit' ? 'Изменить вещь' : 'Новая вещь';
  setFormPhoto(null);
  // Статус: при добавлении — только «В наличии» или «В пути», при правке — все.
  const statuses = mode === 'edit'
    ? [...new Set([...DEFAULT_LISTS.status, ...(state.lists.status || [])])]
    : [STATUS.inStock, STATUS.inTransit];
  f.status.replaceChildren(...statuses.map((s) => el('option', { value: s }, s)));

  if (mode === 'edit') {
    const item = state.current;
    FORM_FIELDS.forEach((k) => setField(f, k, item[k]));
    setField(f, 'buyDate', ruToIso(item.buyDate));
    setField(f, 'status', item.status);
    setField(f, 'salePrice', item.salePrice);
    setField(f, 'saleDate', ruToIso(item.saleDate) || todayIso());
    setField(f, 'soldBy', item.soldBy || (item.status === STATUS.sold ? '' : myName()));
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
    if (!f.buyer.value) setField(f, 'buyer', myName());
    f.status.value = state.tab === STATUS.inTransit ? STATUS.inTransit : STATUS.inStock;
  }
  syncFormExtras();
  show('form');
  if (mode === 'add' && !f.title.value) setTimeout(() => f.title.focus(), 80);
}

function syncFormExtras() {
  const f = $('#item-form');
  const commission = f.source.value === COMMISSION;
  // Комиссия: вместо закупки — комитент и процент; «Дата закупа» → «Дата приёма».
  $('#consignor-row').hidden = !commission;
  document.querySelectorAll('#item-form .buy-only').forEach((n) => { n.hidden = commission; });
  $('#buydate-label').textContent = commission ? 'Дата приёма' : 'Дата закупа';
  $('#buydoc-label').textContent = commission ? 'Договор комиссии' : 'Документ закупа';
  $('#sale-row').hidden = f.status.value !== STATUS.sold;
  const buy = f.buyPrice.value === '' ? null : Number(f.buyPrice.value);
  const plan = f.planPrice.value === '' ? null : Number(f.planPrice.value);
  const pct = f.commissionPct.value === '' ? null : Number(String(f.commissionPct.value).replace(',', '.'));
  const hint = $('#markup-hint');
  if (commission) {
    if (isNum(plan) && isNum(pct)) {
      const ours = Math.round((plan * pct) / 100);
      hint.textContent = `Наша комиссия ${signedRub(ours)}, комитенту ${rub(plan - ours)}`;
    } else hint.textContent = 'Укажите цену и процент — посчитаю нашу комиссию и выплату комитенту.';
  } else if (isNum(buy) && isNum(plan) && buy > 0) {
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
  data.commissionPct = data.commissionPct.replace(',', '.');
  // Комиссия: закупки нет — чистим её поля. Выкуп: процент комиссии не нужен.
  if (data.source === COMMISSION) BUY_ONLY_FIELDS.forEach((k) => { data[k] = ''; });
  else { data.commissionPct = ''; data.consignor = ''; }
  data.status = f.status.value;
  if (state.form.mode === 'edit') {
    const sold = data.status === STATUS.sold;
    data.salePrice = sold ? f.salePrice.value : '';
    data.saleDate = sold ? f.saleDate.value : '';
    data.soldBy = sold ? f.soldBy.value : '';
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
  if (data.commissionPct !== '' && !(Number(data.commissionPct) >= 0 && Number(data.commissionPct) <= 100)) {
    err.textContent = 'Комиссия — число от 0 до 100 %.'; f.commissionPct.focus(); return;
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
      toast(data.status === STATUS.inTransit ? 'Добавлена во «В пути» ✓' : 'Вещь добавлена ✓');
      state.tab = data.status === STATUS.inTransit ? STATUS.inTransit : STATUS.inStock;
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

function deleteCurrent() {
  return deleteItem(state.current);
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

function openStats(tab) {
  if (typeof tab === 'string') state.statsTab = tab;
  show('stats');
  renderStats();
}

function renderStats() {
  document.querySelectorAll('[data-stats-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.statsTab === state.statsTab)));
  $('#stats-general').hidden = state.statsTab !== 'general';
  $('#stats-partners').hidden = state.statsTab !== 'partners';
  if (state.statsTab === 'partners') renderPartners(); else renderGeneralStats();
}

// ---------------------------------------------------------------- партнёры

const PERIODS = [['month', 'Этот месяц'], ['prev', 'Прошлый месяц'], ['all', 'Всё время']];

function inPeriod(ruDate, period) {
  if (period === 'all') return true;
  const d = parseRuDate(ruDate);
  if (!d) return false;
  const now = new Date();
  const ref = new Date(now.getFullYear(), now.getMonth() - (period === 'prev' ? 1 : 0), 1);
  return d.getMonth() === ref.getMonth() && d.getFullYear() === ref.getFullYear();
}

/** Суммы закупок и продаж по партнёрам за период. Ключ '' — «не указано». */
function partnerTotals(period) {
  const t = new Map();
  const get = (name) => {
    if (!t.has(name)) t.set(name, { name, buy: 0, buyCount: 0, sale: 0, saleCount: 0 });
    return t.get(name);
  };
  partnerList().forEach(get);
  state.items.forEach((i) => {
    if (isNum(i.buyPrice) && i.buyPrice > 0 && inPeriod(i.buyDate, period)) {
      const r = get(i.buyer || '');
      r.buy += i.buyPrice; r.buyCount++;
    }
    if (i.status === STATUS.sold && isNum(i.salePrice) && inPeriod(i.saleDate, period)) {
      const r = get(i.soldBy || '');
      r.sale += i.salePrice; r.saleCount++;
    }
  });
  return t;
}

/**
 * Взаиморасчёт поровну за всё время. Комиссионные вещи — только наша комиссия (долю комитента отдаёт тот, кто получил деньги).
 * Каждый: получил от продаж − заплатил за закупки = «на руках». Поровну — это общий итог / число партнёров.
 * Кто держит больше своей доли — переводит разницу тем, у кого меньше.
 */
function settlement() {
  const net = new Map();
  let skipped = 0;
  const add = (name, v) => net.set(name, (net.get(name) || 0) + v);
  state.items.forEach((i) => {
    if (isCommission(i)) {
      // Комиссионная: кто получил деньги, тот отдаёт долю комитенту — у него остаётся наша комиссия.
      const ours = profitOf(i);
      if (i.status === STATUS.sold && ours !== null) { if (i.soldBy) add(i.soldBy, ours); else skipped++; }
      return;
    }
    if (isNum(i.buyPrice) && i.buyPrice > 0) { if (i.buyer) add(i.buyer, -i.buyPrice); else skipped++; }
    if (i.status === STATUS.sold && isNum(i.salePrice)) { if (i.soldBy) add(i.soldBy, i.salePrice); else skipped++; }
  });
  partnerList().forEach((n) => { if (!net.has(n)) net.set(n, 0); });
  const names = [...net.keys()];
  const total = names.reduce((s, n) => s + net.get(n), 0);
  const share = names.length ? total / names.length : 0;
  const bal = names.map((n) => ({ name: n, owe: Math.round(net.get(n) - share) }));
  const transfers = [];
  const payers = bal.filter((b) => b.owe > 0).sort((a, b) => b.owe - a.owe);
  const takers = bal.filter((b) => b.owe < 0).sort((a, b) => a.owe - b.owe);
  for (const p of payers) {
    for (const t of takers) {
      if (p.owe <= 0) break;
      const amount = Math.min(p.owe, -t.owe);
      if (amount > 0) { transfers.push({ from: p.name, to: t.name, amount }); p.owe -= amount; t.owe += amount; }
    }
  }
  return { names, total, share, transfers, skipped };
}

function renderPartners() {
  $('#partner-period').replaceChildren(...PERIODS.map(([key, label]) => el('button', {
    type: 'button', 'aria-pressed': String(state.partnerPeriod === key),
    onclick: () => { state.partnerPeriod = key; haptic('tap'); renderPartners(); },
  }, label)));

  const totals = partnerTotals(state.partnerPeriod);
  const unknown = totals.get('');
  totals.delete('');
  const cards = [...totals.values()];
  const box = $('#partner-cards');
  box.classList.toggle('single', cards.length < 2);
  box.replaceChildren(...cards.map((c) => {
    const diff = c.sale - c.buy;
    return el('div', { class: 'partner-card' + (c.name === myName() ? ' me' : '') },
      el('div', { class: 'partner-name' }, c.name, c.name === myName() ? el('span', { class: 'badge info' }, 'вы') : null),
      el('div', { class: 'partner-row' }, el('span', {}, 'Закупил'), el('b', {}, rub(c.buy)), el('small', {}, pieces(c.buyCount))),
      el('div', { class: 'partner-row' }, el('span', {}, 'Продал'), el('b', {}, rub(c.sale)), el('small', {}, pieces(c.saleCount))),
      el('div', { class: 'partner-row total' }, el('span', {}, 'Разница'),
        el('b', { class: diff < 0 ? 'profit-minus' : diff > 0 ? 'profit-plus' : '' }, signedRub(diff))));
  }));
  if (cards.length < 2) {
    box.append(el('p', { class: 'muted' }, 'Второй партнёр появится здесь, когда его Telegram ID будет в ALLOWED_IDS и он откроет бота, '
      + 'или когда его имя будет указано в «Кто платил» / «Деньги получил».'));
  }

  // Вещи без партнёра — с подсказкой и списком
  const unk = $('#partner-unknown');
  const missing = state.items.filter((i) => (isNum(i.buyPrice) && i.buyPrice > 0 && !i.buyer)
    || (i.status === STATUS.sold && isNum(i.salePrice) && !i.soldBy));
  if (missing.length) {
    const sums = unknown ? `За период: закупки ${rub(unknown.buy)}, продажи ${rub(unknown.sale)}. ` : '';
    const list = el('ul', { class: 'items', hidden: true }, missing.slice(0, 30).map((i) => itemRow(i)));
    unk.replaceChildren(el('div', { class: 'notice' },
      el('b', {}, `Не указан партнёр: ${pieces(missing.length)}`),
      el('p', {}, `${sums}Откройте вещь → «Изменить» → «Кто платил» / «Деньги получил».`),
      el('button', { type: 'button', class: 'link-btn', onclick: (e) => { list.hidden = !list.hidden; e.target.textContent = list.hidden ? 'Показать вещи' : 'Скрыть'; } }, 'Показать вещи'),
      list));
  } else unk.replaceChildren();

  const s = settlement();
  const settle = $('#partner-settle');
  if (s.names.length < 2) {
    settle.replaceChildren(el('p', { class: 'muted' }, 'Расчёт появится, когда в учёте будут два партнёра.'));
  } else {
    const head = s.transfers.length
      ? [el('div', { class: 'muted' }, 'Кто кому переводит, чтобы всё было поровну:'),
        ...s.transfers.map((t) => el('div', { class: 'settle-transfer' },
          el('b', {}, t.from), el('span', { class: 'arrow' }, ' → '), el('b', {}, t.to), el('div', { class: 'settle-amount' }, rub(t.amount))))]
      : [el('div', { class: 'settle-transfer' }, el('b', {}, 'Вы в расчёте ✓'))];
    settle.replaceChildren(el('div', { class: 'settle-card' },
      ...head,
      el('p', { class: 'muted' }, `Общий результат (продажи − закупки): ${signedRub(s.total)}, доля каждого ${signedRub(Math.round(s.share))}.`
        + (s.skipped ? ` Без партнёра не учтено записей: ${s.skipped}.` : ''))));
  }
}

function renderGeneralStats() {
  const onHand = state.items.filter((i) => i.status !== STATUS.sold);
  const sold = state.items.filter((i) => i.status === STATUS.sold);
  const stockCost = onHand.reduce((s, i) => s + (i.buyPrice || 0), 0);
  const planSum = onHand.reduce((s, i) => s + (i.planPrice || 0), 0);
  const potential = onHand.reduce((s, i) => s + (plannedGain(i) || 0), 0);
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
    tile('Не продано', pieces(onHand.length), `вложено ${rub(stockCost)}`
      + (onHand.some((i) => i.status === STATUS.inTransit) ? `, в пути ${onHand.filter((i) => i.status === STATUS.inTransit).length}` : '')),
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

  // По категориям и по странам — одна и та же таблица по проданным
  $('#stats-cats').replaceChildren(groupTable(sold, 'Категория', (i) => i.category || 'Без категории'));
  $('#stats-countries').replaceChildren(groupTable(sold, 'Страна', (i) => withFlag(i.country) || 'Не указана'));

  const stale = onHand.filter(isStale).sort((a, b) => (daysHeld(b) || 0) - (daysHeld(a) || 0));
  $('#stats-stale').replaceChildren(...(stale.length
    ? stale.map((i) => itemRow(i))
    : [el('li', { class: 'muted' }, `Нет вещей, которые лежат дольше ${STALE_DAYS} дней 👍`)]));
}

/** Таблица «группа — штук — прибыль — срок продажи» по проданным вещам. */
function groupTable(sold, title, keyOf) {
  const groups = new Map();
  sold.forEach((i) => {
    const k = keyOf(i);
    const c = groups.get(k) || { count: 0, profit: 0, days: [] };
    c.count++;
    c.profit += profitOf(i) || 0;
    const d = daysHeld(i);
    if (d !== null) c.days.push(d);
    groups.set(k, c);
  });
  const rows = [...groups.entries()].sort((a, b) => b[1].profit - a[1].profit);
  if (!rows.length) return el('p', { class: 'muted' }, 'Пока нет продаж.');
  return el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, title), el('th', {}, 'Шт.'), el('th', {}, 'Прибыль'), el('th', {}, 'Срок'))),
    el('tbody', {}, rows.map(([name, c]) => el('tr', {},
      el('td', {}, name), el('td', {}, c.count),
      el('td', { class: c.profit < 0 ? 'profit-minus' : '' }, signedRub(c.profit)),
      el('td', {}, c.days.length ? `${median(c.days)} дн.` : '—')))));
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
      { ...base, id: 'd0000001', title: 'Пуховик The North Face Nuptse', category: 'Куртки', brand: 'The North Face', size: 'M', condition: 'Хорошее', source: 'Выкуп', buyPrice: 9000, buyDate: d(140), planPrice: 17000, status: 'Продано', salePrice: 16000, saleDate: d(110), authenticity: 'Проверено', buyer: 'Антон', soldBy: 'Антон' },
      { ...base, id: 'd0000002', title: 'Кроссовки Nike Dunk Low', category: 'Обувь', brand: 'Nike', country: 'Китай', size: '42', condition: 'Новое с бирками', source: 'Выкуп', buyPrice: 9000, buyDate: d(75), planPrice: 15000, status: 'Продано', salePrice: 14500, saleDate: d(40), authenticity: 'Проверено', buyer: 'Дима', soldBy: 'Антон' },
      { ...base, id: 'd0000003', title: 'Ремень Gucci GG', category: 'Аксессуары', brand: 'Gucci', size: '90', condition: 'Отличное', source: 'Выкуп', buyPrice: 22000, buyDate: d(95), planPrice: 34000, status: 'В наличии', authenticity: 'Есть сомнения', hasPhoto: false },
      { ...base, id: 'd0000004', title: 'Худи Supreme Box Logo', category: 'Худи', brand: 'Supreme', size: 'M', condition: 'Хорошее', source: 'Комиссия', consignor: 'Иван', commissionPct: 20, country: 'США', buyPrice: null, buyDate: d(20), planPrice: 25000, status: 'Бронь', authenticity: 'Не проверено' },
      { ...base, id: 'd0000005', title: 'Сумка Prada Re-Edition', category: 'Сумки', brand: 'Prada', size: '', condition: 'Отличное', source: 'Выкуп', buyPrice: 48000, buyDate: d(18), planPrice: 70000, status: 'Продано', salePrice: 52000, saleDate: d(3), authenticity: 'Проверено', buyer: 'Антон', soldBy: 'Дима' },
      { ...base, id: 'd0000006', title: 'Куртка Stone Island Soft Shell', category: 'Куртки', brand: 'Stone Island', country: 'Европа', size: 'L', condition: 'Отличное', source: 'Выкуп', buyPrice: 18000, buyDate: d(9), planPrice: 32000, status: 'В наличии', seller: 'Avito', authenticity: 'Проверено', buyer: 'Дима' },
      { ...base, id: 'd0000007', title: 'Футболка Comme des Garçons Play', category: 'Футболки', brand: 'CDG', size: 'S', condition: 'Новое с бирками', source: 'Выкуп', buyPrice: 4000, buyDate: d(2), planPrice: 8500, status: 'В наличии', authenticity: 'Проверено', buyer: 'Антон' },
      { ...base, id: 'd0000008', title: 'Кроссовки New Balance 990v6', category: 'Обувь', brand: 'New Balance', country: 'Китай', size: '43', condition: 'Новое с бирками', source: 'Выкуп', buyPrice: 15000, buyDate: d(4), planPrice: 24000, status: 'В пути', seller: 'Poizon', authenticity: 'Не проверено', buyer: 'Дима' },
      { ...base, id: 'd0000009', title: 'Кепка Stussy', category: 'Аксессуары', brand: 'Stussy', size: 'OS', condition: 'Новое с бирками', source: 'Выкуп', buyPrice: 2500, buyDate: d(1), planPrice: 5000, status: 'В пути', authenticity: 'Не проверено', buyer: 'Антон', hasPhoto: false },
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
    case 'meta': return { user: { id: 0, name: 'Антон' }, partners: ['Антон', 'Дима'], lists: { ...DEFAULT_LISTS, category: ['Куртки', 'Худи', 'Обувь', 'Сумки', 'Аксессуары', 'Футболки'] } };
    case 'list': return JSON.parse(JSON.stringify(demoDb.items));
    case 'photo': {
      const it = demoDb.items.find((i) => i.id === p.id);
      if (!it || !it.hasPhoto) return null;
      return demoDb.photos.get(p.id) || demoPhoto(it);
    }
    case 'add': {
      const id = Math.random().toString(16).slice(2, 10);
      const it = { ...p, id, buyPrice: num(p.buyPrice), planPrice: num(p.planPrice), commissionPct: num(p.commissionPct),
        buyDate: isoToRu(p.buyDate), status: p.status === STATUS.inTransit ? STATUS.inTransit : STATUS.inStock,
        buyer: p.source === COMMISSION ? '' : (p.buyer || 'Антон'), hasPhoto: Boolean(p.photo), addedBy: 'Демо' };
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
      ['buyPrice', 'planPrice', 'salePrice', 'commissionPct'].forEach((k) => { if (k in patch) patch[k] = num(patch[k]); });
      ['buyDate', 'saleDate'].forEach((k) => { if (k in patch) patch[k] = isoToRu(patch[k]); });
      Object.assign(it, patch);
      if (it.status !== STATUS.sold) { it.salePrice = null; it.saleDate = ''; it.soldBy = ''; }
      touch(it);
      return { id: p.id };
    }
    case 'sell': { const it = find(p.id); Object.assign(it, { status: STATUS.sold, salePrice: p.salePrice, saleDate: isoToRu(p.saleDate), soldBy: p.soldBy || 'Антон' }); touch(it); return { id: p.id }; }
    case 'setStatus': { const it = find(p.id); Object.assign(it, { status: p.status, salePrice: null, saleDate: '', soldBy: '' }); touch(it); return { id: p.id }; }
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
  document.querySelectorAll('[data-stats-tab]').forEach((b) => b.addEventListener('click', () => {
    state.statsTab = b.dataset.statsTab;
    haptic('tap');
    renderStats();
  }));
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
  $('#btn-delete-item').addEventListener('click', deleteCurrent);
  // Нажатие мимо открытой строки закрывает свайп
  document.addEventListener('pointerdown', (e) => { if (openSwipeRow && !openSwipeRow.contains(e.target)) closeSwipe(openSwipeRow); });

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
    // Чтобы свайпы и прокрутка не сворачивали приложение (Telegram 7.7+)
    try { if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) { /* старый Telegram */ }
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
    if (cached.user) state.user = cached.user;
    if (cached.partners) state.partners = cached.partners;
    renderList();
    $('#list-note').textContent = 'Обновляю…';
  }
  try {
    const [meta] = await Promise.all([api('meta'), loadItems({ silent: Boolean(cached) })]);
    state.lists = { ...DEFAULT_LISTS, ...meta.lists };
    state.user = meta.user || null;
    state.partners = meta.partners || [];
    saveCache();
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
