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
  partnerPeriod: (() => { try { const p = JSON.parse(localStorage.getItem('uv.period') || 'null'); return ['month', 'prev', 'all'].includes(p) ? p : 'all'; } catch (e) { return 'all'; } })(), // по умолчанию — всё время
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
  pending: 0,
  seq: 0,             // счётчик локальных изменений (для отбрасывания устаревших ответов)
  navIds: [],
  select: null,       // режим выделения: Set выбранных id или null
  layout: 'grid',
  money: [],          // журнал денег: пополнения, выводы, переводы     // вид склада: 'grid' — плитка с крупными фото, 'list' — строки
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

/** Короткое сообщение внизу. action = { label, fn } — кнопка в сообщении (например, «Отменить»). */
function toast(text, ms = 3000, action) {
  const t = $('#toast');
  t.classList.toggle('with-action', Boolean(action));
  if (action) {
    t.replaceChildren(el('span', {}, text), el('button', {
      type: 'button', class: 'toast-action',
      onclick: () => { t.hidden = true; clearTimeout(toast.timer); action.fn(); },
    }, action.label));
  } else t.textContent = text;
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

// Чтение можно безопасно повторить, запись — нет (иначе возможен дубль вещи).
const RETRY_ACTIONS = ['list', 'meta', 'photo', 'photos', 'money'];
const RETRY_CODES = ['network', 'busy', 'server'];

async function api(action, payload) {
  if (DEMO) return demoApi(action, payload || {});
  const attempts = RETRY_ACTIONS.includes(action) ? 3 : 1;
  for (let i = 0; ; i++) {
    try {
      return await apiOnce(action, payload);
    } catch (e) {
      if (i + 1 >= attempts || !RETRY_CODES.includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 700 * (i + 1))); // пауза растёт: 0,7 с, 1,4 с
    }
  }
}

async function apiOnce(action, payload) {
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
    // Не JSON: 401/403/404 — неверная настройка развертывания; остальное — временный сбой Google.
    if ([401, 403, 404].includes(res.status)) {
      throw Object.assign(new Error('Сервер ответил непонятно. Проверьте развертывание Apps Script.'), { code: 'setup' });
    }
    throw Object.assign(new Error('Сервер Google временно не ответил. Попробуйте ещё раз.'), { code: 'network' });
  }
  if (!body.ok) throw Object.assign(new Error(body.error || 'Ошибка сервера.'), { code: body.code || '' });
  return body.data;
}

// ---------------------------------------------------------------- навигация

const VIEWS = ['list', 'item', 'form', 'stats'];

const scrollMemory = {}; // где был экран прокручен, когда с него ушли
let ignoreScrollUntil = 0; // до этого момента прокрутка — программная (не жест)

function show(view, { push = true } = {}) {
  const from = state.view;
  const changed = from !== view;
  // Ушли со списка — режим выделения выключается
  if (changed && view !== 'list' && state.select) {
    state.select = null;
    document.body.classList.remove('select-mode');
    $('#select-bar').hidden = true;
    $('#btn-add').hidden = false;
  }
  if (changed) scrollMemory[from] = window.scrollY;
  if (push && changed) state.stack.push(from);
  if (view === 'list') state.stack = [];
  state.view = view;
  VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== view; });
  document.body.dataset.view = view;
  syncNav();
  if (changed) {
    // Вперёд — экран въезжает справа и сверху страницы; назад — возвращаемся туда, где были.
    const back = !push;
    ignoreScrollUntil = Date.now() + 150; // эту прокрутку делаем мы, а не палец
    window.scrollTo(0, back ? (scrollMemory[view] || 0) : 0);
    animateView($('#view-' + view), back ? 'enter-back' : 'enter-forward');
    if (view === 'list') updateStuck(); // вернулись на прокрученный список — тень панели сразу
  }
  if (tg && tg.BackButton) { if (view === 'list') tg.BackButton.hide(); else tg.BackButton.show(); }
  setClosingGuard(view === 'form' && state.form.dirty);
  syncMainButton();
}

// ---- родная кнопка Telegram внизу: в форме это «Сохранить»
const inTelegram = () => Boolean(tg && tg.initData && tg.MainButton);
function syncMainButton() {
  if (!inTelegram()) return;
  try {
    const mb = tg.MainButton;
    if (state.view === 'form') {
      mb.setText(state.form.mode === 'edit' ? 'Сохранить изменения' : 'Сохранить вещь');
      mb.show();
      mb.enable();
    } else {
      mb.hideProgress();
      mb.hide();
    }
  } catch (e) { /* старый Telegram — остаётся кнопка на странице */ }
}
function mainButtonBusy(on) {
  if (!inTelegram()) return;
  try { if (on) tg.MainButton.showProgress(false); else tg.MainButton.hideProgress(); } catch (e) { /* нет */ }
}

function animateView(node, cls) {
  node.classList.remove('enter-back', 'enter-forward');
  void node.offsetWidth; // перезапуск анимации
  node.classList.add(cls);
  node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
}

async function goBack() {
  if (!$('#lightbox').hidden) { closeLightbox(); return; }
  if (!$('#sell-sheet').hidden) { closeSheet(); return; }
  if (!$('#picker-sheet').hidden) { $('#picker-sheet').hidden = true; return; }
  if (!$('#money-sheet').hidden) { $('#money-sheet').hidden = true; return; }
  if (state.select && state.view === 'list') { exitSelect(); return; }
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
  state.seq++; // любое локальное изменение делает «летящие» ответы сервера устаревшими
  persistCache();
}
/** Записать кеш, не помечая данные изменёнными (для фоновых загрузок). */
function persistCache() {
  storage.set(CACHE_KEY, { items: state.items, lists: state.lists, user: state.user, partners: state.partners, money: state.money, at: state.lastLoad });
}

async function loadItems({ silent = false, force = false } = {}) {
  if (state.loading) return;
  // Пока сохраняются изменения, не затираем их старыми данными с сервера (кроме случая конфликта — force).
  if (state.pending && !force) return;
  const seq = state.seq;
  setLoading(true);
  if (!silent && !state.items.length) {
    $('#list-note').textContent = '';
    // Серые заготовки строк вместо пустого экрана
    $('#items').replaceChildren(...Array.from({ length: 6 }, () => el('li', { class: 'skeleton-row', 'aria-hidden': 'true' },
      el('div', { class: 'thumb loading' }),
      el('div', { class: 'item-main' }, el('div', { class: 'sk-line w70' }), el('div', { class: 'sk-line w45' })),
      el('div', { class: 'sk-line w20' }))));
  }
  try {
    const fresh = await api('list');
    // Пока ждали ответ, что-то поменяли на экране — этот ответ уже устарел, не применяем.
    if (!force && (state.seq !== seq || state.pending)) return;
    // Вещи, удаление которых ещё можно отменить, не показываем.
    state.items = pendingDeletes.size ? fresh.filter((i) => !pendingDeletes.has(i.id)) : fresh;
    state.lastLoad = Date.now();
    saveCache();
    // Миниатюры могли поменяться: подставляем сохранённые, устаревшие забываем, недостающие докачиваем.
    syncThumbs();
    refreshCurrentView();
    prefetchThumbs();
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
    closeSheet();
    try { await loadItems({ silent: true, force: true }); } catch (err) { /* покажем старое */ }
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

// Ползунок под выбранной вкладкой — один на всё время, чтобы он плавно переезжал, а не появлялся заново
const tabIndicator = el('span', { class: 'tab-indicator', 'aria-hidden': 'true' });
const tabIndex = (t) => TABS.indexOf(t);

function renderTabs() {
  const box = $('#status-tabs');
  box.replaceChildren(tabIndicator, ...TABS.map((t) => {
    const n = t === 'Все' ? state.items.length : state.items.filter((i) => i.status === t).length;
    return el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.tab === t),
      onclick: () => switchTab(t),
    }, t, n ? el('span', { class: 'count' }, n) : null);
  }));
  positionIndicator(tabIndex(state.tab), true);
  // ширины вкладок могут уточниться после отрисовки списка — догоняем
  clearTimeout(renderTabs.t);
  renderTabs.t = setTimeout(() => { if (!state.tabSwiping) positionIndicator(tabIndex(state.tab), true); }, 0);
}

/** Поставить ползунок на «дробную» вкладку (1.4 — между 2-й и 3-й) — так он едет за пальцем. */
function positionIndicator(pos, animate) {
  const box = $('#status-tabs');
  const btns = [...box.querySelectorAll('button')];
  if (!btns.length) return;
  const p = Math.max(0, Math.min(btns.length - 1, pos));
  const i0 = Math.floor(p), i1 = Math.min(btns.length - 1, i0 + 1), t = p - i0;
  const b0 = btns[i0], b1 = btns[i1];
  const x = b0.offsetLeft + (b1.offsetLeft - b0.offsetLeft) * t;
  const w = b0.offsetWidth + (b1.offsetWidth - b0.offsetWidth) * t;
  tabIndicator.style.transition = animate ? '' : 'none';
  tabIndicator.style.width = w + 'px';
  tabIndicator.style.transform = `translate3d(${x}px, 0, 0)`;
  // Ближайшая к ползунку вкладка — жирная, пока тянем
  const near = Math.round(p);
  btns.forEach((b, i) => b.classList.toggle('near', i === near));
  // Вкладка за краем полосы — подкрутить полосу, чтобы ползунок был виден
  if (animate && (x < box.scrollLeft || x + w > box.scrollLeft + box.clientWidth)) {
    box.scrollTo({ left: Math.max(0, x - 24), behavior: 'smooth' });
  }
}

/** Переключить вкладку с анимацией: список уезжает в сторону, новая вкладка въезжает с другой. */
function switchTab(t) {
  const from = tabIndex(state.tab), to = tabIndex(t);
  if (from === to) return;
  haptic('tap');
  state.tab = t;
  renderList();
  slideList(to > from ? 1 : -1);
}

function slideList(dir) {
  const items = $('#list-pane');
  items.classList.remove('slide-next', 'slide-prev');
  void items.offsetWidth;
  items.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
  items.addEventListener('animationend', () => items.classList.remove('slide-next', 'slide-prev'), { once: true });
}

/** Палец по списку влево/вправо — соседняя вкладка; ползунок едет вместе с пальцем. */
function bindTabSwipe() {
  const pane = $('#list-pane');
  let sx = 0, sy = 0, dx = 0, lastX = 0, lastT = 0, speed = 0, tracking = false, horiz = false;
  pane.addEventListener('pointerdown', (e) => {
    if (state.select || (e.pointerType === 'mouse' && e.button !== 0)) return;
    sx = lastX = e.clientX; sy = e.clientY; lastT = performance.now();
    dx = 0; speed = 0; tracking = true; horiz = false;
  });
  pane.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!horiz) {
      if (Math.abs(my) > 10) { tracking = false; return; }            // это прокрутка
      if (Math.abs(mx) < 12 || Math.abs(mx) < Math.abs(my) * 1.5) return;
      horiz = true;
      state.tabSwiping = true;
      try { pane.setPointerCapture(e.pointerId); } catch (err) { /* синтетика */ }
      pane.style.transition = 'none';
    }
    const now = performance.now();
    speed = (e.clientX - lastX) / Math.max(1, now - lastT);
    lastX = e.clientX; lastT = now;
    const i = tabIndex(state.tab);
    const edge = (mx > 0 && i === 0) || (mx < 0 && i === TABS.length - 1);
    dx = edge ? mx * 0.25 : mx;                                         // у крайней вкладки — упругое сопротивление
    pane.style.transform = `translate3d(${dx}px, 0, 0)`;
    positionIndicator(i - dx / pane.offsetWidth, false);
  });
  const end = (cancelled) => {
    if (!tracking) return;
    tracking = false;
    if (!horiz) return;
    const width = pane.offsetWidth;
    const i = tabIndex(state.tab);
    let target = i;
    // Переключаем: протянули больше ~четверти ширины или быстро смахнули (но хотя бы на 40 px)
    const flick = Math.abs(speed) > 0.45 && Math.abs(dx) > 40;
    if (!cancelled && (Math.abs(dx) > width * 0.22 || flick)) target = i + (dx < 0 ? 1 : -1);
    target = Math.max(0, Math.min(TABS.length - 1, target));
    pane.style.transition = '';
    if (target === i) {
      pane.style.transform = '';                                        // не дотянули — мягко назад
      positionIndicator(i, true);
    } else {
      const d = target > i ? 1 : -1;
      pane.style.transform = `translate3d(${-d * width * 0.35}px, 0, 0)`;
      pane.style.opacity = '0';
      haptic('tap');
      setTimeout(() => {
        state.tab = TABS[target];
        renderList();
        pane.style.transition = 'none';
        pane.style.transform = `translate3d(${d * width * 0.25}px, 0, 0)`;
        void pane.offsetWidth;
        pane.style.transition = '';
        pane.style.transform = '';
        pane.style.opacity = '';
      }, 140);
    }
    setTimeout(() => { state.tabSwiping = false; }, 50);
  };
  pane.addEventListener('pointerup', () => end(false));
  pane.addEventListener('pointercancel', () => end(true));
}

