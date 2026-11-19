// Szybki test składni całego panelu (używa go GitHub Actions): node --check dla JS, bash -n dla skryptów.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', 'vendor', '.git'].includes(f.name)) continue; const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
walk(root);
let bad = 0;
for (const f of files) {
  const rel = path.relative(root, f);
  const sh = /\.sh$/.test(f) || rel === 'bin/panel-serwera';
  if (!sh && !/\.(m?js)$/.test(f)) continue;
  try { execFileSync(sh ? 'bash' : process.execPath, sh ? ['-n', f] : ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error(`✗ ${rel}\n${String(e.stderr || e.message).trim()}\n`); }
}
for (const f of files.filter((f) => /\.json$/.test(f))) { try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { bad++; console.error(`✗ ${path.relative(root, f)}: ${e.message}`); } }
console.log(bad ? `${bad} plików z błędami` : `✓ ${files.length} plików sprawdzonych`);
process.exit(bad ? 1 : 0);
