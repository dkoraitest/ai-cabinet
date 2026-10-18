import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSiteServer, listenFirstFree, describeListenError } from '../serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'templates', 'site');

function close(server) {
  return new Promise((res) => server.close(() => res()));
}

async function withServer(dir, fn) {
  const server = createSiteServer(dir);
  const port = await listenFirstFree(server, { from: 18500, to: 18599 });
  try {
    return await fn(port);
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
}

// http.get без нормализации пути (fetch схлопывает /../).
function get(port, path) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port, path, agent: false }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () =>
          res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      })
      .on('error', rej);
  });
}

test('отдаёт index.html с text/html; charset=utf-8 и маркером', async () => {
  await withServer(SITE, async (port) => {
    const r = await get(port, '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(r.body, /data-cabinet="ok"/);
  });
});

test('файл с кириллицей и пробелом в имени и в пути корня', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cab-'));
  try {
    const dir = join(tmp, 'Айгуль Н', 'site');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'тест страница.html'), '<p>привет</p>');
    await withServer(dir, async (port) => {
      const r = await get(port, encodeURI('/тест страница.html'));
      assert.equal(r.status, 200);
      assert.equal(r.body, '<p>привет</p>');
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('выход за корень запрещён', async () => {
  const secret = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  await withServer(SITE, async (port) => {
    for (const p of ['/../../CLAUDE.md', '/%2e%2e%2f%2e%2e%2fCLAUDE.md', '/..%2f..%2fCLAUDE.md', '/../CLAUDE.md']) {
      const r = await get(port, p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes(secret.trim().slice(0, 20)), p);
    }
  });
});

test('нет файла: 404 с русским текстом', async () => {
  await withServer(SITE, async (port) => {
    const r = await get(port, '/net-takogo.html');
    assert.equal(r.status, 404);
    assert.match(r.body, /[А-Яа-я]/);
  });
});

test('порт занят: берёт следующий', async () => {
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18700, '127.0.0.1', res));
  const server = createSiteServer(SITE);
  try {
    const port = await listenFirstFree(server, { from: 18700, to: 18710 });
    assert.equal(port, 18701);
  } finally {
    await close(server);
    await close(blocker);
  }
});

test('все порты диапазона заняты: русская ошибка с диапазоном', async () => {
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18720, '127.0.0.1', res));
  const server = createSiteServer(SITE);
  try {
    await assert.rejects(
      listenFirstFree(server, { from: 18720, to: 18720 }),
      (e) => e instanceof Error && /18720/.test(e.message) && /[А-Яа-я]/.test(e.message),
    );
  } finally {
    await close(blocker);
  }
});

test('порт, зарезервированный системой (EACCES): пропускается', async () => {
  const server = createSiteServer(SITE);
  const realListen = server.listen.bind(server);
  server.listen = (port, ...rest) => {
    if (port === 18730) {
      process.nextTick(() => server.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
      return server;
    }
    return realListen(port, ...rest);
  };
  try {
    assert.equal(await listenFirstFree(server, { from: 18730, to: 18735 }), 18731);
  } finally {
    await close(server);
  }
});

test('describeListenError: русские фразы с кодом в скобках', () => {
  for (const code of ['EADDRINUSE', 'EACCES', 'EPERM', 'EADDRNOTAVAIL', 'EWHATEVER']) {
    const m = describeListenError({ code, message: 'english text' }, 8080);
    assert.match(m, /[А-Яа-я]/, code);
    assert.ok(m.endsWith(`(${code})`), code);
    assert.ok(!m.includes('english text'), code);
  }
  assert.match(describeListenError({ code: 'EADDRINUSE' }, 8080), /занят.*--port 8081/);
  assert.ok(!describeListenError({ code: 'EADDRINUSE' }, 65535).includes('--port'));
  assert.match(describeListenError({ message: 'english' }, 80), /Не удалось/);
});

test('CLI --port на занятом порту: русское сообщение и exit 1', async () => {
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18740, '127.0.0.1', res));
  try {
    const r = await new Promise((res) => {
      const c = spawnSync(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), '--port', '18740'], { encoding: 'utf8' });
      res(c);
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /занят/);
    assert.match(r.stderr, /--port 18741/);
  } finally {
    await close(blocker);
  }
});
