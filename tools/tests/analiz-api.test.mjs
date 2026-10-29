// API сервиса «Спроси таблицу» (tools/analiz-api.mjs) через сервер кабинета. Движок tools/analiz.py подменён:
// во временном кабинете (путь с кириллицей и пробелом) лежит маленькая программа на Python, она отвечает по
// контракту и записывает, с какими аргументами её позвали. Python настоящий, как у кнопки «Запустить».
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createCabinetServer, listenFirstFree } from '../serve.mjs';
import { QUESTION_MAX, cleanQuestion, codePhrase, engineMessage, normalizeHistory, parseEngineJson } from '../analiz-api.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const T = `/${TOKEN}`;
const READ = { 'X-Cabinet': '1' };
// Порты 19100-19299: другие файлы тестов (serve, processes-api) идут параллельно на 18500-18999.
const WRITE = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };

// Подменённый движок: подкоманды passport, ask, excel по контракту. Вопрос определяет исход:
// «нет claude...» код 3, «пд...» код 4, «строки...» код 5, «ошибка...» трейсбек и код 1, «долго...» ждёт 30 с,
// «тихо...» пустой вывод. История как у настоящего движка: новые в начале списка, время в поле created.
const FAKE_ENGINE = String.raw`import json, os, sys, time
args = sys.argv[1:]
cmd = args[0] if args else ""
out = os.path.join("output", "analiz")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "calls.jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps(args, ensure_ascii=False) + "\n")

def say(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)

if cmd == "passport":
    folder = os.path.join("input", "analiz")
    names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
    say({"folder": "input/analiz", "files": [{"file": n, "sheets": [{"sheet": None, "rows": 2, "columns": [
        {"name": "АЗС", "type": "текст", "values": ["АЗС-01", "АЗС-02"]},
        {"name": "Литры", "type": "число", "min": 1.5, "max": 2}]}]} for n in names]})
if cmd == "ask":
    q = args[1]
    if q.startswith("нет claude"):
        say({"error": "claude не найден на этом компьютере"}, 3)
    if q.startswith("пд"):
        say({"error": "в модель ушли бы персональные данные: ИИН в столбце «Клиент»"}, 4)
    if q.startswith("строки"):
        say({"error": "Этот вопрос требует строк с текстом или данных о людях (нужно читать жалобы): обезличьте файл анонимайзером с воркшопа 2 и положите копию в input/analiz.", "code": 5, "need_rows": True}, 5)
    if q.startswith("ошибка"):
        sys.stderr.write('Traceback (most recent call last):\n  File "analiz.py", line 1\n    x\nValueError: Нет столбца «Литры»\n')
        sys.exit(1)
    if q.startswith("долго"):
        time.sleep(30)
    if q.startswith("тихо"):
        sys.exit(0)
    hist = os.path.join(out, "history.json")
    items = json.load(open(hist, encoding="utf-8")) if os.path.exists(hist) else []
    ans = {"id": "otvet-%d" % (len(items) + 1), "question": q, "spec": {"table": "prodazhi.csv"},
           "columns": ["АЗС", "Литры"], "rows": [["АЗС-01", 1.5], ["АЗС-02", 2]], "total_rows": 2,
           "totals": {"Литры": 3.5}, "notes": [], "summary": "Всего 3,5 л.", "created": "2026-10-29T22:%02d:00" % (len(items) + 1)}
    items.insert(0, ans)
    json.dump(items, open(hist, "w", encoding="utf-8"), ensure_ascii=False)
    print("служебная строка движка")
    say(ans)
if cmd == "excel":
    name = "otvet-%s.xlsx" % args[1]
    with open(os.path.join(out, name), "wb") as f:
        f.write(b"PK\x03\x04 excel")
    say({"file": "output/analiz/" + name})
sys.exit(2)
`;

let base, cab, server, port, quick, quickPort;
const opened = [];

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'analiz-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(join(cab, 'tools'), { recursive: true });
  copyDir(join(ROOT, 'templates', 'site'), join(cab, 'site'));
  writeFileSync(join(cab, 'tools', 'analiz.py'), FAKE_ENGINE);
  writeFileSync(join(cab, 'CLAUDE.md'), 'секретные правила кабинета');
  server = createCabinetServer(cab, { token: TOKEN, analiz: { openFolder: (dir) => opened.push(dir) } });
  port = await listenFirstFree(server, { from: 19100, to: 19149 });
  // Второй сервер того же кабинета с коротким ограничением времени: для проверки остановки долгого вопроса.
  quick = createCabinetServer(cab, { token: TOKEN, analiz: { askTimeoutMs: 1500, openFolder: () => true } });
  quickPort = await listenFirstFree(quick, { from: 19150, to: 19199 });
});

