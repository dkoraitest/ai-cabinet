// Сторож команд Claude (хук PreToolUse для Bash и PowerShell). Без зависимостей, запускается без оболочки.
//
// Режим автоприёма правок пропускает без окна команды вроде `echo ... >> processes/x/run.py` или `cp`,
// а запуск процесса фразой разрешён. Без сторожа текст из входного файла мог бы записать программу
// процесса и запустить её без единого окна. Разобрать, что команда пишет, надёжно нельзя (экранирование,
// кавычки, короткие имена Windows), поэтому правило простое: любая команда, кроме разрешённых команд
// курса, которая упоминает папку processes или .claude (в любом написании) или идёт изнутри них,
// спрашивает окно разрешения. Запись в tools/, templates/ и input/ закрывают запреты Edit в
// .claude/settings.json: Claude Code применяет их и к командам.
//
// Вход: JSON в stdin (tool_name, tool_input.command, cwd). Выход: пусто (решения нет) или
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"..."}}.
// Код выхода всегда 0.
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REASON =
  'Claude хочет выполнить команду, которая касается программ процессов или настроек кабинета. Разрешите, только если вы сами это просили.';

const TOOLS = new Set(['Bash', 'PowerShell']);

// Разрешённые команды курса, только целиком: одна команда, без ; & | < > $ ( ) ` и переводов строки.
const COURSE =
  /^\s*(node\s+(\.[\\/])?tools[\\/](serve|check|update|processes)\.mjs|(python|py)\s+(\.[\\/])?tools[\\/]read_table\.py)(\s+[^;&|<>$()`\r\n]*)?$/;

const NAMES = ['processes', '.claude'];

// Имя части пути защищённое: processes или .claude; на Windows ещё с точками и пробелами в конце
// (processes. и processes  открывают ту же папку) и короткое имя 8.3 (PROCES~1, CLAUDE~1).
// Дефисы в начале снимаются: ${x:-processes} в bash раскрывается в processes.
function protectedName(part) {
  const bare = part.replace(/^-+/, '');
  const name = bare.replace(/[. ]+$/, '');
  return NAMES.includes(name) || /^(proces|claude)~\d/.test(bare);
}

const hasGlob = (s) => /[*?[]/.test(s);

function globMatches(part) {
  const body = part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  let re;
  try {
    re = new RegExp(`^${body}$`);
  } catch {
    return true; // незакрытая [ и подобное: осторожно считаем, что может совпасть
  }
  return NAMES.some((n) => re.test(n));
}

// $'...' в bash: \xHH, \uHHHH, восьмеричные коды и \n превращаются в символы.
function decodeAnsiC(text) {
  return text.replace(/\$'((?:[^'\\]|\\.)*)'/g, (m, body) =>
    body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|.)/g, (s, e) => {
      try {
        if (/^[xuU]/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 16));
        if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
      } catch {
        return '';
      }
      return { n: '\n', t: '\t', r: '\r' }[e] ?? e;
    }),
  );
}

// Раскрытие {a,b} в bash: pro{c,}esses даёт processes. Не больше limit вариантов.
function expandBraces(text, limit = 64) {
  const done = [];
  const todo = [text];
  while (todo.length && done.length + todo.length <= limit) {
    const t = todo.pop();
    const m = /\{([^{}]*,[^{}]*)\}/.exec(t);
    if (!m) {
      done.push(t);
      continue;
    }
    for (const alt of m[1].split(',')) todo.push(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length));
  }
  return [...done, ...todo];
}

// Свободные формы команды: строчными, без кавычек, обратных кавычек (PowerShell: `x это x) и ^ (cmd: ^x это x).
// a: обратная косая черта убрана (bash: \e это e); b: она разделитель путей (Windows, PowerShell);
// c: как b, но склеены строки "a" + "b" (PowerShell). Каждая форма ещё и с раскрытыми {a,b}.
// Строятся всегда все формы: какой бы ни была оболочка, лишнее окно лучше пропущенного.
export function looseForms(command) {
  const s = decodeAnsiC(String(command)).toLowerCase().replace(/['"`^]/g, '');
  const a = s.replace(/\\/g, '');
  const b = s.replace(/\\/g, '/');
  const c = b.replace(/\s*\+\s*/g, '');
  const forms = new Set();
  for (const f of [a, b, c]) for (const x of expandBraces(f)) forms.add(x);
  return [...forms];
}

// Части путей формы. Разделители: пробелы и знаки оболочки, в том числе : из -Path:значение
// (PowerShell) и = из VAR=значение. Звёздочка, ?, [ ] остаются: это шаблоны имён.
const TOKEN_SPLIT = /[\s;|&<>(){},=:!@#$%+]+/;

export function mentionsProtected(form, rootBase = '') {
  for (const token of form.split(TOKEN_SPLIT)) {
    if (!token) continue;
    const parts = token.split('/');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (protectedName(p)) return true;
      // Шаблон имени (p*, proc?sses, [p]rocesses) в начале относительного пути или сразу после
      // папки кабинета может раскрыться в processes или .claude.
      const prev = i === 0 ? null : parts[i - 1];
      const head = i === 0 || prev === '.' || prev === '..' || (rootBase && prev === rootBase);
      if (head && hasGlob(p) && globMatches(p)) return true;
    }
  }
  return false;
}

const fold = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

// Команда идёт из папки processes или .claude кабинета (Claude перешёл туда раньше).
export function cwdInside(cwds, roots, platform = process.platform) {
  const ci = platform === 'win32' || platform === 'darwin';
  const norm = (p) => (ci ? fold(p).toLowerCase() : fold(p));
  for (const cwd of cwds.filter(Boolean).map(norm)) {
    for (const root of roots.filter(Boolean).map(norm)) {
      if (!cwd.startsWith(`${root}/`)) continue;
      const first = cwd.slice(root.length + 1).split('/')[0];
      if (protectedName(first.toLowerCase())) return true;
    }
  }
  return false;
}

// Решение по команде: null (без решения) или { decision: 'ask', reason }.
// cwds: папка команды (и её настоящий путь); roots: возможные корни кабинета.
export function classify(command, { tool = 'Bash', cwds = [], roots = [], platform = process.platform } = {}) {
  if (!TOOLS.has(tool)) return null;
  if (typeof command !== 'string' || !command.trim()) return null;
  if (COURSE.test(command)) return null;
  const rootBase = roots.filter(Boolean).map((r) => fold(r).toLowerCase().split('/').pop())[0] ?? '';
  if (looseForms(command).some((f) => mentionsProtected(f, rootBase))) return { decision: 'ask', reason: REASON };
  if (cwdInside(cwds, roots, platform)) return { decision: 'ask', reason: REASON };
  return null;
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

function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const tool = input?.tool_name ?? 'Bash';
  const ti = input?.tool_input ?? {};
  // Команда в поле command; если поле названо иначе, проверяем все строки ввода.
  const command =
    typeof ti.command === 'string' ? ti.command : Object.values(ti).filter((v) => typeof v === 'string').join('\n');
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  const roots = [ROOT, real(ROOT), envRoot, envRoot && real(envRoot)];
  let result;
  try {
    result = classify(command, { tool, cwds: [cwd, real(cwd)], roots });
  } catch {
    // Разбор упал: решает человек.
    result = TOOLS.has(tool) ? { decision: 'ask', reason: REASON } : null;
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
