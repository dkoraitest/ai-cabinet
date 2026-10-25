// node tools/processes.mjs list | run | input | demo: общий с кнопкой запуск, замок и статус в файлах output/<slug>/.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createCabinetServer, listenFirstFree } from '../serve.mjs';
import { crc32, deflateRawSync } from 'node:zlib';
import { processStatus, zipEntries } from '../processes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = '0123456789abcdef0123456789abcdef';
const RUN_HEADERS = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };

const RESULT_PY = (slug, title) => `import json, os, sys
from datetime import datetime
out = os.path.join("output", "${slug}")
os.makedirs(out, exist_ok=True)
res = {"title": "${title}", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "yellow", "summary": "Литров за неделю: 1200, нет данных по АЗС-03.", "columns": ["АЗС", "Литры"],
       "rows": [["АЗС-01", 1200], ["АЗС-03", None]], "row_status": ["green", "grey"],
       "files": ["output/${slug}/svodka.xlsx"]}
with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, allow_nan=False)
print("готово")
`;

const SLOW_PY = (slug, seconds) => `import json, os, time
from datetime import datetime
time.sleep(${seconds})
out = os.path.join("output", "${slug}")
os.makedirs(out, exist_ok=True)
res = {"title": "Долгий", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "green", "summary": "Долгий расчёт закончен.", "columns": [], "rows": []}
with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False)
`;

let base, cab;

function addProcess(slug, json, runPy) {
  const dir = join(cab, 'processes', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'process.json'), JSON.stringify(json));
  if (runPy !== undefined) writeFileSync(join(dir, 'run.py'), runPy);
}

const script = (slug, title) => ({ title, phrase: `запусти ${title.toLowerCase()}`, kind: 'script', input: `input/${slug}/`, output: `output/${slug}/` });

before(() => {
  base = mkdtempSync(join(tmpdir(), 'cli-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(cab, { recursive: true });
  copyDir(join(ROOT, 'tools'), join(cab, 'tools'));
  rmSync(join(cab, 'tools', 'tests'), { recursive: true, force: true });
  copyDir(join(ROOT, 'templates'), join(cab, 'templates'));
  rmSync(join(cab, 'templates', 'processes', 'svetofor-dogovorov', '__pycache__'), { recursive: true, force: true });
  copyDir(join(ROOT, 'templates', 'site'), join(cab, 'site'));
  mkdirSync(join(cab, 'input', 'case-azs', 'data'), { recursive: true });
  for (const f of ['reestr_dogovorov.xlsx', 'sales_azs_1c.csv']) {
    writeFileSync(join(cab, 'input', 'case-azs', 'data', f), readFileSync(join(ROOT, 'input', 'case-azs', 'data', f)));
  }
  addProcess('svodka-prodazh', { ...script('svodka-prodazh', 'Сводка продаж'), phrase: 'запусти сводку продаж' }, RESULT_PY('svodka-prodazh', 'Сводка продаж'));
  addProcess('dolgiy', script('dolgiy', 'Долгий'), SLOW_PY('dolgiy', 2));
  addProcess('padaet', script('padaet', 'Падает'), 'import sys\nprint("строка 1")\nprint("Нет файла input/padaet/sales.csv", file=sys.stderr)\nsys.exit(2)\n');
  addProcess('molchit', script('molchit', 'Молчит'), 'print("ничего не записал")\n');
  addProcess('krivoy', script('krivoy', 'Кривой'), `import json, os
os.makedirs(os.path.join("output", "krivoy"), exist_ok=True)
open(os.path.join("output", "krivoy", "result.json"), "w").write('{"title": "Кривой", "updated_at": "2026-10-22T10:00:00", "status": "blue", "summary": "", "columns": [], "rows": []}')
`);
  addProcess('pisma', { title: 'Черновики писем', phrase: 'запусти черновики писем', kind: 'claude', skill: 'pisma-postavshchikam', input: 'input/pisma/', output: 'output/pisma/' });
});

after(() => rmSync(base, { recursive: true, force: true }));

// CLI из копии tools/ внутри кабинета: корень кабинета он находит от своего расположения.
function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [join(cab, 'tools', 'processes.mjs'), ...args], {
    cwd: opts.cwd ?? cab,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...opts.env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function cliAsync(args) {
  const child = spawn(process.execPath, [join(cab, 'tools', 'processes.mjs'), ...args], { cwd: cab, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  // close, а не exit: к close весь вывод уже прочитан.
  const done = new Promise((r) => child.on('close', (code, signal) => r({ code, signal, out })));
  return { child, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockOf = (slug) => join(cab, 'output', slug, '.running');
const lastRunOf = (slug) => join(cab, 'output', slug, 'last-run.json');

// check может бросить (файла ещё нет, файл пишется и пока пуст): это значит «ещё нет».
async function waitFor(check, what, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const v = check();
      if (v) return v;
    } catch {
      // ещё нет
    }
    await sleep(20);
  }
  throw new Error(`не дождались: ${what}`);
}

function request(port, method, path, headers = {}, body) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // не JSON
        }
        res({ status: r.statusCode, json });
      });
    });
    req.on('error', rej);
    req.end(body);
  });
}

