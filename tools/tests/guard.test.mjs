// Сторож .claude/hooks/guard.mjs: любая команда, кроме команд курса, которая упоминает processes или .claude
// в любом написании или идёт изнутри них, спрашивает окно. tools/, templates/, input/ закрывают запреты Edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASON, classify, hookOutput, looseForms } from '../../.claude/hooks/guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(ROOT, '.claude', 'hooks', 'guard.mjs');

const NIX = { tool: 'Bash', roots: ['/home/aigul/ai-cabinet'], cwds: ['/home/aigul/ai-cabinet'], platform: 'linux' };
const WIN = {
  tool: 'PowerShell',
  roots: ['C:\\Users\\Айгуль Н\\ai-cabinet'],
  cwds: ['C:\\Users\\Айгуль Н\\ai-cabinet'],
  platform: 'win32',
};
const GITBASH = { ...WIN, tool: 'Bash' };

const ASK_BASH = [
  // Найдено на ревью: обход через \ и cp без окна.
  "echo '# e1' >> proc\\esses/x/run.py",
  'cp output/a.py proc\\esses/x/a1.py',
  'echo x > processes/x/run.py',
  'ls processes',
  'cat processes/x/run.py',
  "echo x > 'proc''esses'/x/run.py",
  'echo x > "pro"cesses/x/run.py',
  'echo x > pro{c,}esses/x/run.py',
  'echo x > {proc,xx}esses/x/run.py',
  "echo x > $'\\x70rocesses'/x/run.py",
  "echo x > $'\\160rocesses'/x/run.py",
  "echo x > proc$''esses/x/run.py",
  'echo x > p*/x/run.py',
  'echo x > ./proc?sses/x/run.py',
  'echo x > [p]rocesses/x/run.py',
  'echo x > output/../p*/x/run.py',
  'echo x > ${D:-processes}/x/run.py',
  'D=processes; echo x > $D/x/run.py',
  'echo x > /home/aigul/ai-cabinet/processes/x/run.py',
  'echo x > /home/aigul/ai-cabinet/p*/x/run.py',
  'echo x > processes./x/run.py',
  'echo x > "processes /x/run.py"',
  'echo x > PROCES~1/x/run.py',
  'echo x > CLAUDE~1/settings.local.json',
  'echo x > PROCESSES/x/run.py',
  "python -c \"open('processes/x/run.py','w').write('x')\"",
  "bash -c 'echo x > processes/x/run.py'",
  'cmd /c "echo x > proc^esses\\x\\run.py"',
  'node tools/processes.mjs run x && echo x > processes/x/run.py',
  'node tools/processes.mjs list > processes/x/run.py',
  'cd processes/x && echo x > run.py',
  'echo x > .claude/settings.local.json',
  'echo x > .clau\\de/settings.local.json',
  'cp evil.mjs .claude/hooks/guard.mjs',
  'echo x >> ~/ai-cabinet/.claude/skills/moi/SKILL.md',
  'rm -rf .claude/skills/moi',
];

const ASK_POWERSHELL = [
  'Set-Content -Path:processes\\x\\run.py -Value:x',
  'Add-Content -Path:processes\\x\\run.py -Value:x',
  'Clear-Content -Path:processes\\x\\run.py',
  'Remove-Item -Path:processes\\x -Recurse',
  'Set-Content proc`esses\\x\\run.py x',
  'Set-Content ("proc" + "esses" + "\\x\\run.py") x',
  "New-Item -ItemType Directory -Force -Path 'processes', 'output\\x'",
  "Copy-Item -Recurse -Force -LiteralPath 'templates\\processes\\svetofor-dogovorov' -Destination 'processes\\svetofor-dogovorov'",
  'Set-Content PROCES~1\\x\\run.py x',
  'Set-Content processes.\\x\\run.py x',
  'Set-Content processes...\\x\\run.py x',
  "Set-Content 'processes \\x\\run.py' x",
  "[IO.File]::WriteAllText('processes\\x\\run.py', 'x')",
  'echo x > "C:\\Users\\Айгуль Н\\ai-cabinet\\processes\\x\\run.py"',
  'Set-Location processes\\x; Set-Content run.py x',
  "Set-Content -LiteralPath:.claude\\settings.local.json -Value:'{}'",
  'Set-Content CLAUDE~1\\settings.local.json x',
];

