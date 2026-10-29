// Страница сервиса «Спроси таблицу»: analiz.js (паспорт, ответы, график SVG) в песочнице, как render.js,
// разметка analiz.html и карточка-ссылка на главной странице.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'templates', 'site');
const PAGE = readFileSync(join(SITE, 'analiz.html'), 'utf8');

const window = {};
runInNewContext(readFileSync(join(SITE, 'analiz.js'), 'utf8'), { window });
const R = window.AnalizRender;

const ANSWER = {
  id: 'otvet-1',
  question: 'Как изменились продажи по АЗС за последнюю неделю к предыдущей?',
  spec: { table: 'sales.csv' },
  columns: ['АЗС', 'Литры A', 'Литры B', 'Изменение', 'Изменение, %'],
  rows: [
    ['АЗС-01', 10500.5, 9800, -700.5, -6.67],
    ['АЗС-02', 8200, 9020, 820, 10],
    ['АЗС-03', 12000, 12000, 0, 0],
  ],
  total_rows: 12,
  totals: { 'Литры A': 30700.5, 'Литры B': 30820, Изменение: 119.5, 'Изменение, %': 0.39 },
  notes: ['пропущено 2 строки: не число в «Литры»'],
  summary: 'Сеть: +0,4% за неделю, сильнее всего упала АЗС-01.',
  time: '2026-10-29T22:15:00',
};

const count = (html, re) => (html.match(new RegExp(re.source, 'g')) ?? []).length;

// ---------- паспорт ----------