after(async () => {
  for (const s of [server, quick]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }
  rmSync(base, { recursive: true, force: true });
});

function request(method, path, headers = {}, body, onPort = port) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: onPort, path, method, headers, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // не JSON
        }
        res({ status: r.statusCode, headers: r.headers, body: text, buf, json });
      });
    });
    req.on('error', rej);
    req.end(body);
  });
}
const get = (path, headers = READ, onPort) => request('GET', path, headers, undefined, onPort);
const post = (path, data, headers = WRITE, onPort) => request('POST', path, headers, JSON.stringify(data), onPort);
const ask = (question, onPort) => post(`${T}/api/analiz/ask`, { question }, WRITE, onPort);

const calls = () =>
  existsSync(join(cab, 'output', 'analiz', 'calls.jsonl'))
    ? readFileSync(join(cab, 'output', 'analiz', 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

test('без токена, с чужим токеном, без заголовка X-Cabinet или без JSON → 403, движок не запускается', async () => {
  const before = calls().length;
  const routes = ['passport', 'history'];
  for (const r of routes) {
    assert.equal((await get(`/api/analiz/${r}`)).status, 403, r);
    assert.equal((await get(`/0000000000000000/api/analiz/${r}`)).status, 403, r);
    const noHeader = await get(`${T}/api/analiz/${r}`, {});
    assert.equal(noHeader.status, 403, r);
    assert.match(noHeader.json.error, /только со своей страницы/);
  }
  for (const r of ['ask', 'excel', 'open-folder']) {
    assert.equal((await post(`/api/analiz/${r}`, { question: 'вопрос', id: 'a' })).status, 403, r);
    assert.equal((await post(`${T}/api/analiz/${r}`, { question: 'вопрос', id: 'a' }, { 'Content-Type': 'application/json' })).status, 403, r);
    assert.equal((await post(`${T}/api/analiz/${r}`, { question: 'вопрос', id: 'a' }, { 'X-Cabinet': '1', 'Content-Type': 'text/plain' })).status, 403, r);
  }
  assert.equal(calls().length, before, 'движок не вызывался');
  assert.equal(opened.length, 0, 'папка не открывалась');
  assert.equal(existsSync(join(cab, 'input', 'analiz')), false, 'папка input/analiz не создана');
});

test('неверный метод → 405, неизвестный адрес → 404; заголовки no-referrer, nosniff, no-store', async () => {
  const r1 = await request('POST', `${T}/api/analiz/passport`, WRITE, '{}');
  assert.equal(r1.status, 405);
  assert.equal(r1.headers.allow, 'GET, HEAD');
  const r2 = await get(`${T}/api/analiz/ask`);
  assert.equal(r2.status, 405);
  assert.equal(r2.headers.allow, 'POST');
  const r3 = await get(`${T}/api/analiz/net-takogo`);
  assert.equal(r3.status, 404);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  // API процессов рядом работает как раньше.
  assert.equal((await get(`${T}/api/processes`)).status, 200);
});

test('open-folder: создаёт input/analiz и открывает её (без настоящего Проводника); паспорт видит положенный файл', async () => {
  let p = await get(`${T}/api/analiz/passport`);
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.passport.files, []);
  const r = await post(`${T}/api/analiz/open-folder`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.opened, true);
  assert.equal(r.json.path, join(cab, 'input', 'analiz'));
  assert.deepEqual(opened, [join(cab, 'input', 'analiz')]);
  assert.ok(existsSync(join(cab, 'input', 'analiz')));
  writeFileSync(join(cab, 'input', 'analiz', 'prodazhi.csv'), 'АЗС;Литры\nАЗС-01;1,5\n');
  p = await get(`${T}/api/analiz/passport`);
  assert.equal(p.status, 200);
  assert.equal(p.json.passport.files[0].file, 'prodazhi.csv');
  assert.equal(p.json.passport.files[0].sheets[0].columns[0].name, 'АЗС');
  // Повторно: папка уже есть, ответ тот же.
  assert.equal((await post(`${T}/api/analiz/open-folder`, {})).status, 200);
});

test('ask: ответ движка по контракту, вопрос доходит одним аргументом как есть, без оболочки', async () => {
  const q = 'Сколько литров "АИ-92" & %PATH% $(whoami) `id` по АЗС? 50%';
  const r = await ask(q);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.answer.question, q);
  assert.deepEqual(r.json.answer.columns, ['АЗС', 'Литры']);
  assert.deepEqual(calls().at(-1), ['ask', q]);
  const h = await get(`${T}/api/analiz/history`);
  assert.equal(h.status, 200);
  assert.equal(h.json.items[0].question, q);
});

