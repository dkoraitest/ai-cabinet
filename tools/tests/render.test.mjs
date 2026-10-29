import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'templates', 'site');

// render.js подключается на странице обычным <script>: в песочнице он кладёт CabinetRender в window.
const window = {};
runInNewContext(readFileSync(join(SITE, 'render.js'), 'utf8'), { window });
const { renderCard, renderPage } = window.CabinetRender;

const demo = {
  slug: 'svetofor-dogovorov',
  title: 'Светофор договоров',
  phrase: 'запусти светофор договоров',
  kind: 'script',
  running: false,
  error: null,
  result: {
    title: 'Светофор договоров',
    updated_at: '2026-10-22T14:05:09',
    status: 'red',
    summary: 'На 21.09.2026 истекли: 1.',
    columns: ['№ договора', 'Дата окончания'],
    rows: [['МП-301', '31.08.2026'], ['ПВ-08', '30.09.2026'], ['КП-18', '31.01.2027'], ['АЗ-163', null], ['НЛ-5521', 'бессрочно']],
    row_status: ['red', 'yellow', 'green', 'grey', 'info'],
    row_note: [null, null, null, null, 'бессрочно'],
    files: ['output/svetofor-dogovorov/svetofor.xlsx'],
  },
};

const rowsOf = (html) => [...html.matchAll(/<tr class="row-(\w+)">([\s\S]*?)<\/tr>/g)].map((m) => ({ status: m[1], html: m[2] }));

test('карточка: название, время, метка статуса, итог, таблица, файлы, кнопка', () => {
  const html = renderCard(demo);
  assert.match(html, /data-slug="svetofor-dogovorov"/);
  assert.match(html, /<h2[^>]*>Светофор договоров<\/h2>/);
  assert.match(html, /обновлено 22\.10\.2026 14:05/);
  assert.match(html, /class="badge badge-red"[^>]*>красный</);
  assert.match(html, /На 21\.09\.2026 истекли: 1\./);
  assert.match(html, /<th>№ договора<\/th>/);
  assert.match(html, /<a href="output\/svetofor-dogovorov\/svetofor\.xlsx"[^>]*>svetofor\.xlsx<\/a>/);
  assert.match(html, /<button type="button" class="run" data-run="svetofor-dogovorov">Запустить<\/button>/);
  assert.doesNotMatch(html, /Запуск фразой/);
});

test('строки окрашены по row_status, grey подписан «нет данных», info показывает row_note', () => {
  const rows = rowsOf(renderCard(demo));
  assert.deepEqual(rows.map((r) => r.status), ['red', 'yellow', 'green', 'grey', 'info']);
  assert.match(rows[3].html, /нет данных/);
  assert.match(rows[3].html, /АЗ-163/);
  assert.match(rows[4].html, /<td class="mark">бессрочно<\/td>/);
  assert.doesNotMatch(rows[2].html, /нет данных/);
});

test('без row_status: строки без окраски и без столбца отметок', () => {
  const p = { ...demo, result: { ...demo.result, row_status: undefined, row_note: undefined } };
  const html = renderCard(p);
  assert.equal(rowsOf(html).length, 0);
  assert.equal((html.match(/<tr>/g) ?? []).length, 1 + demo.result.rows.length);
  assert.doesNotMatch(html, /class="mark"/);
});

test('«разобрать вручную»: строка с пометкой info и подписью, строки без отметки (null) без окраски, ссылка на файл', () => {
  const p = {
    ...demo,
    slug: 'obr',
    result: {
      ...demo.result,
      status: 'green',
      summary: 'Обращений 3. Разобрать вручную: 1 (файл razobrat-vruchnuyu.xlsx).',
      columns: ['№', 'Тема'],
      rows: [['11', 'разобрать вручную'], ['1', 'оборудование'], ['2', 'другое']],
      row_status: ['info', null, null],
      row_note: ['разобрать вручную', null, null],
      files: ['output/obr/razobrat-vruchnuyu.xlsx'],
    },
  };
  const html = renderCard(p);
  assert.deepEqual(rowsOf(html).map((r) => r.status), ['info']);
  assert.match(rowsOf(html)[0].html, /<td class="mark">разобрать вручную<\/td>/);
  assert.equal((html.match(/<tr><td class="mark"><\/td>/g) ?? []).length, 2);
  assert.match(html, /Разобрать вручную: 1/);
  assert.match(html, /<a href="output\/obr\/razobrat-vruchnuyu\.xlsx" download>razobrat-vruchnuyu\.xlsx<\/a>/);
});

