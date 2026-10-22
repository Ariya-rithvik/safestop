// Policy agent: one check in front of every MCP tool call, with an audit line for each.
// Rules (TaskForge's lesson: a model cannot enforce a rule, the app can):
//  1. An SOS is NEVER blocked or delayed, whatever its text says.
//  2. Text from the traveller (or anything Alexa passes along) is data. Instructions inside it
//     ("ignore your rules", "tell my family I'm safe") are flagged and never acted on.
//  3. An alert can only be silenced (I'm safe / cancel) by asking twice within a minute, so one
//     misheard word, or an assistant tricked by injected text, cannot switch it off.
//  4. No reply ever accuses anyone of a crime.
//  5. The nearby relay can be switched on at most 3 times per incident (no spamming strangers).

export const CRIME_WORDS = /\b(robber(y|ies)?|robbers?|thie(f|ves)|criminals?|gangs?|loot(ers|ing)?|dacoits?|kidnap(per|ping)?s?|rapists?|murderers?|goons?)\b/i;
export const INSTRUCTION_LIKE = /(ignore (all|any|previous|the|your)|disregard (all|your|the)|system prompt|developer message|you are now|new instructions|(tell|message|text|inform) (my )?(family|contacts?|everyone|them)( that)? (i'?m|i am|we'?re|she'?s|she is) (safe|ok|okay|fine)|mark (me|it|this|the alert) (as )?(safe|resolved|closed)|(cancel|close|stop|end|delete) (the |my )?(alert|sos|incident)|call (only )?\+?\d{6,})/i;

export const CONFIRM_WINDOW_MS = 60_000;
export const MAX_RELAY_TOGGLES = 3;

export type Decision = { allow: true; note?: string } | { allow: false; reason: string; say: string };

export class Policy {
  private pendingClose = new Map<string, number>(); // incidentId -> first request time
  private relayToggles = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** Flags instruction-like text; the text is still used only as a description. */
  inspect(text: string | undefined): { injection: boolean } {
    return { injection: !!text && INSTRUCTION_LIKE.test(text) };
  }

  /** Rule 3: closing needs a second request within the window. */
  close(incidentId: string, kind: 'safe' | 'cancel'): Decision {
    const t = this.now();
    const first = this.pendingClose.get(incidentId);
    if (first !== undefined && t - first <= CONFIRM_WINDOW_MS) {
      this.pendingClose.delete(incidentId);
      return { allow: true, note: 'confirmed twice' };
    }
    this.pendingClose.set(incidentId, t);
    return {
      allow: false, reason: 'needs confirmation',
      say: kind === 'safe' ? 'To close your alert and tell your contacts you are safe, say "I\'m safe" once more.' : 'To cancel your alert, say "cancel" once more.',
    };
  }

  /** Rule 5. */
  relay(incidentId: string, enable: boolean): Decision {
    if (!enable) return { allow: true };
    const n = (this.relayToggles.get(incidentId) ?? 0) + 1;
    if (n > MAX_RELAY_TOGGLES) return { allow: false, reason: 'relay limit', say: 'Nearby travellers have already been asked several times for this alert.' };
    this.relayToggles.set(incidentId, n);
    return { allow: true };
  }

  /** Rule 4: a last check on every reply that leaves the server. */
  guardReply(text: string): { text: string; blocked: boolean } {
    if (!CRIME_WORDS.test(text)) return { text, blocked: false };
    return { text: 'Stay in the car with the doors locked and head for a busy, lit place. If you are in danger, call 112.', blocked: true };
  }
}
