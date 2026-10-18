// Локальный сервер страницы кабинета. Без зависимостей, слушает только 127.0.0.1.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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

export function createSiteServer(rootDir) {
  const root = resolve(rootDir);
  return http.createServer(async (req, res) => {
    try {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        return notFound(res);
      }
      if (pathname.includes('\0')) return notFound(res);
      let file = resolve(root, '.' + pathname);
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
      send(res, 500, 'text/plain; charset=utf-8', 'Не удалось отдать файл.');
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

export async function listenFirstFree(server, { host = '127.0.0.1', from = 8000, to = 8019 } = {}) {
  for (let port = from; port <= to; port++) {
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
  const server = createSiteServer(resolve(root, 'site'));
  let port;
  try {
    port = fixed
      ? await tryListen(server, '127.0.0.1', fixed)
      : await listenFirstFree(server, {});
  } catch (e) {
    // Диапазон занят целиком: у этой ошибки уже есть русский текст и нет code.
    console.error(e.code ? describeListenError(e, fixed ?? 8000) : e.message);
    process.exit(1);
  }
  const url = `http://localhost:${port}`;
  console.log(`Страница работает: ${url}`);
  console.log('Остановить: Ctrl+C');
  if (open) openBrowser(url);
}

if (isMain(import.meta.url)) {
  main();
}
