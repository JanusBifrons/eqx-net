/**
 * Serves the art lab on the LAN for a phone run and collects the results.
 *   pnpm tsx scripts/art-lab/phone-server.ts
 * Prints the phone URL; each finished run is written to diag/art-lab/phone/.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const LAB_PORT = 5374, REPORT_PORT = 5375;
const OUT = 'diag/art-lab/phone';
mkdirSync(OUT, { recursive: true });

const lan = Object.values(networkInterfaces()).flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address))?.address ?? 'localhost';

const vite = spawn('pnpm', ['exec', 'vite', '--host', '0.0.0.0', '--port', String(LAB_PORT), '--strictPort'], { shell: true, stdio: 'ignore' });

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  let body = '';
  req.on('data', (c: Buffer) => { body += c.toString(); if (body.length > 2_000_000) req.destroy(); });
  req.on('end', () => {
    try {
      const parsed: unknown = JSON.parse(body);
      const file = `${OUT}/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(file, JSON.stringify(parsed, null, 2));
      console.log(`result saved: ${file}`);
      res.writeHead(200).end('ok');
    } catch {
      res.writeHead(400).end('bad json');
    }
  });
});
server.listen(REPORT_PORT, '0.0.0.0', () => {
  console.log(`PHONE URL: http://${lan}:${LAB_PORT}/__art-lab__/phone.html`);
});

const stop = (): void => {
  server.close();
  if (vite.pid) { try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
