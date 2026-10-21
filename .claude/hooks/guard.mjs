// Проверка команд Claude перед запуском (хук PreToolUse для Bash и PowerShell). Без зависимостей.
//
// Режим автоприёма правок пропускает без окна команды вроде `echo ... > processes/x/run.py` или `cp`,
// а запуск процесса фразой разрешён. Без проверки текст из входного файла мог бы записать программу
// процесса и запустить её без единого окна. Поэтому команда, которая пишет, переносит или удаляет:
//   - в processes/ или .claude/: окно разрешения (ask) с объяснением для человека;
//   - в tools/, templates/, .claude/hooks/ или input/: отказ (deny) с объяснением для Claude.
// Команды курса из разрешённых (node tools/serve.mjs, check.mjs, update.mjs, processes.mjs и
// python или py tools/read_table.py) одной простой командой проходят без проверки.
// Разбор осторожный: если путь не ясен (переменная, вложенная оболочка, код в -c или -e), а команда
// упоминает защищённую папку, Claude спрашивает окном.
//
// Вход: JSON в stdin с tool_input.command и cwd. Выход: пусто (решения нет) или
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask|deny","permissionDecisionReason":"..."}}.
// Код выхода всегда 0.
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REASONS = {
  processes: 'Claude хочет изменить программу процесса командой. Разрешите, только если вы это просили.',
  claude: 'Claude хочет изменить скилл или настройки кабинета командой. Разрешите, только если вы это просили.',
  unclear:
    'Claude хочет выполнить команду, которая может изменить программу процесса, файлы курса или ваши файлы в папке input. Разрешите, только если вы это просили.',
  course:
    'Файлы курса в папках tools, templates и .claude/hooks менять нельзя, в том числе командой: при обновлении кабинета они вернутся к версии курса. Скажи человеку, что этот файл курса не меняется.',
  input:
    'Файлы в папке input: оригиналы человека. Их не меняют, не удаляют и не создают рядом новые. Сохрани результат или копию в output.',
};

// Защищённые папки от корня кабинета. Более узкая папка раньше: .claude/hooks строже, чем .claude.
const AREAS = [
  { id: 'hooks', path: ['.claude', 'hooks'], level: 'deny', reason: 'course' },
  { id: 'claude', path: ['.claude'], level: 'ask', reason: 'claude' },
  { id: 'processes', path: ['processes'], level: 'ask', reason: 'processes' },
  { id: 'tools', path: ['tools'], level: 'deny', reason: 'course' },
  { id: 'templates', path: ['templates'], level: 'deny', reason: 'course' },
  { id: 'input', path: ['input'], level: 'deny', reason: 'input' },
];

// Разрешённые команды курса: только целиком, одной простой командой без перенаправлений.
const COURSE_COMMANDS = [
  /^node$/,
  /^(\.\/)?tools\/(serve|check|update|processes)\.mjs$/,
  /^(python|py)$/,
  /^(\.\/)?tools\/read_table\.py$/,
];

// Что команда делает с путями.
//   all: меняется каждый путь (кроме значений опций из skip);
//   dest: меняется только место назначения (опция из dest или последний путь);
//   deep: удаление или перенос папки затрагивает всё внутри.
const SPEC = new Map();
const def = (names, spec) => names.split(' ').forEach((n) => SPEC.set(n, spec));
def('rm unlink shred del erase rd rmdir remove-item ri', { kind: 'all', deep: true });
def('mv move move-item mi rename ren rename-item rni', { kind: 'all', deep: true, skip: ['-s', '--suffix'] });
def('touch truncate', { kind: 'all', skip: ['-d', '--date', '-r', '--reference', '-t', '-s', '--size'] });
def('mkdir md new-item ni', { kind: 'all', skip: ['-m', '--mode', '-itemtype', '-type', '-value'] });
def('tee tee-object', { kind: 'all', skip: ['-variable'] });
// Ссылка ведёт в защищённую папку: запись через неё попала бы туда же. Поэтому и цель ссылки, и сама ссылка.
def('ln mklink', { kind: 'all', skip: ['--suffix'] });
def('set-content sc add-content ac out-file clear-content clc export-csv epcsv export-clixml', {
  kind: 'all',
  skip: ['-value', '-encoding', '-inputobject', '-width', '-stream', '-delimiter'],
});
def('cp copy copy-item cpi install rsync scp xcopy robocopy', {
  kind: 'dest',
  dest: ['-t', '--target-directory', '-destination'],
  skip: ['-m', '--mode', '-o', '--owner', '-g', '--group', '--suffix', '-filter', '-include', '-exclude'],
});

