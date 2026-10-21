import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createSiteServer, listenFirstFree, describeListenError, portForUser, pageToken } from '../serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'templates', 'site');
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const T = `/${TOKEN}`;

function close(server) {
  return new Promise((res) => server.close(() => res()));
}

async function withServer(dir, fn) {
  const server = createSiteServer(dir, { token: TOKEN });
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
    const r = await get(port, `${T}/`);
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
      const r = await get(port, encodeURI(`${T}/тест страница.html`));
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
    for (const p of [`${T}/../../CLAUDE.md`, `${T}/%2e%2e%2f%2e%2e%2fCLAUDE.md`, `${T}/..%2f..%2fCLAUDE.md`, `${T}/../CLAUDE.md`, `${T}/..%2fCLAUDE.md`]) {
      const r = await get(port, p);
      // Буквальные /../ браузерный разбор адреса схлопывает до пути без токена: 403, тоже безопасно.
      assert.ok(r.status === 404 || (r.status === 403 && !p.includes('%')), `${p}: ${r.status}`);
      assert.ok(!r.body.includes(secret.trim().slice(0, 20)), p);
    }
  });
});

test('нет файла: 404 с русским текстом', async () => {
  await withServer(SITE, async (port) => {
    const r = await get(port, `${T}/net-takogo.html`);
    assert.equal(r.status, 404);
    assert.match(r.body, /[А-Яа-я]/);
  });
});

test('порт занят: берёт следующий', async () => {
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18700, '127.0.0.1', res));
  const server = createSiteServer(SITE, { token: TOKEN });
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
  const server = createSiteServer(SITE, { token: TOKEN });
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
  const server = createSiteServer(SITE, { token: TOKEN });
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
  const tmp = mkdtempSync(join(tmpdir(), 'busy-'));
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18740, '127.0.0.1', res));
  try {
    // Копия кабинета во временной папке: сервер создаёт me/page-token.txt, в репозитории его оставлять нельзя.
    copyDir(join(ROOT, 'tools'), join(tmp, 'tools'));
    copyDir(join(ROOT, 'templates'), join(tmp, 'templates'));
    const r = spawnSync(process.execPath, [join(tmp, 'tools', 'serve.mjs'), '--port', '18740'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /занят/);
    assert.match(r.stderr, /--port 18741/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await close(blocker);
  }
});

test('portForUser: стабилен, в диапазоне 20000-29999, без учёта регистра', () => {
  for (const name of ['dima', 'Айгуль', 'user1', 'user2', 'Администратор', 'a', '']) {
    const p = portForUser(name);
    assert.ok(Number.isInteger(p) && p >= 20000 && p <= 29999, `${name}: ${p}`);
    assert.equal(portForUser(name), p, name);
  }
  assert.equal(portForUser('Айгуль'), portForUser('айгуль'));
  assert.notEqual(portForUser('user1'), portForUser('user2'));
});

test('без токена в пути: 403 с русским текстом, файлы не отдаются', async () => {
  await withServer(SITE, async (port) => {
    for (const p of ['/', '/index.html', '/wrong-token/', `/${TOKEN.slice(0, -1)}x/`, `/${TOKEN}x/`]) {
      const r = await get(port, p);
      assert.equal(r.status, 403, p);
      assert.match(r.body, /только по своей ссылке/, p);
      assert.ok(!r.body.includes('data-cabinet'), p);
    }
  });
});

test('с токеном: 200; без слэша на конце: 301 на /<token>/', async () => {
  await withServer(SITE, async (port) => {
    assert.equal((await get(port, `${T}/`)).status, 200);
    assert.equal((await get(port, `${T}/index.html`)).status, 200);
    const r = await get(port, T);
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, `${T}/`);
  });
});

test('createSiteServer требует токен', () => {
  assert.throws(() => createSiteServer(SITE), /токен/i);
  assert.throws(() => createSiteServer(SITE, { token: '' }), /токен/i);
});