test('паспорт: файлы, листы, столбцы с типами, число строк, значения и «значения скрыты»', () => {
  const html = R.renderPassport({
    files: [
      {
        file: 'sales.csv',
        sheets: [
          {
            sheet: null,
            rows: 1312,
            columns: [
              { name: 'Дата', type: 'date', first: '2026-09-07', last: '2026-09-20' },
              { name: 'Количество, л', type: 'number', min: 0, max: 2340.8 },
              { name: 'АЗС', type: 'text', values: ['АЗС-01', 'АЗС-02'] },
              { name: 'Оператор', type: 'text', values_hidden: true },
            ],
          },
        ],
      },
      { file: 'kniga.xlsx', sheets: [{ sheet: 'Январь', rows: 10, columns: ['А'] }, { sheet: 'Февраль', rows: 12, columns: ['А'] }] },
    ],
    warnings: ['Файл sales.csv большой: 1 312 строк.'],
  });
  assert.match(html, /Файлов: 2, листов: 3, строк всего: 1\u00a0334\./);
  assert.match(html, /<span class="file-name">sales\.csv<\/span>/);
  assert.match(html, /строк: 1\u00a0312, столбцов: 4/);
  assert.match(html, /<span class="type t-date">дата<\/span>/);
  assert.match(html, /с 07\.09\.2026 по 20\.09\.2026/);
  assert.match(html, /<span class="type t-num">число<\/span><\/td><td class="col-info">от 0 до 2\u00a0340,8/);
  assert.match(html, /АЗС-01, АЗС-02/);
  assert.match(html, /col-info muted">значения скрыты/);
  assert.match(html, /Лист «Январь»/);
  assert.match(html, /Лист «Февраль»/);
  assert.match(html, /<li>Файл sales\.csv большой/);
  assert.equal(count(html, /<details class="file" open>/), 2);
});

test('паспорт в виде движка analiz.py: размер, строки над шапкой, пустые ячейки, пропущенные файлы', () => {
  const html = R.renderPassport({
    dir: 'input/analiz',
    files: [
      {
        file: 'sales_azs_1c.csv',
        type: 'csv',
        size_kb: 2048,
        sheets: [
          {
            sheet: null,
            rows: 1312,
            title: ['Продажи нефтепродуктов по АЗС за период 07.09.2026 - 20.09.2026'],
            columns: [
              { name: 'Дата', type: 'дата', first: '2026-09-07', last: '2026-09-20' },
              { name: 'Количество, л', type: 'число', empty: 3, min: 0, max: 2340.8 },
              { name: 'АЗС', type: 'текст', distinct: 12, values: ['АЗС-01', 'АЗС-02'] },
              { name: 'Комментарий', type: 'текст', distinct: 900 },
            ],
          },
        ],
      },
      { file: 'pusto.xlsx', type: 'xlsx', size_kb: 0, sheets: [{ sheet: 'Лист1', rows: 0, note: 'нет данных' }] },
    ],
    skipped: [{ file: 'bityi.xlsx', reason: 'файл не читается (BadZipFile)' }],
    warnings: [],
    total_rows: 1312,
  });
  assert.match(html, /строк: 1\u00a0312, столбцов: 4, 2 МБ/);
  assert.match(html, /Над таблицей: Продажи нефтепродуктов по АЗС/);
  assert.match(html, /от 0 до 2\u00a0340,8<span class="col-extra">; пустых: 3<\/span>/);
  assert.match(html, /разных значений: 900/);
  assert.match(html, /Лист «Лист1»/);
  assert.match(html, /<p class="hint">нет данных<\/p>/);
  assert.match(html, /<li>Пропущен файл bityi\.xlsx: файл не читается \(BadZipFile\)\.<\/li>/);
  // Пустая папка в виде движка: своя подсказка страницы, без повтора подсказки движка.
  const empty = R.renderPassport({ files: [], skipped: [], warnings: ['В папке input/analiz пока нет таблиц: положите туда файлы Excel (.xlsx) или CSV.'] });
  assert.match(empty, /Папка с данными пока пустая/);
  assert.doesNotMatch(empty, /пока нет таблиц/);
});

test('паспорт: файлов нет → подсказка, куда положить; другие написания полей тоже понимаются', () => {
  for (const empty of [{ files: [] }, {}, null, []]) {
    const html = R.renderPassport(empty);
    assert.match(html, /Папка с данными пока пустая/);
    assert.match(html, /input\/analiz/);
    assert.match(html, /«Открыть папку с данными»/);
  }
  const flat = R.normalizePassport({ tables: [{ name: 'a.csv', rows: 5, columns: [{ col: 'X', type: 'число' }] }, 'b.xlsx', { file: 'c.csv', error: 'Не читается' }] });
  assert.equal(flat.files.length, 3);
  assert.equal(flat.files[0].name, 'a.csv');
  assert.equal(flat.files[0].sheets[0].rows, 5);
  assert.equal(flat.files[0].sheets[0].columns[0].name, 'X');
  assert.equal(flat.files[0].sheets[0].columns[0].type, 'число');
  assert.equal(flat.files[1].name, 'b.xlsx');
  assert.match(R.renderPassport({ files: [{ file: 'c.csv', error: 'Не читается <b>' }] }), /<p class="error">Не читается &lt;b&gt;<\/p>/);
  // Много файлов: свёрнуты, длинный список значений обрезается.
  const many = R.renderPassport({ files: [1, 2, 3].map((i) => ({ file: `f${i}.csv`, rows: 1, columns: [{ name: 'Т', type: 'text', values: Array.from({ length: 40 }, (_, k) => `v${k}`) }] })) });
  assert.equal(count(many, /<details class="file">/), 3);
  assert.match(many, /v29 и ещё 10/);
});

// ---------- ответ ----------

test('ответ: вопрос, время, итог, таблица с числами по-русски, строка «Итого», примечания, кнопки', () => {
  const html = R.renderAnswer(ANSWER, {});
  assert.match(html, /<article class="card answer" data-key="id:otvet-1">/);
  assert.match(html, /<h3 class="question">Как изменились продажи по АЗС/);
  assert.match(html, /<span class="when">29\.10\.2026 22:15<\/span>/);
  assert.match(html, /<p class="summary">Сеть: \+0,4% за неделю/);
  assert.match(html, /<th>АЗС<\/th><th class="num">Литры A<\/th>/);
  assert.match(html, /<td class="num">10\u00a0500,5<\/td>/);
  assert.match(html, /<td class="num">-6,67<\/td>/);
  assert.match(html, /<tfoot><tr><td class="total-label">Итого<\/td><td class="num">30\u00a0700,5<\/td>/);
  assert.match(html, /Показаны первые 3 строк из 12\./);
  assert.match(html, /<p class="notes-title">Примечания<\/p><ul class="notes"><li>пропущено 2 строки/);
  assert.match(html, /<button type="button" class="btn" data-chart="id:otvet-1" aria-expanded="false">Построить график<\/button>/);
  assert.match(html, /<button type="button" class="btn" data-excel="id:otvet-1">Скачать Excel с графиком<\/button>/);
  assert.doesNotMatch(html, /<svg/);
  // Знак минус обычный дефис: без тире и «настоящего минуса».
  assert.doesNotMatch(html, /[\u2012-\u2015\u2212]/);
});

test('ответ: годы без пробела между тысячами, остальные числа с пробелом от 1 000; у CSV нет «Листа»', () => {
  const html = R.renderTable({ columns: ['Год', 'Литры'], rows: [[2025, 7413.1], [2026, 17203]] });
  assert.match(html, /<td class="num">2025<\/td><td class="num">7\u00a0413,1<\/td>/);
  assert.match(html, /<td class="num">2026<\/td><td class="num">17\u00a0203<\/td>/);
  const csv = R.renderPassport({ files: [{ file: 'a.csv', sheets: [{ sheet: null, rows: 2, title: ['Отчёт за сентябрь'], columns: [{ name: 'А', type: 'текст' }] }] }] });
  assert.doesNotMatch(csv, /Лист «/);
  assert.match(csv, /Над таблицей: Отчёт за сентябрь/);
});

test('ответ: текст из данных экранируется; без номера ответа Excel недоступен; ошибка и пустой ответ', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const html = R.renderAnswer({ question: evil, columns: [evil], rows: [[evil]], summary: evil, notes: [evil] }, {});
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  assert.match(html, /data-excel="q:[^"]*" disabled>/);
  const err = R.renderAnswer({ id: 'e', question: 'вопрос', error: 'Нет столбца «Литры»' }, {});
  assert.match(err, /<p class="run-error">Нет столбца «Литры»<\/p>/);
  assert.doesNotMatch(err, /data-chart/);
  assert.match(R.renderAnswers([]), /Ответов пока нет/);
  assert.match(R.renderAnswers([ANSWER], {}, 70), /Показаны последние 1 ответов из 70/);
});

