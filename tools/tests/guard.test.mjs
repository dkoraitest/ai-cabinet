// Хук .claude/hooks/guard.mjs: команда пишет в processes/ или .claude/ → окно, в tools/, templates/, input/ → отказ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASONS, classify, hookOutput } from '../../.claude/hooks/guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(ROOT, '.claude', 'hooks', 'guard.mjs');

const NIX = { root: '/home/aigul/ai-cabinet', platform: 'linux' };
const WIN = { root: 'C:\\Users\\Айгуль Н\\ai-cabinet', platform: 'win32' };

const decide = (cmd, ctx) => classify(cmd, ctx)?.decision ?? null;

// [команда, решение, причина (ключ REASONS) или undefined]
const BASH = [
  // Команды курса: без решения, даже если в них есть защищённые папки.
  ['node tools/serve.mjs --open', null],
  ['node tools/check.mjs', null],
  ['node tools/update.mjs', null],
  ['node tools/processes.mjs run svetofor-dogovorov', null],
  ['node tools/processes.mjs demo svetofor-dogovorov', null],
  ['node tools/processes.mjs input svodka-prodazh --no-open', null],
  ['python tools/read_table.py "input/case-azs/data/sales_azs_1c.csv" --rows 3', null],
  ['py tools/read_table.py "input/svodka/Продажи сентябрь.xlsx" --sheet 2', null],
  // Чтение и запись вне защищённых папок: без решения.
  ['ls processes', null],
  ['cat processes/svodka/run.py', null],
  ['head -n 5 input/svodka/sales.csv', null],
  ['sed -n 1,5p input/svodka/sales.csv', null],
  ['mkdir -p output/svodka/input', null],
  ['cp input/svodka/sales.csv output/svodka/', null],
  ['cp -R processes/svodka output/backup/', null],
  ['python tools/read_table.py input/a.xlsx > output/a.txt', null],
  ['cat input/a.csv | tee output/b.csv', null],
  ['echo "# processes и tools" > output/notes.md', null],
  ['rm output/svodka/*.tmp', null],
  ['node tools/processes.mjs list 2>&1 | head -n 20', null],
  ['python -c "print(1)"', null],
  ['python -m pip install --user openpyxl python-docx', null],
  ['node tools/check.mjs > /dev/null 2>&1', null],
  ['cd /tmp && echo x > processes/run.py', null],
  // processes/ и .claude/: окно.
  ['echo "print(1)" > processes/x/run.py', 'ask', 'processes'],
  ["printf 'x' >> './processes/x/run.py'", 'ask', 'processes'],
  ['echo x>processes/x/run.py', 'ask', 'processes'],
  ['echo x 1>processes/x/run.py', 'ask', 'processes'],
  ['echo x &> processes/x/log.txt', 'ask', 'processes'],
  ['cp output/run.py processes/x/', 'ask', 'processes'],
  ['cp -R templates/processes/svetofor-dogovorov processes/', 'ask', 'processes'],
  ['cp -t processes/x output/run.py', 'ask', 'processes'],
  ['mv processes/x/run.py output/', 'ask', 'processes'],
  ['rm processes/x/run.py', 'ask', 'processes'],
  ['rm -rf processes', 'ask', 'processes'],
  ['touch processes/x/run.py', 'ask', 'processes'],
  ['mkdir -p processes/new', 'ask', 'processes'],
  ['rmdir processes/old', 'ask', 'processes'],
  ["sed -i 's/a/b/' processes/x/run.py", 'ask', 'processes'],
  ["sed -i.bak -e 's/a/b/' processes/x/run.py", 'ask', 'processes'],
  ['echo x | tee -a processes/x/run.py', 'ask', 'processes'],
  ['ln -sf /tmp/evil.py processes/x/run.py', 'ask', 'processes'],
  ['ln -s ../processes output/p', 'ask', 'processes'],
  ['install -m 755 a.py processes/x/run.py', 'ask', 'processes'],
  ['dd if=/dev/zero of=processes/x/run.py', 'ask', 'processes'],
  ['find processes -name "*.pyc" -delete', 'ask', 'processes'],
  ["cat > processes/x/run.py <<'EOF'\nimport os\nprint('it\\'s')\nEOF", 'ask', 'processes'],
  ['cd processes/x && echo x > run.py', 'ask', 'processes'],
  ['cd processes; touch run.py', 'ask', 'processes'],
  ['env A=1 cp a.py processes/x/run.py', 'ask', 'processes'],
  ['D=processes; echo x > $D/run.py', 'ask', 'processes'],
  ['echo x > "$CLAUDE_PROJECT_DIR/processes/x/run.py"', 'ask', 'processes'],
  ['echo x > /home/aigul/ai-cabinet/processes/x/run.py', 'ask', 'processes'],
  ['echo x > output/../processes/x/run.py', 'ask', 'processes'],
  ['node tools/processes.mjs run x && echo x > processes/x/run.py', 'ask', 'processes'],
  ['node tools/processes.mjs list > processes/x/run.py', 'ask', 'processes'],
  ['python -c "open(\'processes/x/run.py\',\'w\').write(\'x\')"', 'ask', 'processes'],
  ["node -e \"require('fs').writeFileSync('processes/x/run.py','')\"", 'ask', 'processes'],
  ["bash -c 'echo x > processes/x/run.py'", 'ask', 'processes'],
  ['python - <<EOF\nopen("processes/x/run.py", "w")\nEOF', 'ask', 'processes'],
  ['echo x > `echo processes`/run.py', 'ask', 'processes'],
  ['echo x > $(echo processes)/run.py', 'ask', 'processes'],
  ['curl -o processes/x/run.py https://example.com/a.py', 'ask', 'processes'],
  ['echo x > .claude/skills/moi/SKILL.md', 'ask', 'claude'],
  ['echo "{}" > .claude/settings.local.json', 'ask', 'claude'],
  ['echo x >> ~/ai-cabinet/.claude/settings.local.json', 'ask', 'claude'],
  ['rm -rf .claude/skills/moi', 'ask', 'claude'],
  // tools/, templates/, .claude/hooks/, input/: отказ.
  ['echo x > tools/serve.mjs', 'deny', 'course'],
  ['cp evil.mjs tools/processes.mjs', 'deny', 'course'],
  ['rm -rf templates/processes', 'deny', 'course'],
  ["sed -i 's/a/b/' templates/processes/svetofor-dogovorov/run.py", 'deny', 'course'],
  ['echo x > .claude/hooks/guard.mjs', 'deny', 'course'],
  ['rm -rf .claude', 'deny', 'course'],
  ['echo x > input/svodka/sales.csv', 'deny', 'input'],
  ['mkdir -p input/svodka', 'deny', 'input'],
  ['mv input/a.xlsx output/', 'deny', 'input'],
  ['touch input/new.txt', 'deny', 'input'],
  ['rm -rf .', 'deny'],
  ['rm -rf *', 'deny'],
  ['find . -delete', 'deny'],
  ['echo x > processes/a; echo y > tools/b', 'deny', 'course'],
  // Код в -c или -e упоминает файлы курса: окно с общим текстом.
  ['python -c "import shutil; shutil.copy(\'a\', \'tools/x\')"', 'ask', 'unclear'],
  ['git checkout -- tools/serve.mjs', 'ask', 'unclear'],
];

