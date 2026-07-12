/**
 * Copies non-TypeScript build assets into dist:
 *  - the Vivint dictionary JSON next to the compiled dictionary module
 *  - the custom UI's static public folder
 */
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const copies = [
  [join(root, 'src', 'vivint', 'vivint_dictionary.json'), join(root, 'dist', 'vivint', 'vivint_dictionary.json')],
  [join(root, 'homebridge-ui', 'public'), join(root, 'dist', 'homebridge-ui', 'public')],
];

for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
