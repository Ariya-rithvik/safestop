// Run a SIMULATED station AI agent for the first demo stop: npm run stopagent  (port 8794)
// SafeStop finds it through STOP_AGENTS=<stopId>=<url> and then asks agent-to-agent instead of phoning.
import { existsSync, readFileSync } from 'node:fs';
import { createStopAgent } from './agent.js';

const env: Record<string, string> = {};
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
}
const { places } = JSON.parse(readFileSync('evals/stops-vellore-nominatim.json', 'utf8')) as { places: { osm_type: string; osm_id: number; name: string; type: string }[] };
const first = places.find((p) => p.type === 'fuel' && p.name)!;
const stopId = `${first.osm_type[0]}${first.osm_id}`;
const port = Number(process.env.STOP_AGENT_PORT ?? env.STOP_AGENT_PORT ?? 8794);
const a = await createStopAgent({
  port, stopId, name: first.name, keyFile: 'data/stop-agent-key.json',
  // Demo state of the station's own system (simulated).
  state: { open24h: true, openNow: true, staffOnDuty: 2, litForecourt: true, womensRestroomOpen: true },
  log: (m) => console.log(`[station agent] ${m}`),
});
console.log(`SIMULATED station agent for ${first.name} (${stopId}) on ${a.url}`);
console.log(`  Agent card: ${a.url}/.well-known/agent-card.json`);
console.log(`  Add to SafeStop .env: STOP_AGENTS=${stopId}=${a.url}`);
