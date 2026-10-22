# Devpost submission text: SafeStop Relay Network

**Track:** Alexa+ (self-hosted MCP server + Agent Skill + simulated Alexa+ web app)
**Repo:** https://github.com/Ariya-rithvik/safestop (fill in after pushing)
**Video:** (YouTube link)

## Tagline
SafeStop rings a human, not a database, and tells you honestly when nobody has picked up yet.

## Inspiration
Priya drives from Bengaluru to Chennai at 11 pm. Past Krishnagiri, a biker keeps signalling her to stop. Calling someone out loud can make things worse; a panic button sends a message nobody may read. India's 112 app exists, but nothing tells her **whether a human actually got it**, keeps going until one does, or works in the dead zones that cover long stretches of highway.

## What it does
- **Quiet SOS:** a harmless safe word to Alexa ("pineapple") or a held button. Her trusted contacts are alerted in **milliseconds**, before any AI runs.
- **Honest states:** Sent → reached their screen → on it. Alexa says exactly that; it never says "help is on the way" unless someone acknowledged.
- **Escalation ladder:** nobody taps "I'm on it" in 30 s → SafeStop **phones** contacts one by one (CALL-E, in each person's language), and stops at the first "yes". The "yes" becomes a plan: "Meena is coming to you · ~20 min".
- **Agents act in ms, humans decide:** a signed **CAP 1.2** alert goes over **A2A** to a highway patrol desk agent. It verifies the alert and prepares the nearest unit in about 76–195 ms; only the officer dispatches. (The patrol desk is simulated and clearly labelled.)
- **Machine first:** if a stop runs its own AI agent, SafeStop skips human language and asks it agent-to-agent (signed, 15–102 ms). Otherwise it phones, once, and shares the answer with every traveller (idea from Local Atlas).
- **Five roadside playbooks** (waved down, object at windshield, road blocked, "I'm police", being followed). Fixed, reviewed text with no crime claims; 112 and NHAI 1033.
- **Dead zones:** the SOS waits on the phone ("saved, not sent yet") and goes the moment signal returns.
- **Nearby relay (opt-in, 1 km, 15 min):** strangers see only a distance band, never her name or position; their offers are marked unverified.
- **Evidence:** a SHA-256 hash-chained log of everything, and a private report only she can open.

## How we built it
TypeScript/Node.
- **MCP:** `@modelcontextprotocol/sdk` (stateless Streamable HTTP, 8 tools).
- **A2A:** `@a2a-js/sdk` (patrol desk and station agents).
- **Signing:** `jose` (Ed25519 JWS).
- **Calls:** CALL-E for phone calls.
- **Understanding:** Gemini 2.5 Flash with a Groq fallback, **only after** the alert is out. The model proposes; deterministic rules can only *raise* severity and decide every action.
- **Policy:** checks every tool call (closing needs two requests, no crime words, audit line).
- **Maps:** OpenStreetMap (Nominatim, Overpass, OSRM route), Leaflet.

## Measured (npm run evals / npm run drill)
- **Speed:** safe word → contact's screen: median 8 ms.
- **Understanding:** right playbook 100% (41/41) with model + rules vs 66% with rules alone; red flags caught 93% vs 53%; Tamil 0% → 100%.
- **Safety:** 10/10 injection attempts blocked (alert never closed, no crime claims, no stranger dialled).
- **Drill on the real 155 km Krishnagiri–Vellore road** (simulated people): an SOS held in a dead zone was delivered 0.1 s after signal returned; the patrol agent took 76 ms vs 123 s for the first human phone "yes".
- **Tests:** 44 automated tests.

## Challenges
- The CALL-E balance ran out, and the ladder correctly reported "call failed → call 112".
- Overpass outages: answered with a cache that labels its age.
- An early bug showed a signature rejection as "Declined". Fixed: only an officer's choice is "declined".

## What's next
A real Alexa+ preview connection; SMS fallback; pilots with a highway patrol unit that can run the agent; native-speaker review of Hindi/Tamil.

## Honest limits
- SafeStop is **not an emergency service** and never calls 112 itself.
- The patrol desk and station agent are **simulated** demos of how real agencies would plug in.
- The eval sentences were written by us.

---
## Product feedback (required)
- **Alexa+ (MCP / Agent Skill):** used for the whole integration.
  - Worked well: an open standard, so the official MCP client let us test exactly what Alexa+ would call.
  - Needs work: there is no way for entrants to try a real Alexa+ against their server.
  - Onboarding: docs clear, but no test console.
  - Would build again: yes.
- **CALL-E:** used for escalation calls and stop checks.
  - Worked well: structured `result_schema` and idempotency keys.
  - Needs work: there is no balance check before a call.
- **A2A JS SDK:** used for the authority and station agents.
  - Worked well: the task lifecycle fits human-in-the-loop.
  - Needs work: see friction log #3.

**AWS:** not used in SafeStop.

## Feature requests
- Alexa+ MCP test console (critical).
- Alexa+ "quiet mode" for safety skills, where the assistant replies only on screen or by vibration (important).
- CALL-E balance API (important).

## Friction log
See `docs/FRICTION-LOG.md` (7 entries).

## Built during the hackathon
All of it, 2026-10-18 to 10-23. Earlier projects inspired some parts; no code was copied beyond the CALL-E request pattern from our FloodLens entry.
