import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, ensureParticipantFiles } from '../init.mjs';
import { copyDir } from './copy-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeCabinet() {
  const base = mkdtempSync(join(tmpdir(), 'init-'));
  const dir = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(dir, { recursive: true });
  copyDir(join(ROOT, 'templates'), join(dir, 'templates'));
  return { base, dir };
}

test('init: создаёт отсутствующие, не трогает существующие, повторный запуск ничего не создаёт', () => {
  const { base, dir } = makeCabinet();
  try {
    mkdirSync(join(dir, 'me'));
    writeFileSync(join(dir, 'me', 'rules.md'), 'мои правила участника');

    const created = ensureParticipantFiles(dir);
    assert.deepEqual(created.sort(), ['me/about-me.md', 'site/analiz.html', 'site/analiz.js', 'site/index.html', 'site/render.js']);
    assert.equal(readFileSync(join(dir, 'me', 'rules.md'), 'utf8'), 'мои правила участника');
    for (const { from, to } of MANIFEST.filter((m) => m.to !== 'me/rules.md')) {
      assert.equal(readFileSync(join(dir, to), 'utf8'), readFileSync(join(dir, from), 'utf8'), to);
    }

    writeFileSync(join(dir, 'site', 'index.html'), '<p>моя страница</p>');
    assert.deepEqual(ensureParticipantFiles(dir), []);
    assert.equal(readFileSync(join(dir, 'site', 'index.html'), 'utf8'), '<p>моя страница</p>');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init: MANIFEST берёт шаблоны из templates и кладёт в me и site', () => {
  assert.deepEqual(MANIFEST, [
    { from: 'templates/about-me.md', to: 'me/about-me.md' },
    { from: 'templates/rules.md', to: 'me/rules.md' },
    { from: 'templates/site/index.html', to: 'site/index.html' },
    { from: 'templates/site/render.js', to: 'site/render.js' },
    { from: 'templates/site/analiz.html', to: 'site/analiz.html' },
    { from: 'templates/site/analiz.js', to: 'site/analiz.js' },
  ]);
  for (const { from } of MANIFEST) assert.ok(existsSync(join(ROOT, from)), from);
});

test('init: CLI из пути с кириллицей и пробелом называет созданные файлы', () => {
  const { base, dir } = makeCabinet();
  try {
    copyDir(join(ROOT, 'tools'), join(dir, 'tools'));
    const run = () => spawnSync(process.execPath, [join(dir, 'tools', 'init.mjs')], { encoding: 'utf8', cwd: base });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /me\/about-me\.md/);
    assert.ok(existsSync(join(dir, 'site', 'index.html')));
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /[А-Яа-я]/);
    assert.doesNotMatch(r.stdout, /about-me/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init: --json печатает список созданных файлов', () => {
  const { base, dir } = makeCabinet();
  try {
    copyDir(join(ROOT, 'tools'), join(dir, 'tools'));
    const run = () => spawnSync(process.execPath, [join(dir, 'tools', 'init.mjs'), '--json'], { encoding: 'utf8', cwd: base });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).sort(), MANIFEST.map((m) => m.to).sort());
    r = run();
    assert.deepEqual(JSON.parse(r.stdout), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init: кабинет, поставленный до сервиса «Спроси таблицу», получает его страницу, своя страница и render.js целы', () => {
  const { base, dir } = makeCabinet();
  try {
    mkdirSync(join(dir, 'me'), { recursive: true });
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, 'me', 'about-me.md'), 'обо мне');
    writeFileSync(join(dir, 'me', 'rules.md'), 'мои правила');
    writeFileSync(join(dir, 'site', 'index.html'), '<p>моя страница</p>');
    writeFileSync(join(dir, 'site', 'render.js'), '// мой render');
    assert.deepEqual(ensureParticipantFiles(dir).sort(), ['site/analiz.html', 'site/analiz.js']);
    assert.equal(readFileSync(join(dir, 'site', 'index.html'), 'utf8'), '<p>моя страница</p>');
    assert.equal(readFileSync(join(dir, 'site', 'render.js'), 'utf8'), '// мой render');
    assert.equal(readFileSync(join(dir, 'site', 'analiz.html'), 'utf8'), readFileSync(join(ROOT, 'templates', 'site', 'analiz.html'), 'utf8'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
