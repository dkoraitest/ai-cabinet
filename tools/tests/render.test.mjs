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

test('kind claude: вместо кнопки подсказка с фразой', () => {
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
  assert.doesNotMatch(html, /fetch\(['"`]\//);
  assert.doesNotMatch(html, /@import|url\(/);
  for (const needle of ["'X-Cabinet': '1'", "'Content-Type': 'application/json'", "method: 'POST'", 'api/processes', 'api/run/', 'api/status/', '2000']) {
    assert.ok(html.includes(needle), needle);
  }
  assert.match(html, /last-run\.log/);
});