test('ask: вопрос чистится (переводы строк, «-» в начале), пустой и слишком длинный не отправляются', async () => {
  const r = await ask('  -- итого\nпо   АЗС\t');
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(calls().at(-1), ['ask', 'итого по АЗС']);
  const n = calls().length;
  const empty = await ask('  \n ');
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, 'EEMPTY');
  const long = await ask('я'.repeat(QUESTION_MAX + 1));
  assert.equal(long.status, 400);
  assert.equal(long.json.code, 'ELONG');
  const notText = await post(`${T}/api/analiz/ask`, { question: 42 });
  assert.equal(notText.status, 400);
  const huge = await request('POST', `${T}/api/analiz/ask`, WRITE, JSON.stringify({ question: 'я'.repeat(20000) }));
  assert.equal(huge.status, 413);
  const broken = await request('POST', `${T}/api/analiz/ask`, WRITE, '{"question": ');
  assert.equal(broken.status, 400);
  assert.equal(calls().length, n, 'движок не вызывался');
});

test('ask: код 3 (нет claude) → 503 ENOCLAUDE с фразой для вкладки Code', async () => {
  const r = await ask('нет claude: продажи по АЗС');
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'ENOCLAUDE');
  assert.equal(r.json.phrase, 'спроси таблицу: нет claude: продажи по АЗС');
  assert.equal(r.json.phrase, codePhrase('нет claude: продажи по АЗС'));
  assert.match(r.json.error, /вкладке Code/);
});

test('ask: код 4 (проверка на персональные данные) → 422 EPERSONAL с причиной от движка', async () => {
  const r = await ask('пд: выручка по клиентам');
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'EPERSONAL');
  assert.equal(r.json.error, 'в модель ушли бы персональные данные: ИИН в столбце «Клиент»');
});

test('ask: код 5 (нужны строки с текстом или данные о людях) → 422 EROWS с подсказкой обезличить', async () => {
  const r = await ask('строки: о чём жалуются');
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'EROWS');
  assert.match(r.json.error, /анонимайзером с воркшопа 2/);
});

test('ask: ошибка движка → понятная строка без трейсбека; пустой вывод → 500', async () => {
  const r = await ask('ошибка: литры');
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'EENGINE');
  assert.equal(r.json.error, 'ValueError: Нет столбца «Литры»');
  assert.doesNotMatch(r.json.error, /Traceback|File "/);
  const silent = await ask('тихо');
  assert.equal(silent.status, 500);
  assert.equal(silent.json.code, 'EENGINE');
});

test('ask: дольше ограничения → 504 и движок остановлен; второй вопрос, пока идёт первый → 409', async () => {
  const slow = ask('долго считать', quickPort);
  await new Promise((r) => setTimeout(r, 300));
  const second = await ask('второй вопрос', quickPort);
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'EBUSY');
  const started = Date.now();
  const r = await slow;
  assert.equal(r.status, 504);
  assert.equal(r.json.code, 'ETIMEOUT');
  assert.equal(r.json.phrase, 'спроси таблицу: долго считать');
  assert.ok(Date.now() - started < 15000, 'ответ не ждал 30 с');
  // После остановки вопросы снова принимаются.
  assert.equal((await ask('после долгого', quickPort)).status, 200);
});

