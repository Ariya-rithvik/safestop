// SIMULATED fuel-station AI agent: what a stop that has its own AI receptionist would expose.
// When SafeStop finds this agent card, the two agents skip human language entirely: SafeStop sends one
// structured question (protocol safestop.stopquery/1 over A2A) and the station's agent answers from its
// own system state, signed, in milliseconds. No phone rings, no staff are disturbed, no call is paid for.
// NOT a real station: its state below is a demo stand-in, labelled as such everywhere it appears.
import express from 'express';
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, Role, TaskState, type AgentCard, type Message, type Part } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { makeSigner } from '../src/cap.js';

export const STOPQUERY = 'safestop.stopquery/1';
export const STOPQUERY_SKILL = 'answer_stop_question';

/** The station's own system state (simulated). */
export interface StationState { open24h: boolean; openNow: boolean; staffOnDuty: number; litForecourt: boolean; womensRestroomOpen: boolean }

/** Answer one template question from the station's state (pure; tested). */
export function answerFromState(templateId: string, s: StationState): { answer: 'yes' | 'no' | 'unknown'; statement: string } {
  switch (templateId) {
    case 'open_now': return s.openNow ? { answer: 'yes', statement: s.open24h ? 'Open now; open 24 hours.' : 'Open now.' } : { answer: 'no', statement: 'Closed now.' };
    case 'open_until_6': return s.open24h ? { answer: 'yes', statement: 'Open 24 hours, including until 6 am.' } : { answer: 'no', statement: 'Not open overnight.' };
    case 'staffed_now': return s.staffOnDuty > 0 ? { answer: 'yes', statement: `${s.staffOnDuty} staff on duty now.` } : { answer: 'no', statement: 'No staff on duty now.' };
    case 'lit_parking': return { answer: s.litForecourt ? 'yes' : 'no', statement: s.litForecourt ? 'Forecourt lights are on.' : 'Forecourt is not lit.' };
    case 'womens_restroom': return { answer: s.womensRestroomOpen ? 'yes' : 'no', statement: s.womensRestroomOpen ? "Women's restroom open." : "Women's restroom closed." };
    default: return { answer: 'unknown', statement: 'This agent only answers the standard SafeStop questions.' };
  }
}

const part = (value: unknown): Part => ({ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' });
const textPart = (value: string): Part => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const msg = (taskId: string, contextId: string, parts: Part[]): Message => ({ role: Role.ROLE_AGENT, messageId: crypto.randomUUID(), parts, taskId, contextId, extensions: [], metadata: {}, referenceTaskIds: [] });

export async function createStopAgent(o: { port: number; stopId: string; name: string; state: StationState; keyFile?: string; log?: (m: string) => void }) {
  const signer = await makeSigner(`stop-${o.stopId}`, o.keyFile);
  const card: AgentCard = {
    name: `${o.name} station agent (SIMULATED)`,
    description: `Demo AI receptionist for ${o.name}. Answers SafeStop's standard stop questions machine-to-machine (${STOPQUERY}), signed. Not a real station system.`,
    supportedInterfaces: [{ url: `http://localhost:${o.port}/`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: 'SafeStop demo (simulated stop)', url: 'https://github.com/' },
    version: '0.1.0',
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: STOPQUERY_SKILL, name: 'Answer a stop question', description: `Input: data part {proto:"${STOPQUERY}", stopId, templateId}. Output: COMPLETED task with a signed answer {answer, statement, observedAt}.`, tags: [STOPQUERY, 'fuel', 'highway'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'], securityRequirements: [] }],
    documentationUrl: '', signatures: [],
  };
  const executor: AgentExecutor = {
    cancelTask: async () => {},
    async execute(ctx: RequestContext, bus: ExecutionEventBus) {
      const c = ctx.userMessage.parts.find((p) => p.content?.$case === 'data')?.content;
      const q = (c && c.$case === 'data' ? c.value : null) as { proto?: string; stopId?: string; templateId?: string } | null;
      const done = (state: TaskState, parts: Part[]) => {
        bus.publish(AgentEvent.task({ id: ctx.taskId, contextId: ctx.contextId, status: { state, timestamp: new Date().toISOString(), message: msg(ctx.taskId, ctx.contextId, parts) }, artifacts: [], history: [ctx.userMessage], metadata: {} }));
        bus.finished();
      };
      if (!q || q.proto !== STOPQUERY || q.stopId !== o.stopId || !q.templateId) return done(TaskState.TASK_STATE_REJECTED, [textPart(`Expected ${STOPQUERY} for stop ${o.stopId}.`)]);
      const a = answerFromState(q.templateId, o.state);
      const signed = { proto: STOPQUERY, stopId: o.stopId, templateId: q.templateId, answer: a.answer, statement: a.statement, observedAt: new Date().toISOString(), simulated: true };
      done(TaskState.TASK_STATE_COMPLETED, [part({ ...signed, jws: await signer.sign(signed) }), textPart(a.statement)]);
      o.log?.(`${q.templateId} -> ${a.answer}`);
    },
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const app = express();
  app.get('/.well-known/jwks.json', (_q, r) => r.json(signer.jwks));
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return new Promise<{ port: number; url: string; close: () => Promise<void> }>((ok) => {
    const server = app.listen(o.port, () => {
      const ad = server.address();
      const port = typeof ad === 'object' && ad ? ad.port : o.port;
      card.supportedInterfaces[0].url = `http://localhost:${port}/`;
      ok({ port, url: `http://localhost:${port}`, close: () => new Promise((d) => { server.close(() => d()); server.closeAllConnections?.(); }) });
    });
  });
}
