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
import { processStatus } from '../processes.mjs';

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
  const done = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal, out })));
  return { child, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockOf = (slug) => join(cab, 'output', slug, '.running');
const lastRunOf = (slug) => join(cab, 'output', slug, 'last-run.json');

async function waitFor(check, what, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
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
    await waitFor(() => existsSync(lockOf('dolgiy')), 'замок от CLI');
    const lock = JSON.parse(readFileSync(lockOf('dolgiy'), 'utf8'));
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