async function withServer(fn) {
  const server = createCabinetServer(cab, { token: TOKEN });
  const port = await listenFirstFree(server, { from: 18900, to: 18999 });
  try {
    await fn({
      run: (slug) => request(port, 'POST', `/${TOKEN}/api/run/${slug}`, RUN_HEADERS, '{}'),
      status: async (slug) => (await request(port, 'GET', `/${TOKEN}/api/status/${slug}`)).json,
      list: async () => (await request(port, 'GET', `/${TOKEN}/api/processes`)).json,
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  }
}

test('run: удачный расчёт → «Готово», итог, путь к result.json; last-run.json записан, замок снят', () => {
  const r = cli(['run', 'svodka-prodazh']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Готово: «Сводка продаж»/m);
  assert.match(r.out, /Итог: Литров за неделю: 1200, нет данных по АЗС-03\./);
  assert.match(r.out, /Цвет карточки: жёлтый/);
  assert.match(r.out, /Результат: output\/svodka-prodazh\/result\.json/);
  assert.match(r.out, /Файлы: output\/svodka-prodazh\/svodka\.xlsx/);
  assert.doesNotMatch(r.out, /[\u2012-\u2015]/);
  const last = JSON.parse(readFileSync(lastRunOf('svodka-prodazh'), 'utf8'));
  assert.equal(last.ok, true);
  assert.equal(last.code, 0);
  assert.ok(!Number.isNaN(Date.parse(last.finishedAt)));
  assert.ok(Number.isInteger(last.durationMs) && last.durationMs >= 0);
  assert.equal(existsSync(lockOf('svodka-prodazh')), false, 'замок остался');
  assert.match(readFileSync(join(cab, 'output', 'svodka-prodazh', 'last-run.log'), 'utf8'), /готово/);
});

test('run: расчёт упал → код 1, «не удался», последние строки журнала; last-run.json ok false', () => {
  const r = cli(['run', 'padaet']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /не удался/);
  assert.match(r.out, /output\/padaet\/last-run\.log/);
  assert.match(r.out, /Нет файла input\/padaet\/sales\.csv/);
  const last = JSON.parse(readFileSync(lastRunOf('padaet'), 'utf8'));
  assert.deepEqual([last.ok, last.code], [false, 2]);
  assert.equal(existsSync(lockOf('padaet')), false);
});

test('run: программа не записала result.json или записала не по схеме → код 1, «готово» не печатается', () => {
  const silent = cli(['run', 'molchit']);
  assert.equal(silent.code, 1, silent.out);
  assert.match(silent.out, /не записала output\/molchit\/result\.json/);
  assert.doesNotMatch(silent.out, /Готово/);
  const bad = cli(['run', 'krivoy']);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /result\.json/);
  assert.match(bad.out, /status: нужно green, yellow или red/);
  assert.doesNotMatch(bad.out, /Готово/);
});

test('run: result.json не обновился (старый файл остался) → код 1', () => {
  addProcess('staryi', script('staryi', 'Старый'), 'print("посчитал, но не записал")\n');
  mkdirSync(join(cab, 'output', 'staryi'), { recursive: true });
  writeFileSync(
    join(cab, 'output', 'staryi', 'result.json'),
    JSON.stringify({ title: 'Старый', updated_at: '2026-09-21T10:00:00', status: 'green', summary: 'старый итог', columns: [], rows: [] }),
  );
  const old = new Date(Date.now() - 3600 * 1000);
  utimesSync(join(cab, 'output', 'staryi', 'result.json'), old, old);
  const r = cli(['run', 'staryi']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /не обновился/);
});

test('run: нет такого процесса → код 2 и список процессов; kind claude → код 2 и фраза', () => {
  const none = cli(['run', 'net-takogo']);
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /Такого процесса нет: net-takogo/);
  assert.match(none.out, /svodka-prodazh/);
  const bad = cli(['run', '../tools']);
  assert.equal(bad.code, 2, bad.out);
  const claude = cli(['run', 'pisma']);
  assert.equal(claude.code, 2, claude.out);
  assert.match(claude.out, /фразой в Claude: запусти черновики писем/);
  const empty = cli(['run']);
  assert.equal(empty.code, 2, empty.out);
});

test('list: процессы с названием, папкой, фразой, результатом, последним запуском и ошибками', () => {
  cli(['run', 'svodka-prodazh']);
  const r = cli(['list']);
  assert.equal(r.code, 1, r.out); // есть процессы с ошибкой (krivoy)
  assert.match(r.out, /«Сводка продаж» \(папка svodka-prodazh\)/);
  // Строка программы процесса без слова «скилл»: Sonnet принимал его за «выполни сам».
  assert.match(r.out, /«Сводка продаж» \(папка svodka-prodazh\): программа процесса, кнопка «Запустить», фраза «запусти сводку продаж»\.\n/);
  assert.match(r.out, /Результат: обновлён \d\d\.\d\d\.\d{4} \d\d:\d\d, жёлтый\. Итог: Литров за неделю/);
  assert.match(r.out, /Последний запуск: \d\d\.\d\d\.\d{4} \d\d:\d\d, удачно/);
  assert.match(r.out, /«Черновики писем» \(папка pisma\): выполняет сам Claude по скиллу pisma-postavshchikam, фраза «запусти черновики писем»\./);
  assert.match(r.out, /«Кривой» \(папка krivoy\)[\s\S]*?Ошибка: output\/krivoy\/result\.json: status/);
  // Программа закончилась без ошибки, но карточку не обновила: «удачно» не пишется.
  assert.match(r.out, /«Молчит» \(папка molchit\)[^\n]*\n\s+Результата пока нет\.\n\s+Последний запуск: [^\n]*карточк[^\n]*не обновил/);
  assert.match(r.out, /«Старый» \(папка staryi\)[^\n]*\n[^\n]*\n\s+Последний запуск: [^\n]*не обновил/);
  assert.match(r.out, /«Падает» \(папка padaet\)[\s\S]*?Последний запуск: [^\n]*не удался \(код 2\)/);
  assert.doesNotMatch(r.out, /[\u2012-\u2015]/);
});