function renderChips() {
  const pool = state.tab === 'Все' ? state.items : state.items.filter((i) => i.status === state.tab);
  const cats = [...new Set(pool.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  // Выбранной категории нет в этой вкладке — сбрасываем выбор, а не показываем её с нулём
  if (state.category && !cats.includes(state.category)) state.category = '';
  const box = $('#cat-chips');
  box.hidden = cats.length < 2;
  box.replaceChildren(...['', ...cats].map((c) => el('button', {
    type: 'button', 'aria-pressed': String(state.category === c),
    onclick: () => { state.category = c; haptic('tap'); renderList(); },
  }, c || 'Все категории', c ? el('span', { class: 'count' }, pool.filter((i) => i.category === c).length) : null)));
}

function monthSales(offset = 0) {
  const now = new Date();
  const ref = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return state.items.filter((i) => {
    const d = parseRuDate(i.saleDate);
    return i.status === STATUS.sold && d && d.getMonth() === ref.getMonth() && d.getFullYear() === ref.getFullYear();
  });
}

/** Подсказка на главном экране: сколько вещей без «Кто платил» (нужно для расчёта партнёров). */
function renderBuyerHint() {
  const ids = state.items.filter((i) => isNum(i.buyPrice) && i.buyPrice > 0 && !i.buyer && !isCommission(i)).map((i) => i.id);
  const hint = $('#buyer-hint');
  hint.hidden = !ids.length || Boolean(state.select);
  if (!ids.length) return;
  hint.replaceChildren(el('span', {}, `${pieces(ids.length)} без «Кто платил»`), el('b', {}, 'Указать ›'));
  hint.onclick = () => bulkFillBuyer(ids);
}

/** Короткая сумма для карточек: 4,0 млн ₽ / 125 тыс ₽ / 900 ₽. */
function shortRub(n, signed) {
  if (!isNum(n)) return '—';
  const a = Math.abs(n);
  const sign = signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
  const fmt = (v, d) => v.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d });
  if (a >= 1e6) return sign + fmt(a / 1e6, a >= 1e7 ? 0 : 1) + ' млн ₽';
  if (a >= 1e4) return sign + fmt(Math.round(a / 1e3), 0) + ' тыс ₽';
  return sign + nf.format(Math.round(a)) + ' ₽';
}

function renderSummary() {
  const unsold = state.items.filter((i) => i.status !== STATUS.sold);
  const transit = unsold.filter((i) => i.status === STATUS.inTransit).length;
  const invested = unsold.reduce((s, i) => s + (i.buyPrice || 0), 0);
  const sold = monthSales();
  const profit = sold.reduce((s, i) => s + (profitOf(i) || 0), 0);
  const kpi = (label, value, sub, onclick, cls) => el('button', { type: 'button', class: 'kpi', onclick },
    el('span', { class: 'kpi-label' }, label),
    el('b', { class: 'kpi-value ' + (cls || '') }, value),
    sub ? el('span', { class: 'kpi-sub' }, sub) : null);
  $('#summary').replaceChildren(
    kpi('Не продано', String(unsold.length), transit ? 'в пути ' + transit : 'шт.', () => openListTab(STATUS.inStock)),
    kpi('Вложено', shortRub(invested), 'в непроданном', () => openStats('general')),
    kpi('Прибыль/мес', shortRub(profit, true), 'продано ' + sold.length, () => openStats('general'), profit < 0 ? 'profit-minus' : profit > 0 ? 'profit-plus' : ''),
  );
}

const SORTS = {
  new: (a, b) => b._idx - a._idx,
  old: (a, b) => a._idx - b._idx,
  priceDesc: (a, b) => priceOf(b) - priceOf(a),
  priceAsc: (a, b) => priceOf(a) - priceOf(b),
  stale: (a, b) => (daysHeld(b) || 0) - (daysHeld(a) || 0),
  // прибыль: у проданных — фактическая, у остальных — ожидаемая с плановой цены
  profit: (a, b) => ((profitOf(b) ?? plannedGain(b) ?? -Infinity) - (profitOf(a) ?? plannedGain(a) ?? -Infinity)) || 0,
};
function priceOf(i) {
  const v = i.status === STATUS.sold ? i.salePrice : i.planPrice;
  return isNum(v) ? v : -1;
}

// Русские написания брендов и слов → как они записаны в таблице (поиск по началу слова: «хро» → chrome).
const SEARCH_ALIASES = {
  'хром': 'chrome', 'хартс': 'hearts', 'харт': 'heart', 'эрд': 'erd', 'ерд': 'erd', 'энфантс': 'enfants', 'анфан': 'enfants',
  'баленсиага': 'balenciaga', 'лоро': 'loro', 'пиана': 'piana', 'борис': 'boris', 'биджан': 'bidjan',
  'сабери': 'saberi', 'кэрол': 'carol', 'кароль': 'carol', 'поэлл': 'poell', 'стон': 'stone', 'стоун': 'stone', 'айленд': 'island',
  'суприм': 'supreme', 'найк': 'nike', 'данк': 'dunk', 'прада': 'prada', 'гуччи': 'gucci', 'гучи': 'gucci', 'стусси': 'stussy',
  'нью': 'new', 'беланс': 'balance', 'бэланс': 'balance', 'норт': 'north', 'фейс': 'face', 'мэтти': 'matty', 'мати': 'matty',
  'худи': 'hoodie', 'лонгслив': 'longsleeve', 'лонг': 'long', 'футболк': 'tee', 'штаны': 'pants', 'брюки': 'pants', 'куртк': 'jacket',
  'бомбер': 'bomber', 'ботинки': 'boot', 'сапоги': 'boot', 'кроссовки': 'sneaker', 'ремень': 'belt', 'очки': 'sunglasses',
  'сумка': 'bag', 'рубашка': 'shirt', 'свитшот': 'crewneck', 'шуба': 'fur', 'кожан': 'leather', 'шелк': 'silk', 'шёлк': 'silk',
};
/** Слово запроса → варианты для поиска: само слово + английское написание, если начало совпало со словарём. */
function searchVariants(word) {
  const out = [word];
  Object.entries(SEARCH_ALIASES).forEach(([ru, en]) => {
    if (word.length >= 3 && (ru.startsWith(word) || word.startsWith(ru))) out.push(en);
  });
  return out;
}

function filtered() {
  const words = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean).map(searchVariants);
  return state.items
    .map((i, idx) => Object.assign({}, i, { _idx: idx }))
    .filter((i) => {
      if (state.tab !== 'Все' && i.status !== state.tab) return false;
      if (state.category && i.category !== state.category) return false;
      if (!words.length) return true;
      const hay = [i.title, i.brand, i.size, i.category, i.notes, i.id, i.consignor, i.seller, i.buyer, i.soldBy]
        .join(' ').toLowerCase();
      return words.every((variants) => variants.some((v) => hay.includes(v)));
    })
    .sort(SORTS[state.sort] || SORTS.new);
}

function itemRow(item, onClick, swipeable) {
  const thumb = el('div', { class: 'thumb' + (item.hasPhoto ? ' loading' : '') }, item.hasPhoto ? null : icon('shirt'));
  if (item.hasPhoto) lazyPhoto(item.id, thumb);
  const p = profitOf(item);
  const tags = [];
  if (item.status === STATUS.inTransit && state.tab !== STATUS.inTransit) tags.push(el('span', { class: 'badge info' }, 'В пути'));
  if (item.status === STATUS.reserved && state.tab !== STATUS.reserved) tags.push(el('span', { class: 'badge warn' }, 'Бронь'));
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
  const price = rub(item.status === STATUS.sold ? item.salePrice : item.planPrice);
  const content = swipeable && state.layout === 'grid'
    ? el('div', { class: 'item card' },
      el('div', { class: 'card-ph' },
        thumb,
        item.size ? el('span', { class: 'card-size' }, item.size) : null,
        tags.length ? el('div', { class: 'card-tags' }, tags.slice(0, 3)) : null),
      el('div', { class: 'card-info' },
        el('div', { class: 'item-title' }, item.title || 'Без названия'),
        el('div', { class: 'item-sub' }, flag + (item.brand || item.category || '—')),
        el('div', { class: 'card-price' }, price, sub)))
    : el('div', { class: 'item' },
    thumb,
    el('div', { class: 'item-main' },
      el('div', { class: 'item-title' }, item.title || 'Без названия'),
      el('div', { class: 'item-sub' }, flag + ([item.brand, item.size, item.category].filter(Boolean).join(' · ') || '—')),
      tags.length ? el('div', { class: 'item-tags' }, tags) : null),
    el('div', { class: 'item-price' }, price, sub));
  const row = el('li', { class: 'swipe-row', 'data-id': item.id }, content);
  content.addEventListener('click', () => {
    if (row.dataset.swiped || state.tabSwiping) return; // долгое нажатие или листание вкладок, а не тап
    if (state.select) { toggleSelect(item.id); return; }
    (onClick || (() => openItem(item.id)))();
  });
  if (swipeable) {
    if (state.select && state.select.has(item.id)) row.classList.add('selected');
    enableLongPress(row, content, item.id);
  }
  return row;
}

// ---------------------------------------------------------------- потянуть вниз → обновить

const PTR_TRIGGER = 70; // px — достаточно потянули

function enablePullToRefresh() {
  const ind = document.getElementById('ptr');
  let startX = 0, startY = 0, pull = 0, active = false, decided = false;
  const setPull = (px) => {
    pull = px;
    const p = Math.min(1, px / PTR_TRIGGER);
    ind.style.transform = `translate3d(-50%, ${Math.min(px, PTR_TRIGGER * 1.4) - 48}px, 0) rotate(${p * 270}deg)`;
    ind.style.opacity = String(p);
    const ready = px >= PTR_TRIGGER;
    if (ready && !ind.classList.contains('ready')) haptic('tap'); // дотянули — лёгкий отклик
    ind.classList.toggle('ready', ready);
  };
  document.addEventListener('touchstart', (e) => {
    if (state.view !== 'list' || window.scrollY > 0 || state.loading || e.touches.length !== 1) { active = false; return; }
    if (e.target.closest('.swipe-row.open, input, select, textarea')) { active = false; return; }
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    active = true; decided = false; pull = 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!active) return;
    const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      // Только явное движение вниз от самого верха страницы
      if (dy <= 0 || Math.abs(dy) < Math.abs(dx) * 1.5 || window.scrollY > 0) { active = false; return; }
      ind.classList.add('pulling');
    }
    setPull(Math.max(0, dy * 0.55)); // сопротивление: индикатор идёт медленнее пальца
  }, { passive: true });
  const end = async () => {
    if (!active) return;
    active = false;
    ind.classList.remove('pulling');
    if (pull >= PTR_TRIGGER) {
      haptic('tap');
      ind.classList.add('spinning');
      setPull(PTR_TRIGGER);
      try { await loadItems({ silent: true }); toast('Обновлено'); } catch (err) { toast(err.message); }
      ind.classList.remove('spinning');
    }
    ind.style.transform = '';
    ind.style.opacity = '0';
    ind.classList.remove('ready');
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}

// ---------------------------------------------------------------- выделение нескольких вещей

const LONG_PRESS_MS = 450;

/** Долгое нажатие на строку включает режим выделения. */
function enableLongPress(row, content, id) {
  let timer = 0, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  content.addEventListener('pointerdown', (e) => {
    if (state.select || (e.pointerType === 'mouse' && e.button !== 0)) return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => {
      timer = 0;
      row.dataset.swiped = '1';             // не открывать карточку отпусканием пальца
      setTimeout(() => { delete row.dataset.swiped; }, 400);
      haptic('success');
      enterSelect(id);
    }, LONG_PRESS_MS);
  });
  content.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
  content.addEventListener('pointerup', cancel);
  content.addEventListener('pointercancel', cancel);
  content.addEventListener('contextmenu', (e) => { if (timer || state.select) e.preventDefault(); });
}