test('api-обработчик получает путь после /<token>/api/ и может ответить сам', async () => {
  const seen = [];
  const server = createSiteServer(SITE, {
    token: TOKEN,
    api: async (req, res, sub) => {
      seen.push(sub);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('api ok');
    },
  });
  const port = await listenFirstFree(server, { from: 18560, to: 18579 });
  try {
    const r = await get(port, `${T}/api/processes`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'api ok');
    assert.deepEqual(seen, ['processes']);
    assert.equal((await get(port, '/api/processes')).status, 403);
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test('listenFirstFree: начинает с start и идёт по кругу внутри диапазона', async () => {
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18752, '127.0.0.1', res));
  const server = createSiteServer(SITE, { token: TOKEN });
  try {
    assert.equal(await listenFirstFree(server, { from: 18750, to: 18754, start: 18752 }), 18753);
  } finally {
    await close(server);
    await close(blocker);
  }
  const b2 = http.createServer();
  await new Promise((res) => b2.listen(18754, '127.0.0.1', res));
  const s2 = createSiteServer(SITE, { token: TOKEN });
  try {
    assert.equal(await listenFirstFree(s2, { from: 18750, to: 18754, start: 18754 }), 18750);
  } finally {
    await close(s2);
    await close(b2);
  }
});

test('pageToken: 32 hex, сохраняется между вызовами, создаёт me/', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tok-'));
  try {
    const a = pageToken(tmp);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(readFileSync(join(tmp, 'me', 'page-token.txt'), 'utf8').trim(), a);
    assert.equal(pageToken(tmp), a);
    writeFileSync(join(tmp, 'me', 'page-token.txt'), 'мусор\n');
    const b = pageToken(tmp);
    assert.match(b, /^[0-9a-f]{32}$/);
    assert.notEqual(b, a);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: печатает адрес с токеном, 403 без него, токен тот же при втором запуске', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const tmp = mkdtempSync(join(tmpdir(), 'cli-'));
  try {
    copyDir(join(ROOT, 'tools'), join(tmp, 'tools'));
    copyDir(join(ROOT, 'templates'), join(tmp, 'templates'));
    const run = () =>
      new Promise((res, rej) => {
        const c = spawn(process.execPath, [join(tmp, 'tools', 'serve.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        c.stdout.on('data', (d) => {
          out += d;
          const m = /http:\/\/localhost:(\d+)\/([0-9a-f]{32})\//.exec(out);
          if (m) res({ c, port: Number(m[1]), token: m[2] });
        });
        c.on('error', rej);
        c.on('exit', () => rej(new Error(`serve завершился: ${out}`)));
      });
    const one = await run();
    try {
      assert.equal((await get(one.port, `/${one.token}/`)).status, 200);
      assert.equal((await get(one.port, '/')).status, 403);
      assert.ok(existsSync(join(tmp, 'me', 'page-token.txt')));
    } finally {
      one.c.removeAllListeners('exit');
      one.c.kill();
      await new Promise((r) => one.c.once('exit', r));
    }
    const two = await run();
    try {
      assert.equal(two.token, one.token);
    } finally {
      two.c.removeAllListeners('exit');
      two.c.kill();
      await new Promise((r) => two.c.once('exit', r));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pageToken: два одновременных запуска на пустом me/ получают один токен', async () => {
  const { spawn } = await import('node:child_process');
  const tmp = mkdtempSync(join(tmpdir(), 'race-'));
  try {
    const mod = new URL('../serve.mjs', import.meta.url).href;
    const code = `import(${JSON.stringify(mod)}).then(m => console.log(m.pageToken(${JSON.stringify(tmp)})))`;
    const run = () =>
      new Promise((res, rej) => {
        const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('error', rej);
        c.on('exit', () => res(out.trim()));
      });
    for (let round = 0; round < 5; round++) {
      rmSync(join(tmp, 'me'), { recursive: true, force: true });
      const tokens = await Promise.all([run(), run(), run(), run()]);
      assert.match(tokens[0], /^[0-9a-f]{32}$/);
      assert.deepEqual(new Set(tokens).size, 1, tokens.join(' '));
      assert.equal(readFileSync(join(tmp, 'me', 'page-token.txt'), 'utf8').trim(), tokens[0]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
