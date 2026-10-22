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
import { compareWithEtalon, skillCommandLines, zipEntries } from '../processes.mjs';

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
