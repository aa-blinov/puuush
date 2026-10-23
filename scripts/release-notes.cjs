/**
 * Заметки релиза из CHANGELOG.md.
 *
 *     node scripts/release-notes.mjs 1.1.0
 *
 * Печатает раздел этой версии из CHANGELOG.md: заголовок и пункты под ним.
 * Если раздела нет, печатает заготовку, и релиз всё равно выходит: пустые
 * заметки лучше, чем их отсутствие.
 */
const fs = require('node:fs');
const path = require('node:path');

const CHANGELOG = path.join(__dirname, '..', 'CHANGELOG.md');

const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: release-notes.mjs <version>\n');
  process.exit(2);
}

const text = fs.readFileSync(CHANGELOG, 'utf8');
const lines = text.split('\n');

// Раздел версии: заголовок «## 1.1.0» и всё до следующего «##».
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start === -1) {
  process.stdout.write(`## ${version}\n\n- Сборка ${version}.\n`);
  process.exit(0);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => l.startsWith('## '));
const body = (end === -1 ? rest : rest.slice(0, end));

const notes = [
  '',
  '',
  '**macOS:** подписи Developer ID нет, поэтому macOS не пускает приложение без',
  'подтверждения. Проще всего снять карантин с образа до его открытия:',
  '',
  '```',
  'xattr -dr com.apple.quarantine puuush-*.dmg',
  '```',
  '',
  'После этого образ открывается как обычно, без вопросов. Если карантин уже стоит,',
  'перетащите puuush.app в «Программы», откройте правой кнопкой → **Открыть** и',
  'подтвердите один раз: дальше приложение запускается обычным двойным щелчком.',
  '',
  '**Windows:** если SmartScreen остановит установщик, нажмите **More info** → **Run anyway**.',
  '',
  '**Linux:** AppImage запускается после `chmod +x`, .deb ставится обычным пакетным',
  'менеджером. Настройки и локальные копии снимков лежат в каталоге данных приложения и',
  'переживают обновление.',
  '',
].join('\n');

process.stdout.write([`## ${version}`, ...body].join('\n').replace(/\s+$/, '') + notes);
