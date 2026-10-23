# SafeStop Relay Network

**SafeStop rings a human, not a database, and tells you honestly when nobody has picked up yet.**

*Priya drives from Bengaluru to Chennai at 11 pm. Past Krishnagiri, a biker keeps signalling her to stop. She says "Alexa, pineapple."*

- Her brother's and sister's phones get the alert in milliseconds.
- Nobody taps "I'm on it", so 30 seconds later SafeStop **phones** her brother, then her sister, until one of them says "yes, I'll help".
- No stranger learns her name or where she is.
- If the highway has no signal, the alert waits on her phone, tells her it hasn't gone yet, and goes out the moment one bar returns.

Built for the Amazon Developer Hackathon 2026, **Alexa+ track**:
- a **self-hosted MCP server** (MCP spec 2025-11-25, Streamable HTTP)
- an **Agent Skill** (`skill/SKILL.md`)
- a **simulated Alexa+** web app that reaches SafeStop only through that MCP server, using the official MCP client

## The numbers

From `npm run evals` and `npm run drill` (full output in `evals/results.md`):

| What | Result |
|---|---|
| Safe word → a trusted contact's screen has the alert | **median 8 ms** (local server, real WebSockets, 20 runs) |
| Understanding what she said: right playbook | **100%** with model + rules (41/41) vs 66% keyword rules alone |
| Red flags recognised as high severity | **93%** (14/15) vs 53% rules alone |
| Tamil / Hindi / Hinglish playbook | 100% / 100% / 100% (5 each) vs 0% / 60% / 40% rules alone |
| False alarms on calm requests | 0/4 |
| Injection attempts that closed the alert, named a crime or called a stranger | **0 of 10** (all prevented, against the running server over MCP) |
| Drill: SOS pressed in a 2 km dead zone (real 155 km Krishnagiri–Vellore road from OpenStreetMap) | kept on the phone 51 s, delivered **0.1 s** after signal returned |
| Drill: nobody taps | brother phoned at **+31 s** (no answer), sister at **+78 s**, said yes, ladder stopped; the page-only contact was never phoned |
| Drill: highway patrol desk (simulated authority, A2A + signed CAP) | its **agent** verified the alert and prepared the nearest unit in **76 ms**; the **officer** (simulated human) dispatched at +45 s; first human phone confirmation came at 123 s |
| Drill: nearby relay | 2 of 3 opted-in travellers asked (the one 3 km away was not); **no name or coordinates** in what they got |

Honest limits on these numbers:
- The 55 eval utterances were written by us, not collected from real incidents.
- The model numbers come from one run at temperature 0 (Gemini 2.5 Flash, Groq gpt-oss-20b as fallback).
- The drill's contacts and nearby users are simulated, at 20× speed; the road and the server are real.
- A real CALL-E call was placed by the ladder in a live test. It was refused for "insufficient balance", and SafeStop reported "call failed" and told her to call 112, as designed. The full live call still has to be recorded once the account is topped up.

## How it works

```
"Alexa, pineapple"  ──MCP quiet_sos──►  SafeStop server (one incident record, ten small agents)
                                          │
 1  quiet_sos       alert every trusted contact NOW (before anything else runs)
 2  contact         Sent → Delivered (their screen confirmed) → On it (they tapped, or said yes on a call)
 3  escalation      nobody acknowledged after 30 s? phone contacts one by one (CALL-E), stop at the first "yes"
 4  understanding   model reads her words AFTER the alert is out: playbook, severity, facts (plate, vehicle)
                    rules can only RAISE what the model says; invalid model output is discarded
 5  safety_triage   five fixed playbooks: waved down · object at windshield · road blocked · "I'm police" · followed
 6  nearby_relay    opt-in only: SafeStop users within 1 km for 15 min, distance band only, offers marked Unverified
 7  policy          checks every MCP tool call; closing an alert needs two requests; no crime words; audit line
 8  evidence        append-only SHA-256 hash chain of everything above
 9  resolution      only she can say she is safe
10  coordinator     order: 1 always first, nothing is allowed to delay it
```

