// The simulated Alexa+ (allowed by the hackathon rules for the Alexa+ track): a voice assistant that
// reaches SafeStop ONLY through the MCP server, exactly as Alexa+ would, using the official MCP client
// over Streamable HTTP. Intent routing is deterministic so an SOS is never held up by a model.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { triage } from './playbooks.js';

export type Intent = 'check_stop' | 'confirm' | 'quiet_sos' | 'sos_status' | 'roadside_guidance' | 'safe_places_nearby' | 'share_with_nearby_travellers' | 'stop_sharing' | 'im_safe' | 'cancel_sos' | 'unknown';

const SAFE_WORD = /\b(pineapple)\b/i; // a phrase that sounds harmless to anyone listening

/** What the traveller wants (pure; tested). The SOS check runs first. */
export function route(text: string, sosActive: boolean): Intent {
  const t = text.toLowerCase().normalize('NFC');
  if (/\b(cancel|false alarm|by mistake|mistake)\b/.test(t)) return 'cancel_sos';
  if (/\b(i'?m|i am|we'?re|we are) (safe|ok|okay|fine|home)\b|\bsafe now\b/.test(t)) return 'im_safe';
  if (SAFE_WORD.test(t) || /\b(alert|tell|message|call) (my )?(family|contacts?|husband|wife|mom|mum|dad|brother|sister)\b|\b(sos|help me|i'?m scared|i am scared|not safe|unsafe|danger)\b|बचाओ|मदद करो/.test(t)) return 'quiet_sos';
  if (/\b(stop|don'?t|do not) (asking|sharing|telling)\b/.test(t)) return 'stop_sharing';
  if (/\b(nearby|other) (travell?ers|drivers|people)\b|\bask (people|someone) near/.test(t)) return 'share_with_nearby_travellers';
  if (/\b(did|have|has) (they|anyone|ravi|meena|someone)\b.*\b(see|seen|get|got|reply|replied|respond)|\bstatus\b|\bwho (knows|saw)\b/.test(t)) return 'sos_status';
  if (/\b(is|are|will)\b.*\b(petrol|fuel|pump|bunk|dhaba|toll|station|indian oil|bharat|propel)\b.*\b(open|staff|lit|restroom|toilet|washroom)\b|\b(check|call|ask) (the )?(petrol|fuel|pump|bunk|dhaba|stop)/.test(t)) return 'check_stop';
  if (/^(yes|yes please|yeah|ok|okay|go ahead|call them|please call)\b/.test(t.trim())) return 'confirm';
  if (/\b(where|nearest|closest|find)\b.*\b(police|hospital|fuel|petrol|toll|safe place)\b|\bsafe place\b/.test(t)) return 'safe_places_nearby';
  if (triage(t)) return sosActive ? 'quiet_sos' : 'roadside_guidance';
  return 'unknown';
}

export interface AssistantTurn { said: string; intent: Intent; tool: string | null; reply: string; data?: unknown; ms: number }

export function assistant(mcpUrl: URL, token?: string) {
  let client: Client | null = null;
  const connect = async () => {
    if (client) return client;
    const c = new Client({ name: 'simulated-alexa-plus', version: '0.1.0' });
    await c.connect(new StreamableHTTPClientTransport(mcpUrl, token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined));
    client = c;
    return c;
  };

  const call = async (name: string, args: Record<string, unknown>) => {
    const c = await connect();
    try {
      return await c.callTool({ name, arguments: args });
    } catch (e) {
      client = null; // reconnect next time
      throw e;
    }
  };

  // A stop check waiting for the traveller's "yes" (nothing is dialled before it).
  let pendingStop: Record<string, unknown> | null = null;

  return async (said: string, ctx: { sosActive: boolean; latitude?: number; longitude?: number }): Promise<AssistantTurn> => {
    const t0 = Date.now();
    let intent = route(said, ctx.sosActive);
    if (intent === 'confirm' && !pendingStop) intent = 'unknown';
    const loc = ctx.latitude !== undefined && ctx.longitude !== undefined ? { latitude: ctx.latitude, longitude: ctx.longitude } : {};
    let tool: string | null = null;
    let args: Record<string, unknown> = {};
    switch (intent) {
      case 'quiet_sos': tool = 'quiet_sos'; args = { situation: said, ...loc }; break;
      case 'roadside_guidance': tool = 'roadside_guidance'; args = { situation: said }; break;
      case 'sos_status': tool = 'sos_status'; break;
      case 'safe_places_nearby':
        if (!('latitude' in loc)) return { said, intent, tool: null, reply: 'I need your location for that. Allow location on this page.', ms: Date.now() - t0 };
        tool = 'safe_places_nearby'; args = loc; break;
      case 'share_with_nearby_travellers': tool = 'share_with_nearby_travellers'; args = { enable: true }; break;
      case 'stop_sharing': tool = 'share_with_nearby_travellers'; args = { enable: false }; break;
      case 'im_safe': tool = 'im_safe'; break;
      case 'cancel_sos': tool = 'cancel_sos'; break;
      case 'check_stop': {
        if (!('latitude' in loc)) return { said, intent, tool: null, reply: 'I need your location for that.', ms: Date.now() - t0 };
        const l = said.toLowerCase();
        const question = /until 6|till 6|all night|overnight/.test(l) ? 'open_until_6' : /staff|someone there|anyone there/.test(l) ? 'staffed_now' : /restroom|toilet|washroom/.test(l) ? 'womens_restroom' : /\blit\b|light/.test(l) ? 'lit_parking' : 'open_now';
        const name = /indian oil|bharat petroleum|bharat|hindustan|hp|reliance|nayara|shell|propel/i.exec(said)?.[0];
        tool = 'check_stop_ahead';
        args = { ...loc, question, confirm: false, ...(name ? { stop: name } : {}) };
        break;
      }
      case 'confirm': tool = 'check_stop_ahead'; args = { ...pendingStop!, confirm: true }; pendingStop = null; break;
      default:
        return { said, intent, tool: null, reply: 'I can alert your family, tell you what to do on the road, find a safe place, or ask nearby travellers. Say "alert my family" if you feel unsafe.', ms: Date.now() - t0 };
    }
    const res = (await call(tool, args)) as { content?: { type: string; text?: string }[]; structuredContent?: unknown };
    const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
    // Remember a stop check that needs the traveller's yes; any other request forgets it.
    pendingStop = tool === 'check_stop_ahead' && (res.structuredContent as { confirmationNeeded?: boolean } | undefined)?.confirmationNeeded ? args : null;
    return { said, intent, tool, reply: text, data: res.structuredContent, ms: Date.now() - t0 };
  };
}
