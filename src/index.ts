import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { placesLookup } from './places.js';
import { makeCaller } from './calle.js';
import { llmChain } from './understand.js';
import { Facts, demoStops } from './facts.js';
import type { Profile } from './store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// The traveller's profile: name + trusted contacts. Links stay the same across restarts.
const dataDir = resolve(root, process.env.DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });
const profileFile = join(dataDir, 'profile.json');
const tok = (p: string) => p + randomBytes(12).toString('hex');
let saved: (Profile & { travellerKey: string }) | null = existsSync(profileFile) ? JSON.parse(readFileSync(profileFile, 'utf8')) : null;
const traveller = process.env.TRAVELLER_NAME ?? saved?.traveller ?? 'Priya';
const names = (process.env.CONTACTS ?? saved?.contacts.map((c) => c.name).join(',') ?? 'Ravi,Meena').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
const profile = {
  traveller,
  contacts: names.map((name, i) => saved?.contacts.find((c) => c.name === name) ?? { id: `c${i + 1}`, name, token: tok('ct_') }),
  travellerKey: saved?.travellerKey ?? tok('tk_'),
};
writeFileSync(profileFile, JSON.stringify(profile, null, 2));

// Phone numbers for the escalation ladder come from .env at run time (CONTACT_PHONES=Ravi:+91…,Meena:+91…)
// and are never written to profile.json or sent to any screen.
const phones = new Map((process.env.CONTACT_PHONES ?? '').split(',').map((x) => x.split(':').map((s) => s.trim())).filter((x) => x.length === 2 && x[1]) as [string, string][]);
const langs = new Map((process.env.CONTACT_LANGS ?? '').split(',').map((x) => x.split(':').map((s) => s.trim())).filter((x) => x.length === 2 && x[1]) as [string, string][]);
const caller = makeCaller({
  apiKey: process.env.CALLE_API_KEY, allowed: process.env.CALLE_ALLOWED_NUMBERS, maxCalls: Number(process.env.CALLE_MAX_CALLS ?? 6),
  dryRun: process.env.DRY_RUN === '1', log: (m) => console.log(`[calle] ${m}`),
});

// Confirmed stops ahead: real OSM fuel stations, registered for the demo with the (allowlisted) test phone.
const demoPhone = (process.env.CALLE_ALLOWED_NUMBERS ?? '').split(',')[0]?.trim() ?? '';
// Stops that run their own AI agent (STOP_AGENTS=<stopId>=<url>,...) are asked agent-to-agent first.
const stopAgents = new Map((process.env.STOP_AGENTS ?? '').split(',').map((x) => { const i = x.indexOf('='); return [x.slice(0, i).trim(), x.slice(i + 1).trim()] as [string, string]; }).filter(([k, v]) => k && v));
const facts = new Facts(demoStops(join(root, 'evals', 'stops-vellore-nominatim.json'), demoPhone).map((s) => (stopAgents.has(s.id) ? { ...s, agentUrl: stopAgents.get(s.id) } : s)), caller, {
  file: join(dataDir, 'facts.json'), dailyCap: Number(process.env.STOP_CALLS_PER_DAY ?? 10), log: (m) => console.log(`[stops] ${m}`),
});

const port = Number(process.env.PORT ?? 8790);
const app = createApp({
  profile: { traveller: profile.traveller, contacts: profile.contacts.map((c) => ({ ...c, phone: phones.get(c.name), language: langs.get(c.name) })) },
  caller,
  facts,
  routeFile: join(root, 'evals', 'route-krishnagiri-vellore.json'),
  llm: llmChain(process.env),
  authorities: {
    agents: (process.env.AUTHORITY_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    token: process.env.AUTHORITY_TOKEN || undefined,
    // The traveller's choice, made once in setup: share exact location with authorised agencies.
    consent: process.env.SHARE_WITH_AUTHORITIES === '1',
    status: (process.env.CAP_STATUS as 'Actual' | 'Exercise' | 'Test') ?? 'Exercise',
    sender: `safestop@${process.env.SENDER_HOST ?? 'localhost'}`,
  },
  dataDir, webDir: join(root, 'web'), travellerKey: profile.travellerKey,
  places: placesLookup(undefined, join(dataDir, 'places-cache.json')), mcpToken: process.env.MCP_TOKEN || undefined,
  log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
});
await app.listen(port);

// Optional HTTPS front door for real phones (location and microphone need a secure page).
const cert = process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE ? { cert: readFileSync(resolve(root, process.env.TLS_CERT_FILE)), key: readFileSync(resolve(root, process.env.TLS_KEY_FILE)) } : null;
const tlsPort = Number(process.env.TLS_PORT ?? 8791);
if (cert) {
  const s = https.createServer(cert);
  s.on('request', (req, res) => app.server.emit('request', req, res));
  s.on('upgrade', (req, sock, head) => app.server.emit('upgrade', req, sock, head));
  s.listen(tlsPort);
}

const base = `http://localhost:${port}`;
console.log(`SafeStop Relay on ${base}`);
console.log(`  MCP endpoint (Streamable HTTP, protocol 2025-11-25): ${base}/mcp${process.env.MCP_TOKEN ? '  (Bearer token required)' : '  (no token: local demo only)'}`);
console.log(`  Traveller (simulated Alexa+): ${base}/traveller#${profile.travellerKey}`);
for (const c of profile.contacts) console.log(`  Trusted contact ${c.name}: ${base}/contact/${c.token}`);
console.log(`  Nearby traveller: ${base}/nearby`);
if (cert) console.log(`  HTTPS for phones on port ${tlsPort}`);
console.log(`  Authority agents (A2A, signed CAP): ${process.env.SHARE_WITH_AUTHORITIES === '1' ? process.env.AUTHORITY_AGENTS || 'none configured' : 'off (traveller has not agreed)'}`);
console.log(`  Stops with their own AI agent (asked machine-to-machine first): ${stopAgents.size ? [...stopAgents.keys()].join(', ') : 'none'}`);
console.log(`  Escalation calls: ${caller.mode === 'live' ? 'LIVE via CALL-E' : 'dry run (no calls placed)'} · contacts with a phone: ${[...phones.keys()].join(', ') || 'none'}`);

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
