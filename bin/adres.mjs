// Używa instalator: ustawia adres panelu (vhost Apache + certyfikat Let's Encrypt). node bin/adres.mjs <domena> [e-mail]
import { setupPanelDomain } from '../lib/setup.mjs';
try { await setupPanelDomain(process.argv[2], process.argv[3] || '', (t) => process.stdout.write(t)); process.exit(0); }
catch (e) { console.error('✗ ' + e.message); process.exit(1); }