const NONE = [
  // Команды курса целиком.
  'node tools/serve.mjs --open',
  'node tools/check.mjs',
  'node tools/check.mjs --json',
  'node tools/update.mjs',
  'node tools/processes.mjs run svetofor-dogovorov',
  'node tools/processes.mjs demo svetofor-dogovorov',
  'node tools/processes.mjs input svodka-prodazh --no-open',
  'node tools/processes.mjs list',
  'node tools\\processes.mjs list',
  'python tools/read_table.py "input/case-azs/data/sales_azs_1c.csv" --rows 3',
  'py tools/read_table.py "input\\svodka\\Продажи сентябрь.xlsx" --sheet 2',
  'python tools/read_table.py "processes/svodka/data.csv"',
  // Чтение input/ и другие обычные команды: без решения сторожа.
  "python -c \"import openpyxl; wb = openpyxl.load_workbook('input/case-azs/data/reestr_dogovorov.xlsx'); print(wb.sheetnames)\"",
  "python - <<'EOF'\nimport openpyxl\nwb = openpyxl.load_workbook('input/case-azs/data/reestr_dogovorov.xlsx')\nprint(wb.sheetnames)\nEOF",
  "awk -F';' '{print $1}' input/case-azs/data/sales_azs_1c.csv",
  'head -n 5 input/svodka/sales.csv',
  'cat input/a.csv | tee output/b.csv',
  'node tools/processes.mjs list | head -n 20',
  'node tools/processes.mjs input svodka --no-open 2>&1',
  'python -m pip install --user openpyxl python-docx',
  'ls output',
  'rm output/svodka/*.tmp',
  'cp *.csv output/',
  'node --version',
  'echo "# заметки" > output/notes.md',
  // tools/, templates/, input/: решает не сторож, а запреты Edit в settings.json.
  'echo x > tools/serve.mjs',
  'echo x > templ\\ates/x.txt',
  'mkdir -p input/svodka',
];

const NONE_POWERSHELL = [
  'node tools\\processes.mjs run svetofor-dogovorov',
  'py tools\\read_table.py "input\\Отчёт сентябрь.xlsx"',
  "Get-Content input\\case-azs\\data\\sales_azs_1c.csv -TotalCount 5",
  "Copy-Item -LiteralPath 'input\\case-azs\\data\\reestr_dogovorov.xlsx' -Destination 'output\\reestr.xlsx'",
];

function check(table, ctx, want) {
  const wrong = [];
  for (const cmd of table) {
    const got = classify(cmd, ctx);
    const ok = want ? got?.decision === 'ask' && got.reason === REASON : got === null;
    if (!ok) wrong.push(`${JSON.stringify(cmd)}: получили ${got ? got.decision : 'null'}`);
  }
  assert.deepEqual(wrong, []);
}

test('сторож: обходы из ревью и другие написания processes и .claude спрашивают окно (bash)', () => {
  check(ASK_BASH, NIX, true);
  check(ASK_BASH, GITBASH, true);
});

test('сторож: PowerShell, параметры через двоеточие, `, склейка строк, 8.3, точка и пробел в конце', () => {
  check(ASK_POWERSHELL, WIN, true);
});

test('сторож: команды курса, чтение input/ и запись в tools/, templates/, input/ без решения', () => {
  check(NONE, NIX, false);
  check(NONE, GITBASH, false);
  check(NONE_POWERSHELL, WIN, false);
});

test('сторож: команда изнутри processes/ или .claude/ кабинета спрашивает; другие инструменты без решения', () => {
  assert.equal(classify('echo x > run.py', { ...NIX, cwds: ['/home/aigul/ai-cabinet/processes/x'] })?.decision, 'ask');
  assert.equal(classify('echo x > a.md', { ...NIX, cwds: ['/home/aigul/ai-cabinet/.claude/skills'] })?.decision, 'ask');
  assert.equal(classify('echo x > run.py', { ...NIX, cwds: ['/home/aigul/ai-cabinet/output'] }), null);
  // Настоящий путь папки (ссылка или другой корень, например CLAUDE_PROJECT_DIR) тоже сравнивается.
  const ctx = { ...NIX, roots: ['/home/aigul/ai-cabinet', '/mnt/real/ai-cabinet'], cwds: ['/tmp/link', '/mnt/real/ai-cabinet/processes/x'] };
  assert.equal(classify('echo x > run.py', ctx)?.decision, 'ask');
  assert.equal(classify('Set-Content run.py x', { ...WIN, cwds: ['C:\\Users\\Айгуль Н\\AI-CABINET\\Processes\\x'] })?.decision, 'ask');
  assert.equal(classify('cat processes/x/run.py', { ...NIX, tool: 'Read' }), null);
});

test('looseForms: обратная косая черта и убрана, и как разделитель; кавычки и ` убраны', () => {
  const forms = looseForms('Echo "A" > proc\\esses\\X');
  assert.ok(forms.includes('echo a > processesx'));
  assert.ok(forms.includes('echo a > proc/esses/x'));
});

test('классификатор не падает на странных строках', () => {
  for (const cmd of ['', '   ', '"', "'", '>', '<<', '2>&1', '|||', 'echo "незакрытая', '$(', '`', '((', '[', '[[[', 'cd', "$'\\U110000'", '{'.repeat(50) + ','.repeat(50), '\\\\']) {
    assert.doesNotThrow(() => classify(cmd, NIX), cmd);
    assert.doesNotThrow(() => classify(cmd, WIN), cmd);
  }
  assert.equal(classify(undefined, NIX), null);
});

