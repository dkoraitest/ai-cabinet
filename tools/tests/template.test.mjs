import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST } from '../init.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Файлы шаблона: отслеживаемые + новые, не игнорируемые git.
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
  .filter((f) => existsSync(join(ROOT, f)));

const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const PARTICIPANT = (f) =>
  f === 'CLAUDE.md' ||
  f === 'START.md' ||
  ['.claude/skills/', '.claude/hooks/', 'templates/', 'me/', 'site/'].some((p) => f.startsWith(p));

// Учебный кейс: тексты Практики, стилевые правила участника на него не распространяются.
const CASE_DIR = 'input/case-azs/';
const isCase = (f) => f.startsWith(CASE_DIR);
const TEXT_EXT = /\.(md|csv|txt|json|html)$/i;

test('имена файлов только латиница без пробелов', () => {
  const bad = files.filter((f) => f.split('/').some((s) => !/^[A-Za-z0-9._-]+$/.test(s)) && !isCase(f));
  assert.deepEqual(bad, []);
});

test('имена файлов кейса только ASCII (скопированные выгрузки могут быть с пробелом и скобками)', () => {
  const bad = files.filter((f) => isCase(f) && f.split('/').some((s) => !/^[A-Za-z0-9._ ()-]+$/.test(s)));
  assert.deepEqual(bad, []);
});

test('кейс входит в репо и не игнорируется: input/case-azs/README.md отслеживается', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  assert.ok(tracked.includes('input/case-azs/README.md'), 'README кейса не отслеживается');
  assert.ok(tracked.some((f) => f.startsWith('input/case-azs/data/')), 'нет data кейса');
  assert.ok(!tracked.some((f) => /(^|\/)(trainer|_gen)(\/|$)|trainer-key/.test(f)), 'в репо попали trainer/_gen');
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }).status === 0;
  assert.equal(ignored('input/case-azs/README.md'), false);
  assert.equal(ignored('input/moi-fayl.xlsx'), true);
});

// Имя клиента не должно попасть в публичный репозиторий, поэтому в тесте только хеши.
const CLIENT_HASHES = new Set([
  '06c8c47bab0d6cb6ca934521184e8539c444c61b6809bcfc8122dad1b53f07e1',
  'fbc8cf19f43c292eed00091f58167c043cce31212e9d23caa807bc787f640360',
  '6250aecf3fa543ecd9dfb5655a9be835b6a616aa9e79f9fc7c315c09974f0018',
]);
const HASH_LENGTHS = [5, 6, 11];
const sha = (x) => createHash('sha256').update(x).digest('hex');

function hasClientName(text) {
  for (const token of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    for (const n of HASH_LENGTHS) {
      for (let i = 0; i + n <= token.length; i++) {
        if (CLIENT_HASHES.has(sha(token.slice(i, i + n)))) return true;
      }
    }
  }
  return false;
}

test('нет имени клиента (по хешам)', () => {
  assert.equal(hasClientName('Hello world'), false);
  const bad = files.filter((f) => hasClientName(f) || ((!isCase(f) || TEXT_EXT.test(f)) && hasClientName(read(f))));
  assert.deepEqual(bad, []);
});

test('тексты участника без тире (U+2012-U+2015) и python3', (t) => {
  const mine = files.filter(PARTICIPANT);
  if (mine.length === 0) return t.skip('нет файлов участника');
  const bad = mine.filter((f) => /[\u2012-\u2015]|python3/.test(read(f)));
  assert.deepEqual(bad, []);
});

// Неразрывный пробел из образца в скилле Claude переписывает в программу обычным: разбор чисел ломается.
test('скиллы без неразрывных и невидимых пробелов', () => {
  const bad = files.filter((f) => f.startsWith('.claude/skills/') && /[\u00a0\u2007\u202f\u200b]/.test(read(f)));
  assert.deepEqual(bad, []);
});