test('list: старая страница без карточек (нет render.js) называется отдельной строкой', () => {
  const html = join(cab, 'site', 'index.html');
  const current = readFileSync(html, 'utf8');
  try {
    assert.doesNotMatch(cli(['list']).out, /старой версии/);
    writeFileSync(html, '<!doctype html><body data-cabinet="ok">Кабинет работает</body>');
    assert.match(cli(['list']).out, /^Страница site\/index\.html старой версии: на ней нет карточек процессов\.$/m);
  } finally {
    writeFileSync(html, current);
  }
});

test('list: без процессов → подсказка «добавь процесс», код 0', () => {
  const b = mkdtempSync(join(tmpdir(), 'cli0-'));
  try {
    const root = join(b, 'ai-cabinet');
    copyDir(join(ROOT, 'tools'), join(root, 'tools'));
    const r = spawnSync(process.execPath, [join(root, 'tools', 'processes.mjs'), 'list'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Процессов в кабинете пока нет/);
    assert.match(r.stdout, /«добавь процесс»/);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test('CLI и кнопка не запускают один процесс одновременно: запуск фразой виден странице, кнопка получает 409', async () => {
  await withServer(async (api) => {
    const phrase = cliAsync(['run', 'dolgiy']);
    // Замок создаётся пустым и дописывается: разбираем его, пока не прочитается целиком.
    const lock = await waitFor(() => JSON.parse(readFileSync(lockOf('dolgiy'), 'utf8')), 'замок от CLI');
    assert.equal(lock.pid, phrase.child.pid);
    assert.ok(!Number.isNaN(Date.parse(lock.startedAt)));
    const button = await api.run('dolgiy');
    assert.equal(button.status, 409);
    assert.equal(button.json.code, 'ERUNNING');
    assert.equal((await api.status('dolgiy')).running, true);
    assert.equal((await api.list()).find((p) => p.slug === 'dolgiy').running, true);
    const r = await phrase.done;
    assert.equal(r.code, 0, r.out);
    const st = await api.status('dolgiy');
    assert.equal(st.running, false);
    const last = JSON.parse(readFileSync(lastRunOf('dolgiy'), 'utf8'));
    assert.deepEqual(st.lastRun, last);
    assert.equal(st.lastRun.ok, true);
  });
});

test('кнопка идёт → фраза получает «уже идёт» (код 2) и не трогает журнал', async () => {
  await withServer(async (api) => {
    assert.equal((await api.run('dolgiy')).status, 202);
    assert.equal(existsSync(lockOf('dolgiy')), true);
    const r = cli(['run', 'dolgiy']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /уже идёт/);
    for (let i = 0; i < 200 && (await api.status('dolgiy')).running; i++) await sleep(50);
    const st = await api.status('dolgiy');
    assert.equal(st.running, false);
    assert.equal(st.lastRun.ok, true, readFileSync(join(cab, 'output', 'dolgiy', 'last-run.log'), 'utf8'));
  });
});

test('lastRun переживает перезапуск страницы: новый сервер читает last-run.json', async () => {
  const r = cli(['run', 'padaet']);
  assert.equal(r.code, 1);
  const finishedAt = JSON.parse(readFileSync(lastRunOf('padaet'), 'utf8')).finishedAt;
  await withServer(async (api) => {
    const st = await api.status('padaet');
    assert.equal(st.running, false);
    assert.deepEqual([st.lastRun.ok, st.lastRun.code, st.lastRun.finishedAt], [false, 2, finishedAt]);
  });
  assert.deepEqual(processStatus(cab, 'padaet').lastRun.finishedAt, finishedAt);
});

test('CLI остановили (Ctrl+C, конец команды) → расчёт остановлен, замок снят, last-run.json ok false', { skip: process.platform === 'win32' && 'сигналы на Windows так не доставляются' }, async () => {
  addProcess('zavis', script('zavis', 'Завис'), 'import time\nprint("жду", flush=True)\ntime.sleep(60)\n');
  const run = cliAsync(['run', 'zavis']);
  await waitFor(() => existsSync(lockOf('zavis')) && readFileSync(join(cab, 'output', 'zavis', 'last-run.log'), 'utf8').includes('жду'), 'расчёт начался');
  run.child.kill('SIGTERM');
  const r = await run.done;
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(lockOf('zavis')), false, 'замок остался');
  const last = JSON.parse(readFileSync(lastRunOf('zavis'), 'utf8'));
  assert.equal(last.ok, false);
  assert.match(readFileSync(join(cab, 'output', 'zavis', 'last-run.log'), 'utf8'), /прерван/);
});

test('input: копия файла учебного кейса помечена, свой файл нет', () => {
  const dir = join(cab, 'input', 'na-keyse');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prodazhi.csv'), readFileSync(join(cab, 'input', 'case-azs', 'data', 'sales_azs_1c.csv')));
  writeFileSync(join(dir, 'sales_azs_1c.csv'), 'свой файл с тем же именем\n');
  const r = cli(['input', 'na-keyse', '--no-open']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /prodazhi\.csv \(копия файла учебного кейса sales_azs_1c\.csv\)/);
  assert.match(r.out, /sales_azs_1c\.csv(?! \()/);
  assert.doesNotMatch(r.out, /sales_azs_1c\.csv \(копия/);
});

// Архив zip из членов [[имя, байты]]: время файлов, сжатие и порядок не как у файла кейса. local(имя, данные)
// может подменить сжатые данные и объявленный размер члена (бомба: один поток на все члены).
function zipOf(members, local = null) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  const shared = new Map();
  for (const [nameText, data] of members) {
    const name = Buffer.from(nameText, 'utf8');
    const own = local ? local(nameText, data) : { comp: deflateRawSync(data, { level: 1 }), size: data.length, crc: crc32(data) };
    const fields = (h, at) => {
      h.writeUInt16LE(8, at);
      h.writeUInt16LE(0x6000, at + 2); // 12:00
      h.writeUInt16LE(0x5b57, at + 4); // 23.10.2025
      h.writeUInt32LE(own.crc, at + 6);
      h.writeUInt32LE(own.comp.length, at + 10);
      h.writeUInt32LE(own.size, at + 14);
      h.writeUInt16LE(name.length, at + 18);
    };
    let at = offset;
    if (own.shared && shared.has(own.shared)) at = shared.get(own.shared);
    else {
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      fields(head, 8);
      parts.push(head, name, own.comp);
      if (own.shared) shared.set(own.shared, offset);
      offset += 30 + name.length + own.comp.length;
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    fields(central, 10);
    central.writeUInt32LE(at, 42);
    centrals.push(central, name);
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// Файл кейса, пересобранный заново (как в архиве платформы курса): то же содержимое, другие время файлов
// в zip, сжатие, порядок членов и docProps. change(имя, байты) правит члены архива.
const rezip = (buf, change = (name, data) => data) => zipOf(zipEntries(buf).reverse().map((e) => [e.name, change(e.name, e.read())]));

// Одна ячейка (или абзац) другая: первый знак первого значения в листе или документе.
const oneCell = (member) => (name, data) =>
  name === member ? Buffer.from(data.toString('utf8').replace(/(<(?:v|t|w:t)(?:\s[^>]*)?>)([^<])/, (m, tag, c) => tag + (c === '1' ? '2' : '1'))) : data;
const newProps = (name, data) => (name.startsWith('docProps/') ? Buffer.from(data.toString('utf8').replace(/<\/cp:coreProperties>|<\/Properties>/, '<!-- пересобран -->$&')) : data);

test('input: копия файла кейса из архива платформы (xlsx и docx пересобраны) узнаётся по содержимому, правка ячейки нет', () => {
  const data = join(cab, 'input', 'case-azs', 'data');
  writeFileSync(join(data, 'template_pismo_postavshchiku.docx'), readFileSync(join(ROOT, 'input', 'case-azs', 'data', 'template_pismo_postavshchiku.docx')));
  const dir = join(cab, 'input', 'platforma');
  mkdirSync(dir, { recursive: true });
  const xlsx = readFileSync(join(data, 'reestr_dogovorov.xlsx'));
  const docx = readFileSync(join(data, 'template_pismo_postavshchiku.docx'));
  const files = {
    'reestr s platformy.xlsx': rezip(xlsx, newProps),
    'Реестр правка.xlsx': rezip(xlsx, oneCell('xl/worksheets/sheet1.xml')),
    'pismo s platformy.docx': rezip(docx, newProps),
    'Письмо правка.docx': rezip(docx, oneCell('word/document.xml')),
    'reestr.csv': xlsx, // то же содержимое, другое расширение: только байт в байт с файлом кейса того же вида
  };
  for (const [name, buf] of Object.entries(files)) writeFileSync(join(dir, name), buf);
  assert.notDeepEqual(files['reestr s platformy.xlsx'], xlsx);
  const r = cli(['input', 'platforma', '--no-open']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /reestr s platformy\.xlsx \(копия файла учебного кейса reestr_dogovorov\.xlsx\)/);
  assert.match(r.out, /pismo s platformy\.docx \(копия файла учебного кейса template_pismo_postavshchiku\.docx\)/);
  for (const own of ['Реестр правка.xlsx', 'Письмо правка.docx']) {
    assert.ok(r.out.includes(own), r.out);
    assert.ok(!r.out.includes(`${own} (копия`), `${own}: правка ячейки, это не копия кейса`);
  }
  assert.match(r.out, /reestr\.csv \(копия файла учебного кейса reestr_dogovorov\.xlsx\)/); // байт в байт: как раньше
});

test('input: копия кейса с лимитами: бомба zip, битый файл, повтор имени члена не копия, команда не падает', () => {
  const data = join(cab, 'input', 'case-azs', 'data');
  const dir = join(cab, 'input', 'bomby');
  mkdirSync(dir, { recursive: true });
  const xlsx = readFileSync(join(data, 'reestr_dogovorov.xlsx'));
  const members = zipEntries(xlsx).map((e) => [e.name, e.read()]);
  const zeros = deflateRawSync(Buffer.alloc(5 * 1024 * 1024 - 1), { level: 9 });
  const bomb = (size) => () => ({ comp: zeros, size, crc: 0, shared: 'zeros' });
  // Проба ревью: 1500 членов на одном потоке в 5 МБ (раньше 2 ГБ в памяти и падение).
  const many = Array.from({ length: 1500 }, (_, k) => [String(k).padStart(6, '0'), Buffer.alloc(0)]);
  writeFileSync(join(dir, 'bomba.xlsx'), zipOf(many, bomb(5 * 1024 * 1024 - 1)));
  // Оглавление как у файла кейса (те же имена и размеры), а каждый член распаковывается в 5 МБ нулей.
  writeFileSync(join(dir, 'bomba kak reestr.xlsx'), zipOf(members, (name, d) => bomb(d.length)()));
  // Больше 2000 членов: не копия, даже без распаковки.
  writeFileSync(join(dir, 'mnogo chlenov.xlsx'), zipOf(Array.from({ length: 2001 }, (_, k) => [`m${k}`, Buffer.from('x')])));
  writeFileSync(join(dir, 'bityi.xlsx'), xlsx.subarray(0, Math.floor(xlsx.length / 2)));
  writeFileSync(join(dir, 'ne zip.docx'), 'просто текст');
  // Повтор имени: первым свой лист, за ним лист кейса с тем же именем. Excel откроет первый.
  const sheet = members.find(([name]) => name === 'xl/worksheets/sheet1.xml');
  writeFileSync(join(dir, 'povtor.xlsx'), zipOf([[sheet[0], Buffer.from(sheet[1].toString('utf8').replace('<sheetData>', '<sheetData><!-- свой -->'))], ...members]));
  const started = Date.now();
  const r = cli(['input', 'bomby', '--no-open']);
  assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - started < 10000, `долго: ${Date.now() - started} мс`);
  for (const name of ['bomba.xlsx', 'bomba kak reestr.xlsx', 'mnogo chlenov.xlsx', 'bityi.xlsx', 'ne zip.docx', 'povtor.xlsx']) {
    assert.ok(r.out.includes(name), `${name}: ${r.out}`);
    assert.ok(!r.out.includes(`${name} (копия`), `${name}: не копия кейса`);
  }
});

test('без трейсбека: неожиданная ошибка даёт короткую русскую строку и код 2; имена вроде constructor не ломают demo', () => {
  writeFileSync(join(cab, 'input', 'fayl-a-ne-papka'), 'x');
  const r = cli(['input', 'fayl-a-ne-papka', '--no-open']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /^Не удалось выполнить/m);
  assert.doesNotMatch(r.out, /\n\s+at /);
  for (const name of ['constructor', '__proto__', 'toString']) {
    const d = cli(['demo', name]);
    assert.equal(d.code, 2, `${name}: ${d.out}`);
    assert.match(d.out, /Такого демо нет/);
    assert.doesNotMatch(d.out, /\n\s+at /);
  }
});

test('input: создаёт input/<slug>, печатает полный путь и файлы; неверное имя → код 2', () => {
  const r = cli(['input', 'svodka-prodazh', '--no-open']);
  assert.equal(r.code, 0, r.out);
  const dir = join(cab, 'input', 'svodka-prodazh');
  assert.ok(statSync(dir).isDirectory());
  // Полный путь, как его увидит человек. Сравнение настоящих путей: временная папка Windows бывает короткой (RUNNER~1).
  const printed = r.out.match(/^Папка создана: (.+)$/m)?.[1];
  assert.ok(printed, r.out);
  assert.equal(realpathSync.native(printed), realpathSync.native(dir));
  assert.match(r.out, /Файлов в ней пока нет/);
  writeFileSync(join(dir, 'sales_week.csv'), 'АЗС;Литры\n');
  const again = cli(['input', 'svodka-prodazh', '--no-open']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /уже есть/);
  assert.match(again.out, /sales_week\.csv/);
  for (const bad of ['Svodka', '../me', 'a/b', '']) {
    const x = cli(['input', bad, '--no-open']);
    assert.equal(x.code, 2, `${bad}: ${x.out}`);
  }
  assert.equal(existsSync(join(cab, 'me')), false);
});

const hasOpenpyxl = () => {
  for (const py of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(py, ['-c', 'import openpyxl'], { encoding: 'utf8' });
    if (r.status === 0) return true;
  }
  return false;
};

test('demo: ставит процесс курса, кладёт копию файла кейса и считает эталон 25/3/3/2/1/16', { skip: !hasOpenpyxl() && 'нет openpyxl' }, () => {
  const r = cli(['demo', 'svetofor-dogovorov']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /поставлен в processes\/svetofor-dogovorov/);
  assert.match(r.out, /input\/svetofor-dogovorov\/reestr_dogovorov\.xlsx/);
  assert.match(r.out, /^Готово: «Светофор договоров»/m);
  assert.ok(existsSync(join(cab, 'processes', 'svetofor-dogovorov', 'run.py')));
  assert.equal(existsSync(join(cab, 'processes', 'svetofor-dogovorov', '__pycache__')), false);
  assert.deepEqual(
    readFileSync(join(cab, 'input', 'svetofor-dogovorov', 'reestr_dogovorov.xlsx')),
    readFileSync(join(cab, 'input', 'case-azs', 'data', 'reestr_dogovorov.xlsx')),
  );
  const res = JSON.parse(readFileSync(join(cab, 'output', 'svetofor-dogovorov', 'result.json'), 'utf8'));
  const count = {};
  for (const s of res.row_status) count[s] = (count[s] ?? 0) + 1;
  assert.equal([res.rows.length, count.red, count.yellow, count.grey, count.info, count.green].join('/'), '25/3/3/2/1/16');
  // Второй показ: ничего не копирует заново и считает снова.
  const again = cli(['demo', 'svetofor-dogovorov']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /уже стоит/);
  assert.match(again.out, /Готово/);
});

test('demo: в input лежит другой файл с именем файла кейса → честно говорит и не считает', () => {
  const b = mkdtempSync(join(tmpdir(), 'cli-demo2-'));
  try {
    const root = join(b, 'ai-cabinet');
    copyDir(join(ROOT, 'tools'), join(root, 'tools'));
    copyDir(join(ROOT, 'templates', 'processes'), join(root, 'templates', 'processes'));
    rmSync(join(root, 'templates', 'processes', 'svetofor-dogovorov', '__pycache__'), { recursive: true, force: true });
    mkdirSync(join(root, 'input', 'case-azs', 'data'), { recursive: true });
    writeFileSync(join(root, 'input', 'case-azs', 'data', 'reestr_dogovorov.xlsx'), readFileSync(join(ROOT, 'input', 'case-azs', 'data', 'reestr_dogovorov.xlsx')));
    mkdirSync(join(root, 'input', 'svetofor-dogovorov'), { recursive: true });
    writeFileSync(join(root, 'input', 'svetofor-dogovorov', 'reestr_dogovorov.xlsx'), 'мой реестр');
    const r = spawnSync(process.execPath, [join(root, 'tools', 'processes.mjs'), 'demo', 'svetofor-dogovorov'], { cwd: root, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 2, out);
    assert.match(out, /не совпадает с файлом учебного кейса/);
    assert.doesNotMatch(out, /Готово|Копия файла учебного кейса/);
    assert.equal(readFileSync(join(root, 'input', 'svetofor-dogovorov', 'reestr_dogovorov.xlsx'), 'utf8'), 'мой реестр');
    assert.equal(existsSync(join(root, 'output', 'svetofor-dogovorov')), false, 'расчёт запускался');
    assert.equal(existsSync(join(root, 'processes', 'svetofor-dogovorov')), false, 'демо поставлено');
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test('demo: свой процесс с тем же именем не перезаписывается; неизвестное демо → код 2', () => {
  const b = mkdtempSync(join(tmpdir(), 'cli-demo-'));
  try {
    const root = join(b, 'ai-cabinet');
    copyDir(join(ROOT, 'tools'), join(root, 'tools'));
    copyDir(join(ROOT, 'templates', 'processes'), join(root, 'templates', 'processes'));
    mkdirSync(join(root, 'input', 'case-azs', 'data'), { recursive: true });
    writeFileSync(join(root, 'input', 'case-azs', 'data', 'reestr_dogovorov.xlsx'), 'x');
    mkdirSync(join(root, 'processes', 'svetofor-dogovorov'), { recursive: true });
    writeFileSync(join(root, 'processes', 'svetofor-dogovorov', 'run.py'), 'print("мой светофор")\n');
    const run = (args) => spawnSync(process.execPath, [join(root, 'tools', 'processes.mjs'), ...args], { cwd: root, encoding: 'utf8' });
    const own = run(['demo', 'svetofor-dogovorov']);
    assert.equal(own.status, 2, own.stdout + own.stderr);
    assert.match(own.stdout + own.stderr, /свой процесс/);
    assert.equal(readFileSync(join(root, 'processes', 'svetofor-dogovorov', 'run.py'), 'utf8'), 'print("мой светофор")\n');
    assert.equal(existsSync(join(root, 'input', 'svetofor-dogovorov')), false);
    const unknown = run(['demo', 'net-takogo']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stdout + unknown.stderr, /svetofor-dogovorov/);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test('без команды: подсказка по командам', () => {
  const r = cli([]);
  assert.equal(r.code, 0, r.out);
  for (const c of ['list', 'run', 'input', 'demo']) assert.match(r.out, new RegExp(`processes\\.mjs ${c}`));
});

// V13a. versions <имя>: прежние версии программы и словаря из output/<имя>/versions/, только чтение.
test('versions: без версий, три версии от новой к старой с разницей слов словаря, неверное имя и чужой процесс отказ', () => {
  addProcess('razbor', script('razbor', 'Разбор обращений'), 'print(1)\nprint(2)\n');
  const slovar = (o) => JSON.stringify(o, null, 2);
  writeFileSync(join(cab, 'processes', 'razbor', 'slovar.json'), slovar({ оплата: ['касса?', 'терминал', 'kaspi'], лояльность: ['бонус', 'баллы', 'карта лояльности'] }));
  const none = cli(['versions', 'razbor']);
  assert.equal(none.code, 0, none.out);
  assert.equal(none.out.trim(), 'Прошлых версий у процесса Разбор обращений нет: они появляются, когда программу или словарь меняют.');

  const V = join(cab, 'output', 'razbor', 'versions');
  const put = (stamp, files) => {
    mkdirSync(join(V, stamp), { recursive: true });
    for (const [n, t] of Object.entries(files)) writeFileSync(join(V, stamp, n), t);
  };
  put('2026-10-20-090000', { 'slovar.json': slovar({ оплата: ['касса?', 'наличные'] }), 'run.py': 'print(1)\n' });
  put('2026-10-23-140512', { 'slovar.json': slovar({ оплата: ['касса?', 'терминал'], лояльность: ['бонус'] }), '.razgovor': 'x' });
  put('2026-10-22-101500', { 'run.py': 'print(1)\r\nprint(2)\r\n' });
  mkdirSync(join(V, 'zametki'));
  writeFileSync(join(V, 'readme.txt'), 'x');

  const r = cli(['versions', 'razbor']);
  assert.equal(r.code, 0, r.out);
  const lines = r.out.trim().split('\n');
  assert.equal(lines[0], 'Прошлые версии процесса «Разбор обращений» (папка output/razbor/versions): 3, от новой к старой.');
  const order = ['23.10.2026 14:05', '22.10.2026 10:15', '20.10.2026 09:00'].map((t) => r.out.indexOf(t));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), r.out);
  assert.ok(lines.includes('1. 23.10.2026 14:05, папка output/razbor/versions/2026-10-23-140512: словарь.'), r.out);
  assert.ok(lines.includes('   Словарь, слов по темам: оплата 2, лояльность 1 (всего 3).'), r.out);
  assert.ok(lines.includes('   Если вернуть словарь: уйдут слова «kaspi» (оплата), «баллы» (лояльность), «карта лояльности» (лояльность).'), r.out);
  assert.ok(lines.includes('2. 22.10.2026 10:15, папка output/razbor/versions/2026-10-22-101500: программа.'), r.out);
  assert.ok(lines.includes('   Программа, строк: 2, совпадает с текущей.'), r.out);
  assert.ok(lines.includes('3. 20.10.2026 09:00, папка output/razbor/versions/2026-10-20-090000: словарь, программа.'), r.out);
  assert.ok(
    lines.includes('   Если вернуть словарь: уйдут слова «терминал» (оплата), «kaspi» (оплата), «бонус» (лояльность), «баллы» (лояльность), «карта лояльности» (лояльность); вернутся слова «наличные» (оплата).'),
    r.out,
  );
  assert.ok(lines.includes('   Программа, строк: 1, отличается от текущей (в текущей строк: 2).'), r.out);
  assert.equal(
    lines.at(-1),
    'Последняя версия, которая отличается от текущей: 1 (23.10.2026 14:05). Вернуть: output/razbor/versions/2026-10-23-140512/slovar.json → processes/razbor/slovar.json (текст: node tools/processes.mjs versions razbor --show 2026-10-23-140512 slovar.json).',
  );
  assert.doesNotMatch(r.out, /zametki|readme|razgovor/);

  // Словарь уже вернули к версии 1: она совпадает с текущим, вернуть можно только версию 3 (версия 2 тоже совпадает).
  writeFileSync(join(cab, 'processes', 'razbor', 'slovar.json'), JSON.stringify({ оплата: ['касса?', 'терминал'], лояльность: ['бонус'] }));
  const back = cli(['versions', 'razbor']);
  assert.equal(back.code, 0, back.out);
  assert.ok(back.out.includes('   Словарь совпадает с текущим.'), back.out);
  assert.equal(
    back.out.trim().split('\n').at(-1),
    'Последняя версия, которая отличается от текущей: 3 (20.10.2026 09:00). Вернуть: output/razbor/versions/2026-10-20-090000/slovar.json → processes/razbor/slovar.json (текст: node tools/processes.mjs versions razbor --show 2026-10-20-090000 slovar.json), output/razbor/versions/2026-10-20-090000/run.py → processes/razbor/run.py.',
  );

  for (const bad of ['..', '../me', 'Razbor', 'a/b', '']) {
    const x = cli(['versions', bad]);
    assert.equal(x.code, 2, `${bad}: ${x.out}`);
    assert.doesNotMatch(x.out, /\n\s+at /);
  }
  assert.match(cli(['versions', 'net-takogo']).out, /Такого процесса нет: net-takogo/);
});

test('versions: показывает не больше 5 версий; все совпадают с текущими: возвращать нечего; программа из версии проходит проверку', () => {
  addProcess('pyat', script('pyat', 'Пять'), 'print(1)\n');
  const V = join(cab, 'output', 'pyat', 'versions');
  for (let d = 1; d <= 7; d++) {
    mkdirSync(join(V, `2026-10-0${d}-120000`), { recursive: true });
    writeFileSync(join(V, `2026-10-0${d}-120000`, 'run.py'), 'print(1)\n');
  }
  const r = cli(['versions', 'pyat']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /: 7, от новой к старой, показаны 5 последних\./);
  assert.equal(r.out.split('\n').filter((l) => /^\d+\. /.test(l)).length, 5);
  assert.ok(r.out.includes('07.10.2026 12:00') && !r.out.includes('02.10.2026 12:00'), r.out);
  assert.equal(r.out.trim().split('\n').at(-1), 'Все сохранённые версии совпадают с текущими файлами процесса: возвращать нечего.');
  // Программа из версии, возвращённая записью в processes/, проходит ту же проверку сверки.
  writeFileSync(join(V, '2026-10-01-120000', 'run.py'), 'import subprocess\nprint(1)\n');
  writeFileSync(join(cab, 'processes', 'pyat', 'run.py'), readFileSync(join(V, '2026-10-01-120000', 'run.py')));
  const c = cli(['compare', 'pyat']);
  assert.match(c.out, /строка 1: запуск программ или выход в сеть: import subprocess/);
  assert.match(c.out, /Итог проверки программы: уберите это из программы, «готово» нельзя\./);
});

test('versions --show: файл версии целиком, JSON по строкам с отступом 2; неверная папка, файл, имя: отказ', () => {
  addProcess('pokaz', script('pokaz', 'Показ'), 'print(1)\n');
  const V = join(cab, 'output', 'pokaz', 'versions', '2026-10-23-140512');
  mkdirSync(V, { recursive: true });
  const big = {};
  for (let t = 0; t < 10; t++) big[`тема ${t}`] = Array.from({ length: 50 }, (_, i) => `слово${t}-${i}`);
  big['срочно (не тема)'] = ['пролил', 'запах бенз'];
  const oneLine = JSON.stringify(big);
  assert.ok(oneLine.length > 5000);
  writeFileSync(join(V, 'slovar.json'), `\uFEFF${oneLine}`);
  writeFileSync(join(V, 'process.json'), '{"title":"Показ старый","phrase":"запусти показ","kind":"script"}');
  writeFileSync(join(V, 'run.py'), 'print(1)\r\nprint(2)\r\n');
  const r = cli(['versions', 'pokaz', '--show', '2026-10-23-140512', 'slovar.json']);
  assert.equal(r.code, 0, r.out);
  const lines = r.out.replace(/\n$/, '').split('\n');
  assert.ok(Math.max(...lines.map((l) => l.length)) < 100, 'строки короткие');
  assert.equal(lines[1], '  "тема 0": [');
  assert.deepEqual(JSON.parse(r.out), big);
  const p = cli(['versions', 'pokaz', '--show', '2026-10-23-140512', 'process.json']);
  assert.deepEqual(JSON.parse(p.out), { title: 'Показ старый', phrase: 'запусти показ', kind: 'script' });
  assert.match(p.out, /^\{\n  "title": "Показ старый",/);
  assert.equal(cli(['versions', 'pokaz', '--show', '2026-10-23-140512', 'run.py']).out, 'print(1)\nprint(2)\n');
  for (const args of [
    ['pokaz', '--show', '2026-10-26-140513', 'slovar.json'],
    ['pokaz', '--show', '../../processes', 'slovar.json'],
    ['pokaz', '--show', '2026-10-23-140512', '../../../CLAUDE.md'],
    ['pokaz', '--show', '2026-10-23-140512', 'etalon-skilla.json'],
    ['pokaz', '--show'],
    ['..', '--show', '2026-10-23-140512', 'slovar.json'],
  ]) {
    const x = cli(['versions', ...args]);
    assert.equal(x.code, 2, `${args.join(' ')}: ${x.out}`);
    assert.doesNotMatch(x.out, /\n\s+at /);
  }
  // Испорченный JSON не показывается: вернуть его нельзя.
  writeFileSync(join(V, 'slovar.json'), '{"тема": ["слово",');
  const broken = cli(['versions', 'pokaz', '--show', '2026-10-23-140512', 'slovar.json']);
  assert.equal(broken.code, 2, broken.out);
  assert.match(broken.out, /испорчен/);
  // Описание процесса в списке версий: что вернётся.
  const list = cli(['versions', 'pokaz']);
  assert.ok(list.out.includes('   Описание процесса: отличается от текущего: вернётся название «Показ старый» (сейчас «Показ»).'), list.out);
  assert.match(list.out, /Вернуть: .*process\.json → processes\/pokaz\/process\.json \(текст: node tools\/processes\.mjs versions pokaz --show 2026-10-23-140512 process\.json\)/);
});

test('versions: папка с временем позже текущего не считается новой, идёт в конец списка', () => {
  addProcess('budushchee', script('budushchee', 'Будущее'), 'print(1)\n');
  writeFileSync(join(cab, 'processes', 'budushchee', 'slovar.json'), JSON.stringify({ оплата: ['касса?'] }));
  const V = join(cab, 'output', 'budushchee', 'versions');
  for (const [s, words] of [['2099-01-01-000000', ['наличные']], ['2026-10-20-090000', ['терминал']]]) {
    mkdirSync(join(V, s), { recursive: true });
    writeFileSync(join(V, s, 'slovar.json'), JSON.stringify({ оплата: words }));
  }
  const r = cli(['versions', 'budushchee']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.indexOf('20.10.2026 09:00') < r.out.indexOf('01.01.2099 00:00'), r.out);
  assert.match(r.out.trim().split('\n').at(-1), /^Последняя версия, которая отличается от текущей: 1 \(20\.10\.2026 09:00\)/);
});
