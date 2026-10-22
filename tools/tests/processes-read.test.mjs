// node tools/processes.mjs read <slug> <файл> (скилл файлом и документ Word) и compare <slug> (сверка со скиллом).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { copyDir } from './copy-dir.mjs';
import { compareWithEtalon, programProblems, skillCommandLines, zipEntries } from '../processes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let base, cab;

// Архив zip, как его делает скачивание скилла: deflate, имена в UTF-8.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(n, 8);
  end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Встроенная команда собирается из частей: этот файл сам не должен выглядеть как скилл с командой.
const BANG = '!';
const TICK = '`';
const CMD_LINE = `Сегодня: ${BANG}${TICK}date${TICK}`;
const BLOCK_LINE = `${TICK.repeat(3)}${BANG}`;

const SKILL = `---
name: razbor-obrashcheniy
description: Разбор обращений клиентов по темам. Фраза «разбери обращения».
---

# Разбор обращений

Разложи обращения из файла по темам: качество топлива, обслуживание, оплата, другое.
`;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'read-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(cab, { recursive: true });
  copyDir(join(ROOT, 'tools'), join(cab, 'tools'));
  rmSync(join(cab, 'tools', 'tests'), { recursive: true, force: true });
  const inp = join(cab, 'input', 'razbor');
  mkdirSync(inp, { recursive: true });
  writeFileSync(join(inp, 'SKILL.md'), SKILL);
  writeFileSync(join(inp, 'chuzhoy skill.md'), `${SKILL}\n${CMD_LINE}\n\n${BLOCK_LINE}\nls\n${TICK.repeat(3)}\n`);
  writeFileSync(
    join(inp, 'razbor-obrashcheniy.zip'),
    makeZip({
      'razbor-obrashcheniy/': '',
      'razbor-obrashcheniy/SKILL.md': SKILL,
      'razbor-obrashcheniy/reference/temy.md': `# Темы\n\nкачество топлива: топливо, бензин\n${CMD_LINE}\n`,
      'razbor-obrashcheniy/scripts/build.py': 'import openpyxl\nprint("сводка по темам")\n',
      'razbor-obrashcheniy/assets/logo.png': 'PNG',
      '__MACOSX/razbor-obrashcheniy/._SKILL.md': 'мусор',
    }),
  );
  writeFileSync(join(inp, 'razbor.skill'), makeZip({ 'SKILL.md': SKILL }));
  writeFileSync(join(inp, 'bez-skilla.zip'), makeZip({ 'readme.txt': 'просто текст' }));
  writeFileSync(join(inp, 'bityi.zip'), Buffer.from('это не архив'));
  writeFileSync(join(inp, 'pismo.docx'), readFileSync(join(ROOT, 'input', 'case-azs', 'data', 'template_pismo_postavshchiku.docx')));
  writeFileSync(join(inp, 'dannye.xlsx'), readFileSync(join(ROOT, 'input', 'case-azs', 'data', 'obrashcheniya.xlsx')));
});

after(() => rmSync(base, { recursive: true, force: true }));