test('kind claude (процесс старого вида): вместо кнопки подсказка с фразой', () => {
  const html = renderCard({ ...demo, kind: 'claude', phrase: 'напиши черновики писем' });
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /Запуск фразой в Claude: «напиши черновики писем»/);
});

test('идёт расчёт: кнопка неактивна с подписью; сообщение об ошибке запуска показывается', () => {
  const running = renderCard({ ...demo, running: true });
  assert.match(running, /<button type="button" class="run" data-run="svetofor-dogovorov" disabled>идёт расчёт…<\/button>/);
  const failed = renderCard(demo, { message: 'Расчёт не удался. Подробности в output/svetofor-dogovorov/last-run.log' });
  assert.match(failed, /class="run-error"[^>]*>Расчёт не удался\. Подробности в output\/svetofor-dogovorov\/last-run\.log</);
});

test('ещё не запускался и битый результат', () => {
  const fresh = renderCard({ ...demo, result: null });
  assert.match(fresh, /ещё не запускался/);
  assert.match(fresh, /Запустить/);
  assert.doesNotMatch(fresh, /<table/);
  const broken = renderCard({ ...demo, result: null, error: 'файл output/svetofor-dogovorov/result.json повреждён' });
  assert.match(broken, /class="error"[^>]*>[^<]*result\.json повреждён/);
  assert.match(broken, /Запустить/);
  const badFolder = renderCard({ slug: 'Svetofor_2', title: 'Svetofor_2', phrase: '', kind: null, result: null, error: 'папка processes/Svetofor_2: в имени нужны строчные латинские буквы', running: false });
  assert.doesNotMatch(badFolder, /<button|Запуск фразой/);
  assert.match(badFolder, /class="error"/);
});

test('итог одной строкой: без таблицы и без файлов', () => {
  const html = renderCard({ ...demo, result: { ...demo.result, columns: [], rows: [], row_status: undefined, row_note: undefined, files: undefined } });
  assert.doesNotMatch(html, /<table|<a /);
  assert.match(html, /На 21\.09\.2026/);
});

test('текст из данных экранируется, ссылки только в output/<slug>/', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const p = {
    ...demo,
    title: evil,
    slug: 'svetofor-dogovorov',
    result: {
      ...demo.result,
      title: evil,
      summary: evil,
      columns: [evil],
      rows: [[evil], [5]],
      row_status: ['red', 'info'],
      row_note: [evil, evil],
      files: ['output/svetofor-dogovorov/отчёт 1.xlsx', 'output/drugoi/x.xlsx', '../me/rules.md', 'javascript:alert(1)'],
    },
  };
  const html = renderCard(p);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  assert.match(html, /href="output\/svetofor-dogovorov\/%D0%BE%D1%82%D1%87%D1%91%D1%82%201\.xlsx"/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<td>5<\/td>/);
  const kind = renderCard({ ...demo, kind: 'claude', phrase: evil });
  assert.doesNotMatch(kind, /<img/);
  const run = renderCard({ ...demo, slug: '"><script>' });
  assert.doesNotMatch(run, /<script>/);
});

test('renderPage: пустое состояние и список карточек', () => {
  assert.match(renderPage([]), /Процессов пока нет\. Скажите Claude «добавь процесс»/);
  const two = renderPage([demo, { ...demo, slug: 'vtoroi', title: 'Второй' }], { vtoroi: 'ошибка второго' });
  assert.equal((two.match(/<article/g) ?? []).length, 2);
  assert.match(two, /ошибка второго/);
  assert.doesNotMatch(two, /Процессов пока нет/);
});