// Пишут куда угодно, путь не разобрать: решает упоминание защищённой папки в команде.
const OPAQUE = new Set(
  (
    'eval source . xargs iex invoke-expression invoke-command icm start-process saps start ' +
    'curl wget invoke-webrequest iwr invoke-restmethod irm start-bitstransfer ' +
    'tar unzip 7z 7za expand-archive compress-archive git patch awk gawk mawk'
  ).split(' '),
);

// Интерпретаторы: опасны, когда код в самой команде (-c, -e) или идёт из stdin, без файла программы.
const INTERPRETER = /^(python(3(\.\d+)?)?|py|pythonw|node|deno|bun|perl|ruby|php|bash|sh|zsh|dash|ksh|fish|cmd|powershell|pwsh|osascript)$/;
const INLINE_FLAG = /^(-c|-e|-E|-p|-i|-pi|-pe|-ne|-r|--eval|--print|-command|-encodedcommand|-ec|\/c|\/k)$/i;
// Обёртки: настоящая команда идёт дальше. Значения опций обёрток пропускаются.
const WRAPPERS = {
  env: ['-u', '--unset', '-c', '--chdir', '-s', '--split-string'],
  nohup: [],
  time: [],
  command: [],
  builtin: [],
  exec: ['-a'],
  sudo: ['-u', '-g', '-p', '-c', '-h', '-r', '-t', '-d', '-c'],
  nice: ['-n'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
};
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const NULL_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', 'nul', '$null']);

const hasGlob = (s) => /[*?[]/.test(s);
const isAbs = (p) => p.startsWith('/') || /^[a-z]:\//i.test(p);
const unclearPath = (p) => /[$`%]/.test(p) || p.startsWith('~');

function normalizePath(p) {
  const abs = isAbs(p);
  const drive = /^[a-z]:/i.test(p) ? p.slice(0, 2) : '';
  const parts = [];
  for (const c of p.slice(drive.length).split('/')) {
    if (c === '' || c === '.') continue;
    if (c === '..') parts.pop();
    else parts.push(c);
  }
  return (drive ? drive : '') + (abs ? '/' : '') + parts.join('/');
}

function globRe(pattern) {
  const body = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

const sameName = (comp, name) => (hasGlob(comp) ? globRe(comp).test(name) : comp.toLowerCase() === name.toLowerCase());

// Какие защищённые папки затрагивает путь rel (от корня кабинета, части через /).
function areasOfRel(rel, deep) {
  const comps = rel.split('/').filter((c) => c && c !== '.');
  const hit = [];
  for (const a of AREAS) {
    const n = Math.min(comps.length, a.path.length);
    let match = true;
    for (let i = 0; i < n; i++) if (!sameName(comps[i], a.path[i])) match = false;
    if (!match) continue;
    // Внутри папки или сама папка; путь выше неё задевает её только удалением или переносом.
    if (comps.length >= a.path.length || deep) hit.push(a);
  }
  return hit;
}

// Упоминания защищённых папок в тексте команды (для путей и кода, которые не разобрать).
export function mentions(text) {
  const hit = [];
  for (const a of AREAS) {
    const name = a.path.join('/').replace(/\./g, '\\.');
    const re = new RegExp(`(^|[\\s"'=:;,(|&<>/{\`])(\\./)*${name}(/|$|[\\s"';,)|&<>}\`])`, 'i');
    if (re.test(text)) hit.push(a);
  }
  return hit;
}

// Разбор строки на простые команды: слова и цели перенаправлений. Обратная косая черта уже заменена
// на / (пути Windows). unclear: подстановка $(...) или `...`, незакрытая кавычка и подобное.
export function lex(text) {
  const cmds = [];
  let cur = { words: [], redirects: [] };
  let word = null;
  let quote = null;
  let next = null; // 'redirect' | 'input' | 'heredoc': чем станет следующее слово
  let unclear = false;
  const heredocs = [];
  const push = () => {
    if (word === null) return;
    if (next === 'redirect') cur.redirects.push(word);
    else if (next === 'heredoc') heredocs.push(word);
    else if (next !== 'input') cur.words.push(word);
    next = null;
    word = null;
  };
  const end = () => {
    push();
    if (next) unclear = true;
    next = null;
    if (cur.words.length || cur.redirects.length) cmds.push(cur);
    cur = { words: [], redirects: [] };
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else {
        if (quote === '"' && (c === '`' || (c === '$' && text[i + 1] === '('))) unclear = true;
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      if (word === null) word = '';
      continue;
    }
    if (c === '`' || (c === '$' && text[i + 1] === '(')) unclear = true;
    if (c === '\n') {
      end();
      // Тело heredoc: строки до разделителя, это данные команды.
      while (heredocs.length) {
        const stop = heredocs.shift();
        let j = i + 1;
        for (;;) {
          const eol = text.indexOf('\n', j);
          const line = text.slice(j, eol === -1 ? text.length : eol);
          j = eol === -1 ? text.length : eol + 1;
          if (line.trim() === stop || eol === -1) break;
        }
        i = j - 1;
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      push();
      continue;
    }
    if (c === '>' || (c === '&' && text[i + 1] === '>')) {
      // Номер потока перед >: 2>, 1>>, *> (PowerShell).
      if (word !== null && /^(\d+|\*)$/.test(word)) word = null;
      push();
      if (c === '&') i++;
      while (text[i + 1] === '>' || text[i + 1] === '|') i++;
      if (text[i + 1] === '&') {
        // >&2, 2>&1: поток в поток, файла нет.
        i++;
        while (/[0-9-]/.test(text[i + 1] ?? '')) i++;
        continue;
      }
      next = 'redirect';
      continue;
    }
    if (c === '<') {
      push();
      if (text[i + 1] === '(') {
        unclear = true;
        continue;
      }
      if (text.startsWith('<<<', i)) {
        i += 2;
        next = 'input';
      } else if (text[i + 1] === '<') {
        i++;
        if (text[i + 1] === '-') i++;
        next = 'heredoc';
      } else {
        next = 'input';
      }
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      end();
      continue;
    }
    word = (word ?? '') + c;
  }
  if (quote) unclear = true;
  end();
  return { cmds, unclear };
}

// Имя программы: без пути и .exe, строчными.
const progName = (w) => w.split('/').pop().toLowerCase().replace(/\.exe$/, '');

// Слова после обёрток (env, nohup, sudo ...) и присваиваний VAR=значение. moved: обёртка меняет папку
// (env -C, sudo -D) или запускает строку целиком (env -S): относительные пути уже не ясны.
function stripWrappers(words) {
  let i = 0;
  let moved = false;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (i >= words.length) return { words: [], moved };
    const name = progName(words[i]);
    if (!Object.hasOwn(WRAPPERS, name)) return { words: words.slice(i), moved };
    const valued = new Set(WRAPPERS[name]);
    i++;
    while (i < words.length && words[i].startsWith('-')) {
      const opt = words[i].toLowerCase().split('=')[0];
      if (/^(-c|--chdir|-d|--chdir|-s|--split-string)$/.test(opt) && (name === 'env' || name === 'sudo')) moved = true;
      if (valued.has(opt) && !words[i].includes('=')) i++;
      i++;
    }
    // timeout 10 команда: длительность перед командой.
    if (name === 'timeout' && i < words.length && /^\d/.test(words[i])) i++;
  }
}

function splitList(words) {
  // PowerShell: -Path 'a', 'b' и a,b дают несколько путей.
  return words.flatMap((w) => w.split(',')).filter((w) => w !== '');
}

// Пути, которые команда меняет: { paths, deep } или { opaque: true } или null (не пишет).
function writeTargets(words) {
  const name = progName(words[0]);
  const args = splitList(words.slice(1));
  if (INTERPRETER.test(name)) {
    const positional = args.filter((a) => !a.startsWith('-') && !/^\/[ck]$/i.test(a));
    if (args.some((a) => INLINE_FLAG.test(a)) || positional.length === 0 || positional[0] === '-') return { opaque: true };
    if (/^(cmd|powershell|pwsh)$/.test(name) && !args.some((a) => /^-file$/i.test(a))) return { opaque: true };
    return null;
  }
  if (OPAQUE.has(name)) return { opaque: true };
  if (/^\[(system\.)?io\.(file|directory)\]::/i.test(words[0])) return { opaque: true };
  if (name === 'sed') {
    if (!args.some((a) => /^(-[a-z]*i|--in-place)/i.test(a))) return null;
    return { paths: args.filter((a) => !a.startsWith('-')), deep: false };
  }
  if (name === 'dd') {
    return { paths: args.filter((a) => a.toLowerCase().startsWith('of=')).map((a) => a.slice(3)), deep: false };
  }
  if (name === 'find') {
    if (args.some((a) => /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return { opaque: true };
    if (!args.includes('-delete')) return null;
    const starts = [];
    for (const a of args) {
      if (a.startsWith('-') || a === '!' || a === '(') break;
      starts.push(a);
    }
    return { paths: starts.length ? starts : ['.'], deep: true };
  }
  const spec = SPEC.get(name);
  if (!spec) return null;
  const skip = new Set(spec.skip ?? []);
  const destOpts = new Set(spec.dest ?? []);
  const positional = [];
  const dest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const low = a.toLowerCase();
    const eq = low.indexOf('=');
    if (low.startsWith('--') && eq !== -1) {
      const opt = low.slice(0, eq);
      if (destOpts.has(opt)) dest.push(a.slice(eq + 1));
      continue;
    }
    if (destOpts.has(low)) {
      if (i + 1 < args.length) dest.push(args[++i]);
      continue;
    }
    if (skip.has(low)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  if (spec.kind === 'all') return { paths: [...positional, ...dest], deep: !!spec.deep };
  if (dest.length) return { paths: dest, deep: false };
  if (name === 'robocopy') return { paths: positional.slice(1, 2), deep: false };
  if (positional.length >= 2) return { paths: [positional[positional.length - 1]], deep: false };
  // Один путь (install -d папка, Copy-Item без -Destination): считаем, что меняется он.
  return { paths: positional, deep: false };
}

// Решение по команде: null (без решения) или { decision: 'ask' | 'deny', reason }.
// root: корень кабинета; cwd: папка, где идёт команда; platform: 'win32' и т. п.
export function classify(command, { root, cwd = root, platform = process.platform } = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const win = platform === 'win32' || /^[a-z]:[\\/]/i.test(root ?? '');
  // Git Bash пишет диск как /c/...: это c:/...
  const drive = (p) => (win && /^\/[a-z]\//i.test(p) ? `${p[1]}:${p.slice(2)}` : p);
  // Регистр букв в путях не важен на Windows и обычно на macOS.
  const fold = win || platform === 'darwin';
  const slash = (p) => {
    let s = String(p).replace(/\\/g, '/');
    if (win) s = s.replace(/^\/([a-z])\//i, '$1:/');
    return fold ? s.toLowerCase() : s;
  };
  const text = slash(command);
  const top = normalizePath(slash(root));
  const { cmds, unclear } = lex(text);

  // Разрешённая команда курса целиком: одна простая команда без перенаправлений.
  if (!unclear && cmds.length === 1 && cmds[0].redirects.length === 0) {
    const w = cmds[0].words;
    const course =
      w.length >= 2 &&
      ((COURSE_COMMANDS[0].test(w[0]) && COURSE_COMMANDS[1].test(w[1])) ||
        (COURSE_COMMANDS[2].test(w[0]) && COURSE_COMMANDS[3].test(w[1])));
    if (course) return null;
  }

  const said = mentions(text);
  const sure = new Set(); // затронутые папки, путь ясен
  const unsure = new Set(); // путь или действие не ясны
  if (unclear) said.forEach((a) => unsure.add(a));

  let here = normalizePath(slash(cwd ?? root));
  let hereKnown = true;
  const affect = (p0, deep) => {
    const p = drive(p0);
    if (NULL_TARGETS.has(p.toLowerCase())) return;
    if (unclearPath(p)) {
      for (const a of [...areasOfAnywhere(p), ...said]) unsure.add(a);
      return;
    }
    let full;
    if (isAbs(p)) full = normalizePath(p);
    else if (hereKnown) full = normalizePath(`${here}/${p}`);
    else {
      for (const a of [...areasOfRel(p, deep), ...said]) unsure.add(a);
      return;
    }
    let rel;
    if (full === top) rel = '';
    else if (full.startsWith(`${top}/`)) rel = full.slice(top.length + 1);
    else return;
    for (const a of areasOfRel(rel, deep)) sure.add(a);
  };

  for (const cmd of cmds) {
    for (const r of cmd.redirects) affect(r, false);
    const { words, moved } = stripWrappers(cmd.words);
    if (!words.length) continue;
    if (moved) hereKnown = false;
    const name = progName(words[0]);
    if (CD.has(name)) {
      const to0 = words.slice(1).find((w) => !w.startsWith('-'));
      const to = to0 && drive(to0);
      if (to && !unclearPath(to)) {
        here = isAbs(to) ? normalizePath(to) : normalizePath(`${here}/${to}`);
      } else {
        hereKnown = false;
      }
      continue;
    }
    if (name === 'popd' || name === 'pop-location') {
      hereKnown = false;
      continue;
    }
    const t = writeTargets(words);
    if (!t) continue;
    if (t.opaque) {
      said.forEach((a) => unsure.add(a));
      continue;
    }
    for (const p of t.paths) affect(p, t.deep);
    // Ссылка: относительная цель считается от папки ссылки, поэтому защищённая папка где угодно в пути.
    if (name === 'ln' || name === 'mklink') t.paths.forEach((p) => areasOfAnywhere(p).forEach((a) => sure.add(a)));
  }

  const denied = [...sure].filter((a) => a.level === 'deny');
  if (denied.length) {
    const keys = [...new Set(denied.map((a) => a.reason))].sort();
    return { decision: 'deny', reason: keys.map((k) => REASONS[k]).join(' ') };
  }
  if ([...sure].some((a) => a.id === 'processes')) return { decision: 'ask', reason: REASONS.processes };
  if ([...sure].some((a) => a.id === 'claude')) return { decision: 'ask', reason: REASONS.claude };
  if (unsure.size) {
    const only = [...unsure];
    if (only.every((a) => a.id === 'processes')) return { decision: 'ask', reason: REASONS.processes };
    if (only.every((a) => a.id === 'claude')) return { decision: 'ask', reason: REASONS.claude };
    return { decision: 'ask', reason: REASONS.unclear };
  }
  return null;
}

// Путь с переменной или ~: защищённая папка где угодно в нём.
function areasOfAnywhere(p) {
  const comps = p.split('/');
  const hit = [];
  for (const a of AREAS) {
    for (let i = 0; i + a.path.length <= comps.length; i++) {
      if (a.path.every((n, k) => comps[i + k].toLowerCase() === n)) {
        hit.push(a);
        break;
      }
    }
  }
  return hit;
}

// Ответ хуку: не-ASCII как \uXXXX, чтобы кодовая страница Windows не испортила текст.
export function hookOutput(result) {
  if (!result) return '';
  const json = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: result.reason,
    },
  });
  return json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const command = input?.tool_input?.command;
  let result;
  try {
    result = classify(command, { root: ROOT, cwd: typeof input.cwd === 'string' ? input.cwd : ROOT });
  } catch {
    // Разбор упал: решает человек.
    result = { decision: 'ask', reason: REASONS.unclear };
  }
  process.stdout.write(hookOutput(result));
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