**The model proposes, the code decides.** The model never changes who is alerted, never closes an alert, and never talks to strangers. It only labels her words so her family sees "followed · white Innova TN 09 AB 1234" instead of nothing.

## Confirmed stops ahead (call once, share with everyone)

OpenStreetMap shows where fuel stations are, not whether they're open and staffed at 11 pm. Idea borrowed from **Local Atlas** (an Amazon *Agents for Humans* winner): SafeStop is mostly a system for **not** calling.

1. On the map she taps a stop: "Check: Open now?" (also open until 6 am, staff on site, lit parking, women's restroom).
2. **A fresh answer from any traveller is reused: no call.** That's the common case.
3. Otherwise she sees the exact preview: who will be called, the opening line, the AI disclosure, the one question. **Nothing is dialled until she confirms.**
4. CALL-E asks that one question, says it's an AI, never denies it, and hangs up on voicemail.
5. The answer becomes a **dated fact with the staff member's own words** and an expiry: a firm "yes" lasts 4 hours (or until 6 am), a "no" 12 hours, an "I don't know" 1 hour. Every traveller on that road sees it on the map.

Rules (all tested):
- **Refused questions:** opinion questions (**"is it safe?" is never asked**: SafeStop must not label a place safe), two-in-one questions, and questions about the asker's own account.
- **When a stop may be called:** 10 am–9 pm local unless the stop registered as open 24 hours.
- **Calls:** one question = one call even if 50 travellers ask at once; daily cap.
- **The number:** comes from the stop's own registration, never from the request, and never reaches a screen.
- **What gets stored:** only if a person answered, the dialled number is the registered one, and the quote is in that call's transcript.
- **Never part of an SOS:** during an alert, only stored facts are shown, instantly.

Data: real fuel stations near Vellore from OpenStreetMap (Nominatim). None lists a phone number in OSM, which is why stops **opt in** with their own number. In this demo, three real stations are registered with our test phone and labelled "demo registration (test phone answers)". Alexa can do the same through the `check_stop_ahead` MCP tool ("Is the Indian Oil ahead open?" → "Should I phone them once?" → "yes").

**Maps:** every screen has an OpenStreetMap map (Leaflet):
- traveller: her road, her position, stops and their answers, police and hospitals
- contact: her last shared position and accuracy
- nearby traveller: **only their own position** and the 1 km area, never hers
- patrol desk: units and cases

## Machine first: when the other side is an AI, skip human language

Phone calls exist because humans answer phones. When the other side is **also an AI agent**, speaking English to it is slow, costly and lossy. Every party SafeStop contacts gets the same check first: **does it publish an agent?**

| Other side | How SafeStop talks to it | Measured |
|---|---|---|
| A stop with its own AI agent | A2A, protocol `safestop.stopquery/1`: one structured question, one **signed** structured answer (Ed25519 JWS, checked against the stop's published keys; must name this stop, this question, observed under 5 min ago) | **15–102 ms** (102 ms includes discovering the agent) |
| The highway patrol desk agent | A2A + signed CAP 1.2 alert | 76–195 ms to "received, unit prepared" |
| A stop or family member with no agent | Human language: a CALL-E phone call | ~60–90 s |

**Falls back automatically:** no agent card, no matching skill, agent down, or an answer that doesn't verify or bind → the phone path (with its confirmation screen and call-hour rules).
- **Why no confirmation for agent queries:** they ring no phone and disturb nobody, so the confirm-before-dialling step and the call-hours rule don't apply.
- **Expiry:** machine answers expire after 15 minutes, because live system state changes; they are cheap to re-ask.

`stops/` is a **SIMULATED** station agent for the real Indian Oil station near Vellore. Its "system state" is demo data, labelled on screen:

```bash
npm run stopagent
```

Then set `STOP_AGENTS=<stopId>=http://localhost:8794`.

**Why not switch mid-call (GibberLink-style)?** Switching to a data signal inside a live phone call needs control of the call audio, which CALL-E doesn't expose. SafeStop decides *before* dialling, which is faster still: no call happens at all.

## A "yes" becomes a plan (from Care Call AI, a CALL-E hackathon winner)

A contact saying "yes" is not enough for someone stuck on a highway; she needs to know what help looks like.
- **On the phone:** CALL-E asks one bounded follow-up: "What will you do: call her, go to her, or call the police? If you're going, about how many minutes?"
- **On the page:** after "I'm on it", the contact taps the same choice.
- **She sees it:** "Meena is coming to you · ~20 min", and Alexa says the same when she asks "did anyone see it?".
- **Per-person calling rules:** each contact can be called in their own language (`CONTACT_LANGS=Ravi:ta-IN`), and only a contact who acknowledged can set a plan.

## Ready before any human looks (pre-brief agent)
The moment an alert opens, `src/prebrief.ts` asks every nearby stop that runs its own AI agent, machine to machine (`safestop.stopquery/1`, signed), "open now?" and "someone on site?". It never phones anyone: phoning stays a deliberate, one-at-a-time choice. Measured live: 121 ms, before her family's screens were even opened.

## Everyone sees everyone on the map
- Priya's car, red while the alert is open, rotated to her heading.
- Each contact who taps "I'm going to her" can share their position. It shows as a green car with a live distance ("Meena · 30 m away") on her map, on every contact's map and in the tracker. It is shared only after that choice, and only while the alert is open (`store.contactWhere`).
- The patrol unit, once an officer dispatches it, drives toward her latest signed position. The desk's A2A task carries its position, and SafeStop follows it (simulated at `PATROL_SIM_SPEED`).
- Demo option: "Simulated drive: NH48 into Vellore" moves her along the real OSRM route, clearly labelled SIMULATED DRIVE.

## Agents talking to agents: the highway patrol desk

Phoning people takes 30–120 seconds because a human has to pick up. Machines can answer in milliseconds, so SafeStop's agent also talks **directly to an authority's agent**, before any human there gets involved:

1. **Fixed machine language:** every alert is a **CAP 1.2** message (OASIS Common Alerting Protocol, the format India's NDMA uses in SACHET), **signed** with Ed25519 (JWS). SafeStop's public keys are at `/.well-known/jwks.json`. A message that doesn't verify is rejected.
2. **Open agent-to-agent protocol:** it's sent over **A2A** (official `@a2a-js/sdk`) to every authority agent the traveller agreed to share with (`SHARE_WITH_AUTHORITIES=1`). The link carries a bearer token.
3. **The authority's agent acts at once:** it checks the signature, answers "received", finds the nearest patrol unit and prepares the dispatch (A2A task `WORKING`).
4. **A human officer decides:** dispatch (`COMPLETED`), "I'm calling her", or decline (`REJECTED` → she is told to call 112). **The agent never dispatches anyone by itself.**
5. **She and her family see each step honestly:** "agent answered in 76 ms; HP-12 prepared, not dispatched" → "Officer dispatched HP-12, about 18 min". When she says she's safe, the desk gets a CAP `Cancel`.

`patrol/` is a **SIMULATED** highway patrol desk: an A2A agent plus an officer console at `/desk`. It is **not connected to any real police**; there's no public API for 112 or NHAI 1033. It shows how a real authority would plug in: a configuration change, not a rebuild. Alerts are marked CAP `status: Exercise`.

```bash
npm run patrol
```

The officer console is at http://localhost:8792/desk. Set `AUTHORITY_AGENTS=http://localhost:8792`, `AUTHORITY_TOKEN` and `SHARE_WITH_AUTHORITIES=1` for SafeStop.

## MCP tools (for Alexa+)

| Tool | What it does |
|---|---|
| `quiet_sos` | Alert trusted contacts now; returns one short safe step. Optional `situation`, `latitude`, `longitude`. Never blocked. |
| `sos_status` | Who has it, honestly: sent / delivered / on it (page or phone) / being phoned / nobody yet → call 112. |
| `roadside_guidance` | Playbook steps without raising an alert. |
| `safe_places_nearby` | Stops that confirmed by phone first, then police, hospitals, fuel, toll plazas from OpenStreetMap (unverified; says how old a saved copy is). |
| `check_stop_ahead` | One factual question to a registered stop: reuses a fresh answer, otherwise asks her to confirm, then phones once. |
| `share_with_nearby_travellers` | Opt in/out of the 1 km relay (max 3 times per alert). |
| `im_safe` | She confirms safe. **Needs to be said twice within a minute.** |
| `cancel_sos` | Started by mistake. Also needs two requests. |

## What came from where (we reused what worked elsewhere)

| From our earlier project | Became |
|---|---|
| **recovery-agent** (Razorpay/Stripe): "knows who *not* to contact, and when a call is worth paying for" | the escalation ladder: free page first, a phone call only when nobody has acknowledged |
| **FloodLens** (AWS Environmental hackathon): "saved, not delivered", CALL-E calls with a consenting-number allowlist and call cap | the dead-zone outbox and the call safety rails (`src/calle.ts`) |
| **TaskForge** (WebMCP): "a model can't enforce a rule or capture dated evidence; an app can" | the policy layer + audit on every tool call |
| **Incident Time Machine**: reconstructing what happened | the private after-incident report (`/report`) |
| **VoiceSign / SignLingua**: Tamil and Hindi speakers, people who cannot speak | Tamil/Hindi understanding; the silent button for people who cannot speak |

## Run it

```bash
npm install
npm start
```

The server prints private links:
- **Traveller (simulated Alexa+):** `/traveller#tk_…`. Hold to talk (Chrome), type, or tap the example phrases.
- **Trusted contacts:** `/contact/ct_…`
- **Nearby traveller:** `/nearby`
- **Private report:** `/report#tk_…`
- **MCP endpoint:** `/mcp`

The traveller page has a **simulated location** and a **"Demo: no signal"** switch, both labelled.

`.env` (all optional):

| Setting | What it's for |
|---|---|
| `TRAVELLER_NAME` | the traveller's name |
| `CONTACTS=Ravi,Meena` | trusted contacts |
| `CONTACT_PHONES=Ravi:+91…` | used only by the server, never written to disk or sent to a screen |
| `CALLE_API_KEY` | real phone calls |
| `CALLE_ALLOWED_NUMBERS` | nobody else is ever dialled |
| `CALLE_MAX_CALLS` | hard cap on calls |
| `DRY_RUN=1` | logs calls instead of placing them |
| `GEMINI_API_KEY`, `GROQ_API_KEY` | the understanding agent (rules only without them) |
| `MCP_TOKEN` | Bearer token for MCP clients; **set it before exposing the server** |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | HTTPS, so phones can share location |

```bash
npm test
```

```bash
npm run evals
```

```bash
npm run drill
```

`npm test` runs 44 tests: MCP end-to-end with the official client, the ladder, the CALL-E rails, the policy, the dead zone, relay privacy, and the CAP + A2A patrol link (forged signatures and missing tokens are refused; only the officer dispatches). `npm run evals` prints the numbers table; `npm run drill` prints the road replay.

## Limits (said plainly)

SafeStop alerts the people she chose. It is **not an emergency service**; it never calls 112 itself and does not contact the police.
- Delivery: "Delivered" needs the contact's SafeStop page open; phone calls cover everyone else.
- Places: safe places are OpenStreetMap data and can be wrong or closed.
- Strangers: nearby helpers are strangers and are always labelled unverified.
- The model: it can be wrong. That's why it runs after the alert, the rules can only raise it, and it cannot act.
- Languages: Hindi/Tamil eval lines and playbook text need native-speaker review.
- Alexa+: not yet tested with a real Alexa+ preview account; the simulated Alexa+ uses the same MCP path.

Map data © OpenStreetMap contributors (ODbL). Route from the OSRM demo server. MIT licence.
