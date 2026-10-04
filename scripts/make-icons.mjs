// Renders the app icons from public/icons/*.svg. Run once after changing the artwork: node scripts/make-icons.mjs
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
const rounded = await readFile('public/icons/icon.svg');
const maskable = await readFile('public/icons/icon-maskable.svg');
for (const [name, source, size] of [['icon-192.png', rounded, 192], ['icon-512.png', rounded, 512], ['icon-maskable-512.png', maskable, 512], ['apple-touch-icon.png', maskable, 180]]) {
  await writeFile(`public/icons/${name}`, await sharp(source).resize(size, size).png().toBuffer());
  console.info(`wrote public/icons/${name}`);
}
