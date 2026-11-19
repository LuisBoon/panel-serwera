// Terminal panelu: kod 2FA → sesja → xterm.js. Dane czytane długim odpytywaniem (bez WebSocketów).
(() => {
  const $ = (id) => document.getElementById(id);
  let sid = null, seq = 0, term = null, fit = null, alive = false, outBuf = '', outT = null;
  async function api(method, path, body) {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'X-Panel': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    if (r.status === 401 && method === 'GET') { location.href = './'; throw new Error('Zaloguj się.'); }
    if (!r.ok) { const e = new Error(j?.error || `Błąd ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  function send(data) { // łączymy szybkie naciśnięcia w jedną paczkę
    outBuf += data;
    if (outT) return;
    outT = setTimeout(async () => { const d = outBuf; outBuf = ''; outT = null; if (!sid || !d) return; try { await api('POST', `api/terminal/${sid}/pisz`, { data: d }); } catch (e) { if (e.status === 410) end('Sesja wygasła.'); } }, 25);
  }
  async function poll() {
    while (alive) {
      try {
        const r = await api('GET', `api/terminal/${sid}/czytaj?od=${seq}`);
        if (r.data) term.write(r.data);
        seq = r.seq;
        if (r.closed) { end(`Sesja zakończona (${r.reason}).`); return; }
      } catch (e) { if (e.status === 410 || e.status === 403) { end('Sesja wygasła.'); return; } await new Promise((res) => setTimeout(res, 1500)); }
    }
  }
  function end(text) {
    alive = false; sid = null;
    $('endtxt').textContent = text; $('ended').hidden = false; $('term').hidden = true; $('end').hidden = true; $('shortcuts').hidden = true;
  }
  function size() { try { fit.fit(); } catch {} return { cols: term.cols, rows: term.rows }; }
  async function start(code) {
    $('gate').hidden = true; $('ended').hidden = true; $('term').hidden = false;
    if (!term) {
      term = new window.Terminal({ fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace', fontSize: window.innerWidth < 600 ? 12 : 14, cursorBlink: true, scrollback: 5000, theme: { background: '#06080b', foreground: '#d7e0dc', cursor: '#2bb39b', selectionBackground: '#2bb39b55' } });
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open($('term'));
      term.onData(send);
      let rt = null;
      window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { const s = size(); if (sid) api('POST', `api/terminal/${sid}/rozmiar`, s).catch(() => {}); }, 150); });
    } else term.reset();
    const s = size();
    const r = await api('POST', 'api/terminal/otworz', { totp: code, ...s });
    sid = r.id; seq = 0; alive = true;
    $('end').hidden = false; $('shortcuts').hidden = false;
    term.focus();
    poll();
  }
  $('gate').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('err').hidden = true; $('go').disabled = true;
    try { await start($('totp').value.trim()); }
    catch (er) { $('gate').hidden = false; $('term').hidden = true; $('err').textContent = er.message; $('err').hidden = false; $('totp').value = ''; $('totp').focus(); }
    finally { $('go').disabled = false; }
  });
  $('end').addEventListener('click', async () => { if (sid) { try { await api('POST', `api/terminal/${sid}/zamknij`); } catch {} } end('Sesja zakończona.'); });
  $('again').addEventListener('click', () => { $('ended').hidden = true; $('gate').hidden = false; $('totp').value = ''; $('totp').focus(); });
  for (const b of document.querySelectorAll('[data-cmd]')) b.addEventListener('click', () => { if (sid) { send(b.dataset.cmd + '\r'); term.focus(); } });
  const unesc = (s) => s.replace(/\\t/g, '\t').replace(/\\u([0-9a-f]{4})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));
  for (const b of document.querySelectorAll('[data-key]')) b.addEventListener('click', () => { if (sid) { send(unesc(b.dataset.key)); term.focus(); } });
  window.addEventListener('pagehide', () => { if (sid) fetch(`api/terminal/${sid}/zamknij`, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'X-Panel': '1' } }).catch(() => {}); });
  api('GET', 'api/terminal').catch((e) => { if (e.status === 403) { $('gate').innerHTML = ''; const p = document.createElement('p'); p.textContent = 'Terminal jest dostępny tylko dla właściciela panelu.'; $('gate').append(p); } });
  $('totp').focus();
})();