test('ответ: состояния кнопки Excel (готовлю, ошибка, файл готов со ссылкой)', () => {
  assert.match(R.renderAnswer(ANSWER, { excel: { busy: true } }), /data-excel="id:otvet-1" disabled>.*Готовлю файл Excel/);
  assert.match(R.renderAnswer(ANSWER, { excel: { error: 'Нет openpyxl' } }), /class="action-msg error">Нет openpyxl/);
  assert.match(
    R.renderAnswer(ANSWER, { excel: { url: 'output/analiz/otvet-1.xlsx', file: 'otvet-1.xlsx' } }),
    /Файл готов: <a href="output\/analiz\/otvet-1\.xlsx" download>otvet-1\.xlsx<\/a>/,
  );
});

// ---------- график ----------

test('график: столбики для категорий, по умолчанию «Изменение, %», выбор показателя, минус ниже нуля', () => {
  const html = R.renderAnswer(ANSWER, { chart: true });
  assert.match(html, /aria-expanded="true">Скрыть график/);
  assert.match(html, /<div class="chart">/);
  assert.match(html, /<p class="chart-title">Изменение, % <span class="chart-by">по столбцу «АЗС»<\/span>/);
  assert.match(html, /<select data-measure="id:otvet-1">/);
  assert.match(html, /<option value="4" selected>Изменение, %<\/option>/);
  assert.match(html, /<svg class="chart-svg" viewBox="0 0 960 380"/);
  // Нулевое значение без столбика, остальные со своим столбиком; подписи категорий снизу.
  assert.equal(count(html, /<path class="bar"/), 2);
  assert.equal(count(html, /<text class="cat"[^>]*text-anchor="middle">АЗС-0\d<\/text>/), 3);
  assert.match(html, /<title>АЗС-01: -6,67 %<\/title>/);
  assert.match(html, /<line class="zero"/);
  const gap = R.renderChart({ columns: ['АЗС', 'Изменение, %'], rows: [['АЗС-01', 5], ['АЗС №7', null], ['АЗС-02', -3]] });
  assert.match(gap, /Без числа в «Изменение, %», на графике нет: АЗС №7\./);
  const litry = R.renderChart(ANSWER, 1);
  assert.match(litry, /<option value="1" selected>Литры A<\/option>/);
  assert.match(litry, /<title>АЗС-01: 10\u00a0500,5<\/title>/);
});