function enterSelect(firstId) {
  state.select = new Set(firstId ? [firstId] : []);
  document.body.classList.add('select-mode');
  renderList();
  syncSelectBar();
}

function exitSelect() {
  state.select = null;
  document.body.classList.remove('select-mode');
  renderList();
  syncSelectBar();
}

function toggleSelect(id) {
  if (!state.select) return;
  if (state.select.has(id)) state.select.delete(id); else state.select.add(id);
  haptic('tap');
  const row = document.querySelector(`#items .swipe-row[data-id="${CSS.escape(id)}"]`);
  if (row) row.classList.toggle('selected', state.select.has(id));
  syncSelectBar();
}

function selectAllVisible() {
  if (!state.select) return;
  const ids = filtered().map((i) => i.id);
  const all = ids.length > 0 && ids.every((id) => state.select.has(id));
  ids.forEach((id) => { if (all) state.select.delete(id); else state.select.add(id); });
  renderList();
  syncSelectBar();
}

function syncSelectBar() {
  const bar = $('#select-bar');
  const on = Boolean(state.select);
  bar.hidden = !on;
  $('#btn-add').hidden = on;
  if (tg && tg.BackButton && state.view === 'list') {
    try { if (on) tg.BackButton.show(); else tg.BackButton.hide(); } catch (e) { /* нет */ }
  }
  if (!on) return;
  const n = state.select.size;
  $('#select-count').textContent = n ? `Выбрано: ${n}` : 'Выберите вещи';
  const visible = filtered().map((i) => i.id);
  $('#select-all').textContent = visible.length && visible.every((id) => state.select.has(id)) ? 'Снять все' : 'Выбрать все';
  bar.querySelectorAll('[data-bulk]').forEach((b) => { b.disabled = n === 0; });
}

/** Шторка выбора значения для массового действия. */
function openPicker(title, options, onPick) {
  const sheet = $('#picker-sheet');
  $('#picker-title').textContent = title;
  $('#picker-list').replaceChildren(...options.map(([value, label]) => el('button', {
    type: 'button', class: 'picker-option',
    onclick: () => { sheet.hidden = true; onPick(value); },
  }, label)));
  sheet.hidden = false;
}

const BULK_LABELS = { buyer: 'Кто платил', status: 'Статус', country: 'Страна', category: 'Категория' };

function bulkPick(field) {
  const n = state.select ? state.select.size : 0;
  if (!n) return;
  let options;
  if (field === 'buyer') options = [...walletList().map((p) => [p, walletLabel(p)]), ['', '— не указано']];
  else if (field === 'status') options = [STATUS.inTransit, STATUS.inStock, STATUS.reserved].map((s) => [s, s]);
  else if (field === 'country') {
    options = [...(state.lists.country || DEFAULT_LISTS.country).map((c) => [c, withFlag(c)]), ['', '— не указано']];
  } else options = (state.lists.category || []).map((c) => [c, c]);
  openPicker(`${BULK_LABELS[field]} — для ${pieces(n)}`, options, (value) => applyBulk(field, value));
}

/** Массовое изменение: сразу на экране, сервер в фоне, при ошибке — откат. */
async function applyBulk(field, value) {
  const ids = [...state.select];
  const targets = state.items.filter((i) => ids.includes(i.id) && !(field === 'status' && i.status === STATUS.sold));
  const before = targets.map((i) => ({ ...i }));
  targets.forEach((i) => {
    i[field] = value;
    if (field === 'status') Object.assign(i, { salePrice: null, saleDate: '', soldBy: '' });
  });
  const skipped = ids.length - targets.length;
  state.pending++;
  saveCache();
  exitSelect();
  haptic('success');
  toast(`${BULK_LABELS[field]}: ${value || 'не указано'} — ${pieces(targets.length)}`
    + (skipped ? ` (проданные не тронуты: ${skipped})` : ''));
  try {
    await api('bulkUpdate', { ids, patch: { [field]: value } });
    state.pending--;
    if (!state.pending) await loadItems({ silent: true });
  } catch (e) {
    state.pending--;
    targets.forEach((i, k) => { Object.keys(i).forEach((key) => delete i[key]); Object.assign(i, before[k]); });
    saveCache();
    renderList();
    handleWriteError(e);
  }
}

/** Из «Партнёры»: открыть список, выделить вещи без «Кто платил» и сразу спросить партнёра. */
function bulkFillBuyer(ids) {
  state.tab = 'Все';
  state.category = '';
  state.query = '';
  $('#search').value = '';
  $('#search-clear').hidden = true;
  show('list');
  enterSelect();
  ids.forEach((id) => state.select.add(id));
  renderList();
  syncSelectBar();
  bulkPick('buyer');
}

async function bulkDelete() {
  const ids = [...state.select];
  if (!ids.length) return;
  if (!(await ask(`Удалить ${pieces(ids.length)} из таблицы? Фото уйдут в корзину Google Диска.`))) return;
  const removed = state.items.filter((i) => ids.includes(i.id));
  const snapshot = state.items.slice();
  state.items = state.items.filter((i) => !ids.includes(i.id));
  state.pending++;
  saveCache();
  exitSelect();
  haptic('success');
  toast(`Удалено: ${pieces(removed.length)}`);
  try {
    await api('bulkDelete', { ids });
    state.pending--;
    if (!state.pending) await loadItems({ silent: true });
  } catch (e) {
    state.pending--;
    state.items = snapshot;
    saveCache();
    renderList();
    handleWriteError(e);
  }
}

// ---------------------------------------------------------------- прокрутка

// Тень у панели поиска, когда она прилипла к верху: метка над панелью ушла за экран.
function updateStuck() {
  const sentinel = document.getElementById('toolbar-sentinel');
  if (!sentinel || state.view !== 'list') return;
  document.getElementById('toolbar').classList.toggle('stuck', sentinel.getBoundingClientRect().top < 0);
}
if ('IntersectionObserver' in window) {
  new IntersectionObserver(updateStuck).observe(document.getElementById('toolbar-sentinel'));
}

// Работа при прокрутке — не чаще раза в кадр (~16 мс), чтобы листание не подтормаживало.
let lastScrollY = 0;
let scrollQueued = false;
function onScrollFrame() {
  scrollQueued = false;
  updateStuck();
  lastScrollY = window.scrollY;
}
window.addEventListener('scroll', () => {
  if (scrollQueued) return;
  scrollQueued = true;
  setTimeout(onScrollFrame, 16);
}, { passive: true });

const UNDO_MS = 5000;          // сколько секунд можно отменить удаление
const pendingDeletes = new Map(); // id → функция «удалить на сервере прямо сейчас»

/**
 * Удаление вещи (из свайпа, карточки или формы): строка сразу исчезает, внизу «Отменить» на 5 секунд.
 * На сервер удаление уходит после этого (или сразу, если приложение сворачивают).
 */
async function deleteItem(stale) {
  // Ищем по ID: пока была открыта форма, список мог обновиться и объект смениться.
  const index = state.items.findIndex((i) => i.id === stale.id);
  const item = index !== -1 ? state.items[index] : stale;
  const version = item.changedAt;
  const row = document.querySelector(`.swipe-row[data-id="${CSS.escape(item.id)}"]`);
  state.form.dirty = false;
  haptic('success');
  if (row && state.view === 'list') {
    row.style.height = row.offsetHeight + 'px';
    void row.offsetHeight;
    row.classList.add('removing');
    await new Promise((r) => setTimeout(r, 220));
  }
  if (index !== -1) state.items.splice(index, 1);
  state.pending++;
  saveCache();
  if (state.view !== 'list') show('list');
  renderList();

  let done = false;
  const restore = () => {
    if (index !== -1 && !state.items.includes(item)) state.items.splice(Math.min(index, state.items.length), 0, item);
    saveCache();
    renderList();
  };
  const commit = async () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pendingDeletes.delete(item.id);
    saveCache();
    try {
      await api('delete', { id: item.id, version });
      state.pending--;
      if (!state.pending) await loadItems({ silent: true });
    } catch (e) {
      state.pending--;
      restore();
      handleWriteError(e);
    }
  };
  const timer = setTimeout(commit, UNDO_MS);
  pendingDeletes.set(item.id, commit);
  toast(`Удалено: ${item.title}`, UNDO_MS, {
    label: 'Отменить',
    fn: () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingDeletes.delete(item.id);
      state.pending--;
      restore();
      haptic('tap');
    },
  });
  return true;
}

/** Приложение сворачивают — отложенные удаления отправляем сразу, чтобы не потерялись. */
function flushPendingDeletes() {
  [...pendingDeletes.values()].forEach((commit) => commit());
}

function renderList() {
  renderTabs();
  renderChips();
  renderSummary();
  renderBuyerHint();
  const list = filtered();
  const note = $('#list-note');
  const box = $('#items');
  box.classList.toggle('grid', state.layout === 'grid' && list.length > 0);

  if (!list.length) {
    note.textContent = '';
    // Пустая вкладка — объясняем, что здесь бывает и как сюда попасть
    const TAB_HINTS = {
      [STATUS.inTransit]: ['Ничего не едет', 'Здесь вещи, которые оплачены, но ещё в пути. При добавлении выберите статус «В пути».'],
      [STATUS.inStock]: ['В наличии пусто', 'Добавьте вещь или отметьте «Получена» у той, что в пути.'],
      [STATUS.reserved]: ['Броней нет', 'Отложить вещь для покупателя — «В бронь» в её карточке.'],
      [STATUS.sold]: ['Продаж пока нет', 'Отметьте продажу кнопкой «Продано» в карточке вещи.'],
    };
    const filteredOut = state.query || state.category;
    const [title, text] = !state.items.length ? ['Вещей пока нет', 'Начните с первой — фото, название и цена закупа.']
      : filteredOut ? ['Ничего не найдено', state.query ? `По запросу «${state.query.trim()}» в этой вкладке ничего нет.` : 'В этой категории здесь ничего нет.']
        : (TAB_HINTS[state.tab] || ['Пусто', '']);
    const empty = el('div', { class: 'empty' }, icon('box'), el('b', { class: 'empty-title' }, title), text ? el('p', {}, text) : null,
      filteredOut ? el('button', { type: 'button', onclick: resetFilters }, 'Сбросить фильтры') : null,
      !state.items.length ? el('button', { type: 'button', class: 'primary', onclick: () => openForm('add') }, 'Добавить первую') : null,
      filteredOut && state.tab !== 'Все' ? el('button', { type: 'button', class: 'link-btn', onclick: () => switchTab('Все') }, 'Искать во всех вкладках') : null);
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
  if (state.query.trim()) note.textContent = `Найдено: ${pieces(list.length)}`;
  const ids = list.map((i) => i.id); // порядок для пролистывания карточек
  box.replaceChildren(...list.map((item) => itemRow(item, () => { state.navIds = ids; openItem(item.id); }, true)));
}

function resetFilters() {
  state.query = '';
  state.category = '';
  $('#search').value = '';
  renderList();
}

// ---------------------------------------------------------------- фото

// ---- миниатюры хранятся на телефоне: при следующем открытии показываются сразу, без сервера
// Запись: id вещи → { k: «версия» фото (имя файла), src: картинка }. Сменилось фото — сменилась версия.
const thumbStore = (() => {
  const DB = DEMO ? 'uv-demo-thumbs' : 'uv-thumbs';
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB, 1);
          req.onupgradeneeded = () => req.result.createObjectStore('t');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    }
    return dbp;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const t = db.transaction('t', mode);
        const r = fn(t.objectStore('t'));
        t.oncomplete = () => resolve(r && 'result' in r ? r.result : null);
        t.onerror = t.onabort = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  };
  return {
    /** Все сохранённые миниатюры: Map id → { k, src }. */
    async all() {
      const out = new Map();
      const db = await open();
      if (!db) return out;
      return new Promise((resolve) => {
        try {
          const req = db.transaction('t').objectStore('t').openCursor();
          req.onsuccess = () => {
            const c = req.result;
            if (!c) { resolve(out); return; }
            out.set(c.key, c.value);
            c.continue();
          };
          req.onerror = () => resolve(out);
        } catch (e) { resolve(out); }
      });
    },
    put(id, k, src) { return tx('readwrite', (st) => st.put({ k, src }, id)); },
    del(id) { return tx('readwrite', (st) => st.delete(id)); },
  };
})();
const photoKeys = new Map(); // id → версия миниатюры, которая сейчас в state.photos
const savedThumbs = { map: null, ready: null };
function loadSavedThumbs() {
  if (!savedThumbs.ready) {
    // не ждём дольше 400 мс: если хранилище тормозит — грузим с сервера как раньше
    savedThumbs.ready = Promise.race([
      thumbStore.all().then((m) => {
        savedThumbs.map = m;
        // Хранилище ответило позже, чем ждали, — всё равно подставляем сохранённые фото
        if (state.items.length) {
          const before = new Set(state.photos.keys());
          syncThumbs();
          state.photos.forEach((src, id) => { if (!before.has(id)) paintPhoto(id, src); });
        }
      }),
      new Promise((r) => setTimeout(r, 400)),
    ]);
  }
  return savedThumbs.ready;
}
const keyOf = (id) => { const it = state.items.find((i) => i.id === id); return it ? (it.photoKey || '') : ''; };

