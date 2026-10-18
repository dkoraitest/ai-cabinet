// Файлы участника (me/, site/) создаются из шаблонов, если их ещё нет. Существующие не трогаем никогда.
// Запуск: node tools/init.mjs. Его же вызывают check.mjs, serve.mjs и update.mjs.
import { constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const MANIFEST = [
  { from: 'templates/about-me.md', to: 'me/about-me.md' },
  { from: 'templates/rules.md', to: 'me/rules.md' },
  { from: 'templates/site/index.html', to: 'site/index.html' },
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
  console.log(created.length ? `Созданы файлы: ${created.join(', ')}` : 'Все файлы участника на месте, ничего не создано.');
}

if (isMain(import.meta.url)) {
  main();
}
