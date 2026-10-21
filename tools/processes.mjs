// Процессы участника: папки processes/<slug>/ с process.json и, для kind "script", run.py. Без зависимостей.
// Результат процесса лежит в output/<slug>/result.json, страница «Мой кабинет» рисует его карточкой.
// Запуск: только processes/<slug>/run.py этого кабинета, из корня кабинета, без аргументов,
// своим Python (абсолютный путь вне кабинета), по одному запуску на процесс и не больше двух на кабинет,
// не дольше timeoutMs, журнал output/<slug>/last-run.log не больше 20 МБ.
import { spawn } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const SLUG_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_CONCURRENT = 2;
export const LOG_LIMIT_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 5000;
const LOG_CHECK_MS = 200;
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const TASKKILL = join(SYSTEM_ROOT, 'System32', 'taskkill.exe');

const KINDS = ['script', 'claude'];
const STATUSES = ['green', 'yellow', 'red'];
const ROW_STATUSES = [...STATUSES, 'grey', 'info'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// Состояние запусков живёт в процессе страницы: ключ это кабинет и slug.
const active = new Set();
const lastRuns = new Map();
const keyOf = (root, slug) => `${resolve(root)}\0${slug}`;
const runningIn = (root) => [...active].filter((k) => k.startsWith(`${resolve(root)}\0`)).length;

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
    running: active.has(keyOf(root, slug)),
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

export function processStatus(root, slug) {
  const key = keyOf(root, slug);
  return { running: active.has(key), lastRun: lastRuns.get(key) ?? null };
}

// Проверки до запуска. Ошибки с кодом: страница превращает его в ответ (404, 400, 403, 409).
// Возвращает настоящий путь run.py: запускается именно он, подменить файл после проверки нельзя.
function checkRunnable(root, slug, maxConcurrent) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw processError('EBADSLUG', 'Такого процесса нет.');
  const info = readProcessInfo(root, slug);
  if (info.missing) throw processError('ENOPROCESS', `Такого процесса нет: ${slug}.`);
  if (info.error) throw processError('EBADPROCESS', `Процесс не запускается: ${info.error}.`);
  if (info.kind === 'claude') {
    throw processError('ECLAUDE', `этот процесс запускается фразой в Claude: ${info.phrase || info.title}`);
  }
  if (active.has(keyOf(root, slug))) {
    throw processError('ERUNNING', 'Этот процесс уже идёт. Дождитесь, пока обновится время на карточке.');
  }
  if (runningIn(root) >= maxConcurrent) {
    throw processError(
      'ELIMIT',
      `Одновременно можно запускать не больше ${maxConcurrent} расчётов. Дождитесь, пока один закончится, и запустите снова.`,
    );
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
  const { timeoutMs, logLimitBytes, killGraceMs, stopTree } = opts;
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

// Синхронно проверяет и занимает процесс, затем запускает run.py. Бросает ошибку с кодом, если запускать нельзя.
// done никогда не отклоняется: { ok, code, durationMs, logPath }.
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
  const runFile = checkRunnable(root, slug, maxConcurrent);
  const outDir = join(root, 'output', slug);
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, 'last-run.log');
  // Дописывание в конец: и Python, и строки этого модуля попадают после уже записанного.
  writeFileSync(logPath, '');
  const fd = openSync(logPath, 'a');
  const key = keyOf(root, slug);
  active.add(key);
  const started = Date.now();
  const done = (async () => {
    let code = null;
    let stopped = null;
    try {
      const exe = python ?? (await findPython(root));
      if (!exe) {
        writeLine(fd, 'Python не найден. Скажите Claude «проверь сетап».');
      } else {
        let spawnFailed;
        ({ code, stopped, spawnFailed } = await spawnRun(root, exe, runFile, fd, logPath, { timeoutMs, logLimitBytes, killGraceMs, stopTree }));
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
    lastRuns.set(key, { ok, code, finishedAt: new Date().toISOString() });
    active.delete(key);
    return { ok, code, durationMs: Date.now() - started, logPath };
  })();
  return { done, logPath };
}

export function runProcess(root, slug, options) {
  try {
    return startRun(root, slug, options).done;
  } catch (e) {
    return Promise.reject(e);
  }
}
