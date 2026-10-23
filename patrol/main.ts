// Run the SIMULATED highway patrol desk: npm run patrol   (officer console at http://localhost:8792/desk)
import { existsSync, readFileSync } from 'node:fs';
import { createDesk, unitsOnRoute } from './patrol.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const SAFESTOP = process.env.SAFESTOP_URL ?? 'http://localhost:8790';
let cached: { keys: any[] } | null = null;
const desk = createDesk({
  port: Number(process.env.PATROL_PORT ?? 8792),
  // Demo only: how much faster than real time the simulated unit drives (default 1 = real time).
  simSpeed: Number(process.env.PATROL_SIM_SPEED ?? 1),
  token: process.env.AUTHORITY_TOKEN || undefined,
  webDir: 'patrol',
  units: unitsOnRoute(JSON.parse(readFileSync('evals/route-krishnagiri-vellore.json', 'utf8')).coordinates),
  // SafeStop's public signing keys: alerts that do not verify against them are rejected.
  safestopJwks: async (refresh) => (refresh || !cached ? (cached = (await (await fetch(`${SAFESTOP}/.well-known/jwks.json`)).json()) as { keys: any[] }) : cached),
  log: (m) => console.log(`[patrol desk] ${m}`),
});
const port = await desk.listen();
console.log(`SIMULATED highway patrol desk (A2A agent) on http://localhost:${port}`);
console.log(`  Agent card: http://localhost:${port}/.well-known/agent-card.json`);
console.log(`  Officer console: http://localhost:${port}/desk`);