/** Свериться с хранилищем: подставить сохранённые миниатюры, выбросить устаревшие. */
function syncThumbs() {
  const saved = savedThumbs.map;
  state.items.forEach((i) => {
    const k = i.photoKey || '';
    if (!i.hasPhoto) {
      state.photos.delete(i.id); state.fullPhotos.delete(i.id); photoKeys.delete(i.id);
      if (saved && saved.has(i.id)) { saved.delete(i.id); thumbStore.del(i.id); }
      return;
    }
    // Только что сняли фото в форме — оно и есть новая версия: запоминаем его на телефоне
    if (photoKeys.get(i.id) === 'local' && state.photos.get(i.id)) {
      photoKeys.set(i.id, k); thumbStore.put(i.id, k, state.photos.get(i.id));
      if (saved) saved.set(i.id, { k, src: state.photos.get(i.id) });
    }
    // В памяти фото другой версии — забыть (и большое тоже)
    if (photoKeys.has(i.id) && photoKeys.get(i.id) !== k) {
      state.photos.delete(i.id); state.fullPhotos.delete(i.id); photoKeys.delete(i.id);
    }
    if (!state.photos.has(i.id) && saved && saved.has(i.id)) {
      const v = saved.get(i.id);
      if (v && v.k === k && v.src) { state.photos.set(i.id, v.src); photoKeys.set(i.id, k); }
    }
  });
}

/** Докачать в фоне миниатюры всех вещей, которых ещё нет — чтобы другие вкладки открывались уже с фото. */
function prefetchThumbs() {
  clearTimeout(prefetchThumbs.t);
  prefetchThumbs.t = setTimeout(() => {
    state.items.forEach((i) => {
      if (i.hasPhoto && !state.photos.has(i.id) && !photoQueue.some((q) => q.id === i.id)) photoQueue.push({ id: i.id });
    });
    pumpPhotos();
  }, 1200); // сначала — то, что на экране
}

// Миниатюры грузим пачками, не больше нескольких запросов одновременно.
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
  // Чуть подождать, чтобы собрать в один запрос все строки, появившиеся на экране разом
  if (!queuePhoto.timer) queuePhoto.timer = setTimeout(() => { queuePhoto.timer = 0; pumpPhotos(); }, 16);
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
// Миниатюры — пачками по 8 одним запросом (сервер отвечает ~1 с на запрос, а не на фото), 2 запроса параллельно.
const PHOTO_BATCH = 8;
const PHOTO_PARALLEL = 3;
function pumpPhotos() {
  while (photoActive < PHOTO_PARALLEL && photoQueue.length) {
    const batch = [];
    while (batch.length < PHOTO_BATCH && photoQueue.length) {
      const { id } = photoQueue.shift();
      if (state.photos.has(id)) paintPhoto(id, state.photos.get(id));
      else if (!batch.includes(id)) batch.push(id);
    }
    if (!batch.length) continue;
    photoActive++;
    api('photos', { ids: batch })
      .catch(() => ({}))
      .then((res) => {
        batch.forEach((id) => {
          const ph = res && res[id];
          const src = ph ? `data:${ph.mime};base64,${ph.base64}` : null;
          state.photos.set(id, src);
          if (src) {
            const k = keyOf(id);
            photoKeys.set(id, k);
            thumbStore.put(id, k, src);
            if (savedThumbs.map) savedThumbs.map.set(id, { k, src });
          }
          paintPhoto(id, src);
        });
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

// ---- просмотр фото: двойное нажатие — увеличить, смахнуть вниз — закрыть, нажатие — закрыть
const lightbox = { scale: 1, tx: 0, ty: 0, lastTap: 0, closeTimer: 0, moved: false };

function lbImage() { return $('#lightbox img'); }
function lbApply(animate) {
  const img = lbImage();
  if (!img) return;
  img.style.transition = animate ? 'transform .25s cubic-bezier(.2,.8,.2,1)' : 'none';
  img.style.transform = `translate3d(${lightbox.tx}px, ${lightbox.ty}px, 0) scale(${lightbox.scale})`;
}

function openLightbox() {
  const item = state.current;
  if (!item || !item.hasPhoto) return;
  const lb = $('#lightbox');
  const src = state.fullPhotos.get(item.id) || state.photos.get(item.id);
  Object.assign(lightbox, { scale: 1, tx: 0, ty: 0, lastTap: 0, moved: false });
  lb.style.background = '';
  lb.replaceChildren(src ? el('img', { src, alt: item.title, draggable: 'false' }) : el('p', {}, 'Загрузка…'));
  lb.classList.remove('closing');
  lb.hidden = false;
  loadFullPhoto(item.id).then((full) => {
    if (full && !lb.hidden) { lb.replaceChildren(el('img', { src: full, alt: item.title, draggable: 'false' })); lbApply(false); }
  });
}

function closeLightbox() {
  const lb = $('#lightbox');
  if (lb.hidden) return;
  lb.classList.add('closing');
  setTimeout(() => { lb.hidden = true; lb.classList.remove('closing'); lb.style.background = ''; }, 180);
}

function bindLightbox() {
  const lb = $('#lightbox');
  let sx = 0, sy = 0, bx = 0, by = 0, dragging = false;
  lb.addEventListener('pointerdown', (e) => {
    if (!lbImage()) return;
    dragging = true; lightbox.moved = false;
    sx = e.clientX; sy = e.clientY; bx = lightbox.tx; by = lightbox.ty;
    try { lb.setPointerCapture(e.pointerId); } catch (err) { /* синтетические события */ }
  });
  lb.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!lightbox.moved && Math.hypot(dx, dy) < 6) return;
    lightbox.moved = true;
    if (lightbox.scale > 1) { lightbox.tx = bx + dx; lightbox.ty = by + dy; }  // увеличено — двигаем фото
    else {                                                                      // обычный размер — тянем вниз/вверх
      lightbox.tx = 0; lightbox.ty = dy;
      lb.style.background = `rgba(0,0,0,${Math.max(0.25, 1 - Math.abs(dy) / 400)})`;
    }
    lbApply(false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (!lightbox.moved) return;
    if (lightbox.scale === 1) {
      if (Math.abs(lightbox.ty) > 110) { closeLightbox(); return; }       // смахнули — закрыть
      lightbox.ty = 0; lb.style.background = ''; lbApply(true);           // не дотянули — вернуть
    }
  };
  lb.addEventListener('pointerup', end);
  lb.addEventListener('pointercancel', end);
  lb.addEventListener('click', (e) => {
    if (lightbox.moved) { lightbox.moved = false; return; } // это было перетаскивание
    const now = Date.now();
    if (now - lightbox.lastTap < 300) {
      // Двойное нажатие: увеличить в точке нажатия / вернуть
      clearTimeout(lightbox.closeTimer);
      lightbox.lastTap = 0;
      if (lightbox.scale === 1) {
        const img = lbImage();
        if (!img) return;
        const r = img.getBoundingClientRect();
        lightbox.scale = 2;
        lightbox.tx = (r.left + r.width / 2 - e.clientX);
        lightbox.ty = (r.top + r.height / 2 - e.clientY);
      } else Object.assign(lightbox, { scale: 1, tx: 0, ty: 0 });
      lbApply(true);
      return;
    }
    lightbox.lastTap = now;
    // Одиночное нажатие закрывает (ждём — вдруг это начало двойного)
    if (lightbox.scale === 1) lightbox.closeTimer = setTimeout(closeLightbox, 300);
  });
}

// ---------------------------------------------------------------- карточка

const ITEM_FIELDS = [
  // бренд, размер, состояние и страна — метками над ценой, в таблице не дублируем
  ['category', 'Категория'], ['authenticity', 'Подлинность'], ['source', 'Источник'], ['consignor', 'Комитент'],
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
  // Короткие метки: главное о вещи одной строкой
  $('#item-chips').replaceChildren(...[item.brand, item.size ? 'Размер ' + item.size : '', item.condition, withFlag(item.country)]
    .filter(Boolean).map((t) => el('span', { class: 'chip' }, t)));
  // Счётчик «3 / 9» — если открыто из списка
  const nav = state.navIds.indexOf(item.id);
  const counter = $('#item-counter');
  counter.hidden = !(nav !== -1 && state.navIds.length > 1);
  counter.textContent = nav !== -1 ? `${nav + 1} / ${state.navIds.length}` : '';
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
  // Строка под ценой: закуп или комиссия
  const sub = [];
  if (isCommission(item)) {
    if (item.consignor) sub.push('комитент ' + item.consignor);
    if (isNum(item.commissionPct)) sub.push(`комиссия ${item.commissionPct}%`);
  } else if (isNum(item.buyPrice)) sub.push('закуп ' + rub(item.buyPrice));
  if (!isCommission(item) && item.buyer) sub.push(item.buyer === COMMON ? 'из общей кассы' : 'платил ' + item.buyer);
  if (item.status === STATUS.sold && item.saleDate) sub.push('продано ' + item.saleDate);
  if (item.status === STATUS.sold && item.soldBy) sub.push(item.soldBy === COMMON ? 'деньги в кассе' : 'деньги у ' + item.soldBy);
  const subBox = $('#item-subprice');
  subBox.replaceChildren(sub.join(' · '));
  // Не указано, кто платил, — ссылка «указать» прямо здесь (одно нажатие вместо «Изменить»)
  if (!isCommission(item) && !item.buyer && isNum(item.buyPrice) && item.buyPrice > 0) {
    subBox.append(sub.length ? ' · ' : '', el('button', { type: 'button', class: 'inline-link', onclick: () => pickBuyer(item) }, 'указать, кто платил'));
  }

  const rows = [];
  ITEM_FIELDS.forEach(([key, label, fmt]) => {
    const v = item[key];
    if (v === '' || v === null || v === undefined) return;
    if (key === 'buyPrice') return;                                    // закуп — уже под ценой
    if (key === 'planPrice' && item.status !== STATUS.sold) return;   // план — это и есть большая цена
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

/** Следующая (+1) / предыдущая (−1) вещь текущего списка. */
function navItem(dir) {
  const ids = state.navIds;
  const i = state.current ? ids.indexOf(state.current.id) : -1;
  if (i === -1 || ids.length < 2) return false;
  const next = ids[(i + dir + ids.length) % ids.length];
  if (!state.items.some((it) => it.id === next)) return false;
  openItem(next, { push: false });
  ignoreScrollUntil = Date.now() + 150;
  window.scrollTo(0, 0);
  animateView($('#view-item'), dir > 0 ? 'enter-forward' : 'enter-back');
  haptic('tap');
  return true;
}

/** Смахивание фото в карточке влево/вправо листает вещи. */
function bindPhotoSwipe() {
  const wrap = $('#item-photo-wrap');
  let sx = 0, sy = 0, tracking = false, horizontal = false, dx = 0;
  wrap.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; dx = 0; tracking = true; horizontal = false; });
  wrap.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!horizontal) {
      if (Math.abs(my) > 10) { tracking = false; return; }
      if (Math.abs(mx) < 14 || Math.abs(mx) < Math.abs(my) * 2) return;
      horizontal = true;
      try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* синтетика */ }
      wrap.dataset.swiped = '1';
    }
    dx = mx;
    $('#item-photo').style.transform = `translate3d(${mx * 0.35}px,0,0)`;
  });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    $('#item-photo').style.transform = '';
    if (!horizontal) return;
    if (Math.abs(dx) > 50) navItem(dx < 0 ? 1 : -1);
    setTimeout(() => { delete wrap.dataset.swiped; }, 0);
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
}