test('скиллы: name совпадает с папкой, description есть', (t) => {
  const skills = files.filter((f) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f));
  if (skills.length === 0) return t.skip('нет скиллов');
  for (const f of skills) {
    const dir = f.split('/')[2];
    const m = read(f).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, `${f}: нет frontmatter`);
    const name = m[1].match(/^name:\s*(.+)$/m);
    const desc = m[1].match(/^description:\s*(.+)$/m);
    assert.ok(name, `${f}: нет name`);
    assert.equal(name[1].trim().replace(/^["']|["']$/g, ''), dir, `${f}: name не совпадает с папкой`);
    assert.ok(desc && desc[1].trim().length > 0, `${f}: нет description`);
  }
});

test('settings: sonnet, без обхода, PYTHONUTF8, input защищён, без автопамяти', () => {
  const p = '.claude/settings.json';
  assert.ok(files.includes(p), 'нет .claude/settings.json');
  const s = JSON.parse(read(p));
  assert.equal(s.model, 'sonnet');
  assert.notEqual(s.permissions.defaultMode, 'bypassPermissions');
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(s.env.PYTHONUTF8, '1');
  assert.ok(s.permissions.deny.includes('Edit(./input/**)'));
  // Инструменты курса запускаются без вопроса, поэтому править их Claude не может.
  assert.ok(s.permissions.deny.includes('Edit(./tools/**)'), 'нужен запрет Edit(./tools/**)');
  // «Запомни» пишется только в мои правила: автопамять проекта не читается и не пишется.
  assert.equal(s.autoMemoryEnabled, false, 'нужен "autoMemoryEnabled": false');
  // Процесс запускается фразой без вопроса, как кнопкой. Поэтому программу процесса Claude пишет только
  // через окно разрешения: правка processes/ всегда спрашивает человека.
  assert.ok(s.permissions.allow.includes('Bash(node tools/processes.mjs*)'), 'нужно разрешение Bash(node tools/processes.mjs*)');
  assert.ok((s.permissions.ask ?? []).includes('Edit(./processes/**)'), 'нужен вопрос Edit(./processes/**)');
  // Демо копирует templates/processes в processes/ и запускается той же разрешённой командой: шаблоны не правятся.
  assert.ok(s.permissions.deny.includes('Edit(./templates/**)'), 'нужен запрет Edit(./templates/**)');
});

test('lint: каждый @import из CLAUDE.md есть в репо или в MANIFEST.to', (t) => {
  if (!files.includes('CLAUDE.md')) return t.skip('нет CLAUDE.md');
  const text = read('CLAUDE.md')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
  const paths = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) =>
    m[1].replace(/[.,;:!?)]+$/, ''),
  );
  assert.ok(paths.length > 0, 'в CLAUDE.md нет @import');
  const created = MANIFEST.map((m) => m.to);
  const missing = paths.filter((p) => !files.includes(p) && !created.includes(p));
  assert.deepEqual(missing, []);
});

// Хук проверки команд: файл курса в репо (обновление его привезёт), имя ASCII, правка под запретом.
test('хук .claude/hooks/guard.mjs отслеживается, имя ASCII, зарегистрирован в settings.json', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const hooks = tracked.filter((f) => f.startsWith('.claude/hooks/'));
  assert.deepEqual(hooks, ['.claude/hooks/guard.mjs']);
  assert.ok(hooks.every((f) => /^[A-Za-z0-9._/-]+$/.test(f)));
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }).status === 0;
  assert.equal(ignored('.claude/hooks/guard.mjs'), false);
  const s = JSON.parse(read('.claude/settings.json'));
  const cmds = (s.hooks?.PreToolUse ?? []).flatMap((h) => h.hooks.map((x) => x.command));
  assert.ok(cmds.some((c) => c.includes('.claude/hooks/guard.mjs')), 'хук не зарегистрирован');
  assert.ok(s.permissions.deny.includes('Edit(./.claude/hooks/**)'), 'нужен запрет Edit(./.claude/hooks/**)');
});

test('файлы участника вне репо: обновление их не перезапишет', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const own = tracked.filter(
    (f) => ['me/', 'site/', 'input/', 'output/'].some((p) => f.startsWith(p)) && !f.endsWith('/.gitkeep') && !isCase(f),
  );
  assert.deepEqual(own, []);
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }).status === 0;
  for (const { from, to } of MANIFEST) {
    assert.ok(files.includes(from), `${from}: шаблона нет в репо`);
    assert.equal(ignored(from), false, `${from}: шаблон попал под .gitignore`);
    assert.equal(ignored(to), true, `${to} не в .gitignore`);
  }
  assert.equal(ignored('.claude/settings.local.json'), true, '.claude/settings.local.json не в .gitignore');
  // Процессы участника его, шаблоны процессов курса в репо.
  assert.equal(ignored('processes/svodka-prodazh/run.py'), true, 'processes/ не в .gitignore');
  assert.equal(ignored('templates/processes/svetofor-dogovorov/run.py'), false, 'шаблоны процессов попали под .gitignore');
});

test('шаблоны me/ начинаются со строки-заглушки, которую узнают правила кабинета', () => {
  const MARK = 'Файл пока не заполнен.';
  for (const f of ['templates/about-me.md', 'templates/rules.md']) {
    const lines = read(f).replace(/\r\n/g, '\n').split('\n');
    assert.equal(lines[0].startsWith('# '), true, `${f}: первая строка не заголовок`);
    assert.ok(lines[2].startsWith(MARK), `${f}: третья строка не начинается с заглушки`);
    assert.equal(lines.filter((l) => l.includes(MARK)).length, 1, `${f}: заглушка не одной строкой`);
  }
  assert.ok(read('CLAUDE.md').includes(`«${MARK}»`));
  assert.ok(read('.claude/skills/about-me/SKILL.md').includes(`«${MARK}»`));
});

test('в tools нет системного копирования папок (падает на кириллице в Node 22 на Windows)', () => {
  const word = ['cp', 'Sync'].join('');
  const bad = files.filter((f) => f.startsWith('tools/') && read(f).includes(word));
  assert.deepEqual(bad, []);
});
