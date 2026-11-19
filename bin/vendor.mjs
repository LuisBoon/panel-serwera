// Po `npm install`: kopiuje pliki terminala (xterm.js) z node_modules do public/vendor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });
for (const [from, to] of [['@xterm/xterm/lib/xterm.js', 'xterm.js'], ['@xterm/xterm/css/xterm.css', 'xterm.css'], ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js']]) {
  const src = path.join(root, 'node_modules', from);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, to));
}
