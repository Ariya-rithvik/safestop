// SIMULATED highway patrol desk: an A2A agent (official @a2a-js/sdk) that a real authority could run.
// It is NOT connected to any real police. It shows the division of work SafeStop proposes:
//   the desk's AGENT acts in milliseconds  -> verifies the signed CAP alert, says "received",
//                                             finds the nearest patrol unit, prepares the dispatch;
//   the desk's OFFICER (a human) decides    -> dispatch, call the traveller, or decline.
// The agent never dispatches anyone by itself.
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, Role, TaskState, type AgentCard, type Message, type Part, type Task } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor, type ExecutionEventBus, type RequestContext, type ServerCallContext } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { verifySigned, type CapAlert } from '../src/cap.js';
import { distanceM } from '../src/incident.js';

export interface Unit { id: string; name: string; lat: number; lon: number }
export interface DeskCase {
  taskId: string; contextId: string; receivedAt: number; verified: boolean; alert: CapAlert;
  prepared: { unit: Unit; distanceKm: number; etaMin: number } | null;
  decision: null | { kind: 'dispatch' | 'call' | 'decline'; at: number; note: string };
  closed: boolean;
  /** The A2A call context the task was stored under (needed to update that same task later). */
  callContext?: ServerCallContext;
}

const part = (text: string): Part => ({ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const dataPart = (value: unknown): Part => ({ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' });
const agentMsg = (taskId: string, contextId: string, parts: Part[]): Message => ({
  role: Role.ROLE_AGENT, messageId: crypto.randomUUID(), parts, taskId, contextId, extensions: [], metadata: {}, referenceTaskIds: [],
});

/** Nearest unit and a rough ETA (straight line x1.3 for roads, 60 km/h) (pure; tested). */
export function nearestUnit(units: Unit[], lat: number, lon: number) {
  let best: { unit: Unit; distanceKm: number; etaMin: number } | null = null;
  for (const u of units) {
    const km = (distanceM({ lat, lon }, u) / 1000) * 1.3;
    if (!best || km < best.distanceKm) best = { unit: u, distanceKm: Math.round(km * 10) / 10, etaMin: Math.max(1, Math.round((km / 60) * 60)) };
  }
  return best;
}

export function createDesk(opts: { port: number; safestopJwks: (refresh?: boolean) => Promise<{ keys: any[] }>; units: Unit[]; token?: string; publicUrl?: string; webDir: string; log?: (m: string) => void }) {
  const log = opts.log ?? (() => {});
  const cases = new Map<string, DeskCase>(); // by CAP identifier
  const listeners = new Set<(c: DeskCase) => void>();
  const changed = (c: DeskCase) => listeners.forEach((f) => f(c));
  const taskStore = new InMemoryTaskStore();

  const card: AgentCard = {
    name: 'Highway Patrol Desk (SIMULATED)',
    description: 'Demo authority agent. Receives signed CAP 1.2 traveller alerts from SafeStop, verifies them, prepares the nearest-unit dispatch in milliseconds, and waits for a human officer to decide. Not connected to real police.',
    supportedInterfaces: [{ url: `${opts.publicUrl ?? `http://localhost:${opts.port}`}/`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: 'SafeStop demo (simulated authority)', url: 'https://github.com/' },
    version: '0.1.0',
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json', 'text/plain'],
    skills: [{
      id: 'receive_traveller_alert', name: 'Receive a traveller alert',
      description: 'Accepts a JWS-signed CAP 1.2 alert (data part {jws}); returns a task: WORKING with the prepared dispatch, then COMPLETED (officer dispatched) or REJECTED (officer declined).',
      tags: ['cap', 'highway', 'safety'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'], securityRequirements: [],
    }],
    documentationUrl: '', signatures: [],
  };

  const executor: AgentExecutor = {
    cancelTask: async () => {},
    async execute(ctx: RequestContext, bus: ExecutionEventBus) {
      const t0 = Date.now();
      const data = ctx.userMessage.parts.find((p) => p.content?.$case === 'data')?.content;
      const jws = data && data.$case === 'data' ? (data.value as { jws?: string })?.jws : undefined;
      const fail = (state: TaskState, why: string) => {
        bus.publish(AgentEvent.task({ id: ctx.taskId, contextId: ctx.contextId, status: { state, timestamp: new Date().toISOString(), message: agentMsg(ctx.taskId, ctx.contextId, [part(why)]) }, artifacts: [], history: [ctx.userMessage], metadata: {} }));
        bus.finished();
      };
      if (!jws) return fail(TaskState.TASK_STATE_REJECTED, 'No signed alert in the message.');
      let alert: CapAlert;
      try {
        try {
          alert = await verifySigned(jws, await opts.safestopJwks());
        } catch {
          // The sender may have a new key: fetch its published keys once more, then decide.
          alert = await verifySigned(jws, await opts.safestopJwks(true));
        }
      } catch (e) {
        log(`rejected: signature check failed (${(e as Error).message})`);
        return fail(TaskState.TASK_STATE_REJECTED, 'Signature did not verify; alert ignored.');
      }
      const existing = cases.get(alert.identifier);
      const [lat, lon] = alert.info.area.circle[0].split(' ')[0].split(',').map(Number);
      const prepared = nearestUnit(opts.units, lat, lon);
      const c: DeskCase = existing ?? { taskId: ctx.taskId, contextId: ctx.contextId, receivedAt: t0, verified: true, alert, prepared, decision: null, closed: false };
      c.alert = alert;
      c.callContext ??= ctx.context;
      if (!c.decision) c.prepared = prepared; // after an officer decided, the dispatch is not silently re-planned
      if (alert.msgType === 'Cancel') c.closed = true;
      cases.set(alert.identifier, c);
      const state = c.closed ? TaskState.TASK_STATE_CANCELED : c.decision?.kind === 'dispatch' ? TaskState.TASK_STATE_COMPLETED : c.decision?.kind === 'decline' ? TaskState.TASK_STATE_REJECTED : TaskState.TASK_STATE_WORKING;
      const text = c.closed
        ? 'Alert closed by the traveller side. Desk case closed.'
        : `Received and verified. Prepared: nearest unit ${prepared?.unit.name ?? 'none'}${prepared ? `, about ${prepared.distanceKm} km, ${prepared.etaMin} min` : ''}. Waiting for the desk officer to decide.`;
      bus.publish(AgentEvent.task({
        id: c.taskId, contextId: c.contextId,
        status: { state, timestamp: new Date().toISOString(), message: agentMsg(c.taskId, c.contextId, [part(text), dataPart({ stage: c.closed ? 'closed' : 'prepared', verified: true, prepared: c.prepared, decision: c.decision, agentMs: Date.now() - t0 })]) },
        artifacts: [], history: [ctx.userMessage], metadata: {},
      }));
      bus.finished();
      changed(c);
      log(`${alert.msgType} ${alert.identifier}: verified, prepared ${prepared?.unit.id} in ${Date.now() - t0} ms`);
    },
  };

  const handler = new DefaultRequestHandler(card, taskStore, executor);

  /** The officer's decision: the only way a dispatch happens. Updates the A2A task SafeStop is watching. */
  async function decide(identifier: string, kind: 'dispatch' | 'call' | 'decline') {
    const c = cases.get(identifier);
    if (!c || c.closed) return false;
    const unit = c.prepared?.unit.name ?? 'a unit';
    const note = kind === 'dispatch' ? `Officer dispatched ${unit}, about ${c.prepared?.etaMin ?? '?'} min.` : kind === 'call' ? 'Officer is calling the traveller.' : 'Officer declined: please call 112.';
    c.decision = { kind, at: Date.now(), note };
    const task = c.callContext ? ((await taskStore.load(c.taskId, c.callContext)) as Task | undefined) : undefined;
    if (task) {
      const state = kind === 'dispatch' ? TaskState.TASK_STATE_COMPLETED : kind === 'decline' ? TaskState.TASK_STATE_REJECTED : TaskState.TASK_STATE_WORKING;
      task.status = { state, timestamp: new Date().toISOString(), message: agentMsg(c.taskId, c.contextId, [part(note), dataPart({ stage: 'decided', decision: c.decision, prepared: c.prepared })]) };
      if (kind === 'dispatch') task.artifacts = [{ artifactId: crypto.randomUUID(), name: 'dispatch', description: 'Officer decision', parts: [dataPart({ unit: c.prepared?.unit, etaMin: c.prepared?.etaMin, by: 'desk officer (demo)' })], metadata: undefined, extensions: [] }];
      await taskStore.save(task, c.callContext!);
    }
    changed(c);
    log(`officer: ${kind} on ${identifier}`);
    return true;
  }

  const app = express();
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  // Agent-to-agent calls need the shared token (plus the JWS signature on every alert).
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/' && opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return void res.status(401).json({ error: 'unauthorized' });
    next();
  });
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  // The officer's console (a human).
  app.get('/desk', (_req, res) => res.type('html').send(readFileSync(join(opts.webDir, 'desk.html'), 'utf8')));
  app.get('/desk/units', (_req, res) => res.json({ units: opts.units }));
  app.get('/desk/map.js', (_req, res) => res.type('js').send(readFileSync(join(opts.webDir, '..', 'web', 'map.js'), 'utf8')));
  app.get('/api/route', (_req, res) => { try { const r = JSON.parse(readFileSync(join(opts.webDir, '..', 'evals', 'route-krishnagiri-vellore.json'), 'utf8')); res.json({ coordinates: r.coordinates }); } catch { res.status(404).end(); } });
  app.get('/desk/events', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const push = (c: DeskCase) => res.write(`data: ${JSON.stringify({ ...c, callContext: undefined })}\n\n`);
    for (const c of cases.values()) push(c);
    listeners.add(push);
    req.on('close', () => listeners.delete(push));
  });
  app.post('/desk/decide', express.json({ limit: '2kb' }), async (req, res) => {
    const { identifier, kind } = req.body ?? {};
    if (typeof identifier !== 'string' || !['dispatch', 'call', 'decline'].includes(kind)) return void res.status(400).json({ error: 'bad request' });
    res.json({ ok: await decide(identifier, kind) });
  });

  let server: ReturnType<typeof app.listen> | null = null;
  return {
    cases, decide,
    listen: () => new Promise<number>((ok) => {
      server = app.listen(opts.port, () => {
        const a = server!.address();
        const port = typeof a === 'object' && a ? a.port : opts.port;
        // The card must advertise the port actually in use (tests ask for port 0 = any free port).
        if (!opts.publicUrl) card.supportedInterfaces[0].url = `http://localhost:${port}/`;
        ok(port);
      });
    }),
    close: () => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())),
  };
}

/** Simulated patrol units placed on the real Krishnagiri -> Vellore road (evals/route-krishnagiri-vellore.json). */
export function unitsOnRoute(coords: [number, number][]): Unit[] {
  const at = (f: number) => { const [lon, lat] = coords[Math.floor(f * (coords.length - 1))]; return { lat, lon }; };
  return [
    { id: 'HP-07', name: 'Highway patrol HP-07 (simulated)', ...at(0.12) },
    { id: 'HP-12', name: 'Highway patrol HP-12 (simulated)', ...at(0.45) },
    { id: 'HP-19', name: 'Highway patrol HP-19 (simulated)', ...at(0.85) },
  ];
}