function cli(...args) {
  const r = spawnSync(process.execPath, [join(cab, 'tools', 'processes.mjs'), ...args], { cwd: cab, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('read: скилл .md без встроенных команд', () => {
  const r = cli('read', 'razbor', 'SKILL.md');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Файл SKILL\.md:/);
  assert.match(r.out, /Разложи обращения из файла по темам/);
  assert.match(r.out, /Встроенных команд нет\.$/m);
});

test('read: встроенные команды скилла показаны с номерами строк (и строка, и блок)', () => {
  const r = cli('read', 'razbor', 'chuzhoy', 'skill.md');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Встроенные команды: 2\. Они выполнятся сами при запуске скилла, без вопроса:/);
  assert.match(r.out, /chuzhoy skill\.md, строка 10: Сегодня: !`date`/);
  assert.match(r.out, /chuzhoy skill\.md, строка 12: ```!/);
  assert.deepEqual(skillCommandLines('Важно! Не трогайте файл.\nКоманда `ls` без восклицательного знака.'), []);
});

test('read: архив .zip скилла: список файлов, SKILL.md и тексты, текст программы из scripts без запуска, команды из всех текстов', () => {
  const r = cli('read', 'razbor', 'razbor-obrashcheniy.zip');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Архив razbor-obrashcheniy\.zip, файлов 4: razbor-obrashcheniy\/SKILL\.md, razbor-obrashcheniy\/reference\/temy\.md, razbor-obrashcheniy\/scripts\/build\.py, razbor-obrashcheniy\/assets\/logo\.png\./);
  assert.match(r.out, /Текст razbor-obrashcheniy\/SKILL\.md:\n---\nname: razbor-obrashcheniy/);
  assert.match(r.out, /Текст razbor-obrashcheniy\/reference\/temy\.md:/);
  assert.match(r.out, /Программа razbor-obrashcheniy\/scripts\/build\.py из архива \(только текст: программу из архива не запускают, это файл извне\):\nimport openpyxl\nprint\("сводка по темам"\)/);
  assert.match(r.out, /Остальные файлы архива \(razbor-obrashcheniy\/assets\/logo\.png\) здесь не показаны\./);
  assert.match(r.out, /Встроенные команды: 1\.[^\n]*\n {2}razbor-obrashcheniy\/reference\/temy\.md, строка 4: Сегодня: !`date`/);
});

test('read: .skill это тот же архив', () => {
  const r = cli('read', 'razbor', 'razbor.skill');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Текст SKILL\.md:/);
  assert.match(r.out, /Встроенных команд нет\./);
});

test('read: документ Word: текст по абзацам, без проверки команд', () => {
  const r = cli('read', 'razbor', 'pismo.docx');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Документ Word pismo\.docx/);
  assert.match(r.out, /^\[Наименование поставщика\]$/m);
  assert.match(r.out, /Исх\. № ____ от \[дата\]/);
  assert.doesNotMatch(r.out, /Встроенн/);
  const real = zipEntries(readFileSync(join(cab, 'input', 'razbor', 'pismo.docx'))).map((e) => e.name);
  assert.ok(real.includes('word/document.xml'));
});

test('read: понятные отказы: нет SKILL.md, битый архив, таблица, путь с папками, нет файла, нет имени', () => {
  const cases = [
    [['read', 'razbor', 'bez-skilla.zip'], /в архиве нет файла SKILL\.md/],
    [['read', 'razbor', 'bityi.zip'], /bityi\.zip не читается/],
    [['read', 'razbor', 'dannye.xlsx'], /python tools\/read_table\.py/],
    [['read', 'razbor', '../razbor/SKILL.md'], /только имя файла/],
    [['read', 'razbor', 'net.md'], /Нет файла input\/razbor\/net\.md\. Файлы в папке input\/razbor: /],
    [['read', 'razbor'], /Укажите файл/],
    [['read', 'Razbor', 'SKILL.md'], /Имя папки процесса/],
  ];
  for (const [args, re] of cases) {
    const r = cli(...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, re, args.join(' '));
    assert.doesNotMatch(r.out, /at .*processes\.mjs/);
  }
});

test('skills: свои скиллы с описанием, скиллы курса и папки без SKILL.md не показываются', () => {
  const sk = join(cab, '.claude', 'skills');
  let r = cli('skills');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Своих скиллов в кабинете нет, только скиллы курса\./);
  for (const [name, text] of [
    ['add-process', '---\nname: add-process\ndescription: курс\n---\n'],
    ['razbor-obrashcheniy', '---\nname: razbor-obrashcheniy\ndescription: Разбирает обращения по темам.\n---\n# Текст\n'],
    ['bez-opisaniya', '# Скилл без шапки\n'],
  ]) {
    mkdirSync(join(sk, name), { recursive: true });
    writeFileSync(join(sk, name, 'SKILL.md'), text);
  }
  mkdirSync(join(sk, 'pustaya'), { recursive: true });
  r = cli('skills');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), ['Свои скиллы в кабинете: 2. Текст скилла: .claude/skills/<папка>/SKILL.md.', '- bez-opisaniya', '- razbor-obrashcheniy: Разбирает обращения по темам.'].join('\n'));
});

// ---------- compare ----------

const ETALON = {
  'скилл': 'razbor-obrashcheniy',
  'файл': 'obrashcheniya.xlsx',
  'итоги': { 'обращений': 5, 'литров': 12345.6 },
  'по категориям': { 'оборудование': 2, 'другое': 2 },
  'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'оборудование', 4: 'другое', 5: 'повтор' },
};

test('compareWithEtalon: всё совпало, числа с точностью эталона, регистр и ё не важны', () => {
  const r = compareWithEtalon(ETALON, {
    'итоги': { 'Обращений': 5, 'литров': 12345.63 },
    'по категориям': { 'Оборудование': 2, 'другое': 2 },
    'по строкам': { '1': 'оборудование', '2': 'Другое', '3': 'оборудование', '4': 'другое', '5': 'повтор' },
  });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.lines.at(-1), 'Итог сверки: программа дала тот же результат, что скилл.');
  assert.ok(r.lines.includes('По строкам: совпало 5 из 5.'));
});

test('compareWithEtalon: строки в «разобрать вручную» и разница в категориях, которую они объясняют, не расхождение', () => {
  const r = compareWithEtalon(ETALON, {
    'итоги': { 'обращений': 5, 'литров': 12345.6 },
    'по категориям': { 'оборудование': 2, 'разобрать вручную': 2 },
    'по строкам': { 1: 'оборудование', 2: 'разобрать вручную', 3: 'оборудование', 4: 'разобрать вручную', 5: 'повтор' },
  });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.manual, 2);
  const text = r.lines.join('\n');
  assert.match(text, /Программа отправила в «разобрать вручную»: 2\.\n {2}2: у скилла «другое»\n {2}4: у скилла «другое»/);
  assert.match(text, /«другое»: у скилла 2, у программы 0, разница 2 в «разобрать вручную»/);
  assert.equal(r.lines.at(-1), 'Итог сверки: программа дала тот же результат, что скилл, кроме 2 строк в «разобрать вручную».');
});

test('compareWithEtalon: другая категория, другой итог, лишняя категория, документы → расхождения, код 1', () => {
  const r = compareWithEtalon({ ...ETALON, 'документов': 3 }, {
    'итоги': { 'обращений': 5, 'литров': 12345.7 },
    'по категориям': { 'оборудование': 1, 'другое': 2, 'чистота': 1 },
    'по строкам': { 1: 'чистота', 2: 'другое', 3: 'оборудование', 4: 'другое', 5: 'повтор', 6: 'другое' },
    'документов': 2,
  });
  assert.equal(r.code, 1);
  const text = r.lines.join('\n');
  assert.match(text, /Другой результат у программы: 1\.\n {2}1: у скилла «оборудование», у программы «чистота»/);
  assert.match(text, /Есть у программы, нет у скилла: 1: 6\./);
  assert.match(text, /«литров»: у скилла 12345,6, у программы 12345,7/);
  assert.match(text, /«чистота»: у скилла нет, у программы 1/);
  assert.match(text, /Документов: у скилла 3, у программы 2\./);
  assert.match(r.lines.at(-1), /^Итог сверки: расхождений 6\. Поправьте словарь или программу/);
});

test('compareWithEtalon: эталон по части большого файла: строки вне эталона не расхождение, итоги по всему файлу сравниваются', () => {
  const r = compareWithEtalon(
    { 'строк в эталоне': 2, 'по строкам': { 1: 'оборудование', 2: 'другое' }, 'итоги': { 'обращений': 3 }, 'по категориям': { 'другое': 1 } },
    { 'итоги': { 'обращений': 3 }, 'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'другое' } },
  );
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.differences, 0);
  const text = r.lines.join('\n');
  assert.match(text, /По строкам: совпало 2 из 2\./);
  assert.match(text, /Не входят в эталон: 1 строк или групп программы \(эталон по первым 2\), их не сравниваем\./);
  assert.match(text, /Эталон по части файла: «по категориям» по всему файлу с ним не сравнить, не сравниваем\./);
  assert.match(text, /Итоги: совпали все \(1\)\./);
  assert.equal(r.lines.at(-1), 'Итог сверки: программа дала тот же результат, что скилл.');
  // Итог по всему файлу в эталоне по части файла тоже сверяется: другой итог у программы → расхождение.
  const wrongTotal = compareWithEtalon(
    { 'строк в эталоне': 2, 'по строкам': { 1: 'оборудование', 2: 'другое' }, 'итоги': { 'обращений': 3 } },
    { 'итоги': { 'обращений': 4 }, 'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'другое' } },
  );
  assert.equal(wrongTotal.code, 1);
  assert.match(wrongTotal.lines.join('\n'), /«обращений»: у скилла 3, у программы 4/);
  // Без пометки о части файла лишняя строка остаётся расхождением.
  const full = compareWithEtalon({ 'по строкам': { 1: 'оборудование', 2: 'другое' } }, { 'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'другое' } });
  assert.equal(full.code, 1);
});

// Сводная: литры по АЗС и виду топлива, ключ группы «АЗС-01 / АИ-92».
const groups = (n, shift = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`АЗС-${String(i + 1).padStart(3, '0')} / АИ-92`, 100 + i + (i === 0 ? shift : 0)]));
const sum = (g) => Math.round(Object.values(g).reduce((a, b) => a + b, 0) * 10) / 10;

test('compareWithEtalon: сводная до 300 групп: все группы в «по категориям», неверная группа или итог → расхождение', () => {
  const g = groups(47);
  const etalon = { 'итоги': { 'литров': sum(g) }, 'по категориям': g };
  const ok = compareWithEtalon(etalon, { 'итоги': { 'литров': sum(g) }, 'по категориям': { ...g } });
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  assert.ok(ok.lines.includes('По категориям: совпали все (47).'));
  const wrongGroup = compareWithEtalon(etalon, { 'итоги': { 'литров': sum(g) }, 'по категориям': groups(47, 5) });
  assert.equal(wrongGroup.code, 1);
  assert.match(wrongGroup.lines.join('\n'), /«АЗС-001 \/ АИ-92»: у скилла 100, у программы 105/);
  const wrongTotal = compareWithEtalon(etalon, { 'итоги': { 'литров': sum(g) + 7 }, 'по категориям': { ...g } });
  assert.equal(wrongTotal.code, 1);
  assert.match(wrongTotal.lines.join('\n'), /Итоги: не совпало 1 из 1\./);
});

test('compareWithEtalon: сводная больше 300 групп: первые 100 групп в «по строкам» и итоги по всему файлу', () => {
  const all = groups(350);
  const first = Object.fromEntries(Object.entries(all).slice(0, 100));
  const etalon = { 'строк в эталоне': 100, 'итоги': { 'литров': sum(all), 'групп': 350 }, 'по строкам': first };
  const ok = compareWithEtalon(etalon, { 'итоги': { 'литров': sum(all), 'групп': 350 }, 'по строкам': { ...all } });
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  const text = ok.lines.join('\n');
  assert.match(text, /По строкам: совпало 100 из 100\./);
  assert.match(text, /Не входят в эталон: 250 строк или групп программы \(эталон по первым 100\), их не сравниваем\./);
  assert.match(text, /Итоги: совпали все \(2\)\./);
  // Программа ошиблась в группе за пределами первых 100: её видно по итогу по всему файлу.
  const tail = { ...all, 'АЗС-300 / АИ-92': all['АЗС-300 / АИ-92'] + 50 };
  const wrongTotal = compareWithEtalon(etalon, { 'итоги': { 'литров': sum(tail), 'групп': 350 }, 'по строкам': tail });
  assert.equal(wrongTotal.code, 1, wrongTotal.lines.join('\n'));
  assert.match(wrongTotal.lines.join('\n'), /«литров»: у скилла/);
  assert.match(wrongTotal.lines.at(-1), /^Итог сверки: расхождений 1\./);
  const wrongGroup = compareWithEtalon(etalon, { 'итоги': { 'литров': sum(all), 'групп': 350 }, 'по строкам': { ...all, 'АЗС-001 / АИ-92': 1 } });
  assert.equal(wrongGroup.code, 1);
});

test('compareWithEtalon: больше 20% строк в «разобрать вручную» → предупреждение, не расхождение', () => {
  const e = { 'по строкам': { 1: 'а', 2: 'б', 3: 'а', 4: 'б', 5: 'а' } };
  const r = compareWithEtalon(e, { 'по строкам': { 1: 'а', 2: 'разобрать вручную', 3: 'а', 4: 'разобрать вручную', 5: 'а' } });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.ok(r.lines.includes('Внимание: в «разобрать вручную» ушло 2 из 5 строк. Проверьте словарь: скорее всего, в нём не хватает слов.'));
  const few = compareWithEtalon(e, { 'по строкам': { 1: 'а', 2: 'разобрать вручную', 3: 'а', 4: 'б', 5: 'а' } });
  assert.ok(!few.lines.some((l) => l.startsWith('Внимание')));
});

test('programProblems: запуск программ, сеть, eval, абсолютные пути; комментарии и обычные строки не трогает', () => {
  const bad = [
    'import subprocess',
    'os.system("del *")',
    'from urllib.request import urlopen',
    'import requests',
    'from http import client',
    'v = eval(text)',
    'data = open("/Users/aigul/secret.txt").read()',
    'p = "C:\\\\Users\\\\secret.xlsx"',
    'home = Path.home()',
    'shutil.rmtree(ROOT)',
  ];
  for (const line of bad) assert.equal(programProblems(line).length, 1, line);
  const good = ['# subprocess не нужен', 'r = re.compile(r"\\d+")', 'out = OUT / "result.json"', 'tmp.unlink(missing_ok=True)', 's.replace("\\\\", "/")', 'os.replace(tmp, target)'];
  for (const line of good) assert.deepEqual(programProblems(line), [], line);
});

test('compare: запрещённое в программе процесса закрывает «готово» (код 1), даже без эталона и при совпадении', () => {
  const slug = 'opasno';
  const dir = join(cab, 'processes', slug);
  const out = join(cab, 'output', slug);
  mkdirSync(dir, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(dir, 'process.json'), JSON.stringify({ title: 'Опасно', phrase: 'запусти опасно', kind: 'script' }));
  writeFileSync(join(dir, 'run.py'), 'import json\nimport subprocess\nsubprocess.run(["curl", "x"])\n');
  let r = cli('compare', slug);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Эталона нет/);
  assert.match(r.out, /В программе processes\/opasno\/run\.py есть то, что программе процесса нельзя/);
  assert.match(r.out, /строка 2: запуск программ или выход в сеть: import subprocess/);
  const sverka = { 'по строкам': { 1: 'а' } };
  writeFileSync(join(out, 'etalon-skilla.json'), JSON.stringify(sverka));
  writeFileSync(join(out, 'result.json'), JSON.stringify({ title: 'Опасно', updated_at: '2026-10-22T10:00:00+05:00', status: 'green', summary: 'x', columns: [], rows: [], sverka }));
  r = cli('compare', slug);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Итог сверки: программа дала тот же результат, что скилл\./);
  assert.match(r.out, /Итог проверки программы: уберите это из программы, «готово» нельзя\.$/m);
  writeFileSync(join(dir, 'run.py'), 'import json\nprint("ok")\n');
  r = cli('compare', slug);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /нельзя/);
});

test('compare: эталон и result.json из файлов; нет эталона, нет sverka, пустой эталон → код 2', () => {
  const out = join(cab, 'output', 'razbor');
  mkdirSync(join(cab, 'processes', 'razbor'), { recursive: true });
  writeFileSync(join(cab, 'processes', 'razbor', 'process.json'), JSON.stringify({ title: 'Разбор обращений', phrase: 'запусти разбор обращений', kind: 'script' }));
  mkdirSync(out, { recursive: true });
  let r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /Эталона нет: output\/razbor\/etalon-skilla\.json, нет файла/);
  writeFileSync(join(out, 'etalon-skilla.json'), JSON.stringify(ETALON));
  r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /Результата программы нет/);
  const result = { title: 'Разбор обращений', updated_at: '2026-10-22T10:00:00+05:00', status: 'green', summary: 'x', columns: [], rows: [] };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result));
  r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /нет раздела sverka/);
  writeFileSync(join(out, 'result.json'), JSON.stringify({ ...result, sverka: { 'итоги': ETALON['итоги'], 'по категориям': ETALON['по категориям'], 'по строкам': ETALON['по строкам'] } }));
  r = cli('compare', 'razbor');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Сверка «Разбор обращений»: эталон скилла output\/razbor\/etalon-skilla\.json \(файл obrashcheniya\.xlsx\), программа output\/razbor\/result\.json от 22\.10\.2026/);
  writeFileSync(join(out, 'etalon-skilla.json'), JSON.stringify({ 'скилл': 'x' }));
  r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /В эталоне нет ни одного раздела/);
  writeFileSync(join(out, 'etalon-skilla.json'), '{ битый');
  r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /повреждён/);
});