test('график: длинные подписи и много строк → полосы с подписями слева, не больше 30', () => {
  const rows = Array.from({ length: 45 }, (_, i) => [`Станция на трассе Алматы - Бишкек № ${i + 1}`, 100 + i]);
  const html = R.renderChart({ columns: ['Станция', 'Литры'], rows });
  assert.equal(count(html, /<path class="bar"/), 30);
  assert.match(html, /<text class="cat" x="\d+(\.\d+)?" y="[\d.]+" text-anchor="end">Станция на трассе/);
  assert.match(html, /На графике первые 30 строк из 45, как в таблице\./);
  assert.doesNotMatch(html, /<select/);
  // Отрицательные значения: полосы влево от нуля, подпись значения слева от конца полосы.
  const neg = R.renderChart({ columns: ['АЗС', 'Изменение'], rows: Array.from({ length: 13 }, (_, i) => [`АЗС-${i + 1}`, i === 0 ? -50 : 30 + i]) });
  assert.equal(count(neg, /<path class="bar"/), 13);
  assert.match(neg, /<text class="value" x="[\d.]+" y="[\d.]+" text-anchor="end">-50<\/text>/);
  assert.match(neg, /<text class="value" x="[\d.]+" y="[\d.]+" text-anchor="start">42<\/text>/);
  // Две длинные подписи помещаются под столбиками: столбики.
  const two = R.renderChart({ columns: ['Номенклатура', 'Изменение'], rows: [['Дизельное топливо летнее', -50], ['Бензин АИ-92 класса К4', 30]] });
  assert.match(two, /viewBox="0 0 960 380"/);
});