/** −10% с округлением вниз до сотни. */
const discounted = (price) => Math.floor((price * 0.9) / 100) * 100;

/**
 * «Сразу показать, сохранить в фоне»: изменение видно мгновенно, сервер (1–2 с) догоняет.
 * Если сервер откажет — возвращаем как было и показываем причину.
 */
async function optimistic(stale, patch, call, okMessage, undoTo) {
  const item = state.items.find((i) => i.id === stale.id) || stale; // актуальный объект из списка
  const before = { ...item };
  Object.assign(item, patch);
  state.pending++;
  saveCache();
  refreshCurrentView();
  haptic('success');
  // undoTo — статус, к которому вернёт «Отменить» (только «В пути» / «В наличии» / «Бронь»)
  let resolveSaved;
  const saved = new Promise((r) => { resolveSaved = r; });
  const canUndo = [STATUS.inTransit, STATUS.inStock, STATUS.reserved].includes(undoTo);
  toast(okMessage, canUndo ? 5000 : 3000, canUndo ? {
    label: 'Отменить',
    fn: async () => {
      if (!(await saved)) return; // сохранение не прошло — откатилось само
      const live = state.items.find((i) => i.id === item.id) || item;
      optimistic(live, { status: undoTo, salePrice: null, saleDate: '', soldBy: '' },
        () => api('setStatus', { id: live.id, status: undoTo, version: live.changedAt }), `Отменено — снова «${undoTo}»`);
    },
  } : undefined);
  try {
    const res = await call();
    // Сервер вернул новую версию — следующее действие с вещью пройдёт без перезагрузки списка
    if (res && res.version) item.changedAt = res.version;
    state.pending--;
    resolveSaved(true);
    if (!state.pending) await loadItems({ silent: true });
  } catch (e) {
    state.pending--;
    resolveSaved(false);
    Object.keys(item).forEach((k) => { delete item[k]; });
    Object.assign(item, before);
    saveCache();
    refreshCurrentView();
    handleWriteError(e);
  }
}

/** Выбрать «Кто платил» прямо из карточки. */
function pickBuyer(item) {
  openPicker('Кто платил за «' + item.title + '»', walletList().map((p) => [p, walletLabel(p)]), (name) => {
    const version = item.changedAt;
    optimistic(item, { buyer: name }, () => api('update', { id: item.id, version, buyer: name }), `Кто платил: ${name}`);
  });
}

async function discount10() {
  const item = state.current;
  const next = discounted(item.planPrice);
  const margin = isNum(item.buyPrice) ? ` Наценка станет ${signedRub(next - item.buyPrice)}.` : '';
  if (!(await ask(`Снизить плановую цену с ${rub(item.planPrice)} до ${rub(next)}?${margin}`))) return;
  const version = item.changedAt;
  optimistic(item, { planPrice: next }, () => api('update', { id: item.id, version, planPrice: next }), `Новая цена: ${rub(next)}`);
}

async function changeStatus(status) {
  const item = state.current;
  if (item.status === STATUS.sold && !(await ask('Вернуть вещь в наличие? Цена и дата продажи сотрутся.'))) return;
  const version = item.changedAt;
  const msg = item.status === STATUS.inTransit && status === STATUS.inStock ? 'Получена — теперь в наличии ✓' : `Статус: ${status}`;
  optimistic(item, { status, salePrice: null, saleDate: '', soldBy: '' },
    () => api('setStatus', { id: item.id, status, version }), msg, item.status);
}

/** Скопировать текст и в Telegram предложить переслать его в любой чат. */
async function shareText(text, title) {
  const ok = await copyText(text);
  if (tg && tg.initData && tg.showPopup && tg.openTelegramLink) {
    try {
      tg.showPopup({
        title: ok ? 'Текст скопирован' : title,
        message: text.slice(0, 250),
        buttons: [{ id: 'share', type: 'default', text: 'Переслать в чат' }, { type: 'close' }],
      }, (id) => {
        if (id === 'share') tg.openTelegramLink('https://t.me/share/url?url=%20&text=' + encodeURIComponent(text));
      });
      return;
    } catch (e) { /* старый Telegram — просто уведомление ниже */ }
  }
  toast(ok ? `${title}: скопировано` : 'Не удалось скопировать');
}

/** Текст отчёта за текущий месяц — для партнёра. */
function reportText() {
  const now = new Date();
  const sold = monthSales(0);
  const revenue = sold.reduce((s, i) => s + (i.salePrice || 0), 0);
  const profit = sold.reduce((s, i) => s + (profitOf(i) || 0), 0);
  const unsold = state.items.filter((i) => i.status !== STATUS.sold);
  const transit = unsold.filter((i) => i.status === STATUS.inTransit).length;
  const invested = unsold.reduce((s, i) => s + (i.buyPrice || 0), 0);
  const lines = [`📊 Учёт вещей — ${MONTHS_FULL[now.getMonth()].toLowerCase()} ${now.getFullYear()}`, ''];
  lines.push(`Продано: ${pieces(sold.length)} на ${rub(revenue)}, прибыль ${signedRub(profit)}`);
  sold.slice(0, 10).forEach((i) => lines.push(`• ${i.title} — ${rub(i.salePrice)}${profitOf(i) !== null ? ' (' + signedRub(profitOf(i)) + ')' : ''}`));
  if (sold.length > 10) lines.push(`• …и ещё ${sold.length - 10}`);
  lines.push('', `Не продано: ${pieces(unsold.length)}${transit ? ` (в пути ${transit})` : ''}, вложено ${rub(invested)}`);
  const totals = [...partnerTotals('month').values()].filter((t) => t.name && (t.buy || t.sale || t.profit));
  if (totals.length) {
    lines.push('', 'По деньгам за месяц:');
    totals.forEach((t) => lines.push(`• ${walletLabel(t.name)}: вложено ${rub(t.buy)}, продано ${rub(t.sale)}, прибыль ${signedRub(t.profit)}`));
  }
  return lines.join('\n');
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

/** Плавно закрыть шторку «Продано» (уезжает вниз). */
function closeSheet() {
  const sheet = $('#sell-sheet');
  if (sheet.hidden || sheet.classList.contains('closing')) return;
  const body = sheet.querySelector('.sheet-body');
  body.style.transform = '';
  sheet.classList.add('closing');
  setTimeout(() => { sheet.hidden = true; sheet.classList.remove('closing'); }, 200);
}

/** Шторку можно смахнуть вниз за ручку или заголовок. */
function bindSheetDrag() {
  const sheet = $('#sell-sheet');
  const body = sheet.querySelector('.sheet-body');
  const grip = sheet.querySelector('.sheet-grip');
  let sy = 0, dy = 0, drag = false;
  const start = (e) => { drag = true; sy = e.clientY; dy = 0; body.style.transition = 'none'; try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* синтетика */ } };
  const move = (e) => { if (!drag) return; dy = Math.max(0, e.clientY - sy); body.style.transform = `translate3d(0, ${dy}px, 0)`; };
  const end = () => {
    if (!drag) return;
    drag = false;
    body.style.transition = '';
    if (dy > 90) closeSheet(); else body.style.transform = '';
  };
  [grip, $('#sell-h')].forEach((h) => {
    h.addEventListener('pointerdown', start);
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  });
}

function openSell() {
  const f = $('#sell-form');
  f.reset();
  f.salePrice.value = isNum(state.current.planPrice) ? state.current.planPrice : '';
  f.saleDate.value = todayIso();
  fillPartnerSelect(f.soldBy, lastWallet());
  // Быстрые цены: по плану, −5%, −10% (округление до сотни)
  const plan = state.current.planPrice;
  const quick = $('#sell-quick');
  quick.replaceChildren(...(isNum(plan) && plan > 0 ? [['по плану', plan], ['−5%', Math.round(plan * 0.95 / 100) * 100], ['−10%', Math.round(plan * 0.9 / 100) * 100]] : [])
    .map(([label, value]) => el('button', {
      type: 'button', class: 'quick-price',
      onclick: () => { f.salePrice.value = value; updateSellProfit(); haptic('tap'); },
    }, el('b', {}, label), ' ', nf.format(value))));
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
  if (f.salePrice.value === '' || Number(f.salePrice.value) < 0) {
    $('#sell-error').textContent = 'Укажите цену продажи.'; f.salePrice.focus(); return;
  }
  const item = state.current;
  const payload = {
    id: item.id, salePrice: Number(f.salePrice.value), saleDate: f.saleDate.value || todayIso(),
    soldBy: f.soldBy.value, version: item.changedAt,
  };
  rememberWallet(payload.soldBy);
  closeSheet();
  optimistic(item, {
    status: STATUS.sold, salePrice: payload.salePrice, saleDate: isoToRu(payload.saleDate), soldBy: payload.soldBy,
  }, () => api('sell', payload), 'Продано ✓', item.status);
}

// ---------------------------------------------------------------- форма (добавить / изменить)

const FORM_FIELDS = ['title', 'category', 'brand', 'size', 'condition', 'country', 'source', 'authenticity', 'consignor',
  'commissionPct', 'buyPrice', 'buyDate', 'buyer', 'seller', 'buyDoc', 'planPrice', 'notes'];
const CLONE_FIELDS = ['title', 'category', 'brand', 'condition', 'country', 'source', 'authenticity', 'consignor',
  'commissionPct', 'buyPrice', 'buyer', 'seller', 'buyDoc', 'planPrice'];
// Поля закупки — у комиссионных вещей их нет.
const BUY_ONLY_FIELDS = ['buyPrice', 'buyer', 'seller'];

const myName = () => (state.user && state.user.name) || '';
/** Общие деньги (касса) — третий «кошелёк» наряду с личными деньгами партнёров. */
const COMMON = 'Общие';
const walletLabel = (n) => (n === COMMON ? 'Общая касса' : n);
const DEFAULT_PARTNERS = ['Арсений', 'Сева'];
/** Люди, за чьи деньги покупаются вещи. Фиксированный список (с сервера), не зависит от того, кто открыл бота. */
function partnerList() {
  const all = (state.partners && state.partners.length ? state.partners : DEFAULT_PARTNERS).filter((n) => n && n !== COMMON);
  return all.filter((n, i) => all.indexOf(n) === i);
}
/** Последний выбранный «кошелёк» на этом телефоне — подставляется по умолчанию. */
const lastWallet = () => { const w = storage.get('uv.wallet'); return w && walletList().includes(w) ? w : ''; };
const rememberWallet = (w) => { if (w) storage.set('uv.wallet', w); };
/** Варианты для «Кто платил» / «Деньги получил»: касса и партнёры. */
function walletList() {
  return [COMMON, ...partnerList()];
}
function fillPartnerSelect(sel, value) {
  sel.replaceChildren(el('option', { value: '' }, '— не указано'), ...walletList().map((n) => el('option', { value: n }, walletLabel(n))));
  setField(sel.form, sel.name, value);
}