const POWERSHELL = [
  ["Set-Content -Path 'processes\\x\\run.py' -Value 'print(1)'", 'ask', 'processes'],
  ["Set-Content -Path output\\notes.txt -Value 'processes\\x'", null],
  ["'x' | Out-File -FilePath processes\\x\\run.py -Encoding utf8", 'ask', 'processes'],
  ["Add-Content processes\\x\\run.py 'x'", 'ask', 'processes'],
  ["New-Item -ItemType File -Path processes\\x\\run.py -Value 'print(1)'", 'ask', 'processes'],
  ["New-Item -ItemType Directory -Force -Path 'processes', 'output\\x'", 'ask', 'processes'],
  ["New-Item -ItemType Directory -Force -Path 'processes', 'input\\svetofor-dogovorov'", 'deny', 'input'],
  ["Copy-Item -Recurse -Force -LiteralPath 'templates\\processes\\svetofor-dogovorov' -Destination 'processes\\svetofor-dogovorov'", 'ask', 'processes'],
  ["Copy-Item -LiteralPath 'input\\case-azs\\data\\reestr_dogovorov.xlsx' -Destination 'output\\reestr.xlsx'", null],
  ['Move-Item processes\\x\\run.py output\\', 'ask', 'processes'],
  ['Remove-Item -Recurse -Force processes\\x', 'ask', 'processes'],
  ['Remove-Item -Recurse -Force tools', 'deny', 'course'],
  ['ni processes\\x\\run.py', 'ask', 'processes'],
  ["echo 'x' > processes\\x\\run.py", 'ask', 'processes'],
  ["Write-Output 'x' *> processes\\x\\log.txt", 'ask', 'processes'],
  ['Set-Location processes\\x; Set-Content run.py x', 'ask', 'processes'],
  ["[IO.File]::WriteAllText('processes\\x\\run.py', 'x')", 'ask', 'processes'],
  ["powershell -Command \"Set-Content processes\\x\\run.py x\"", 'ask', 'processes'],
  ['cmd /c "echo x > processes\\x\\run.py"', 'ask', 'processes'],
  ['echo x > "C:\\Users\\Айгуль Н\\ai-cabinet\\processes\\x\\run.py"', 'ask', 'processes'],
  ['echo x > "C:/USERS/АЙГУЛЬ Н/AI-CABINET/Processes/x/run.py"', 'ask', 'processes'],
  ['echo x > "/c/Users/Айгуль Н/ai-cabinet/tools/serve.mjs"', 'deny', 'course'],
  ['echo x > "D:\\other\\processes\\run.py"', null],
  ['Get-Content processes\\x\\run.py', null],
  ['node tools\\processes.mjs run svetofor-dogovorov', null],
  ['py tools\\read_table.py "input\\Отчёт сентябрь.xlsx"', null],
  ['node tools/check.mjs > $null', null],
];

