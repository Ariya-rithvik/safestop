// The Alexa+ integration: a self-hosted MCP server (protocol 2025-11-25, Streamable HTTP).
// Alexa+ (or any MCP client) calls these tools; every tool works on the same incident record.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PLAYBOOKS, triage } from './playbooks.js';
import type { Place } from './places.js';
import type { Store } from './store.js';
import { incidentView, relayActive } from './incident.js';
import { Policy } from './policy.js';
import { TEMPLATES, type Facts, type TemplateId } from './facts.js';

export interface McpDeps {
  store: Store;
  places: (lat: number, lon: number) => Promise<Place[] | null>;
  /** Shared across requests (the server is stateless per request; the policy's memory is not). */
  policy?: Policy;
  facts?: Facts;
  now?: () => number;
}

type Reply = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const reply = (text: string, data?: Record<string, unknown>): Reply => ({ content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}) });

const latLon = {
  latitude: z.number().min(-90).max(90).optional().describe('Device latitude, if Alexa has it'),
  longitude: z.number().min(-180).max(180).optional().describe('Device longitude, if Alexa has it'),
};

export function statusSentence(v: ReturnType<typeof incidentView>): string {
  if (v.status !== 'open') return v.safeConfirmedAt ? 'Your alert is closed. You told us you are safe.' : `Your alert is ${v.status}.`;
  const ack = v.contacts.filter((c) => c.state === 'acknowledged').map((c) => (c.channel === 'call' ? `${c.name} (said yes on a phone call)` : c.name));
  const calling = v.contacts.filter((c) => c.call?.state === 'calling').map((c) => c.name);
  const seen = v.contacts.filter((c) => c.state === 'delivered').map((c) => c.name);
  const sent = v.contacts.filter((c) => c.state === 'sent').map((c) => c.name);
  const parts: string[] = [];
  if (ack.length) parts.push(`${list(ack)} ${ack.length > 1 ? 'have' : 'has'} seen it and ${ack.length > 1 ? 'are' : 'is'} responding`);
  const PLAN = { calling_her: 'will call you', going_there: 'is coming to you', calling_police: 'is calling the police', other: 'is helping' } as const;
  for (const c of v.contacts) if (c.plan) parts.push(`${c.name} ${PLAN[c.plan.action]}${c.plan.etaMin != null ? `, about ${c.plan.etaMin} minutes away` : ''}`);
  if (seen.length) parts.push(`it has reached ${list(seen)}'s phone`);
  if (sent.length) parts.push(`it is sent to ${list(sent)} but not confirmed yet`);
  if (calling.length) parts.push(`I am phoning ${list(calling)} now`);
  if (v.ladder.state === 'exhausted' && !ack.length) parts.push('nobody has confirmed yet, so please call 112');
  for (const a of v.authorities ?? []) {
    // The desk's agent answering is not an officer deciding: say which one happened.
    if (a.state === 'dispatched') parts.push(`an officer at ${a.name} dispatched ${a.unit ?? 'a unit'}${a.etaMin ? `, about ${a.etaMin} minutes away` : ''}`);
    else if (a.state === 'declined') parts.push(`${a.name} declined, so please call 112`);
    else if (a.state === 'officer_calling') parts.push(`an officer at ${a.name} is calling you`);
    else if (a.state === 'prepared' || a.state === 'received') parts.push(`${a.name} has received it; an officer has not decided yet`);
  }
  return `Your alert is active. ${cap(parts.join('; '))}.`;
}
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function buildMcpServer(deps: McpDeps): McpServer {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const policy = deps.policy ?? new Policy(now);
  const server = new McpServer({ name: 'safestop-relay', version: '0.2.0' }, { instructions: 'Quiet roadside SOS for travellers in India. Call quiet_sos FIRST whenever the user says they are unsafe, scared, being followed, stopped, or uses their safe word; do not ask questions before calling it. Then read the guidance back briefly. Never say a crime is happening; never say help is on the way unless sos_status says a contact acknowledged. Closing an alert needs the traveller to say it twice.' });

  // Policy wrapper on every tool: inspect arguments, run, check the reply, write one audit line.
  let decision = 'allowed';
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) =>
    register(name, config, async (args: Record<string, unknown>, extra: unknown) => {
      decision = 'allowed';
      const before = store.current()?.id; // the call that closes an alert is still logged on it
      const flagged = policy.inspect(JSON.stringify(args ?? {})).injection;
      const res = (await (cb as (a: unknown, e: unknown) => Promise<Reply>)(args, extra)) as Reply;
      let blocked = false;
      res.content = res.content.map((c) => {
        const g = policy.guardReply(c.text);
        blocked ||= g.blocked;
        return { ...c, text: g.text };
      });
      store.audit(String(name), decision + (flagged ? '; instruction-like text treated as data' : '') + (blocked ? '; reply blocked (crime claim)' : ''), '', store.current()?.id ?? before);
      return res;
    });

  server.registerTool('quiet_sos', {
    title: 'Quiet SOS',
    description: 'Immediately alert the traveller’s trusted contacts that they may be unsafe on the road, then return short, safe guidance for the situation. Call this first, before asking anything.',
    inputSchema: { situation: z.string().max(500).optional().describe('What the traveller said, in their words'), ...latLon },
    annotations: { title: 'Quiet SOS', destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ situation, latitude, longitude }) => {
    const loc = latitude !== undefined && longitude !== undefined ? { lat: latitude, lon: longitude, accuracyM: null, at: now() } : null;
    const existed = !!store.current();
    const inc = store.sos('mcp', loc, situation);
    const v = incidentView(inc);
    const p = v.playbook;
    const names = list(v.contacts.map((c) => c.name));
    const text = [
      existed ? 'Your alert is still on; I have updated it.' : `I've alerted ${names || 'your trusted contacts'}.`,
      p ? p.say : 'Stay in the car with the doors locked and head for a busy, lit place if you can.',
      'If you are in danger, call 112.',
    ].join(' ');
    return reply(text, { incidentId: inc.id, contacts: v.contacts.map((c) => ({ name: c.name, state: c.state })), playbook: p, emergencyNumbers: ['112', '1033'] });
  });

  server.registerTool('sos_status', {
    title: 'SOS status',
    description: 'Say honestly who has received and who has acknowledged the traveller’s alert (sent, delivered, acknowledged).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const inc = store.current();
    if (!inc) return reply('There is no active alert.', { active: false });
    const v = incidentView(inc);
    return reply(statusSentence(v), { active: true, incidentId: inc.id, contacts: v.contacts, relay: v.relay });
  });

  server.registerTool('roadside_guidance', {
    title: 'Roadside guidance',
    description: 'Safe steps for one of five roadside situations (someone waving you down, object hit the windshield, road blocked, someone claiming to be police, being followed). Does not send an alert.',
    inputSchema: { situation: z.string().min(1).max(500).describe('What is happening, in the traveller’s words') },
    annotations: { readOnlyHint: true },
  }, async ({ situation }) => {
    const id = triage(situation);
    if (!id) return reply('Stay in the car with the doors locked, keep moving towards a busy, lit place, and call 112 if you feel unsafe. Say "SafeStop, alert my family" to alert your contacts.', { playbook: null });
    const p = PLAYBOOKS[id];
    return reply(`${p.say} ${p.steps.slice(0, 2).join(' ')}`, { playbook: p });
  });

  server.registerTool('safe_places_nearby', {
    title: 'Safe places nearby',
    description: 'Nearest police stations, hospitals, fuel stations and toll plazas from OpenStreetMap. Results are unverified and may be closed.',
    inputSchema: { latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ latitude, longitude }) => {
    const places = await deps.places(latitude, longitude);
    // Answers stops gave on the phone (shared by every traveller who asked before) come first.
    const confirmed = (deps.facts?.near(latitude, longitude, 15_000) ?? []).flatMap((s) => s.facts.filter((f) => f.answer === 'yes').slice(0, 1).map((f) => `${s.name}, ${(s.distanceM / 1000).toFixed(1)} km: asked "${f.question}" ${f.via === 'agent' ? "via its own AI agent" : 'by phone'} at ${new Date(f.collectedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}, they said "${f.quote}"`));
    if (confirmed.length && (places === null || !places.length)) return reply(`Confirmed by phone: ${confirmed.slice(0, 2).join('; ')}.`, { confirmed });
    if (places === null) return reply('I could not look up places right now. Head for the next fuel station or toll plaza on your route.', { places: null });
    if (!places.length) return reply('OpenStreetMap shows no police station, hospital, fuel station or toll plaza within 8 km.', { places: [] });
    const top = places.slice(0, 3).map((p) => `${p.label}${p.name !== p.label ? ` ${p.name}` : ''}, ${(p.distanceM / 1000).toFixed(1)} km`);
    const age = places[0].asOf ? Date.now() - places[0].asOf : 0;
    const when = age > 10 * 60_000 ? ` (saved copy from ${Math.round(age / 3_600_000) || 1} hours ago; the live map is not answering)` : '';
    return reply(`${confirmed.length ? `Confirmed by phone: ${confirmed.slice(0, 2).join('; ')}. ` : ''}From OpenStreetMap${when}, not verified: ${top.join('; ')}.`, { places, source: 'OpenStreetMap contributors (ODbL)', verified: false });
  });

  server.registerTool('check_stop_ahead', {
    title: 'Check a stop ahead',
    description: 'Ask a roadside stop (fuel station, dhaba, toll plaza) one factual question: open now, open until 6 am, staff on site, lit parking, women’s restroom. A recent answer from any traveller is reused without calling. Otherwise SafeStop phones the stop once, but only after the traveller confirms (call again with confirm: true). Never asks whether a place is "safe".',
    inputSchema: {
      stop: z.string().max(80).optional().describe('Name of the stop, e.g. "Indian Oil"; nearest one if omitted'),
      question: z.enum(Object.keys(TEMPLATES) as [TemplateId, ...TemplateId[]]).default('open_now'),
      latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
      confirm: z.boolean().default(false).describe('true only after the traveller agreed to the call'),
    },
    annotations: { openWorldHint: true },
  }, async ({ stop, question, latitude, longitude, confirm }) => {
    if (!deps.facts) return reply('Stop checks are not set up on this server.', { available: false });
    const near = deps.facts.near(latitude, longitude, 40_000);
    const s = stop ? near.find((x) => x.name.toLowerCase().includes(stop.toLowerCase())) : near[0];
    if (!s) return reply(stop ? `I don't have a registered stop called ${stop} near you.` : 'There is no registered stop near you yet.', { found: false });
    const r = await deps.facts.ask(s.id, { templateId: question }, confirm);
    const when = (t: number) => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    switch (r.status) {
      case 'answered': return reply(`${s.name}'s own AI agent answered machine-to-machine in ${r.fact.ms} ms: "${r.fact.quote}" No phone call needed.`, { fact: r.fact, stop: s.name, via: 'agent' });
      case 'fresh': return reply(`${s.name} was asked "${r.fact.question}" ${r.fact.via === 'agent' ? "via its own AI agent" : 'by phone'} at ${when(r.fact.collectedAt)} and said: "${r.fact.quote}". Still fresh, so nobody is asked again.`, { fact: r.fact, stop: s.name });
      case 'needs_confirmation': return reply(`Nobody has asked ${s.name} that recently. Should I phone them once and ask "${r.preview.question}"? The answer will be shared with other travellers.`, { preview: r.preview, confirmationNeeded: true });
      case 'calling': return reply(`Calling ${s.name} now. The answer usually takes about a minute.`, { calling: true, callId: r.callId });
      case 'in_flight': return reply(`Someone is already asking ${s.name} that right now; I'll use their answer.`, { inFlight: true });
      default: return reply(r.reason, { refused: true });
    }
  });

  server.registerTool('share_with_nearby_travellers', {
    title: 'Ask nearby travellers',
    description: 'Opt in (or out) to tell SafeStop users within 1 km that someone nearby asked for help, for 15 minutes. They never see the traveller’s name or exact location; their offers are labelled unverified.',
    inputSchema: { enable: z.boolean() },
    annotations: { openWorldHint: true },
  }, async ({ enable }) => {
    const inc = store.current();
    if (!inc) return reply('Start an alert first: say "SafeStop, alert my family".', { active: false });
    const d = policy.relay(inc.id, enable);
    if (!d.allow) {
      decision = `denied: ${d.reason}`;
      return reply(d.say, { relay: relayActive(inc, now()), denied: d.reason });
    }
    store.relay(inc.id, enable);
    if (!enable) return reply('Nearby travellers will no longer be asked.', { relay: false });
    if (!inc.location) return reply('I need your location to ask nearby travellers. Your family has been alerted.', { relay: true, notified: 0 });
    const n = inc.relay?.notified ?? 0;
    return reply(n ? `I've asked ${n} SafeStop ${n === 1 ? 'traveller' : 'travellers'} within 1 kilometre. Anyone who answers is unverified; do not leave your car for them.` : 'No SafeStop travellers are within 1 kilometre right now. I will keep asking for 15 minutes.', { relay: relayActive(inc, now()), notified: n });
  });

  server.registerTool('im_safe', {
    title: 'I’m safe',
    description: 'The traveller confirms they are safe. Closes the alert and tells their contacts.',
    inputSchema: {},
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async () => {
    const inc = store.current();
    if (!inc) return reply('There is no active alert.', { active: false });
    const d = policy.close(inc.id, 'safe');
    if (!d.allow) {
      decision = `held: ${d.reason}`;
      return reply(d.say, { resolved: false, confirmationNeeded: true });
    }
    store.resolve(inc.id, 'traveller');
    return reply('Glad you are safe. I have told your contacts.', { resolved: true, incidentId: inc.id });
  });

  server.registerTool('cancel_sos', {
    title: 'Cancel SOS',
    description: 'Cancel an alert that was started by mistake. Contacts are told it was cancelled.',
    inputSchema: {},
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async () => {
    const inc = store.current();
    if (!inc) return reply('There is no active alert.', { active: false });
    const d = policy.close(inc.id, 'cancel');
    if (!d.allow) {
      decision = `held: ${d.reason}`;
      return reply(d.say, { cancelled: false, confirmationNeeded: true });
    }
    store.resolve(inc.id, 'traveller', true);
    return reply('Cancelled. Your contacts have been told it was a mistake.', { cancelled: true, incidentId: inc.id });
  });

  return server;
}
