// Процессы участника: папки processes/<slug>/ с process.json и, для kind "script", run.py. Без зависимостей.
// Результат процесса лежит в output/<slug>/result.json, страница «Мой кабинет» рисует его карточкой.
// Запуск: только processes/<slug>/run.py этого кабинета, из корня кабинета, без аргументов,
// по одному запуску на процесс, не дольше timeoutMs; вывод в output/<slug>/last-run.log.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const SLUG_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const KINDS = ['script', 'claude'];
const STATUSES = ['green', 'yellow', 'red'];
const ROW_STATUSES = [...STATUSES, 'grey', 'info'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// Состояние запусков живёт в процессе страницы: ключ это кабинет и slug.
const active = new Set();
const lastRuns = new Map();
const keyOf = (root, slug) => `${resolve(root)}\0${slug}`;

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
function checkRunnable(root, slug) {
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
  // run.py должен по-настоящему лежать внутри processes/: ссылка наружу не запускается.
  let base, file;
  try {
    base = realpathSync(join(root, 'processes'));
    file = realpathSync(join(root, 'processes', slug, 'run.py'));
  } catch {
    throw processError('ENORUN', `Нет файла processes/${slug}/run.py.`);
  }
  if (!file.startsWith(base + sep)) {
    throw processError('EOUTSIDE', `Файл processes/${slug}/run.py ведёт за пределы папки processes, такой процесс не запускается.`);
  }
  if (!isFile(file)) throw processError('ENORUN', `Нет файла processes/${slug}/run.py.`);
}

let foundPython = null;

// Python ищется так же, как в проверке сетапа: python или py -3 на Windows, python3 или python на остальных.
async function findPython() {
  if (foundPython) return foundPython;
  const { defaultExec, detectPython } = await import('./check.mjs');
  const py = await detectPython(defaultExec, process.platform);
  if (py) foundPython = { cmd: py.cmd, pre: py.pre };
  return foundPython;
}

// На Windows дерево процессов останавливает taskkill, на остальных системах вся группа процессов.
function killTree(child) {
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
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

function spawnRun(root, slug, py, fd, timeoutMs) {
  return new Promise((done) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) writeLine(fd, `Расчёт остановлен: он шёл дольше ${humanTime(timeoutMs)}.`);
      done({ code, timedOut });
    };
    let child;
    try {
      child = spawn(py.cmd, [...py.pre, join('processes', slug, 'run.py')], {
        cwd: root,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', fd, fd],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
      });
    } catch (e) {
      writeLine(fd, `Не удалось запустить Python (${e.code ?? e.message}).`);
      return finish(null);
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('error', (e) => {
      writeLine(fd, `Не удалось запустить Python «${py.cmd}» (${e.code ?? e.message}).`);
      finish(null);
    });
    child.on('exit', (code) => finish(code));
  });
}

// Синхронно проверяет и занимает процесс, затем запускает run.py. Бросает ошибку с кодом, если запускать нельзя.
// done никогда не отклоняется: { ok, code, durationMs, logPath }.
export function startRun(root, slug, { python, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  root = resolve(root);
  checkRunnable(root, slug);
  const outDir = join(root, 'output', slug);
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, 'last-run.log');
  const fd = openSync(logPath, 'w');
  const key = keyOf(root, slug);
  active.add(key);
  const started = Date.now();
  const done = (async () => {
    let code = null;
    let timedOut = false;
    try {
      const py = python ?? (await findPython());
      if (!py) {
        writeLine(fd, 'Python не найден. Скажите Claude «проверь сетап».');
      } else {
        ({ code, timedOut } = await spawnRun(root, slug, py, fd, timeoutMs));
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
    const ok = code === 0 && !timedOut;
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