test('текст окна: по-русски, без тире и без слов, которых человеку не говорят', () => {
  assert.equal(REASON, 'Claude хочет выполнить команду, которая касается программ процессов или настроек кабинета. Разрешите, только если вы сами это просили.');
  assert.doesNotMatch(REASON, /[\u2012-\u2015]|скрипт|порт|сервер|терминал|консол|в фоне/i);
});

test('hookOutput: формат PreToolUse, не-ASCII экранирован, без решения пусто', () => {
  assert.equal(hookOutput(null), '');
  const out = hookOutput({ decision: 'ask', reason: REASON });
  assert.match(out, /^[\x20-\x7e]+$/);
  assert.deepEqual(JSON.parse(out), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: REASON },
  });
});

function runHook(input, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('хук как процесс: JSON из stdin, решение в stdout, код 0', () => {
  const ask = runHook({ tool_name: 'Bash', cwd: ROOT, tool_input: { command: "echo '# e1' >> proc\\esses/x/run.py" } });
  assert.equal(ask.status, 0, ask.stderr);
  assert.deepEqual(JSON.parse(ask.stdout).hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: REASON,
  });
  const ps = runHook({ tool_name: 'PowerShell', cwd: ROOT, tool_input: { command: 'Set-Content -Path:processes\\x\\run.py -Value:x' } });
  assert.equal(JSON.parse(ps.stdout).hookSpecificOutput.permissionDecision, 'ask');
  for (const command of ['node tools/processes.mjs run x', 'echo x > tools/serve.mjs', "awk '{print $1}' input/a.csv"]) {
    const r = runHook({ tool_name: 'Bash', cwd: ROOT, tool_input: { command } });
    assert.equal(r.status, 0, command);
    assert.equal(r.stdout, '', command);
  }
  assert.equal(runHook({ tool_name: 'Write', cwd: ROOT, tool_input: { file_path: 'processes/x/run.py', content: 'x' } }).stdout, '');
  for (const bad of ['', 'не JSON', '{}', '{"tool_input":{}}']) {
    const r = runHook(bad);
    assert.equal(r.status, 0, bad);
    assert.equal(r.stdout, '', bad);
  }
});

test('хук как процесс: корень из CLAUDE_PROJECT_DIR и настоящий путь папки команды', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')));
  try {
    const cab = join(base, 'Айгуль Н', 'ai-cabinet');
    mkdirSync(join(cab, 'processes', 'x'), { recursive: true });
    const inside = runHook({ tool_name: 'Bash', cwd: join(cab, 'processes', 'x'), tool_input: { command: 'echo x > run.py' } }, { CLAUDE_PROJECT_DIR: cab });
    assert.equal(JSON.parse(inside.stdout).hookSpecificOutput.permissionDecision, 'ask');
    const outside = runHook({ tool_name: 'Bash', cwd: join(cab), tool_input: { command: 'echo x > run.py' } }, { CLAUDE_PROJECT_DIR: cab });
    assert.equal(outside.stdout, '');
    const link = join(base, 'ssylka');
    try {
      symlinkSync(join(cab, 'processes', 'x'), link, 'junction');
    } catch (e) {
      return t.skip(`ссылки на папки недоступны (${e.code})`);
    }
    const viaLink = runHook({ tool_name: 'Bash', cwd: link, tool_input: { command: 'echo x > run.py' } }, { CLAUDE_PROJECT_DIR: cab });
    assert.equal(JSON.parse(viaLink.stdout).hookSpecificOutput.permissionDecision, 'ask');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('settings.json: сторож без оболочки (exec) на Bash и PowerShell, правка хука под запретом, py для таблиц', () => {
  const s = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const pre = s.hooks?.PreToolUse ?? [];
  const entry = pre.find((h) => /(^|\|)Bash(\||$)/.test(h.matcher) && /(^|\|)PowerShell(\||$)/.test(h.matcher));
  assert.ok(entry, 'нет PreToolUse с matcher Bash|PowerShell');
  const hook = entry.hooks.find((h) => h.type === 'command');
  assert.equal(hook.command, 'node');
  assert.deepEqual(hook.args, ['${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.mjs']);
  assert.ok(s.permissions.deny.includes('Edit(./.claude/hooks/**)'), 'нужен запрет Edit(./.claude/hooks/**)');
  for (const d of ['Edit(./input/**)', 'Edit(./tools/**)', 'Edit(./templates/**)']) assert.ok(s.permissions.deny.includes(d), d);
  assert.ok(s.permissions.allow.includes('Bash(py tools/read_table.py*)'), 'нужно разрешение Bash(py tools/read_table.py*)');
});
