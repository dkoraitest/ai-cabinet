// Локальный сервер страницы кабинета. Без зависимостей, слушает только 127.0.0.1.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { ensureParticipantFiles } from './init.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const notFound = (res) =>
  send(res, 404, 'text/plain; charset=utf-8', 'Такого файла нет в папке site.');

const forbidden = (res) =>
  send(
    res,
    403,
    'text/plain; charset=utf-8',
    'Страница кабинета открывается только по своей ссылке. Её показывает Claude или команда node tools/serve.mjs.',
  );

const PORT_MIN = 20000;
const PORT_SPAN = 10000;

// Порт зависит от имени пользователя Windows: на общем сервере у каждого свой стартовый порт.
export function portForUser(username) {
  const h = createHash('sha256').update(String(username).toLowerCase()).digest();
  return PORT_MIN + (h.readUInt32BE(0) % PORT_SPAN);
}

export function currentUser() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}

const TOKEN_RE = /^[0-9a-f]{32}$/;

// Личный секрет адреса страницы. Лежит в me/ (папка участника, не в Git).
// Создание атомарное (flag wx): два одновременных запуска получат один токен.
function readSavedToken(file) {
  try {
    const saved = readFileSync(file, 'utf8').trim();
    return TOKEN_RE.test(saved) ? saved : null;
  } catch {
    return null;
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function pageToken(root) {
  const file = resolve(root, 'me', 'page-token.txt');
  mkdirSync(resolve(root, 'me'), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt++) {
    const saved = readSavedToken(file);
    if (saved) return saved;
    const token = randomBytes(16).toString('hex');
    try {
      writeFileSync(file, token + '\n', { flag: 'wx', mode: 0o600 });
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Файл уже есть: либо его пишет другой запуск, либо в нём мусор.
      pause(25);
      if (attempt >= 20 && !readSavedToken(file)) {
        // Мусор или пустой файл надолго: заменяем его.
        rmSync(file, { force: true });
      }
    }
  }
  throw new Error('Не удалось получить личный адрес страницы: файл me/page-token.txt занят.');
}

function sameToken(a, b) {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

// Страница отдаётся только под /<token>/. Остальные пути: 403.
// Необязательный api(req, res, sub) вызывается для /<token>/api/<sub>; вернёт true или промис
// с true, если ответ отправлен. Так задача V10 добавит свои маршруты под тем же токеном.
export function createSiteServer(rootDir, { token, api } = {}) {
  if (typeof token !== 'string' || token.length < 8) {
    throw new Error('Для страницы нужен токен (личная часть адреса).');
  }
  const root = resolve(rootDir);
  return http.createServer(async (req, res) => {
    try {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        return forbidden(res);
      }
      const first = pathname.split('/')[1] ?? '';
      if (!sameToken(first, token)) return forbidden(res);
      if (pathname === `/${first}`) {
        res.writeHead(301, { Location: `/${token}/`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const rel = pathname.slice(first.length + 1);
      if (api && (rel === '/api' || rel.startsWith('/api/'))) {
        if (await api(req, res, rel.slice('/api/'.length))) return;
        if (!res.headersSent) return notFound(res);
        return;
      }
      if (rel.includes('\0')) return notFound(res);
      let file = resolve(root, '.' + rel);
      if (file !== root && !file.startsWith(root + sep)) return notFound(res);
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = resolve(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) return notFound(res);
      const body = await readFile(file);
      send(res, 200, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', body);
    } catch {
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Не удалось отдать файл.');
    }
  });
}

function tryListen(server, host, port) {
  return new Promise((ok, fail) => {
    const onError = (e) => fail(e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      ok(port);
    });
  });
}

// Пробует порты по кругу в диапазоне from..to, начиная со start, не больше attempts попыток.
export async function listenFirstFree(
  server,
  { host = '127.0.0.1', from = PORT_MIN, to = PORT_MIN + PORT_SPAN - 1, start = from, attempts = 50 } = {},
) {
  const size = to - from + 1;
  const tries = Math.min(attempts, size);
  for (let i = 0; i < tries; i++) {
    const port = from + ((start - from + i) % size);
    try {
      return await tryListen(server, host, port);
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
    }
  }
  throw new Error(`Все порты с ${from} по ${to} заняты. Закройте другие программы и попробуйте снова.`);
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Браузер не открылся: адрес уже напечатан.
  }
}

export function describeListenError(err, port) {
  const code = err?.code;
  const next = port < 65535 ? ` Выберите другой номер: --port ${port + 1}` : '';
  const tail = code ? ` (${code})` : '';
  switch (code) {
    case 'EADDRINUSE':
      return `Порт ${port} занят другой программой.${next}${tail}`;
    case 'EACCES':
      return `Порт ${port} закрыт системой.${next}${tail}`;
    case 'EPERM':
      return `Системе не разрешено открыть порт ${port}. Возможно, мешает антивирус или брандмауэр.${next}${tail}`;
    case 'EADDRNOTAVAIL':
      return `Адрес 127.0.0.1 сейчас недоступен на этом компьютере. Проверьте сетевые настройки.${tail}`;
    default:
      return `Не удалось открыть порт ${port}. Покажите это сообщение Claude или тренеру.${tail}`;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const open = args.includes('--open');
  const pi = args.indexOf('--port');
  let fixed = null;
  if (pi !== -1) {
    fixed = Number(args[pi + 1]);
    if (!Number.isInteger(fixed) || fixed < 1 || fixed > 65535) {
      console.error('Укажите номер порта числом, например: --port 8080');
      process.exit(1);
    }
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    ensureParticipantFiles(root);
  } catch (e) {
    console.error(`Не удалось создать файлы кабинета из шаблонов (${e.code ?? e.message}).`);
  }
  let token;
  try {
    token = pageToken(root);
  } catch (e) {
    console.error(`Не удалось сохранить личный адрес страницы в папке me (${e.code ?? e.message}).`);
    process.exit(1);
  }
  const server = createSiteServer(resolve(root, 'site'), { token });
  let port;
  try {
    port = fixed
      ? await tryListen(server, '127.0.0.1', fixed)
      : await listenFirstFree(server, { start: portForUser(currentUser()) });
  } catch (e) {
    // Диапазон занят целиком: у этой ошибки уже есть русский текст и нет code.
    console.error(e.code ? describeListenError(e, fixed ?? PORT_MIN) : e.message);
    process.exit(1);
  }
  const url = `http://localhost:${port}/${token}/`;
  console.log(`Страница работает: ${url}`);
  console.log('Остановить: Ctrl+C');
  if (open) openBrowser(url);
}

if (isMain(import.meta.url)) {
  main();
}
