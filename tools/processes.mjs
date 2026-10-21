// Процессы участника: папки processes/<slug>/ с process.json и, для kind "script", run.py. Без зависимостей.
// Результат процесса лежит в output/<slug>/result.json, страница «Мой кабинет» рисует его карточкой.
// Запуск: только processes/<slug>/run.py этого кабинета, из корня кабинета, без аргументов,
// своим Python (абсолютный путь вне кабинета), по одному запуску на процесс и не больше двух на кабинет,
// не дольше timeoutMs, журнал output/<slug>/last-run.log не больше 20 МБ.
// Кнопка на странице и фраза в Claude (node tools/processes.mjs run <slug>) запускают одно и то же:
// замок output/<slug>/.running и итог последнего запуска output/<slug>/last-run.json общие для обоих.
//
//   node tools/processes.mjs list            процессы, результат и последний запуск
//   node tools/processes.mjs run <slug>      запуск, как кнопкой «Запустить»
//   node tools/processes.mjs input <slug>    папка input/<slug> для файлов человека, открывается в Проводнике
//   node tools/processes.mjs demo <slug>     демо курса из templates/processes с файлом учебного кейса
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const SLUG_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_CONCURRENT = 2;
export const LOG_LIMIT_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 5000;
const LOG_CHECK_MS = 200;
// Замок старше своего ограничения времени с этим запасом считается брошенным.
const STALE_MARGIN_MS = 60 * 1000;
export const LOCK_FILE = '.running';
export const LAST_RUN_FILE = 'last-run.json';
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const TASKKILL = join(SYSTEM_ROOT, 'System32', 'taskkill.exe');