test('страница: маркер, заголовок, render.js по относительной ссылке, без внешних ресурсов', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  assert.match(html, /data-cabinet="ok"/);
  assert.match(html, /<title>Мой кабинет<\/title>/);
  assert.match(html, /<h1>Мой кабинет<\/h1>/);
  assert.match(html, /<script src="render\.js"><\/script>/);
  assert.doesNotMatch(html, /(src|href)="(\/|https?:|\/\/)/);
  // Бренд: стили по относительной ссылке после стилей страницы (переменные переопределяются), логотип скрыт,
  // пока не загрузится: без папки бренда нет пустой рамки и битой картинки.
  assert.match(html, /<\/style>\s*<link rel="stylesheet" href="brand\/theme\.css">/);
  assert.match(html, /<img class="brand-logo" id="brand-logo" alt="" hidden>/);
  assert.match(html, /<span class="brand-name" id="brand-name" hidden><\/span>/);
  for (const needle of ["'brand/logo.svg'", "'brand/logo.png'", "fetch('brand/brand.json'"]) assert.ok(html.includes(needle), needle);
  assert.doesNotMatch(html, /<link[^>]+(https?:|\/\/)/);
  // Переменные, которые переопределяет theme.css папки бренда.
  for (const v of ['--accent:', '--accent-ink:', '--accent-dark:', '--accent-dark-ink:', '--link:', '--stripe:', '--logo-height:']) {
    assert.ok(html.includes(v), v);
  }
  assert.doesNotMatch(html, /fetch\(['"`]\//);
  assert.doesNotMatch(html, /@import|url\(/);
  for (const needle of ["'X-Cabinet': '1'", "'Content-Type': 'application/json'", "method: 'POST'", 'api/processes', 'api/run/', 'api/status/', '2000']) {
    assert.ok(html.includes(needle), needle);
  }
  assert.match(html, /last-run\.log/);
  // 409: ERUNNING ждёт этот процесс или показывает свежую карточку, ELIMIT оставляет кнопку доступной.
  assert.ok(html.includes("j.code === 'ERUNNING'"), 'страница различает коды 409');
  // Запуск фразой в Claude: пока страница на экране, список перечитывается раз в 10 секунд.
  assert.ok(html.includes('10000'), 'опрос списка раз в 10 с');
  assert.match(html, /document\.visibilityState === 'visible'/);
  assert.match(html, /setInterval\(/);
});

// Элемент страницы для песочницы: свойства и обработчики событий.
function stubElement() {
  return {
    hidden: true,
    className: '',
    textContent: '',
    alt: '',
    src: '',
    on: {},
    addEventListener(type, fn) {
      this.on[type] = fn;
    },
  };
}

// Скрипт страницы в песочнице: fetch, таймеры и DOM подставные, запросы к api/ считаются.
// Запросы бренда (brand/...) идут в brandRespond, по умолчанию 404: папки бренда нет.
const NO_BRAND = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new SyntaxError('не JSON')) });

function pageSandbox(respond, brandRespond = NO_BRAND) {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const box = { innerHTML: '', addEventListener() {} };
  const elements = { top: stubElement(), 'brand-logo': stubElement(), 'brand-name': stubElement() };
  const intervals = new Map();
  const timeouts = [];
  const calls = [];
  const brandCalls = [];
  let nextId = 1;
  const document = {
    title: 'Мой кабинет',
    getElementById: (id) => (id === 'processes' ? box : elements[id] ?? null),
    visibilityState: 'visible',
    addEventListener() {},
  };
  const sandbox = {
    window: { CabinetRender: { renderPage: (list) => `карточек: ${list.length}` }, addEventListener() {} },
    document,
    fetch: (url, opts) => {
      if (String(url).startsWith('brand/')) {
        brandCalls.push(url);
        return brandRespond(url, opts);
      }
      calls.push(url);
      return respond(url, opts);
    },
    setTimeout: (fn) => timeouts.push(fn),
    setInterval: (fn) => {
      intervals.set(nextId, fn);
      return nextId++;
    },
    clearInterval: (id) => intervals.delete(id),
    encodeURIComponent,
    Error,
    Array,
    String,
  };
  runInNewContext(code, sandbox);
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    box,
    calls,
    brandCalls,
    elements,
    document,
    intervals,
    async tick() {
      for (const fn of [...intervals.values()]) fn();
      await settle();
      await settle();
    },
    settle,
  };
}

test('страница: после трёх неудачных запросов подряд опрос останавливается с подсказкой', async () => {
  const p = pageSandbox(() => Promise.reject(new TypeError('Failed to fetch')));
  await p.settle();
  await p.settle();
  assert.equal(p.calls.length, 1);
  assert.match(p.box.innerHTML, /Страница не отвечает/);
  await p.tick();
  assert.equal(p.calls.length, 2);
  await p.tick();
  assert.equal(p.calls.length, 3);
  assert.match(p.box.innerHTML, /Страница остановлена\. Скажите Claude «открой страницу»\./);
  assert.equal(p.intervals.size, 0, 'опрос раз в 10 секунд не снят');
  await p.tick();
  assert.equal(p.calls.length, 3, 'после остановки вкладка снова спрашивает');
});

test('страница: ответ 403 (чужой или старый токен) считается неудачей; удачный ответ обнуляет счёт', async () => {
  let mode = 'fail';
  const p = pageSandbox(() => {
    if (mode === 'ok') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    return Promise.resolve({ ok: false, status: 403, json: () => Promise.reject(new SyntaxError('не JSON')) });
  });
  await p.settle();
  await p.settle();
  await p.tick();
  assert.equal(p.calls.length, 2);
  mode = 'ok';
  await p.tick();
  assert.match(p.box.innerHTML, /карточек: 0/);
  mode = 'fail';
  await p.tick();
  await p.tick();
  assert.equal(p.intervals.size, 1, 'остановилась раньше трёх неудач подряд');
  await p.tick();
  assert.equal(p.calls.length, 6);
  assert.match(p.box.innerHTML, /Страница остановлена/);
  assert.equal(p.intervals.size, 0);
});

// Бренд в песочнице: brand.json отвечает brandRespond, логотип «загружается» вызовом его обработчика.
const brandJson = (data) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
const OK_LIST = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });

test('бренд: папки нет, шапка без логотипа и названия, svg и png пробуются по разу', async () => {
  const p = pageSandbox(OK_LIST);
  await p.settle();
  await p.settle();
  const logo = p.elements['brand-logo'];
  assert.equal(logo.src, 'brand/logo.svg');
  logo.on.error();
  assert.equal(logo.src, 'brand/logo.png');
  logo.on.error();
  assert.equal(logo.src, 'brand/logo.png', 'после png ничего больше не пробует');
  assert.equal(logo.hidden, true);
  assert.equal(p.elements['brand-name'].hidden, true);
  assert.equal(p.elements.top.className, 'top');
  assert.equal(p.document.title, 'Мой кабинет');
  assert.deepEqual(p.brandCalls, ['brand/brand.json']);
  assert.deepEqual(p.calls, ['api/processes'], 'запросы бренда не мешают счёту запросов страницы');
  assert.match(p.box.innerHTML, /карточек: 0/);
});

test('бренд: логотип и название, название в заголовке вкладки и подписи логотипа, текстом не повторяется', async () => {
  const p = pageSandbox(OK_LIST, brandJson({ name: '  Компания Пример  ' }));
  p.elements['brand-logo'].on.load();
  await p.settle();
  await p.settle();
  assert.equal(p.elements['brand-logo'].hidden, false);
  assert.equal(p.elements['brand-logo'].alt, 'Компания Пример');
  assert.equal(p.elements['brand-name'].hidden, true);
  assert.equal(p.elements.top.className, 'top branded');
  assert.equal(p.document.title, 'Мой кабинет · Компания Пример');
});

test('бренд: название без логотипа показывается текстом в шапке', async () => {
  const p = pageSandbox(OK_LIST, brandJson({ name: 'Компания Пример' }));
  await p.settle();
  await p.settle();
  p.elements['brand-logo'].on.error();
  p.elements['brand-logo'].on.error();
  const name = p.elements['brand-name'];
  assert.equal(name.hidden, false);
  assert.equal(name.textContent, 'Компания Пример');
  assert.equal(p.elements['brand-logo'].hidden, true);
  assert.equal(p.elements.top.className, 'top branded');
});

test('бренд: brand.json без строки name или не объект не меняет шапку, длинное название обрезается', async () => {
  for (const data of [[], { name: 5 }, { name: '   ' }, null, 'Компания']) {
    const p = pageSandbox(OK_LIST, brandJson(data));
    await p.settle();
    await p.settle();
    assert.equal(p.elements['brand-name'].hidden, true, JSON.stringify(data));
    assert.equal(p.document.title, 'Мой кабинет', JSON.stringify(data));
  }
  const p = pageSandbox(OK_LIST, brandJson({ name: 'Я'.repeat(200) }));
  await p.settle();
  await p.settle();
  assert.equal(p.elements['brand-name'].textContent.length, 80);
  const broken = pageSandbox(OK_LIST, () => Promise.reject(new TypeError('Failed to fetch')));
  await broken.settle();
  await broken.settle();
  assert.equal(broken.elements['brand-name'].hidden, true);
  assert.match(broken.box.innerHTML, /карточек: 0/);
});
