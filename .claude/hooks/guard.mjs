// Сторож Claude (хук PreToolUse для Bash, PowerShell и инструментов записи файлов). Без зависимостей,
// запускается без оболочки.
//
// Команды. Режим автоприёма правок пропускает без окна команды вроде `echo ... >> processes/x/run.py`
// или `cp`, а запуск процесса фразой разрешён. Без сторожа текст из входного файла мог бы записать
// программу процесса и запустить её без единого окна. Разобрать, что команда пишет, надёжно нельзя
// (экранирование, кавычки, короткие имена Windows), поэтому правило простое: любая команда, кроме
// разрешённых команд курса, которая упоминает папку processes или .claude (в любом написании) или идёт
// изнутри них, спрашивает окно разрешения. Запись командой в tools/, templates/ и input/ закрывают
// запреты Edit в .claude/settings.json: Claude Code применяет их и к командам, в любом режиме.
//
// Файлы (Write, Edit, MultiEdit, NotebookEdit). Запись в input/, tools/, templates/ и .claude/hooks/
// запрещена в любом режиме (вдобавок к запретам Edit в settings.json). Запись в processes/ и .claude/
// в обычных режимах решают правило ask в settings.json и встроенная защита .claude/ в Claude Code.
//
// Режимы (поле permission_mode во входе хука; D70: организация не отключает обход разрешений и Auto).
// Проверено на Claude Code 2.1.231 и 2.1.307: окно по ответу хука "ask" появляется во всех режимах,
// правило ask в settings.json спрашивает везде, кроме dontAsk, запреты deny действуют везде. Но в Auto
// встроенную защиту .claude/ (settings.local.json, скиллы) решает классификатор без окна, поэтому в Auto
// сторож сам спрашивает окно и для файлов в processes/ и .claude/. В режимах обхода разрешений
// (bypassPermissions) и dontAsk человек окон не ждёт, а в dontAsk правила ask отклоняются сами, поэтому
// там всё, что сторож спросил бы, запрещено с подсказкой вернуть обычный режим. Режим не передан или
// незнаком: считаем, что спросить нельзя.
//
// Вход: JSON в stdin (tool_name, tool_input, cwd, permission_mode). Выход: пусто (решения нет) или
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"|"deny","permissionDecisionReason":"..."}}.
// Код выхода всегда 0.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REASON =
  'Claude хочет выполнить команду, которая касается программ процессов или настроек кабинета. Разрешите, только если вы сами это просили.';
export const REASON_FILE =
  'Claude хочет изменить программу процесса или настройки кабинета. Разрешите, только если вы сами это просили.';
export const REASON_NO_PROMPT =
  'В этом режиме Claude не может спросить вас, поэтому изменения программ процессов и настроек кабинета закрыты. Переключите режим на обычный (Shift+Tab) и повторите.';
export const REASON_DATA = 'Это файлы курса или ваши исходные данные, Claude их не меняет.';

const TOOLS = new Set(['Bash', 'PowerShell']);
export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Режимы, где человек видит окно на ответ сторожа "ask" (manual: другое имя default).
const PROMPT_MODES = new Set(['default', 'manual', 'acceptEdits', 'plan', 'auto']);
// Режимы, где запись файлов в processes/ и .claude/ спрашивают правила settings.json и Claude Code сами.
const RULE_MODES = new Set(['default', 'manual', 'acceptEdits', 'plan']);

export const canPrompt = (mode) => PROMPT_MODES.has(mode);

// Решение для записи в processes/ или .claude/: окно, где оно будет, иначе запрет с подсказкой.
function guarded(mode, reason) {
  return canPrompt(mode) ? { decision: 'ask', reason } : { decision: 'deny', reason: REASON_NO_PROMPT };
}

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

// Решение по команде: null (без решения) или { decision: 'ask' | 'deny', reason }.
// cwds: папка команды (и её настоящий путь); roots: возможные корни кабинета; mode: permission_mode.
export function classify(command, { tool = 'Bash', cwds = [], roots = [], platform = process.platform, mode } = {}) {
  if (!TOOLS.has(tool)) return null;
  if (typeof command !== 'string' || !command.trim()) return null;
  if (COURSE.test(command)) return null;
  const rootBase = roots.filter(Boolean).map((r) => fold(r).toLowerCase().split('/').pop())[0] ?? '';
  if (looseForms(command).some((f) => mentionsProtected(f, rootBase))) return guarded(mode, REASON);
  if (cwdInside(cwds, roots, platform)) return guarded(mode, REASON);
  return null;
}

// Имя части пути без того, что Windows отбрасывает: поток после : (processes::$INDEX_ALLOCATION),
// точки и пробелы в конце. Строчными.
function bareName(part) {
  return String(part).toLowerCase().split(':')[0].replace(/[. ]+$/, '');
}