test('график: первый столбец дата → линия по времени с точками и подписями дат', () => {
  const rows = Array.from({ length: 14 }, (_, i) => [`2026-09-${String(7 + i).padStart(2, '0')}`, 1000 + i * 37.5]);
  const html = R.renderChart({ columns: ['Дата', 'Литры'], rows: rows.reverse() });
  assert.match(html, /<path class="line" d="M/);
  assert.equal(count(html, /<circle class="dot"/), 14);
  // Подписи дат с ровным шагом от последней: 20.09, 18.09, ..., 08.09 (не больше 8, соседние не слипаются).
  const dates = [...html.matchAll(/<text class="cat"[^>]*>(\d\d\.\d\d)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(dates, ['20.09', '18.09', '16.09', '14.09', '12.09', '10.09', '08.09']);
  assert.match(html, /<title>20\.09\.2026: 1\u00a0487,5<\/title>/);
  assert.doesNotMatch(html, /<path class="bar"/);
  const months = R.renderChart({ columns: ['Месяц', 'Литры'], rows: [['2025-10', 5], ['2025-11', 7], ['2026-01', 6]] });
  assert.match(months, />10\.2025<\/text>/);
  assert.match(months, /<path class="line"/);
});

test('график: две группы (group_columns) → подпись строки из обеих, показатель после них', () => {
  const a = {
    columns: ['АЗС', 'Топливо', 'Литры'],
    group_columns: 2,
    rows: [['АЗС-01', 'АИ-92', 100], ['АЗС-01', 'ДТ', 50], ['АЗС-02', 'АИ-92', 70]],
  };
  const html = R.renderChart(a);
  assert.match(html, /по столбцам «АЗС», «Топливо»/);
  assert.match(html, /<title>АЗС-01 · АИ-92: 100<\/title>/);
  assert.equal(count(html, /<path class="bar"/), 3);
});

test('график: нет чисел или одна строка → понятная подсказка вместо пустого рисунка', () => {
  assert.match(R.renderChart({ columns: ['АЗС', 'Тема'], rows: [['АЗС-01', 'текст'], ['АЗС-02', 'ещё']] }), /нужен столбец с числами/);
  assert.match(R.renderChart({ columns: ['АЗС', 'Литры'], rows: [['АЗС-01', 5]] }), /хотя бы две строки/);
  // Числа строкой тоже рисуются.
  assert.match(R.renderChart({ columns: ['АЗС', 'Литры'], rows: [['АЗС-01', '1 234,5'], ['АЗС-02', '17']] }), /<path class="bar"/);
});

// ---------- вопрос не получился ----------

test('нет claude (код 3): подсказка про вкладку Code с готовой фразой и кнопкой «Скопировать»', () => {
  const html = R.renderAskProblem(503, { code: 'ENOCLAUDE', phrase: 'спроси таблицу: литры по "АЗС"' }, 'литры по "АЗС"');
  assert.match(html, /вкладке <b>Code<\/b>/);
  assert.match(html, /value="спроси таблицу: литры по &quot;АЗС&quot;"/);
  assert.match(html, /data-copy="phrase">Скопировать</);
  assert.match(R.renderAskProblem(503, { code: 'ENOCLAUDE' }, 'вопрос'), /value="спроси таблицу: вопрос"/);
});

test('проверка ПД (код 4): причина от движка и подсказка обезличить; прочие ошибки текстом', () => {
  const pd = R.renderAskProblem(422, { code: 'EPERSONAL', error: 'в модель ушли бы персональные данные: ИИН' }, 'q');
  assert.match(pd, /Вопрос не отправлен\.<\/b> в модель ушли бы персональные данные: ИИН/);
  assert.match(pd, /анонимайзером с воркшопа 2/);
  assert.match(R.renderAskProblem(422, { code: 'EENGINE', error: 'Нет столбца <x>' }, 'q'), /<div class="notice"><p>Нет столбца &lt;x&gt;<\/p>/);
  assert.match(R.renderAskProblem(422, { code: 'EROWS', error: 'Этот вопрос требует строк с текстом' }, 'q'), /<div class="notice"><p>Этот вопрос требует строк/);
  assert.match(R.renderAskProblem(500, { error: 'Python не найден' }, 'q'), /<p class="run-error">Python не найден<\/p>/);
  assert.match(R.renderAskProblem(504, { code: 'ETIMEOUT', error: 'долго', phrase: 'спроси таблицу: q' }, 'q'), /data-copy="phrase"/);
  assert.match(R.renderAskProblem(404, {}, 'q'), /запущена до обновления/);
});

// ---------- разметка страниц ----------

test('analiz.html: заголовок, бренд как на главной, ссылка на кабинет, только относительные ссылки, без интернета', () => {
  assert.match(PAGE, /data-cabinet="ok"/);
  assert.match(PAGE, /<title>Спроси таблицу<\/title>/);
  assert.match(PAGE, /<h1>Спроси таблицу<\/h1>/);
  assert.match(PAGE, /<a class="back" href="\.\/">← Мой кабинет<\/a>/);
  assert.match(PAGE, /<script src="analiz\.js"><\/script>/);
  assert.match(PAGE, /<\/style>\s*<link rel="stylesheet" href="brand\/theme\.css">/);
  assert.match(PAGE, /<img class="brand-logo" id="brand-logo" alt="" hidden>/);
  for (const needle of ["'brand/logo.svg'", "'brand/logo.png'", "fetch('brand/brand.json'"]) assert.ok(PAGE.includes(needle), needle);
  for (const v of ['--accent:', '--accent-ink:', '--accent-dark:', '--accent-dark-ink:', '--link:', '--stripe:', '--logo-height:']) {
    assert.ok(PAGE.includes(v), v);
  }
  // Адрес страницы содержит секретную часть: ни одной ссылки от корня сайта и ни одного внешнего ресурса.
  assert.doesNotMatch(PAGE, /(src|href|action)="(\/|https?:|\/\/)/);
  assert.doesNotMatch(PAGE, /fetch\(['"`]\//);
  assert.doesNotMatch(PAGE, /@import|url\(/);
  assert.doesNotMatch(PAGE, /https?:\/\//);
  for (const needle of ["'X-Cabinet': '1'", "'Content-Type': 'application/json'", "method: 'POST'", "'api/analiz/' + path", "call('passport')", "call('history')", "call('ask'", "call('excel'", "call('open-folder'"]) {
    assert.ok(PAGE.includes(needle), needle);
  }
  for (const block of ['Ваши данные', 'Открыть папку с данными', 'Ваш вопрос', '>Спросить<', 'Считаю…', 'Ответы']) assert.ok(PAGE.includes(block), block);
  assert.ok(PAGE.includes('maxlength="1000"'), 'длина вопроса ограничена и на странице');
  const js = readFileSync(join(SITE, 'analiz.js'), 'utf8');
  assert.doesNotMatch(js, /https?:\/\/|fetch\(|import\s/);
});

test('главная: карточка-ссылка «Спроси таблицу» над карточками процессов, ссылка относительная', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const card = html.indexOf('<a class="service" href="analiz.html">');
  assert.ok(card !== -1, 'нет карточки-ссылки');
  assert.ok(card < html.indexOf('id="processes"'), 'карточка над процессами');
  assert.ok(html.includes('<span class="service-title">Спроси таблицу</span>'));
  assert.ok(
    html.includes('<span class="service-desc">Задайте вопрос своим таблицам: считает программа на вашем компьютере, строки никуда не уходят</span>'),
  );
  assert.doesNotMatch(html, /(src|href)="(\/|https?:|\/\/)/);
});

// ---------- скрипт страницы в песочнице ----------

function stub(extra = {}) {
  return {
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    value: '',
    on: {},
    addEventListener(type, fn) {
      this.on[type] = fn;
    },
    focus() {},
    ...extra,
  };
}

// Скрипт страницы (первый встроенный <script>) с подставными DOM, fetch и таймерами.
function pageSandbox(respond) {
  const code = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const ids = ['passport', 'answers', 'ask-form', 'question', 'ask', 'busy', 'ask-msg', 'folder-msg', 'open-folder', 'refresh'];
  const el = Object.fromEntries(ids.map((id) => [id, stub()]));
  const calls = [];
  const document = { getElementById: (id) => el[id] ?? null, visibilityState: 'visible', addEventListener() {} };
  const sandbox = {
    window: { AnalizRender: R, addEventListener() {} },
    document,
    navigator: {},
    fetch: (url, opts = {}) => {
      calls.push({ url, opts });
      return respond(url, opts);
    },
    setTimeout: () => 0,
    setInterval: () => 1,
    clearInterval() {},
    Date,
    JSON,
    Promise,
    Number,
    String,
    Array,
  };
  runInNewContext(code, sandbox);
  return { el, calls };
}

const json = (status, data) => Promise.resolve({ status, ok: status < 300, json: () => Promise.resolve(data) });
const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

test('страница: при открытии паспорт и история с заголовком X-Cabinet по относительным адресам', async () => {
  const p = pageSandbox((url) =>
    url === 'api/analiz/passport' ? json(200, { ok: true, passport: { files: [] } }) : json(200, { ok: true, items: [ANSWER], total: 1 }),
  );
  await settle();
  assert.deepEqual(p.calls.map((c) => c.url).sort(), ['api/analiz/history', 'api/analiz/passport']);
  for (const c of p.calls) assert.equal(c.opts.headers['X-Cabinet'], '1');
  assert.match(p.el.passport.innerHTML, /Папка с данными пока пустая/);
  assert.match(p.el.answers.innerHTML, /data-key="id:otvet-1"/);
});

test('страница: «Спросить» шлёт вопрос JSON-ом; код 3 показывает фразу для вкладки Code; пустой вопрос не уходит', async () => {
  let askBody = null;
  const p = pageSandbox((url, opts) => {
    if (url === 'api/analiz/ask') {
      askBody = opts;
      return json(503, { code: 'ENOCLAUDE', error: 'нет claude', phrase: 'спроси таблицу: литры по АЗС' });
    }
    return url === 'api/analiz/passport' ? json(200, { passport: { files: [] } }) : json(200, { items: [], total: 0 });
  });
  await settle();
  p.el.question.value = '   ';
  p.el['ask-form'].on.submit({ preventDefault() {} });
  await settle();
  assert.equal(askBody, null);
  assert.match(p.el['ask-msg'].innerHTML, /Напишите вопрос/);
  p.el.question.value = 'литры по АЗС';
  p.el['ask-form'].on.submit({ preventDefault() {} });
  assert.equal(p.el.ask.disabled, true, 'кнопка неактивна, пока считается');
  assert.equal(p.el.busy.hidden, false, 'виден индикатор «Считаю…»');
  await settle();
  assert.equal(askBody.method, 'POST');
  assert.equal(askBody.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(askBody.body), { question: 'литры по АЗС' });
  assert.match(p.el['ask-msg'].innerHTML, /value="спроси таблицу: литры по АЗС"/);
  assert.equal(p.el.ask.disabled, false);
  assert.equal(p.el.busy.hidden, true);
  assert.equal(p.el.question.value, 'литры по АЗС', 'вопрос остаётся в поле');
});

test('страница: удачный ответ перечитывает историю и очищает поле; три неудачи подряд останавливают страницу', async () => {
  let history = [];
  const p = pageSandbox((url) => {
    if (url === 'api/analiz/ask') {
      history = [ANSWER];
      return json(200, { ok: true, answer: ANSWER });
    }
    return url === 'api/analiz/passport' ? json(200, { passport: { files: [] } }) : json(200, { items: history, total: history.length });
  });
  await settle();
  p.el.question.value = ANSWER.question;
  p.el['ask-form'].on.submit({ preventDefault() {} });
  await settle();
  assert.equal(p.el.question.value, '');
  assert.match(p.el.answers.innerHTML, /data-key="id:otvet-1"/);

  const down = pageSandbox(() => Promise.reject(new TypeError('Failed to fetch')));
  await settle();
  down.el.refresh.on.click();
  await settle();
  assert.match(down.el.answers.innerHTML, /Страница остановлена/);
  assert.equal(down.el.ask.disabled, true);
  const n = down.calls.length;
  down.el.refresh.on.click();
  down.el['ask-form'].on.submit({ preventDefault() {} });
  await settle();
  assert.equal(down.calls.length, n, 'после остановки запросов нет');
});