test('history: новые сверху; файла нет → пусто; битый файл → 500 с понятным текстом; вложенный вид записей', async () => {
  const file = join(cab, 'output', 'analiz', 'history.json');
  const saved = readFileSync(file, 'utf8');
  try {
    const h = await get(`${T}/api/analiz/history`);
    const times = h.json.items.map((a) => a.time);
    assert.ok(times.length >= 3 && times.every(Boolean), 'время из поля created');
    assert.deepEqual(times, [...times].sort().reverse());
    assert.equal(h.json.total, h.json.items.length);

    rmSync(file);
    const none = await get(`${T}/api/analiz/history`);
    assert.equal(none.status, 200);
    assert.deepEqual(none.json.items, []);

    writeFileSync(file, '[{"question": ');
    const broken = await get(`${T}/api/analiz/history`);
    assert.equal(broken.status, 500);
    assert.match(broken.json.error, /history\.json/);

    writeFileSync(
      file,
      JSON.stringify({
        items: [
          { id: 'x1', question: 'первый', time: '2026-10-29T10:00:00', result: { columns: ['А'], rows: [[1]], summary: 'раз' } },
          { id: 'x2', question: 'второй', time: '2026-10-29T11:00:00', result: { columns: ['А'], rows: [[2]], summary: 'два' } },
        ],
      }),
    );
    const nested = await get(`${T}/api/analiz/history`);
    assert.deepEqual(nested.json.items.map((a) => [a.id, a.question, a.summary]), [['x2', 'второй', 'два'], ['x1', 'первый', 'раз']]);
  } finally {
    writeFileSync(file, saved);
  }
});

test('excel: ссылка на файл в output/analiz, файл скачивается; чужой номер и лишние файлы не отдаются', async () => {
  const r = await post(`${T}/api/analiz/excel`, { id: 'otvet-1' });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.file, 'otvet-otvet-1.xlsx');
  assert.equal(r.json.url, 'output/analiz/otvet-otvet-1.xlsx');
  assert.deepEqual(calls().at(-1), ['excel', 'otvet-1']);
  const file = await get(`${T}/${r.json.url}`, {});
  assert.equal(file.status, 200);
  assert.match(file.headers['content-disposition'], /^attachment; filename\*=UTF-8''otvet-otvet-1\.xlsx$/);
  assert.equal(file.headers['content-security-policy'], 'sandbox');
  assert.match(file.headers['content-type'], /spreadsheetml/);
  assert.equal(file.buf.subarray(0, 2).toString(), 'PK');

  const n = calls().length;
  for (const id of ['-rf', '../x', '', 'a b', 'я'.repeat(3), null]) {
    const bad = await post(`${T}/api/analiz/excel`, { id });
    assert.equal(bad.status, 400, String(id));
  }
  assert.equal(calls().length, n, 'движок не вызывался');
  // Из output/analiz отдаются только файлы Excel: история, журнал вызовов и вложенные пути нет.
  for (const p of ['history.json', 'calls.jsonl', '..%2Fanaliz%2Fhistory.json', 'sub/x.xlsx', '.skrytyi.xlsx']) {
    assert.equal((await get(`${T}/output/analiz/${p}`, {})).status, 404, p);
  }
});

test('страница сервиса и её скрипт отдаются под токеном, только на чтение; без токена 403', async () => {
  const page = await get(`${T}/analiz.html`, {});
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /<h1>Спроси таблицу<\/h1>/);
  const js = await get(`${T}/analiz.js`, {});
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.match(js.body, /AnalizRender/);
  assert.equal((await get('/analiz.html', {})).status, 403);
  assert.equal((await request('POST', `${T}/analiz.html`, WRITE, '{}')).status, 405);
  const main = await get(`${T}/`, {});
  assert.match(main.body, /<a class="service" href="analiz\.html">/);
});

test('движка нет в кабинете: понятный ответ «обнови кабинет», Python не ищется', async () => {
  const other = join(base, 'bez-dvizhka');
  mkdirSync(join(other, 'site'), { recursive: true });
  const s = createCabinetServer(other, { token: TOKEN, python: join(other, 'net-pythona.exe') });
  const p = await listenFirstFree(s, { from: 19200, to: 19249 });
  try {
    for (const r of [await get(`${T}/api/analiz/passport`, READ, p), await ask('вопрос', p), await post(`${T}/api/analiz/excel`, { id: 'a1' }, WRITE, p)]) {
      assert.equal(r.status, 500);
      assert.equal(r.json.code, 'ENOENGINE');
      assert.match(r.json.error, /обнови кабинет/);
    }
    const h = await get(`${T}/api/analiz/history`, READ, p);
    assert.deepEqual(h.json.items, []);
  } finally {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }
});

