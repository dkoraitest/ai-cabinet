// Файлы участника (me/, site/) создаются из шаблонов, если их ещё нет. Существующие не трогаем никогда.
// Новый файл в MANIFEST (как страница сервиса «Спроси таблицу» site/analiz.html) появляется в уже поставленном
// кабинете при «обнови кабинет» (update.mjs запускает init) или при следующем запуске страницы (serve.mjs).
// Запуск: node tools/init.mjs [--json]. Его же вызывают check.mjs, serve.mjs и update.mjs.
// --json: только список созданных файлов в JSON (его читает update.mjs).
import { constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const MANIFEST = [
  { from: 'templates/about-me.md', to: 'me/about-me.md' },
  { from: 'templates/rules.md', to: 'me/rules.md' },
  { from: 'templates/site/index.html', to: 'site/index.html' },
  { from: 'templates/site/render.js', to: 'site/render.js' },
  { from: 'templates/site/analiz.html', to: 'site/analiz.html' },
  { from: 'templates/site/analiz.js', to: 'site/analiz.js' },
];

export function ensureParticipantFiles(root) {
  const created = [];
  for (const { from, to } of MANIFEST) {
    const src = join(root, from);
    const dst = join(root, to);
    if (existsSync(dst) || !existsSync(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    // COPYFILE_EXCL: даже при гонке файл участника не перезаписывается.
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    created.push(to);
  }
  return created;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const created = ensureParticipantFiles(root);
  if (process.argv.includes('--json')) return console.log(JSON.stringify(created));
  console.log(created.length ? `Созданы файлы: ${created.join(', ')}` : 'Все файлы участника на месте, ничего не создано.');
}

if (isMain(import.meta.url)) {
  main();
}