const KINDS = ['script', 'claude'];
const STATUSES = ['green', 'yellow', 'red'];
const ROW_STATUSES = [...STATUSES, 'grey', 'info'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// path лежит внутри dir. На Windows регистр букв в путях не важен, поэтому сравнение без него.
export function isInside(path, dir, platform = process.platform) {
  const win = platform === 'win32';
  const norm = (p) => (win ? p.toLowerCase() : p);
  return norm(path).startsWith(norm(dir) + (win ? '\\' : '/'));
}
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function processError(code, message) {
  return Object.assign(new Error(message), { code });
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export const hasProcess = (root, slug) =>
  typeof slug === 'string' && SLUG_RE.test(slug) && isDir(join(root, 'processes', slug));

// process.json: { title, phrase, kind, input, output }. missing: файла нет; error: файл есть, но не годится.
function readProcessInfo(root, slug) {
  const rel = `processes/${slug}/process.json`;
  let data;
  try {
    data = readJson(join(root, 'processes', slug, 'process.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return { title: slug, phrase: '', kind: null, missing: true, error: `нет файла ${rel}` };
    return { title: slug, phrase: '', kind: null, error: `файл ${rel} повреждён или не в формате JSON` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { title: slug, phrase: '', kind: null, error: `в файле ${rel} нужен объект JSON` };
  }
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : slug;
  const phrase = typeof data.phrase === 'string' ? data.phrase.trim() : '';
  if (!KINDS.includes(data.kind)) {
    return { title, phrase, kind: null, error: `${rel}: kind должен быть script или claude` };
  }
  return { title, phrase, kind: data.kind, error: null };
}

const isCell = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

// Путь файла результата: output/<slug>/..., без выхода наверх. Обратную косую черту (Windows) принимаем.
export function isOutputPath(path, slug) {
  if (typeof path !== 'string') return false;
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length < 3 || parts[0] !== 'output') return false;
  if (slug ? parts[1] !== slug : !SLUG_RE.test(parts[1])) return false;
  return parts.every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes(':'));
}

// Схема result.json. slug (необязательно) проверяет, что файлы лежат в output/<slug>/.
export function validateResult(obj, slug) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['результат должен быть объектом JSON с полями title, updated_at, status, summary, columns, rows'] };
  }
  const errors = [];
  if (typeof obj.title !== 'string' || !obj.title.trim()) errors.push('title: нужно название процесса строкой');
  if (typeof obj.updated_at !== 'string' || !ISO_RE.test(obj.updated_at) || Number.isNaN(Date.parse(obj.updated_at))) {
    errors.push('updated_at: нужны дата и время в формате ISO, например 2026-09-21T10:30:00');
  }
  if (!STATUSES.includes(obj.status)) errors.push('status: нужно green, yellow или red');
  if (typeof obj.summary !== 'string') errors.push('summary: нужен итог строкой');
  const columnsOk = Array.isArray(obj.columns) && obj.columns.every((c) => typeof c === 'string');
  if (!columnsOk) errors.push('columns: нужен список названий столбцов (может быть пустым)');
  if (!Array.isArray(obj.rows)) {
    errors.push('rows: нужен список строк (может быть пустым)');
  } else if (columnsOk) {
    const bad = obj.rows.findIndex((r) => !Array.isArray(r) || r.length !== obj.columns.length || !r.every(isCell));
    if (bad !== -1) {
      errors.push(`rows: в строке ${bad + 1} нужно ${obj.columns.length} значений по числу столбцов (текст, число или null)`);
    }
  }
  const perRow = (field, good, hint) => {
    const v = obj[field];
    if (v === undefined) return;
    if (!Array.isArray(v) || (Array.isArray(obj.rows) && v.length !== obj.rows.length)) {
      errors.push(`${field}: нужен список той же длины, что rows`);
    } else if (!v.every(good)) {
      errors.push(`${field}: допустимые значения ${hint}`);
    }
  };
  perRow('row_status', (v) => ROW_STATUSES.includes(v), 'green, yellow, red, grey, info');
  perRow('row_note', (v) => v === null || typeof v === 'string', 'текст или null');
  if (obj.files !== undefined) {
    if (!Array.isArray(obj.files)) {
      errors.push('files: нужен список путей к файлам');
    } else {
      const bad = obj.files.find((f) => !isOutputPath(f, slug));
      if (bad !== undefined) errors.push(`files: путь ${JSON.stringify(bad)} должен вести в папку output/${slug ?? '<процесс>'}/`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function readResult(root, slug) {
  const rel = `output/${slug}/result.json`;
  let data;
  try {
    data = readJson(join(root, 'output', slug, 'result.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return { result: null, error: null };
    return { result: null, error: `файл ${rel} повреждён или не в формате JSON` };
  }
  const v = validateResult(data, slug);
  return v.ok ? { result: data, error: null } : { result: null, error: `${rel}: ${v.errors.join('; ')}` };
}

function describe(root, slug) {
  if (!SLUG_RE.test(slug)) {
    return {
      slug,
      title: slug,
      phrase: '',
      kind: null,
      result: null,
      error: `папка processes/${slug}: в имени нужны строчные латинские буквы, цифры и дефис, до 40 знаков`,
      running: false,
    };
  }
  const info = readProcessInfo(root, slug);
  const errors = [info.error];
  if (info.kind === 'script' && !isFile(join(root, 'processes', slug, 'run.py'))) {
    errors.push(`нет файла processes/${slug}/run.py`);
  }
  const res = readResult(root, slug);
  errors.push(res.error);
  return {
    slug,
    title: info.title,
    phrase: info.phrase,
    kind: info.kind,
    result: res.result,
    error: errors.filter(Boolean).join('; ') || null,
    running: isRunning(root, slug),
  };
}

export function listProcesses(root) {
  let entries;
  try {
    entries = readdirSync(join(root, 'processes'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith('.') && isDir(join(root, 'processes', e.name)))
    .map((e) => describe(root, e.name))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

// Замок запуска output/<slug>/.running: { pid, startedAt, timeoutMs, id }. Его создаёт тот, кто запускает
// (страница или node tools/processes.mjs), атомарно (flag wx), и снимает по окончании. Брошенный замок
// (процесса с этим pid нет или запуск идёт дольше своего срока с запасом) не мешает новому запуску.
const lockPath = (root, slug) => join(root, 'output', slug, LOCK_FILE);

function pidAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readLock(file) {
  let mtimeMs, text;
  try {
    mtimeMs = statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Замок пишется прямо сейчас или повреждён: судим по времени файла.
  }
  return { data: data && typeof data === 'object' ? data : {}, mtimeMs };
}

function isStale({ data, mtimeMs }, now = Date.now()) {
  if (Number.isInteger(data.pid) && data.pid > 0 && !pidAlive(data.pid)) return true;
  const started = Date.parse(data.startedAt);
  const since = Number.isFinite(started) ? started : mtimeMs;
  const limit = (Number.isFinite(data.timeoutMs) ? data.timeoutMs : DEFAULT_TIMEOUT_MS) + KILL_GRACE_MS + STALE_MARGIN_MS;
  return now - since > limit;
}

function isRunning(root, slug) {
  const lock = readLock(lockPath(root, slug));
  return Boolean(lock) && !isStale(lock);
}

function acquireLock(root, slug, timeoutMs) {
  const file = lockPath(root, slug);
  const lock = { pid: process.pid, startedAt: new Date().toISOString(), timeoutMs, id: randomBytes(8).toString('hex') };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(lock), { flag: 'wx' });
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readLock(file);
      if (held && !isStale(held)) break;
      rmSync(file, { force: true });
    }
  }
  throw processError('ERUNNING', 'Этот процесс уже идёт. Дождитесь, пока обновится время на карточке.');
}

// Снимаем только свой замок: брошенный мог быть снят и занят другим запуском.
function releaseLock(root, slug, lock) {
  const file = lockPath(root, slug);
  if (readLock(file)?.data.id === lock.id) rmSync(file, { force: true });
}

// Сколько других процессов кабинета сейчас считается (по замкам: и с этой страницы, и из Claude).
function runningInCabinet(root, except) {
  let entries;
  try {
    entries = readdirSync(join(root, 'output'), { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((e) => e.isDirectory() && e.name !== except && SLUG_RE.test(e.name) && isRunning(root, e.name)).length;
}

// Итог последнего запуска output/<slug>/last-run.json: { ok, code, finishedAt, durationMs }.
// Пишется через временный файл: страница не прочитает половину.
function writeLastRun(root, slug, data) {
  const file = join(root, 'output', slug, LAST_RUN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(data, null, 2) + '\n';
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
      writeFileSync(file, text);
    } catch {
      // Не записался: карточка всё равно покажет время из result.json.
    }
  }
}

function readLastRun(root, slug) {
  try {
    const d = readJson(join(root, 'output', slug, LAST_RUN_FILE));
    if (d && typeof d.ok === 'boolean' && typeof d.finishedAt === 'string' && (d.code === null || Number.isInteger(d.code))) {
      const run = { ok: d.ok, code: d.code, finishedAt: d.finishedAt };
      if (Number.isFinite(d.durationMs)) run.durationMs = d.durationMs;
      return run;
    }
  } catch {
    // нет файла или он повреждён: последнего запуска не знаем
  }
  return null;
}

export function processStatus(root, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return { running: false, lastRun: null };
  return { running: isRunning(root, slug), lastRun: readLastRun(root, slug) };
}

// Проверки до запуска. Ошибки с кодом: страница превращает его в ответ (404, 400, 403, 409).
// Возвращает настоящий путь run.py: запускается именно он, подменить файл после проверки нельзя.
function checkRunnable(root, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw processError('EBADSLUG', 'Такого процесса нет.');
  const info = readProcessInfo(root, slug);
  if (info.missing) throw processError('ENOPROCESS', `Такого процесса нет: ${slug}.`);
  if (info.error) throw processError('EBADPROCESS', `Процесс не запускается: ${info.error}.`);
  if (info.kind === 'claude') {
    throw processError('ECLAUDE', `этот процесс запускается фразой в Claude: ${info.phrase || info.title}`);
  }
  // run.py должен по-настоящему лежать в папке processes этого кабинета: ссылка наружу не запускается,
  // и сама папка processes, ведущая в другое место, тоже. Граница считается от настоящего пути кабинета.
  let base, file;
  try {
    base = join(realpathSync(root), 'processes');
    file = realpathSync(join(root, 'processes', slug, 'run.py'));
  } catch {
    throw processError('ENORUN', `Нет файла processes/${slug}/run.py.`);
  }
  if (!isInside(file, base)) {
    throw processError('EOUTSIDE', `Файл processes/${slug}/run.py ведёт за пределы папки processes, такой процесс не запускается.`);
  }
  if (!isFile(file)) throw processError('ENORUN', `Нет файла processes/${slug}/run.py.`);
  return file;
}

// Python ищется из папки вне кабинета: Windows ищет программу сначала в текущей папке, и python.exe
// или python.bat, подложенные в кабинет, нашлись бы раньше настоящего.
const outsideCwd = () => (process.platform === 'win32' ? SYSTEM_ROOT : dirname(process.execPath));

function isOutsideCabinet(exe, root) {
  if (typeof exe !== 'string' || !exe || !isAbsolute(exe)) return false;
  let real = exe;
  try {
    real = realpathSync(exe);
  } catch {
    // Псевдоним программы (Microsoft Store) может не раскрываться: проверяем путь как есть.
  }
  let top = resolve(root);
  try {
    top = realpathSync(root);
  } catch {
    // кабинета нет: сравниваем с путём как есть
  }
  return ![exe, real].some((p) => samePath(p, top) || isInside(p, top) || isInside(p, resolve(root)));
}

// Путь к Python из вывода пробы: последняя непустая строка, строка JSON. Юникод в пути приходит
// экранированным (\uXXXX), поэтому кодовая страница канала его не искажает. Не строка JSON: null.
export function parseExecutable(out) {
  const line = String(out ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return null;
  try {
    const value = JSON.parse(line);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

// Абсолютный путь к Python: тот же выбор, что в проверке сетапа (python или py -3 на Windows, python3 или python
// на остальных), затем sys.executable. Путь принимается, только если это файл вне кабинета. null: подходящего нет.
// Проба печатает путь через json.dumps (только ASCII) в UTF-8: на Windows Python пишет в канал в кодовой
// странице ANSI, и профиль «Айгуль Н» или казахские буквы иначе превращаются в мусор или в ошибку.
export async function resolvePython(root) {
  const { defaultExec, detectPython } = await import('./check.mjs');
  const cwd = outsideCwd();
  const exec = (cmd, args, o = {}) => defaultExec(cmd, args, { ...o, cwd });
  const py = await detectPython(exec, process.platform);
  if (!py) return null;
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const r = await exec(py.cmd, [...py.pre, '-c', 'import json, sys; print(json.dumps(sys.executable))'], { timeout: 15000, env });
  const exe = r.code === 0 ? parseExecutable(r.stdout) : null;
  return exe && isFile(exe) && isOutsideCabinet(exe, root) ? exe : null;
}

let foundPython = null;

async function findPython(root) {
  if (foundPython && isFile(foundPython) && isOutsideCabinet(foundPython, root)) return foundPython;
  const exe = await resolvePython(root);
  foundPython = exe;
  return exe;
}

// Python не запустился по запомненному пути: забываем путь, следующий запуск найдёт Python заново.
function forgetPython(exe) {
  if (foundPython === exe) foundPython = null;
}

// На Windows дерево процессов останавливает taskkill (полный путь: не из папки кабинета), на остальных
// системах вся группа процессов. Не вышло: останавливаем хотя бы сам процесс.
function killTree(child) {
  if (process.platform === 'win32') {
    const k = spawn(TASKKILL, ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
    k.on('exit', (code) => {
      if (code !== 0) child.kill();
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

const humanTime = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} мин` : `${Math.round(ms / 1000)} с`);

function writeLine(fd, text) {
  try {
    writeSync(fd, `\n${text}\n`);
  } catch {
    // Лог не пишется: результат запуска всё равно попадёт в статус.
  }
}

function spawnRun(root, exe, runFile, fd, logPath, opts) {
  const { timeoutMs, logLimitBytes, killGraceMs, stopTree, control } = opts;
  return new Promise((done) => {
    let settled = false;
    let stopped = null;
    let spawnFailed = false;
    let timer = null;
    let grace = null;
    let watch = null;
    let child = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(watch);
      if (stopped === 'timeout') writeLine(fd, `Расчёт остановлен: он шёл дольше ${humanTime(timeoutMs)}.`);
      if (stopped === 'cancel') writeLine(fd, 'Расчёт прерван: запуск остановили.');
      if (stopped === 'log') {
        try {
          truncateSync(logPath, logLimitBytes);
        } catch {
          // не обрезался: строка всё равно допишется в конец
        }
        writeLine(fd, `Процесс остановлен: слишком большой журнал (больше ${Math.round(logLimitBytes / 1048576)} МБ).`);
      }
      done({ code, stopped, spawnFailed });
    };
    // Остановка: всё дерево процессов; не закончился за killGraceMs, значит добиваем сам процесс
    // и считаем запуск неудачным, чтобы процесс не остался «идёт» навсегда.
    const stop = (reason) => {
      if (stopped || settled) return;
      stopped = reason;
      try {
        stopTree(child);
      } catch {
        // ниже добьём через паузу
      }
      grace = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // процесса уже нет
        }
        finish(null);
      }, killGraceMs);
    };
    try {
      child = spawn(exe, [runFile], {
        cwd: root,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', fd, fd],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
      });
    } catch (e) {
      spawnFailed = true;
      writeLine(fd, `Не удалось запустить Python (${e.code ?? e.message}).`);
      return finish(null);
    }
    child.on('error', (e) => {
      // Процесс уже запущен (есть pid): это ошибка остановки, ждём выхода или паузы добивания.
      if (child.pid !== undefined) return;
      spawnFailed = true;
      writeLine(fd, `Не удалось запустить Python «${exe}» (${e.code ?? e.message}).`);
      finish(null);
    });
    child.on('exit', (code) => finish(code));
    control.stop = stop;
    if (control.cancelled) stop('cancel');
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    watch = setInterval(() => {
      try {
        if (fstatSync(fd).size > logLimitBytes) stop('log');
      } catch {
        // размер не прочитался: проверим в следующий раз
      }
    }, LOG_CHECK_MS);
  });
}

// Синхронно проверяет и занимает процесс (замок), затем запускает run.py. Бросает ошибку с кодом, если запускать нельзя.
// done никогда не отклоняется: { ok, code, durationMs, logPath }; cancel() останавливает запуск.
// python: абсолютный путь к интерпретатору (по умолчанию ищется сам); killTree подменяется только в тестах.
export function startRun(
  root,
  slug,
  {
    python,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logLimitBytes = LOG_LIMIT_BYTES,
    killGraceMs = KILL_GRACE_MS,
    maxConcurrent = MAX_CONCURRENT,
    killTree: stopTree = killTree,
  } = {},
) {
  root = resolve(root);
  const runFile = checkRunnable(root, slug);
  const outDir = join(root, 'output', slug);
  mkdirSync(outDir, { recursive: true });
  const lock = acquireLock(root, slug, timeoutMs);
  const logPath = join(outDir, 'last-run.log');
  let fd;
  try {
    if (runningInCabinet(root, slug) >= maxConcurrent) {
      throw processError(
        'ELIMIT',
        `Одновременно можно запускать не больше ${maxConcurrent} расчётов. Дождитесь, пока один закончится, и запустите снова.`,
      );
    }
    // Дописывание в конец: и Python, и строки этого модуля попадают после уже записанного.
    writeFileSync(logPath, '');
    fd = openSync(logPath, 'a');
  } catch (e) {
    releaseLock(root, slug, lock);
    throw e;
  }
  const control = { stop: null, cancelled: false };
  const started = Date.now();
  const done = (async () => {
    let code = null;
    let stopped = null;
    try {
      const exe = python ?? (await findPython(root));
      if (control.cancelled) {
        stopped = 'cancel';
        writeLine(fd, 'Расчёт прерван: запуск остановили.');
      } else if (!exe) {
        writeLine(fd, 'Python не найден. Скажите Claude «проверь сетап».');
      } else {
        let spawnFailed;
        ({ code, stopped, spawnFailed } = await spawnRun(root, exe, runFile, fd, logPath, { timeoutMs, logLimitBytes, killGraceMs, stopTree, control }));
        if (spawnFailed) forgetPython(exe);
      }
    } catch (e) {
      writeLine(fd, `Не удалось запустить расчёт (${e.code ?? e.message}).`);
    } finally {
      try {
        closeSync(fd);
      } catch {
        // уже закрыт
      }
    }
    const ok = code === 0 && !stopped;
    const durationMs = Date.now() - started;
    // Сначала итог, потом снять замок: кто увидит «не идёт», уже прочитает свежий last-run.json.
    writeLastRun(root, slug, { ok, code, finishedAt: new Date().toISOString(), durationMs });
    releaseLock(root, slug, lock);
    return { ok, code, durationMs, logPath };
  })();
  const cancel = () => {
    control.cancelled = true;
    control.stop?.('cancel');
  };
  return { done, logPath, cancel };
}

export function runProcess(root, slug, options) {
  try {
    return startRun(root, slug, options).done;
  } catch (e) {
    return Promise.reject(e);
  }
}

// ---------- демо курса ----------

// Демо-процессы курса: шаблон templates/processes/<slug>/ и файлы учебного кейса, которые кладутся в input/<slug>/.
// Только файлы кейса (их выдумали для курса): файлы человека в input кладёт сам человек.
export const DEMOS = {
  'svetofor-dogovorov': ['input/case-azs/data/reestr_dogovorov.xlsx'],
};

// Копия папки шаблона без служебных папок (__pycache__, скрытые). Существующие файлы не перезаписываются.
function copyTemplate(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '__pycache__') continue;
    const from = join(src, e.name);
    const to = join(dst, e.name);
    if (e.isDirectory()) copyTemplate(from, to);
    else if (e.isFile()) copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
}

const sameBytes = (a, b) => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

// Ставит демо: процесс из шаблона (если его ещё нет), папка input/<slug> и копии файлов кейса (если их там нет).
// Свой процесс человека с тем же именем не трогает. Возвращает { installed, placed: [путь] }.
export function installDemo(root, slug) {
  const files = DEMOS[slug];
  if (!files) throw processError('ENODEMO', `Такого демо нет: ${slug}. Есть: ${Object.keys(DEMOS).join(', ')}.`);
  const tpl = join(root, 'templates', 'processes', slug);
  const dst = join(root, 'processes', slug);
  if (!isFile(join(tpl, 'run.py'))) throw processError('ENODEMO', `Нет шаблона templates/processes/${slug}. Скажите Claude «обнови кабинет».`);
  for (const rel of files) {
    if (!isFile(join(root, rel))) throw processError('ENODEMO', `Нет файла учебного кейса ${rel}. Скажите Claude «обнови кабинет».`);
  }
  let installed = false;
  if (existsSync(dst)) {
    if (!sameBytes(join(tpl, 'run.py'), join(dst, 'run.py'))) {
      throw processError(
        'EOWN',
        `В кабинете уже есть свой процесс processes/${slug}, демо поверх него не ставлю. ` +
          `Если это прежнее демо курса, удалите папку processes/${slug} и повторите.`,
      );
    }
  } else {
    copyTemplate(tpl, dst);
    installed = true;
  }
  const inputDir = join(root, 'input', slug);
  mkdirSync(inputDir, { recursive: true });
  const placed = [];
  for (const rel of files) {
    const target = join(inputDir, basename(rel));
    if (existsSync(target)) continue;
    copyFileSync(join(root, rel), target, constants.COPYFILE_EXCL);
    placed.push(`input/${slug}/${basename(rel)}`);
  }
  return { installed, placed };
}

// ---------- node tools/processes.mjs ----------

const USAGE = `Процессы кабинета:
  node tools/processes.mjs list            процессы, их результат и последний запуск
  node tools/processes.mjs run <имя>       запустить processes/<имя>/run.py, как кнопкой «Запустить»
  node tools/processes.mjs input <имя>     создать папку input/<имя> и открыть её в Проводнике (--no-open: не открывать)
  node tools/processes.mjs demo <имя>      поставить демо курса из templates/processes и запустить
<имя>: имя папки процесса латиницей, например svodka-prodazh.`;

const COLOR = { green: 'зелёный', yellow: 'жёлтый', red: 'красный' };
const pad2 = (n) => String(n).padStart(2, '0');

// 2026-10-22T14:05:09+05:00 → 22.10.2026 14:05 по часам компьютера, как на карточке.
function formatTime(iso) {
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} с`;

// Имя скилла, на котором построен процесс (поле skill в process.json, необязательно).
function skillOf(root, slug) {
  try {
    const s = readJson(join(root, 'processes', slug, 'process.json')).skill;
    return typeof s === 'string' && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

// Удачный запуск, после которого карточка не обновилась (result.json нет, он не по схеме или старше запуска),
// удачным не называем.
function describeLastRun(root, slug, lastRun, result) {
  if (!lastRun) return null;
  const when = formatTime(lastRun.finishedAt);
  if (lastRun.ok) {
    let mtime = -Infinity;
    try {
      mtime = statSync(join(root, 'output', slug, 'result.json')).mtimeMs;
    } catch {
      // нет файла
    }
    const fresh = result && mtime >= Date.parse(lastRun.finishedAt) - (lastRun.durationMs ?? 0) - 2000;
    return fresh
      ? `Последний запуск: ${when}, удачно.`
      : `Последний запуск: ${when}, программа закончилась без ошибки, но карточку не обновила (output/${slug}/result.json).`;
  }
  const code = lastRun.code === null ? '' : ` (код ${lastRun.code})`;
  return `Последний запуск: ${when}, не удался${code}, журнал output/${slug}/last-run.log.`;
}

export function formatList(root) {
  const list = listProcesses(root);
  if (!list.length) return { text: 'Процессов в кабинете пока нет. Чтобы добавить, скажите Claude «добавь процесс».', code: 0 };
  const lines = [`Процессов в кабинете: ${list.length}.`];
  list.forEach((p, i) => {
    // Скилл называем только у процессов, которые выполняет сам Claude: у программы процесса слово «скилл»
    // в строке сбивало с толку, и расчёт делали вручную вместо run.
    const phrase = `фраза «${p.phrase || `запусти ${p.title}`}»`;
    const skill = skillOf(root, p.slug);
    const how =
      p.kind === 'script'
        ? `программа процесса, кнопка «Запустить», ${phrase}`
        : p.kind === 'claude'
          ? `выполняет сам Claude${skill ? ` по скиллу ${skill}` : ''}, ${phrase}`
          : 'запуск не настроен';
    lines.push(`${i + 1}. «${p.title}» (папка ${p.slug}): ${how}.`);
    if (p.running) lines.push('   Сейчас идёт расчёт.');
    if (p.result) {
      lines.push(`   Результат: обновлён ${formatTime(p.result.updated_at)}, ${COLOR[p.result.status]}. Итог: ${p.result.summary}`);
    } else if (!p.error) {
      lines.push('   Результата пока нет.');
    }
    const last = describeLastRun(root, p.slug, processStatus(root, p.slug).lastRun, p.result);
    if (last) lines.push(`   ${last}`);
    if (p.error) lines.push(`   Ошибка: ${p.error}`);
  });
  return { text: lines.join('\n'), code: list.some((p) => p.error) ? 1 : 0 };
}

function logTail(logPath, count = 12) {
  try {
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-count);
  } catch {
    return [];
  }
}

// Отчёт о запуске для Claude: «Готово» только если result.json записан этим запуском и годится для карточки.
function reportRun(root, slug, r, startedAt) {
  const title = readProcessInfo(root, slug).title;
  const rel = `output/${slug}/result.json`;
  if (!r.ok) {
    const code = r.code === null ? '' : ` (код ${r.code})`;
    const tail = logTail(r.logPath);
    const lines = [`Расчёт «${title}» не удался${code}. Журнал: output/${slug}/last-run.log`];
    if (tail.length) lines.push('Последние строки журнала:', ...tail.map((l) => `  ${l}`));
    return { text: lines.join('\n'), code: 1 };
  }
  const file = join(root, 'output', slug, 'result.json');
  let mtime;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return { text: `Расчёт закончился, но программа не записала ${rel}: карточка на странице не обновится.`, code: 1 };
  }
  const res = readResult(root, slug);
  if (res.error) return { text: `Расчёт закончился, но результат не годится для карточки: ${res.error}`, code: 1 };
  // Запас 2 с на грубые часы файловой системы.
  if (mtime < startedAt - 2000) {
    return { text: `Расчёт закончился, но ${rel} не обновился: на карточке остался прежний результат.`, code: 1 };
  }
  const result = res.result;
  const lines = [
    `Готово: «${title}», расчёт занял ${seconds(r.durationMs)}.`,
    `Итог: ${result.summary}`,
    `Цвет карточки: ${COLOR[result.status]}.`,
    `Обновлено: ${formatTime(result.updated_at)}.`,
    `Результат: ${rel}`,
  ];
  if (Array.isArray(result.files) && result.files.length) lines.push(`Файлы: ${result.files.map((f) => f.replace(/\\/g, '/')).join(', ')}`);
  return { text: lines.join('\n'), code: 0 };
}

const known = (root) => listProcesses(root).map((p) => p.slug).join(', ') || 'процессов пока нет';

async function cliRun(root, slug) {
  if (!slug) return { text: 'Укажите процесс: node tools/processes.mjs run <имя папки процесса>.', code: 2 };
  let run;
  const startedAt = Date.now();
  try {
    run = startRun(root, slug);
  } catch (e) {
    if (e.code === 'EBADSLUG' || e.code === 'ENOPROCESS') {
      return { text: `Такого процесса нет: ${slug}. Процессы кабинета: ${known(root)}.`, code: 2 };
    }
    return { text: e.message, code: 2 };
  }
  // Команду остановили (Ctrl+C или ограничение времени): останавливаем и расчёт, замок снимется.
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = () => run.cancel();
  for (const s of signals) process.on(s, onSignal);
  const r = await run.done;
  for (const s of signals) process.off(s, onSignal);
  return reportRun(root, slug, r, startedAt);
}

function openFolder(dir) {
  const [cmd, args] =
    process.platform === 'win32'
      ? [join(SYSTEM_ROOT, 'explorer.exe'), [dir]]
      : process.platform === 'darwin'
        ? ['open', [dir]]
        : ['xdg-open', [dir]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function cliInput(root, slug, open) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return { text: 'Имя папки процесса: строчные латинские буквы, цифры и дефис, до 40 знаков, например svodka-prodazh.', code: 2 };
  }
  const dir = join(root, 'input', slug);
  const existed = isDir(dir);
  mkdirSync(dir, { recursive: true });
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.startsWith('~$'))
    .map((e) => e.name);
  const lines = [`Папка ${existed ? 'уже есть' : 'создана'}: ${dir}`];
  lines.push(files.length ? `Файлы в ней: ${files.join(', ')}.` : 'Файлов в ней пока нет.');
  if (open && openFolder(dir)) lines.push(`Папка открыта в ${process.platform === 'darwin' ? 'Finder' : 'Проводнике'}.`);
  return { text: lines.join('\n'), code: 0 };
}

async function cliDemo(root, slug) {
  if (!slug) return { text: `Укажите демо: node tools/processes.mjs demo <имя>. Есть: ${Object.keys(DEMOS).join(', ')}.`, code: 2 };
  let setup;
  try {
    setup = installDemo(root, slug);
  } catch (e) {
    return { text: e.message, code: 2 };
  }
  const title = readProcessInfo(root, slug).title;
  const lines = [
    setup.installed ? `Демо «${title}» поставлен в processes/${slug}.` : `Демо «${title}» уже стоит в processes/${slug}.`,
    setup.placed.length
      ? `Копия файла учебного кейса положена: ${setup.placed.join(', ')}.`
      : `Файл учебного кейса уже лежит в input/${slug}.`,
  ];
  const run = await cliRun(root, slug);
  return { text: `${lines.join('\n')}\n${run.text}`, code: run.code };
}

export async function main(argv = process.argv.slice(2)) {
  // Windows не ищет программы (explorer, python) в текущей папке, то есть в кабинете.
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [cmd, slug] = argv;
  let out;
  if (cmd === 'list') out = formatList(root);
  else if (cmd === 'run') out = await cliRun(root, slug);
  else if (cmd === 'input') out = cliInput(root, slug, !argv.includes('--no-open'));
  else if (cmd === 'demo') out = await cliDemo(root, slug);
  else out = { text: USAGE, code: cmd ? 2 : 0 };
  console.log(out.text);
  return out.code;
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