test('Python не запускается: понятный ответ «проверь сетап»', async () => {
  const s = createCabinetServer(cab, { token: TOKEN, python: join(base, 'net-takogo-pythona', 'python.exe') });
  const p = await listenFirstFree(s, { from: 19250, to: 19299 });
  try {
    const r = await get(`${T}/api/analiz/passport`, READ, p);
    assert.equal(r.status, 500);
    assert.equal(r.json.code, 'ENOPYTHON');
    assert.match(r.json.error, /проверь сетап/);
  } finally {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }
});

// ---------- чистые функции ----------

test('cleanQuestion: одна строка, без управляющих знаков и «-» в начале', () => {
  assert.equal(cleanQuestion('  Продажи\r\nпо АЗС\u0000 '), 'Продажи по АЗС');
  assert.equal(cleanQuestion('--help'), 'help');
  assert.equal(cleanQuestion('-5% к прошлой неделе?'), '5% к прошлой неделе?');
  assert.equal(cleanQuestion('АЗС-05 упала?'), 'АЗС-05 упала?');
  assert.equal(cleanQuestion(null), '');
  assert.equal(cleanQuestion(['a']), '');
  assert.equal(cleanQuestion('a\ud800b'), 'a\ufffdb');
});

test('parseEngineJson: весь вывод, последняя строка JSON или объект внутри текста', () => {
  assert.deepEqual(parseEngineJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(parseEngineJson('\ufeff{"a": 1}\n'), { a: 1 });
  assert.deepEqual(parseEngineJson('читаю файлы\n{"a": 2}\n'), { a: 2 });
  assert.deepEqual(parseEngineJson('итог: {"a": 3} готово'), { a: 3 });
  assert.equal(parseEngineJson(''), null);
  assert.equal(parseEngineJson('просто текст'), null);
});

test('engineMessage: поле JSON, находки проверки, последняя строка stderr без трейсбека', () => {
  assert.equal(engineMessage({ error: 'Нет столбца' }, 'x'), 'Нет столбца');
  assert.equal(engineMessage({ findings: ['ИИН', { kind: 'телефон' }] }, ''), 'в модель ушли бы персональные данные: ИИН, телефон');
  assert.equal(engineMessage(null, 'Traceback (most recent call last):\n  File "a.py"\nKeyError: «Литры»\n'), 'KeyError: «Литры»');
  assert.equal(engineMessage(null, ''), null);
  assert.ok(engineMessage({ error: 'я'.repeat(5000) }, '').length <= 600);
});

test('normalizeHistory: список, объект со списком, без времени как в файле, ограничение', () => {
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory({ nothing: 1 }), []);
  const flat = [{ id: 3 }, { id: 2 }, 'мусор', { id: 1 }];
  assert.deepEqual(normalizeHistory(flat).map((a) => a.id), [3, 2, 1]);
  // Как у движка: новые в начале, время в created; одинаковое время не меняет порядок файла.
  const engine = [
    { id: 'q-2', created: '2026-10-29T22:15:00' },
    { id: 'q-1b', created: '2026-10-29T22:10:00' },
    { id: 'q-1a', created: '2026-10-29T22:10:00' },
  ];
  assert.deepEqual(normalizeHistory(engine).map((a) => [a.id, a.time]), [
    ['q-2', '2026-10-29T22:15:00'],
    ['q-1b', '2026-10-29T22:10:00'],
    ['q-1a', '2026-10-29T22:10:00'],
  ]);
  const timed = [
    { id: 'b', created_at: '2026-10-29 12:00:00' },
    { id: 'a', created_at: '2026-10-29 09:00:00' },
    { id: 'c', created_at: '2026-10-29 15:00:00' },
  ];
  assert.deepEqual(normalizeHistory({ history: timed }).map((a) => [a.id, a.time]), [
    ['c', '2026-10-29 15:00:00'],
    ['b', '2026-10-29 12:00:00'],
    ['a', '2026-10-29 09:00:00'],
  ]);
  assert.equal(normalizeHistory(Array.from({ length: 80 }, (_, i) => ({ id: i }))).length, 50);
});