for (const [label, ctx, table] of [
  ['bash', NIX, BASH],
  ['PowerShell и пути Windows', WIN, POWERSHELL],
]) {
  test(`classify: таблица команд (${label})`, () => {
    const wrong = [];
    for (const [cmd, want, why] of table) {
      const got = classify(cmd, ctx);
      if ((got?.decision ?? null) !== want || (why && got.reason !== REASONS[why] && !got.reason.includes(REASONS[why]))) {
        wrong.push(`${JSON.stringify(cmd)}: ждали ${want}${why ? `/${why}` : ''}, получили ${got ? `${got.decision}: ${got.reason}` : 'null'}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
}

test('classify: папка, где идёт команда (cwd внутри processes), учитывается', () => {
  assert.equal(decide('echo x > run.py', { ...NIX, cwd: '/home/aigul/ai-cabinet/processes/x' }), 'ask');
  assert.equal(decide('echo x > run.py', { ...NIX, cwd: '/home/aigul/ai-cabinet/output' }), null);
  assert.equal(decide('touch ../tools/x', { ...NIX, cwd: '/home/aigul/ai-cabinet/output' }), 'deny');
  assert.equal(decide('Set-Content run.py x', { ...WIN, cwd: 'C:\\Users\\Айгуль Н\\ai-cabinet\\processes\\x' }), 'ask');
});

test('классификатор не падает на странных строках', () => {
  for (const cmd of ['', '   ', '"', "'", '>', '>>', '<<', '2>&1', '|||', 'echo "незакрытая', '$(', '`', '((', 'cd', 'cd -; rm x', '\\\\']) {
    assert.doesNotThrow(() => classify(cmd, NIX), cmd);
    assert.doesNotThrow(() => classify(cmd, WIN), cmd);
  }
  assert.equal(classify(undefined, NIX), null);
  // Незакрытая кавычка: путь не разобрать, но processes упомянута рядом с записью.
  assert.equal(decide('echo "x > processes/x/run.py', NIX), 'ask');
  // cd с переменной: дальше относительные пути не ясны.
  assert.equal(decide('cd $D && touch run.py processes', NIX), 'ask');
});

test('тексты причин: по-русски, без тире и без слов, которых человеку не говорят', () => {
  for (const [k, text] of Object.entries(REASONS)) {
    assert.match(text, /[А-Яа-я]/, k);
    assert.doesNotMatch(text, /[\u2012-\u2015]/, k);
    assert.doesNotMatch(text, /скрипт|порт|сервер|терминал|консол|в фоне/i, k);
  }
  assert.equal(REASONS.processes, 'Claude хочет изменить программу процесса командой. Разрешите, только если вы это просили.');
});

test('hookOutput: формат PreToolUse, не-ASCII экранирован, без решения пусто', () => {
  assert.equal(hookOutput(null), '');
  const out = hookOutput({ decision: 'ask', reason: REASONS.processes });
  assert.match(out, /^[\x20-\x7e]+$/);
  assert.deepEqual(JSON.parse(out), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: REASONS.processes },
  });
});

function runHook(input) {
  return spawnSync(process.execPath, [GUARD], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
}

test('хук как процесс: JSON из stdin, решение в stdout, код 0', () => {
  const ask = runHook({ tool_name: 'Bash', cwd: ROOT, tool_input: { command: 'echo x > processes/x/run.py' } });
  assert.equal(ask.status, 0, ask.stderr);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecisionReason, REASONS.processes);
  const deny = runHook({ tool_name: 'Bash', cwd: ROOT, tool_input: { command: 'cp x tools/serve.mjs' } });
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const none = runHook({ tool_name: 'Bash', cwd: ROOT, tool_input: { command: 'node tools/processes.mjs run x' } });
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '');
  for (const bad of ['', 'не JSON', '{}', '{"tool_input":{}}']) {
    const r = runHook(bad);
    assert.equal(r.status, 0, bad);
    assert.equal(r.stdout, '', bad);
  }
});

test('settings.json: хук на Bash и PowerShell, правка хука под запретом, py для просмотра таблиц', () => {
  const s = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const pre = s.hooks?.PreToolUse ?? [];
  const entry = pre.find((h) => /(^|\|)Bash(\||$)/.test(h.matcher) && /(^|\|)PowerShell(\||$)/.test(h.matcher));
  assert.ok(entry, 'нет PreToolUse с matcher Bash|PowerShell');
  const cmd = entry.hooks.find((h) => h.type === 'command')?.command ?? '';
  assert.match(cmd, /^node "\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/guard\.mjs"$/);
  assert.ok(s.permissions.deny.includes('Edit(./.claude/hooks/**)'), 'нужен запрет Edit(./.claude/hooks/**)');
  assert.ok(s.permissions.allow.includes('Bash(py tools/read_table.py*)'), 'нужно разрешение Bash(py tools/read_table.py*)');
});