const DATA = ['input', 'tools', 'templates'];
const isData = (raw) => DATA.includes(bareName(raw)) || /^templa~\d/.test(String(raw).toLowerCase());
const isHooks = (raw) => bareName(raw) === 'hooks';
const isClaude = (raw) => bareName(raw) === '.claude' || /^claude~\d/.test(String(raw).toLowerCase());
const isProcesses = (raw) => bareName(raw) === 'processes' || /^proces~\d/.test(String(raw).toLowerCase());

// Куда в кабинете попадает файл: 'data' (input/, tools/, templates/, .claude/hooks/), 'guarded'
// (processes/, .claude/) или null. Относительный путь берётся от папки команды и от корня кабинета,
// ~ от домашней папки. real(путь) даёт настоящий путь (ссылки, junction) или null.
export function fileZone(file, { cwds = [], roots = [], platform = process.platform, home = homedir(), real = null } = {}) {
  if (typeof file !== 'string' || !file.trim()) return null;
  const P = platform === 'win32' ? win32 : posix;
  const ci = platform === 'win32' || platform === 'darwin';
  const norm = (p) => (ci ? fold(p).toLowerCase() : fold(p));
  let raw = file.trim().replace(/^[\\/]{2}[?.][\\/](?!unc[\\/])/i, '');
  if (/^~([\\/]|$)/.test(raw)) raw = P.join(home, raw.slice(1));
  const bases = [...cwds, ...roots].filter(Boolean);
  const paths = P.isAbsolute(raw) ? [P.resolve(raw)] : bases.map((b) => P.resolve(b, raw));
  if (real) for (const p of [...paths]) {
    const r = real(p);
    if (r) paths.push(r);
  }
  let zone = null;
  for (const p of paths.map(norm)) {
    for (const root of roots.filter(Boolean).map(norm)) {
      if (!p.startsWith(`${root}/`)) continue;
      const [first, second] = p.slice(root.length + 1).split('/');
      if (isData(first) || (isClaude(first) && second !== undefined && isHooks(second))) return 'data';
      if (isProcesses(first) || isClaude(first)) zone = 'guarded';
    }
  }
  return zone;
}

// Решение по записи файла: null или { decision, reason }.
export function classifyFile(file, ctx = {}) {
  if (!FILE_TOOLS.has(ctx.tool)) return null;
  const zone = fileZone(file, ctx);
  if (zone === 'data') return { decision: 'deny', reason: REASON_DATA };
  if (zone === 'guarded' && !RULE_MODES.has(ctx.mode)) return guarded(ctx.mode, REASON_FILE);
  return null;
}

// Путь к файлу в вводе инструмента записи.
export const filePathOf = (ti) => (typeof ti?.file_path === 'string' ? ti.file_path : typeof ti?.notebook_path === 'string' ? ti.notebook_path : '');

// Решение по входу хука целиком. ctx: roots, platform, cwds (если не заданы, папка из входа), real.
export function decide(input, ctx = {}) {
  const tool = input?.tool_name ?? 'Bash';
  const ti = input?.tool_input ?? {};
  const mode = typeof input?.permission_mode === 'string' ? input.permission_mode : undefined;
  const cwds = ctx.cwds ?? [typeof input?.cwd === 'string' ? input.cwd : process.cwd()];
  const full = { ...ctx, tool, mode, cwds };
  try {
    if (FILE_TOOLS.has(tool)) return classifyFile(filePathOf(ti), full);
    if (!TOOLS.has(tool)) return null;
    // Команда в поле command; если поле названо иначе, проверяем все строки ввода.
    const command =
      typeof ti.command === 'string' ? ti.command : Object.values(ti).filter((v) => typeof v === 'string').join('\n');
    return classify(command, full);
  } catch {
    // Разбор упал: решает человек, а где спросить нельзя, запрет.
    return guarded(mode, FILE_TOOLS.has(tool) ? REASON_FILE : REASON);
  }
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

// Настоящий путь файла, которого ещё нет: настоящий путь ближайшей существующей папки и остаток.
function nearestReal(p) {
  let dir = p;
  const rest = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(dir)) {
      const r = real(dir);
      return r ? resolve(r, ...rest) : null;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    rest.unshift(dir.slice(up.length).replace(/^[\\/]+/, ''));
    dir = up;
  }
  return null;
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
  if (!input || typeof input !== 'object') return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  const roots = [ROOT, real(ROOT), envRoot, envRoot && real(envRoot)];
  process.stdout.write(hookOutput(decide(input, { cwds: [cwd, real(cwd)], roots, real: nearestReal })));
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