function fillSelects() {
  document.querySelectorAll('select[data-list]').forEach((sel) => {
    const partners = sel.dataset.list === 'partners';
    const values = partners ? walletList() : (state.lists[sel.dataset.list] || []);
    const keep = sel.value;
    sel.replaceChildren(
      el('option', { value: '' }, partners ? '— не указано' : '—'),
      ...values.map((v) => el('option', { value: v }, partners ? walletLabel(v) : v)),
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
    setField(f, 'soldBy', item.soldBy || (item.status === STATUS.sold ? '' : lastWallet()));
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
    if (!f.buyer.value) setField(f, 'buyer', lastWallet());
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

function onFormInput(e) {
  if (e && e.target && e.target.classList) e.target.classList.remove('invalid');
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
  f.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
  // Ошибка: подсветить поле, прокрутить к нему, сообщение у кнопки
  const bad = (name, message) => {
    const input = f.elements[name];
    err.textContent = message;
    input.classList.add('invalid');
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => input.focus({ preventScroll: true }), 250);
    haptic('error');
  };
  if (!data.title) { bad('title', 'Укажите название.'); return; }
  if (data.status === STATUS.sold && data.salePrice === '') { bad('salePrice', 'Укажите цену продажи.'); return; }
  for (const k of ['buyPrice', 'planPrice', 'salePrice']) {
    if (data[k] !== undefined && data[k] !== '' && !(Number(data[k]) >= 0)) { bad(k, 'Проверьте цену — нужно число не меньше 0.'); return; }
  }
  if (data.commissionPct !== '' && !(Number(data.commissionPct) >= 0 && Number(data.commissionPct) <= 100)) {
    bad('commissionPct', 'Комиссия — число от 0 до 100 %.'); return;
  }

  const btn = $('#form-submit');
  btn.disabled = true;
  btn.textContent = state.form.photo ? 'Загружаю фото…' : 'Сохраняю…';
  mainButtonBusy(true);
  const photo = state.form.photo ? { mime: state.form.photo.mime, base64: state.form.photo.base64 } : undefined;
  try {
    if (state.form.mode === 'edit') {
      const item = state.current;
      await api('update', Object.assign(data, { id: item.id, version: item.changedAt, photo, removePhoto: state.form.removePhoto }));
      if (photo) { state.photos.set(item.id, state.form.photo.dataUrl); state.fullPhotos.set(item.id, state.form.photo.dataUrl); photoKeys.set(item.id, 'local'); }
      if (state.form.removePhoto) { state.photos.delete(item.id); state.fullPhotos.delete(item.id); }
      state.form.dirty = false;
      haptic('success');
      toast('Сохранено ✓');
      await loadItems({ silent: true, force: true }); // force: показать сохранённое, даже если рядом ждёт удаление
      openItem(item.id, { push: false });
      state.stack = ['list'];
    } else {
      const res = await api('add', Object.assign(data, { photo }));
      if (photo) { state.photos.set(res.id, state.form.photo.dataUrl); state.fullPhotos.set(res.id, state.form.photo.dataUrl); photoKeys.set(res.id, 'local'); }
      state.form.dirty = false;
      storage.del(DRAFT_KEY);
      haptic('success');
      toast(data.status === STATUS.inTransit ? 'Добавлена во «В пути» ✓' : 'Вещь добавлена ✓');
      state.tab = data.status === STATUS.inTransit ? STATUS.inTransit : STATUS.inStock;
      state.query = '';
      $('#search').value = '';
      show('list');
      await loadItems({ silent: true, force: true }); // force: новая вещь видна сразу
    }
  } catch (ex) {
    handleWriteError(ex, err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить';
    mainButtonBusy(false);
  }
}

function deleteCurrent() {
  return deleteItem(state.current);
}

// ---------------------------------------------------------------- статистика

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** Плитка статистики. tab — если задан, нажатие открывает список с этой вкладкой. */
function tile(label, value, sub, cls, tab) {
  const children = [
    el('div', { class: 'tile-label' }, label, tab ? el('span', { class: 'tile-go', 'aria-hidden': 'true' }, '›') : null),
    el('div', { class: 'tile-value ' + (cls || '') }, value),
    sub ? el('div', { class: 'tile-sub' }, sub) : null,
  ];
  if (!tab) return el('div', { class: 'tile' }, ...children);
  return el('button', { type: 'button', class: 'tile tile-link', onclick: () => openListTab(tab) }, ...children);
}

/** Из статистики — в список нужной вкладки (сбросив фильтры). */
function openListTab(tab) {
  state.tab = tab;
  state.category = '';
  state.query = '';
  $('#search').value = '';
  $('#search-clear').hidden = true;
  haptic('tap');
  show('list');
  renderList();
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function openStats(tab) {
  if (typeof tab === 'string') state.statsTab = tab;
  const again = state.view === 'stats';
  show('stats');
  if (again) { window.scrollTo(0, 0); animateView($('#view-stats'), 'enter-forward'); }
  renderStats();
}

// ---------------------------------------------------------------- нижняя панель разделов
function syncNav() {
  const active = state.view === 'list' ? 'list' : state.view === 'stats' ? state.statsTab : '';
  document.querySelectorAll('#bottom-nav [data-nav]').forEach((b) => {
    if (b.dataset.nav === active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

/** Нажатие на раздел внизу. Повторное нажатие на открытый раздел — наверх. */
function navTo(target) {
  haptic('tap');
  if (target === 'list') {
    if (state.view === 'list') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    state.stack = [];
    renderList();
    show('list', { push: false });
    return;
  }
  if (state.view === 'stats' && state.statsTab === target) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  state.statsTab = target;
  // Разделы — верхний уровень: «Назад» из любого ведёт на склад, а не по цепочке разделов
  if (state.view !== 'stats') { state.stack = []; if (state.view !== 'list') state.view = 'list'; }
  openStats();
}

function setLayout(layout) {
  state.layout = layout === 'list' ? 'list' : 'grid';
  document.body.classList.toggle('layout-list', state.layout === 'list');
  storage.set('uv.layout', state.layout);
}

const STATS_TITLES = { general: 'Статистика', partners: 'Партнёры', journal: 'Журнал' };
function renderStats() {
  document.querySelectorAll('[data-stats-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.statsTab === state.statsTab)));
  $('#stats-title').textContent = STATS_TITLES[state.statsTab] || 'Статистика';
  $('#stats-general').hidden = state.statsTab !== 'general';
  $('#stats-partners').hidden = state.statsTab !== 'partners';
  $('#stats-journal').hidden = state.statsTab !== 'journal';
  syncNav();
  if (state.statsTab === 'partners') renderPartners();
  else if (state.statsTab === 'journal') loadHistory();
  else renderGeneralStats();
}

// ---------------------------------------------------------------- партнёры

const PERIODS = [['month', 'Этот месяц'], ['prev', 'Прошлый месяц'], ['all', 'Всё время']];

// ---------------------------------------------------------------- деньги: свободные и в одежде

/**
 * В чей кошелёк идут живые деньги человека. Арсений — в общие (его продажи и закупки — общие деньги),
 * Сева — в свой. Кошельков два: «Общие» и «Сева».
 */
const CASH_OF = { 'Арсений': COMMON };
const cashWallet = (n) => CASH_OF[n] || n;
function cashWallets() {
  const all = walletList().map(cashWallet);
  return all.filter((n, i) => all.indexOf(n) === i);
}
const cashLabel = (n) => (n === COMMON ? 'Общие' : n);

async function loadMoney() {
  try {
    const rows = await api('money');
    if (Array.isArray(rows)) { state.money = rows; persistCache(); }
  } catch (e) { /* без журнала денег — остальное работает */ }
}

/**
 * По каждому кошельку: free — свободные деньги (пополнения − выводы ± переводы − закупки + продажи),
 * clothes — деньги в непроданных вещах (по «Кто платил»).
 */
function moneyByWallet() {
  const w = new Map(cashWallets().map((n) => [n, { name: n, free: 0, clothes: 0, clothesCount: 0, ops: 0, sales: 0, buys: 0 }]));
  const get = (n) => (n ? w.get(cashWallet(n)) : null);
  let unknownBuy = 0, unknownBuyCount = 0, unknownSale = 0;
  state.money.forEach((m) => { const r = get(m.wallet); if (r) { r.free += m.amount; r.ops += m.amount; } });
  state.items.forEach((i) => {
    if (!isCommission(i) && isNum(i.buyPrice) && i.buyPrice > 0) {
      const r = get(i.buyer);
      if (r) {
        r.free -= i.buyPrice; r.buys += i.buyPrice;
        if (i.status !== STATUS.sold) { r.clothes += i.buyPrice; r.clothesCount++; }
      } else { unknownBuy += i.buyPrice; unknownBuyCount++; }
    }
    if (i.status === STATUS.sold && isNum(i.salePrice)) {
      const r = get(i.soldBy);
      if (!r) { unknownSale++; return; }
      let cash = i.salePrice;
      // чужая вещь на комиссии: долю комитента отдали ему — у нас осталась комиссия
      if (isCommission(i) && !walletList().includes(i.consignor)) cash = commissionFrom(i, i.salePrice) || 0;
      r.free += cash; r.sales += cash;
    }
  });
  return { wallets: [...w.values()], unknownBuy, unknownBuyCount, unknownSale };
}

/**
 * Чья вещь: тот, за чьи деньги куплена («Кто платил»). Его затраты — и его прибыль.
 * Комиссионная вещь своего человека (комитент — Арсений/Сева/касса) — его; чужая комиссионная — касса (наша комиссия).
 */
function ownerOf(i) {
  if (isCommission(i)) return walletList().includes(i.consignor) ? i.consignor : COMMON;
  return i.buyer || '';
}
/** Проданная вещь: кому сколько причитается. owner — владельцу, kassa — комиссия в кассу (у комиссионных своих). */
function saleSplit(i) {
  if (i.status !== STATUS.sold || !isNum(i.salePrice)) return null;
  const owner = ownerOf(i);
  if (isCommission(i)) {
    const fee = commissionFrom(i, i.salePrice) || 0;
    if (owner !== COMMON || walletList().includes(i.consignor)) {
      // своя вещь на комиссии: владелец получает всё минус комиссию, комиссия — в кассу
      return owner === COMMON ? { owner, owes: i.salePrice, profit: i.salePrice, kassa: 0 } : { owner, owes: i.salePrice - fee, profit: i.salePrice - fee, kassa: fee };
    }
    return { owner: COMMON, owes: fee, profit: fee, kassa: 0 }; // чужая: нам только комиссия
  }
  return { owner, owes: i.salePrice, profit: profitOf(i), kassa: 0 };
}

function inPeriod(ruDate, period) {
  if (period === 'all') return true;
  const d = parseRuDate(ruDate);
  if (!d) return false;
  const now = new Date();
  const ref = new Date(now.getFullYear(), now.getMonth() - (period === 'prev' ? 1 : 0), 1);
  return d.getMonth() === ref.getMonth() && d.getFullYear() === ref.getFullYear();
}

/**
 * Итоги по каждому «кошельку» (касса, Арсений, Сева) за период. Ключ '' — «не указано, чьи деньги».
 * buy — вложил в закупки; sale/profit — выручка и прибыль с ЕГО проданных вещей; stock — деньги в его непроданных вещах (сейчас).
 */
function partnerTotals(period) {
  const t = new Map();
  const get = (name) => {
    if (!t.has(name)) t.set(name, { name, buy: 0, buyCount: 0, sale: 0, saleCount: 0, profit: 0, stock: 0, stockCount: 0 });
    return t.get(name);
  };
  walletList().forEach(get);
  state.items.forEach((i) => {
    const owner = ownerOf(i);
    if (isNum(i.buyPrice) && i.buyPrice > 0 && !isCommission(i)) {
      if (inPeriod(i.buyDate, period)) { const r = get(owner); r.buy += i.buyPrice; r.buyCount++; }
      if (i.status !== STATUS.sold) { const r = get(owner); r.stock += i.buyPrice; r.stockCount++; }
    }
    const split = saleSplit(i);
    if (split && inPeriod(i.saleDate, period)) {
      const r = get(split.owner);
      r.sale += split.owes; r.saleCount++; r.profit += split.profit || 0;
      if (split.kassa) { const k = get(COMMON); k.sale += split.kassa; k.profit += split.kassa; }
    }
  });
  return t;
}

/**
 * Кто кому должен (за всё время). Каждая проданная вещь — деньги её владельца.
 * Если деньги получил другой человек (или касса), он должен их владельцу. Встречные долги взаимозачитываются.
 */
function settlement() {
  const debt = new Map(); // 'от→кому' → сумма
  let skipped = 0;
  const add = (from, to, v) => {
    if (!v || from === to) return;
    const k = from + '→' + to;
    debt.set(k, (debt.get(k) || 0) + v);
  };
  state.items.forEach((i) => {
    const split = saleSplit(i);
    if (!split) return;
    if (!i.soldBy || !split.owner) { skipped++; return; }
    add(cashWallet(i.soldBy), cashWallet(split.owner), split.owes);
    if (split.kassa) add(cashWallet(i.soldBy), COMMON, split.kassa);
  });
  // Переводы между кошельками гасят долг: перевод A → B уменьшает долг A перед B
  const links = new Map();
  state.money.forEach((m) => { if (m.link) { if (!links.has(m.link)) links.set(m.link, []); links.get(m.link).push(m); } });
  links.forEach((pair) => {
    const from = pair.find((m) => m.amount < 0);
    const to = pair.find((m) => m.amount > 0);
    if (from && to) add(cashWallet(to.wallet), cashWallet(from.wallet), to.amount);
  });
  const names = cashWallets();
  const transfers = [];
  names.forEach((a, ai) => names.slice(ai + 1).forEach((b) => {
    const net = Math.round((debt.get(a + '→' + b) || 0) - (debt.get(b + '→' + a) || 0));
    if (net > 0) transfers.push({ from: a, to: b, amount: net });
    else if (net < 0) transfers.push({ from: b, to: a, amount: -net });
  }));
  return { names, transfers, skipped };
}

function renderMoney() {
  const box = $('#money-cards');
  if (!box) return;
  const m = moneyByWallet();
  box.replaceChildren(...m.wallets.map((w) => el('div', { class: 'money-card' + (w.name === COMMON ? ' common' : '') },
    el('div', { class: 'money-name' }, w.name === COMMON ? '🏦 Общие' : '👤 ' + w.name),
    el('div', { class: 'money-free-label' }, 'Свободные'),
    el('div', { class: 'money-free ' + (w.free < 0 ? 'profit-minus' : '') }, rub(w.free)),
    el('div', { class: 'money-row' }, el('span', {}, 'В одежде'), el('b', {}, rub(w.clothes)), el('small', {}, pieces(w.clothesCount))),
    el('div', { class: 'money-row total' }, el('span', {}, 'Всего'), el('b', {}, rub(w.free + w.clothes))))));
  const notes = [];
  if (m.unknownBuyCount) notes.push(`${pieces(m.unknownBuyCount)} на ${rub(m.unknownBuy)} без «Кто платил» — не вычтены ни из чьих денег.`);
  if (m.unknownSale) notes.push(`Продаж без «Деньги получил»: ${m.unknownSale} — не учтены.`);
  if (!state.money.length) notes.push('Внесите стартовые суммы кнопкой «Пополнить» — иначе свободные деньги уйдут в минус на сумму закупок.');
  $('#money-note').textContent = notes.join(' ');
  // последние операции
  const ops = state.money.slice().reverse().filter((op, i, arr) => !op.link || arr.findIndex((o) => o.link === op.link) === i).slice(0, 15);
  $('#money-ops').replaceChildren(...(ops.length ? ops.map((op) => {
    const pair = op.link ? state.money.filter((o) => o.link === op.link) : [op];
    const from = pair.find((o) => o.amount < 0), to = pair.find((o) => o.amount > 0);
    const text = op.link && from && to
      ? `🔁 ${cashLabel(from.wallet)} → ${cashLabel(to.wallet)}: ${rub(to.amount)}`
      : (op.amount >= 0 ? `➕ ${cashLabel(op.wallet)}: +${rub(op.amount)}` : `➖ ${cashLabel(op.wallet)}: −${rub(-op.amount)}`);
    return el('li', { class: 'history-row money-op' },
      el('div', { class: 'history-text' }, text, op.note ? el('div', { class: 'muted-small' }, op.note) : null),
      el('div', { class: 'history-when' }, op.date),
      el('button', { type: 'button', class: 'op-del', 'aria-label': 'Удалить операцию', onclick: () => deleteMoneyOp(op) }, '×'));
  }) : [el('li', { class: 'muted' }, 'Операций пока нет.')]));
}

async function deleteMoneyOp(op) {
  if (!(await ask(op.link ? 'Удалить перевод целиком (обе стороны)?' : 'Удалить эту операцию?'))) return;
  const before = state.money;
  state.money = state.money.filter((o) => o.id !== op.id && !(op.link && o.link === op.link));
  renderPartners();
  try {
    await api('moneyDelete', { id: op.id });
    toast('Операция удалена');
    loadMoney().then(() => { if (state.view === 'stats' && state.statsTab === 'partners') renderPartners(); });
  } catch (e) {
    state.money = before;
    renderPartners();
    toast(e.message);
  }
}

/** Шторка операции с деньгами. kind: in | out | transfer; preset — подставить кошельки и сумму (для «Отметить перевод»). */
function openMoney(kind, preset) {
  const f = $('#money-form');
  f.reset();
  f.kind.value = kind;
  const fill = (sel, value) => {
    sel.replaceChildren(...cashWallets().map((n) => el('option', { value: n }, cashLabel(n))));
    sel.value = value || cashWallets()[0];
  };
  fill(f.wallet, preset && preset.from);
  fill(f.to, (preset && preset.to) || cashWallets().find((n) => n !== f.wallet.value));
  f.amount.value = preset && preset.amount ? preset.amount : '';
  f.date.value = todayIso();
  f.note.value = (preset && preset.note) || '';
  $('#money-title').textContent = { in: 'Пополнить', out: 'Вывести / потратить', transfer: 'Перевод между кошельками' }[kind];
  $('#money-wallet-label').firstChild.textContent = kind === 'transfer' ? 'Откуда' : 'Кошелёк';
  $('#money-to-label').hidden = kind !== 'transfer';
  $('#money-error').textContent = '';
  $('#money-sheet').hidden = false;
  haptic('tap');
  setTimeout(() => f.amount.focus(), 80);
}

async function submitMoney(e) {
  e.preventDefault();
  const f = e.target;
  const amount = Number(f.amount.value);
  if (!(amount > 0)) { $('#money-error').textContent = 'Укажите сумму больше нуля.'; f.amount.focus(); return; }
  if (f.kind.value === 'transfer' && f.to.value === f.wallet.value) { $('#money-error').textContent = 'Выберите разные кошельки.'; return; }
  const payload = { kind: f.kind.value, wallet: f.wallet.value, to: f.to.value, amount, date: f.date.value || todayIso(), note: f.note.value.trim() };
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('moneyAdd', payload);
    $('#money-sheet').hidden = true;
    haptic('success');
    toast('Записано ✓');
    await loadMoney();
    if (state.view === 'stats' && state.statsTab === 'partners') renderPartners();
  } catch (err) {
    $('#money-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function renderPartners() {
  renderMoney();
  $('#partner-period').replaceChildren(...PERIODS.map(([key, label]) => el('button', {
    type: 'button', 'aria-pressed': String(state.partnerPeriod === key),
    onclick: () => { state.partnerPeriod = key; storage.set('uv.period', key); haptic('tap'); renderPartners(); },
  }, label)));

  const totals = partnerTotals(state.partnerPeriod);
  const unknown = totals.get('');
  totals.delete('');
  const cards = [...totals.values()];
  const box = $('#partner-cards');
  box.classList.toggle('single', cards.length < 2);
  box.classList.toggle('three', cards.length === 3);
  box.replaceChildren(...cards.map((c) => {
    const isCommon = c.name === COMMON;
    return el('div', { class: 'partner-card' + (isCommon ? ' common' : '') },
      el('div', { class: 'partner-name' }, isCommon ? '🏦 Общая касса' : c.name),
      el('div', { class: 'partner-row' }, el('span', {}, 'Вложено'), el('b', {}, rub(c.buy)), el('small', {}, pieces(c.buyCount))),
      el('div', { class: 'partner-row' }, el('span', {}, 'Продано'), el('b', {}, rub(c.sale)), el('small', {}, pieces(c.saleCount))),
      el('div', { class: 'partner-row total' }, el('span', {}, 'Прибыль'),
        el('b', { class: c.profit < 0 ? 'profit-minus' : c.profit > 0 ? 'profit-plus' : '' }, signedRub(c.profit))),
      el('div', { class: 'partner-row stock' }, el('span', {}, 'В товаре сейчас'), el('b', {}, rub(c.stock)), el('small', {}, pieces(c.stockCount))));
  }));

  // Вещи без партнёра — с подсказкой и списком
  const unk = $('#partner-unknown');
  const missing = state.items.filter((i) => (isNum(i.buyPrice) && i.buyPrice > 0 && !i.buyer)
    || (i.status === STATUS.sold && isNum(i.salePrice) && !i.soldBy));
  // (чьи деньги не указаны — вещь ничья: её затраты и прибыль никому не засчитаны)
  if (missing.length) {
    const sums = unknown ? `За период: закупки ${rub(unknown.buy)}, продажи ${rub(unknown.sale)}. ` : '';
    const list = el('ul', { class: 'items', hidden: true }, missing.slice(0, 30).map((i) => itemRow(i)));
    const noBuyer = missing.filter((i) => isNum(i.buyPrice) && i.buyPrice > 0 && !i.buyer).map((i) => i.id);
    unk.replaceChildren(el('div', { class: 'notice' },
      el('b', {}, `Не указано, чьи деньги: ${pieces(missing.length)}`),
      el('p', {}, `${sums}Эти вещи никому не засчитаны. Укажите «Кто платил» сразу всем — или по одной: вещь → «Изменить».`),
      el('div', { class: 'notice-actions' },
        noBuyer.length ? el('button', { type: 'button', class: 'primary', onclick: () => bulkFillBuyer(noBuyer) }, `Указать разом (${noBuyer.length})`) : null,
        el('button', { type: 'button', class: 'link-btn', onclick: (e) => { list.hidden = !list.hidden; e.target.textContent = list.hidden ? 'Показать вещи' : 'Скрыть'; } }, 'Показать вещи')),
      list));
  } else unk.replaceChildren();

  const s = settlement();
  const settle = $('#partner-settle');
  const who = (n) => (n === COMMON ? 'Общие' : n);
  const head = s.transfers.length
    ? [el('div', { class: 'muted' }, 'Деньги за проданные вещи получил не владелец — нужно передать:'),
      ...s.transfers.map((t) => el('div', { class: 'settle-transfer' },
        el('b', {}, who(t.from)), el('span', { class: 'arrow' }, ' → '), el('b', {}, who(t.to)), el('div', { class: 'settle-amount' }, rub(t.amount)),
        el('button', { type: 'button', class: 'link-btn settle-pay', onclick: () => openMoney('transfer', { from: t.from, to: t.to, amount: t.amount, note: 'Погашение долга за проданные вещи' }) }, 'Отметить перевод')))]
    : [el('div', { class: 'settle-transfer' }, el('b', {}, 'Никто никому не должен ✓'))];
  settle.replaceChildren(el('div', { class: 'settle-card' }, ...head,
    s.skipped ? el('p', { class: 'muted' }, `Не учтено продаж без «Кто платил» или «Деньги получил»: ${s.skipped}.`) : null));
}

/** «5 мин назад» из «10.11.2026 14:05:00». */
function timeAgo(at) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/.exec(at || '');
  if (!m) return at || '';
  const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  if (hrs < 48) return 'вчера';
  return `${m[1]}.${m[2]}`;
}

/** Последние изменения из листа «Журнал» — грузим при открытии статистики. */
async function loadHistory() {
  const box = $('#stats-history');
  if (!box.querySelector('.history-row')) {
    box.replaceChildren(...[0, 1, 2, 3, 4].map(() => el('li', { class: 'history-skel' })));
  }
  try {
    const rows = await api('history');
    if (!rows.length) { box.replaceChildren(el('li', { class: 'muted' }, 'Пока пусто — здесь появятся действия из приложения.')); return; }
    box.replaceChildren(...rows.slice(0, 50).map((r) => {
      const exists = r.id && state.items.some((i) => i.id === r.id);
      return el('li', {
        class: 'history-row' + (exists ? ' link' : ''),
        onclick: exists ? () => { state.navIds = []; openItem(r.id); } : null,
      }, el('div', { class: 'history-text' }, r.text), el('div', { class: 'history-when' }, timeAgo(r.at)));
    }));
  } catch (e) {
    box.replaceChildren(el('li', { class: 'muted' }, 'Не удалось загрузить: ' + e.message));
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
      + (onHand.some((i) => i.status === STATUS.inTransit) ? `, в пути ${onHand.filter((i) => i.status === STATUS.inTransit).length}` : ''), '', 'Все'),
    tile('План продаж', rub(planSum), `наценка ${signedRub(potential)}`, '', STATUS.inStock),
    tile('Продано за месяц', pieces(thisM.length), `выручка ${rub(thisM.reduce((s, i) => s + (i.salePrice || 0), 0))}`, '', STATUS.sold),
    tile('Прибыль за месяц', signedRub(profitThis), prevM.length || profitPrev ? `${delta >= 0 ? '▲' : '▼'} ${signedRub(delta)} к прошлому` : 'прошлый месяц — нет продаж',
      profitThis < 0 ? 'profit-minus' : '', STATUS.sold),
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
    bar.style.animationDelay = `${i * 45}ms`; // столбики вырастают по очереди
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
    money: [],
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

const demoLog = [];
function demoRecord(text, id) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  demoLog.push({ at: `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, who: 'Антон', text, id: id || '' });
}

async function demoApi(action, p) {
  if (['add', 'update', 'sell', 'setStatus', 'delete', 'bulkUpdate', 'bulkDelete'].includes(action)) {
    const it = p.id && demoDb.items.find((i) => i.id === p.id);
    const title = it ? it.title : (p.title || '');
    const texts = { add: '🆕 Антон добавил(а) «' + title + '»', update: '✏️ Антон изменил(а) «' + title + '»', sell: '💰 Антон продал(а) «' + title + '»',
      setStatus: '🔁 Антон: «' + title + '» → ' + p.status, delete: '🗑 Антон удалил(а) «' + title + '»',
      bulkUpdate: '✏️ Антон изменил(а) ' + (p.ids || []).length + ' шт.', bulkDelete: '🗑 Антон удалил(а) ' + (p.ids || []).length + ' шт.' };
    demoRecord(texts[action], p.id);
  }
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
    case 'history': return demoLog.slice().reverse().slice(0, 50);
    case 'money': return JSON.parse(JSON.stringify(demoDb.money));
    case 'moneyAdd': {
      const nid = () => Math.random().toString(16).slice(2, 10);
      const date = isoToRu(p.date || todayIso());
      if (p.kind === 'transfer') {
        const link = nid();
        demoDb.money.push({ id: nid(), date, wallet: p.wallet, amount: -p.amount, note: p.note || '', link }, { id: nid(), date, wallet: p.to, amount: p.amount, note: p.note || '', link });
      } else demoDb.money.push({ id: nid(), date, wallet: p.wallet, amount: p.kind === 'in' ? p.amount : -p.amount, note: p.note || '', link: '' });
      return { ok: true };
    }
    case 'moneyDelete': {
      const hit = demoDb.money.find((m) => m.id === p.id);
      demoDb.money = demoDb.money.filter((m) => m.id !== p.id && !(hit && hit.link && m.link === hit.link));
      return { removed: 1 };
    }
    case 'photos': {
      const out = {};
      p.ids.forEach((id) => {
        const it = demoDb.items.find((i) => i.id === id);
        out[id] = it && it.hasPhoto ? (demoDb.photos.get(id) || demoPhoto(it)) : null;
      });
      return out;
    }
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
      if (p.photo) { demoDb.photos.set(id, p.photo); it.photoKey = 'demo-' + Date.now(); }
      delete it.photo;
      touch(it);
      demoDb.items.push(it);
      return { id };
    }
    case 'update': {
      const it = find(p.id);
      const patch = { ...p };
      ['id', 'version', 'photo', 'removePhoto'].forEach((k) => delete patch[k]);
      if (p.photo) { demoDb.photos.set(p.id, p.photo); it.hasPhoto = true; it.photoKey = 'demo-' + Date.now(); }
      if (p.removePhoto) { demoDb.photos.delete(p.id); it.hasPhoto = false; }
      // Как на сервере: меняем только присланные поля.
      ['buyPrice', 'planPrice', 'salePrice', 'commissionPct'].forEach((k) => { if (k in patch) patch[k] = num(patch[k]); });
      ['buyDate', 'saleDate'].forEach((k) => { if (k in patch) patch[k] = isoToRu(patch[k]); });
      Object.assign(it, patch);
      if (it.status !== STATUS.sold) { it.salePrice = null; it.saleDate = ''; it.soldBy = ''; }
      touch(it);
      return { id: p.id, version: it.changedAt };
    }
    case 'sell': { const it = find(p.id); Object.assign(it, { status: STATUS.sold, salePrice: p.salePrice, saleDate: isoToRu(p.saleDate), soldBy: p.soldBy || 'Антон' }); touch(it); return { id: p.id, version: it.changedAt }; }
    case 'setStatus': { const it = find(p.id); Object.assign(it, { status: p.status, salePrice: null, saleDate: '', soldBy: '' }); touch(it); return { id: p.id, version: it.changedAt }; }
    case 'bulkUpdate': {
      let updated = 0;
      demoDb.items.forEach((it) => {
        if (!p.ids.includes(it.id)) return;
        if ('status' in p.patch && it.status === STATUS.sold) return;
        Object.assign(it, p.patch);
        if ('status' in p.patch) Object.assign(it, { salePrice: null, saleDate: '', soldBy: '' });
        touch(it); updated++;
      });
      return { updated };
    }
    case 'bulkDelete': {
      const before = demoDb.items.length;
      demoDb.items = demoDb.items.filter((i) => !p.ids.includes(i.id));
      return { removed: before - demoDb.items.length };
    }
    case 'delete': { find(p.id); demoDb.items = demoDb.items.filter((i) => i.id !== p.id); return { id: p.id }; }
    default: throw new Error('Неизвестное действие');
  }
}

// ---------------------------------------------------------------- запуск

function bindEvents() {
  const syncOnline = () => { $('#offline').hidden = navigator.onLine !== false; };
  window.addEventListener('online', () => { syncOnline(); loadItems({ silent: true }).catch(() => {}); });
  window.addEventListener('offline', syncOnline);
  syncOnline();
  window.addEventListener('pagehide', flushPendingDeletes);
  enablePullToRefresh();
  let searchTimer;
  $('#search-clear').addEventListener('click', () => {
    const s = $('#search');
    s.value = '';
    s.dispatchEvent(new Event('input'));
    s.focus();
  });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#search').addEventListener('input', (e) => {
    $('#search-clear').hidden = !e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; renderList(); }, 120);
  });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; storage.set('uv.sort', state.sort); renderList(); });
  $('#btn-add').addEventListener('click', () => openForm('add'));
  $('#btn-refresh').addEventListener('click', () => Promise.all([loadItems(), loadMoney()]).then(() => toast('Обновлено')).catch((e) => toast(e.message)));
  document.querySelectorAll('[data-money]').forEach((b) => b.addEventListener('click', () => openMoney(b.dataset.money)));
  $('#money-form').addEventListener('submit', submitMoney);
  $('#money-cancel').addEventListener('click', () => { $('#money-sheet').hidden = true; });
  $('#money-sheet').addEventListener('click', (e) => { if (e.target.id === 'money-sheet') $('#money-sheet').hidden = true; });
  document.querySelectorAll('#bottom-nav [data-nav]').forEach((b) => b.addEventListener('click', () => navTo(b.dataset.nav)));
  $('#btn-layout').addEventListener('click', () => {
    setLayout(state.layout === 'grid' ? 'list' : 'grid');
    haptic('tap');
    renderList();
    slideList(1);
  });
  document.querySelectorAll('[data-stats-tab]').forEach((b) => b.addEventListener('click', () => {
    state.statsTab = b.dataset.statsTab;
    haptic('tap');
    renderStats();
  }));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', goBack));

  $('#item-photo').addEventListener('click', () => { if (!$('#item-photo-wrap').dataset.swiped) openLightbox(); });
  bindPhotoSwipe();
  bindLightbox();
  bindTabSwipe();
  window.addEventListener('resize', () => positionIndicator(tabIndex(state.tab), false));
  // Ширина вкладок изменилась (поворот, шрифт, полоса прокрутки) — ползунок следом, без анимации
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (!state.tabSwiping) positionIndicator(tabIndex(state.tab), false); }).observe($('#status-tabs'));
  $('#select-cancel').addEventListener('click', exitSelect);
  $('#select-all').addEventListener('click', selectAllVisible);
  document.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.bulk === 'delete') bulkDelete(); else bulkPick(b.dataset.bulk);
  }));
  $('#picker-sheet').addEventListener('click', (e) => {
    if (e.target.id === 'picker-sheet' || e.target.id === 'picker-cancel') $('#picker-sheet').hidden = true;
  });
  $('#btn-edit').addEventListener('click', () => openForm('edit'));
  $('#btn-clone').addEventListener('click', () => openForm('add', state.current));
  $('#btn-copy-ad').addEventListener('click', () => shareText(adText(state.current), 'Текст объявления'));
  $('#btn-share-report').addEventListener('click', () => shareText(reportText(), 'Отчёт за месяц'));

  const f = $('#item-form');
  f.addEventListener('submit', submitForm);
  f.addEventListener('input', onFormInput);
  f.addEventListener('change', onFormInput);
  $('#photo-input').addEventListener('change', onPhotoPicked);
  $('#photo-remove').addEventListener('click', onPhotoRemove);
  $('#btn-delete').addEventListener('click', deleteCurrent);
  $('#btn-delete-item').addEventListener('click', deleteCurrent);

  $('#sell-form').addEventListener('submit', submitSell);
  $('#sell-form').salePrice.addEventListener('input', updateSellProfit);
  $('#sell-cancel').addEventListener('click', () => { closeSheet(); });
  $('#sell-sheet').addEventListener('click', (e) => { if (e.target.id === 'sell-sheet') closeSheet(); });
  bindSheetDrag();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') goBack();
    if (state.view === 'item' && $('#lightbox').hidden && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      if (e.key === 'ArrowRight') navItem(1);
      if (e.key === 'ArrowLeft') navItem(-1);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingDeletes();
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

// ---- заставка с логотипом
const SPLASH_BG = '#1b1511';
const splashShownAt = Date.now();
const SPLASH_MIN_MS = 700;
let splashDone = false;
function hideSplash() {
  if (splashDone) return;
  splashDone = true;
  setTimeout(() => {
    const sp = document.getElementById('splash');
    document.documentElement.classList.remove('booting');
    // Шапка и фон Telegram — обратно в цвет приложения
    try { if (tg && tg.setHeaderColor) tg.setHeaderColor('bg_color'); if (tg && tg.setBackgroundColor) tg.setBackgroundColor('bg_color'); } catch (e) { /* старый Telegram */ }
    if (!sp) return;
    sp.classList.add('gone');
    setTimeout(() => sp.remove(), 500);
  }, Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt)));
}

function showFatal(message) {
  hideSplash();
  document.body.classList.add('fatal');
  $('#items').replaceChildren(el('li', {}, el('div', { class: 'empty' }, icon('box'), el('p', {}, message))));
  $('#list-note').textContent = '';
  $('#btn-add').hidden = true;
}

async function init() {
  setTimeout(hideSplash, 8000);
  if (tg && tg.initData) {
    document.documentElement.classList.add('tg');
    if (tg.colorScheme === 'dark') document.documentElement.classList.add('tg-dark');
    tg.onEvent && tg.onEvent('themeChanged', () => document.documentElement.classList.toggle('tg-dark', tg.colorScheme === 'dark'));
    tg.ready();
    tg.expand();
    // Пока видна заставка — шапка Telegram в цвет логотипа; потом — в цвет приложения (hideSplash)
    try {
      if (tg.setHeaderColor) tg.setHeaderColor(SPLASH_BG);
      if (tg.setBackgroundColor) tg.setBackgroundColor(SPLASH_BG);
    } catch (e) { /* старый Telegram */ }
    tg.BackButton.onClick(goBack);
    try { tg.MainButton.onClick(() => { if (state.view === 'form') $('#item-form').requestSubmit(); }); } catch (e) { /* нет */ }
    document.documentElement.classList.add('tg-mainbutton');
    // Чтобы свайпы и прокрутка не сворачивали приложение (Telegram 7.7+)
    try { if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) { /* старый Telegram */ }
  }
  bindEvents();
  const savedSort = storage.get('uv.sort');
  if (savedSort && SORTS[savedSort]) { state.sort = savedSort; $('#sort').value = savedSort; }
  setLayout(storage.get('uv.layout') || 'grid');
  document.body.dataset.view = state.view;

  if (!DEMO && !(tg && tg.initData)) {
    renderSummary();
    showFatal('Откройте приложение через бота в Telegram. Посмотреть без Telegram: добавьте ?demo=1 к адресу.');
    return;
  }

  // Мгновенный показ из кеша, потом свежие данные.
  const cached = storage.get(CACHE_KEY);
  await loadSavedThumbs();
  if (cached && Array.isArray(cached.items)) {
    state.items = cached.items;
    syncThumbs();
    if (cached.lists) state.lists = { ...DEFAULT_LISTS, ...cached.lists };
    if (cached.user) state.user = cached.user;
    if (cached.partners) state.partners = cached.partners;
    if (Array.isArray(cached.money)) state.money = cached.money;
    renderList();
    hideSplash(); // есть сохранённые данные — сразу к списку
    $('#list-note').textContent = 'Обновляю…';
  }
  try {
    const [meta] = await Promise.all([api('meta'), loadItems({ silent: Boolean(cached) }), loadMoney()]);
    state.lists = { ...DEFAULT_LISTS, ...meta.lists };
    state.user = meta.user || null;
    state.partners = meta.partners || [];
    saveCache();
    renderList();
    hideSplash();
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
