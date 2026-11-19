// Dziennik zmian z cofaniem: każda zmiana zrobiona w panelu trafia tu z opisem i — jeśli się da —
// z przepisem na cofnięcie. Przepis to { type, data }; obsługę typów rejestrują moduły (handler()).
import fs from 'node:fs';
import path from 'node:path';

let db;
const handlers = new Map();
const after = new Map(); // czynności po przywróceniu pliku (np. przeładowanie Apache)

export function init(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS dziennik(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, login TEXT, area TEXT, text TEXT, undo TEXT,
    undone INTEGER NOT NULL DEFAULT 0, undone_by TEXT, undone_ts INTEGER, link TEXT)`);
  handler('plik', async (d) => {
    // przywrócenie pliku do stanu sprzed zmiany (albo usunięcie, jeśli wcześniej go nie było)
    if (d.content == null) fs.rmSync(d.path, { force: true });
    else { fs.mkdirSync(path.dirname(d.path), { recursive: true }); fs.writeFileSync(d.path, Buffer.from(d.content, 'base64'), { mode: d.mode || 0o644 }); }
    for (const a of [].concat(d.after || [])) { const fn = after.get(String(a).split(':')[0]); if (fn) await fn(String(a).split(':').slice(1).join(':')); }
  });
  handler('pliki', async (d) => { for (const f of d.files) await handlers.get('plik')(f); });
}
export function handler(type, fn) { handlers.set(type, fn); }
export function afterRestore(name, fn) { after.set(name, fn); }

/** Stan pliku przed zmianą — do przepisu cofnięcia. */
export function fileBefore(p, afterActions = []) {
  let content = null, mode = 0o644;
  try { content = fs.readFileSync(p).toString('base64'); mode = fs.statSync(p).mode & 0o777; } catch {}
  return { path: p, content, mode, after: afterActions };
}

export function add(who, area, text, undo = null, link = null) {
  const r = db.prepare('INSERT INTO dziennik(ts,login,area,text,undo,link) VALUES(?,?,?,?,?,?)')
    .run(Date.now(), who?.login || 'autopilot', String(area), String(text).slice(0, 400), undo ? JSON.stringify(undo) : null, link);
  return Number(r.lastInsertRowid);
}

export function list({ limit = 150, area = null, before = null } = {}) {
  const rows = db.prepare(`SELECT id,ts,login,area,text,undo IS NOT NULL can,undone,undone_by,undone_ts,link FROM dziennik
    WHERE (? IS NULL OR area=?) AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`).all(area, area, before, before, Math.min(500, limit));
  return rows.map((r) => ({ ...r, can: !!r.can && !r.undone }));
}

export async function undo(id, who) {
  const e = db.prepare('SELECT * FROM dziennik WHERE id=?').get(Number(id));
  if (!e) throw new Error('Nie ma takiej zmiany.');
  if (e.undone) throw new Error('Ta zmiana jest już cofnięta.');
  if (!e.undo) throw new Error('Tej zmiany nie da się cofnąć z panelu.');
  const u = JSON.parse(e.undo);
  const fn = handlers.get(u.type);
  if (!fn) throw new Error('Tej zmiany nie da się już cofnąć (nieznany rodzaj).');
  await fn(u.data, who);
  db.prepare('UPDATE dziennik SET undone=1, undone_by=?, undone_ts=? WHERE id=?').run(who?.login || '', Date.now(), e.id);
  add(who, e.area, `Cofnięto: ${e.text}`, null, e.link);
  return { ok: true };
}
