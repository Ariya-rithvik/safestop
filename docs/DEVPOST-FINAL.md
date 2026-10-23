# SafeStop Relay Network

**Tagline:** A quiet roadside SOS that rings a real person, not a database, and tells you honestly when nobody has picked up yet.

**Track:** Alexa+
**Repo:** https://github.com/Ariya-rithvik/safestop
**Video:** (paste YouTube link)

---

## Inspiration

Picture this. It's 11 pm on NH48, somewhere past Krishnagiri. A woman is driving alone to Chennai, and a biker keeps pulling up beside her car, waving at her to stop.

What can she actually do in that moment? Calling someone out loud might make things worse. A panic button sends a message, but she has no idea whether anyone read it. India's 112 app exists, but it can't tell her the one thing she needs: has a real human seen this, and are they doing something about it? And on long stretches of highway there's often no signal at all.

That gap is what I wanted to close. Not another alert that disappears into a server, but something that keeps going until a person says "I'm on it", and is honest with her the whole time.

## What it does

She says a harmless safe word to Alexa, "pineapple", or holds a button. That's the SOS. Alexa answers on screen only, so the car behind hears nothing.

**Her family knows in milliseconds.** Her trusted contacts get the alert before any AI even runs (median 8 ms in our tests). Her screen shows exactly where it stands: sent, reached their phone, or "on it". Alexa never says "help is on the way" unless someone actually confirmed.

**If nobody responds, it keeps going.** After 30 seconds with no reply, an escalation agent phones her contacts one by one through CALL-E, in each person's language, and stops at the first "yes". That "yes" turns into a plan she can see: "Meena is coming to you, about 20 minutes."

**Agents talk to agents, humans decide.** Police can't talk at machine speed, so in our design the highway patrol desk runs its own scoped AI agent. SafeStop sends it a signed alert in CAP 1.2, the same format India's disaster authority uses, over the A2A protocol. The desk agent verifies the signature and prepares the nearest patrol unit in about 100–200 ms. It then briefs the officer in plain words. It is not allowed to dispatch anyone; only the officer can. You can watch the actual machine-to-machine messages on the desk's "Machine channel" screen.

**Things are ready before any human looks.** The moment the alert opens, SafeStop's agent asks every nearby fuel station that runs its own AI agent two questions: are you open, and is someone on site? No phone rings, nobody is disturbed, and in about 150 ms everyone sees "Nearest open, staffed stop: Indian Oil, 1 km", with that station agent's signed answer.

**A real AI call where it fits.** If a station has no agent, SafeStop phones it once with CALL-E ("Are you open right now?"), saves the exact words and the time, and shares that answer with every other traveller so nobody has to call again. That call was live in our video.

**Everyone sees everyone.** Her car, the family member driving to her, and the patrol unit all move on every map. A family member's location is shared only after they choose "I'm going to her", and only until the alert closes.

It also handles dead zones: the SOS waits on her phone, says plainly "saved, not sent yet", and goes out the moment one bar of signal comes back. It has five reviewed roadside playbooks, an opt-in nearby-traveller relay that never reveals her name or position, and a tamper-evident report that only she can open.

## How we built it

Everything is TypeScript on Node.

- **Alexa+ side:** a self-hosted MCP server using the official `@modelcontextprotocol/sdk` (protocol 2025-11-25, stateless Streamable HTTP, 8 tools), plus an Agent Skill file. Since there's no public way to test with a real Alexa+, I built a simulated Alexa+ web app that talks to SafeStop only through the official MCP client, the same path Alexa+ would use.
- **Agent to agent:** `@a2a-js/sdk` for the patrol desk and station agents, with alerts signed as Ed25519 JWS using `jose`.
- **Phone calls:** the CALL-E Developer API with a structured `result_schema`, idempotency keys, a number allowlist and a hard call cap.
- **Understanding her words:** Gemini 2.5 Flash, with Groq as a fallback. It only runs after the alert is already out. The model only labels what she said; deterministic rules decide every action, and they can only raise the severity, never lower it.
- **A policy layer** checks every tool call: closing an alert needs two separate requests, no crime words are allowed, and every call is written to an audit line.
- **Maps:** OpenStreetMap (Nominatim, Overpass and an OSRM route of the real Krishnagiri–Vellore road) with Leaflet.

## What we measured

- Safe word to a contact's screen: **8 ms** median.
- Picking the right playbook: **100%** (41/41) with model plus rules, against 66% with rules alone. Red flags caught: 93% against 53%. Tamil went from 0% to 100%.
- **10 out of 10** prompt-injection attempts were blocked: no alert was closed, no crime was claimed, and no stranger was dialled.
- In a drill on the real 155 km road, an SOS held in a dead zone went out 0.1 s after signal returned. The patrol agent acknowledged in 76 ms, while the first human "yes" by phone took 123 s. That gap is exactly why the agents do the fast part.
- 44 automated tests.

## Challenges we ran into

The biggest surprise came on the last day. The first live escalation call failed twice. First, CALL-E rejected a nullable field in our result schema. After I fixed that, CALL-E declined the call outright: its policy doesn't allow calls for emergency or safety situations. I chose not to reword the task to sneak past that. SafeStop treats it like any failed call: it marks it failed, says so honestly, and tells her to call 112. The video shows the family call as a labelled dry run. The real AI call is the station question, which CALL-E does allow.

Other problems: the public Overpass servers kept timing out, so I added a cache that shows its age. Early on, a signature mismatch showed up as "Declined" on her screen; now only an officer's real decision can say that.

## Accomplishments that we're proud of

- The honesty. Every status on her screen is something that really happened.
- The split between agents and people: machines do the millisecond work, and a human always makes the call that matters.
- The pre-brief. By the time her sister opens the alert, the nearest safe, open stop is already confirmed.

## What we learned

The model is the least important part of a safety product. The parts that matter are the boring, deterministic ones: who knows, when, and what we are allowed to say. I also learned to read provider policies before an emergency, not during one.

## What's next

Connecting to a real Alexa+ preview, an SMS fallback, piloting with a highway patrol unit that could run its own agent, and native-speaker review of the Hindi and Tamil text.

## Honest limits

SafeStop is not an emergency service and never calls 112 itself. The patrol desk, the station agent and the drive in the video are simulated, and clearly labelled. The evaluation sentences were written by us.

## Built with

typescript · node.js · model-context-protocol · alexa · a2a · cap · call-e · gemini · groq · openstreetmap · leaflet · jose · websockets · playwright · amazon-polly

---

## Product feedback (paste into the feedback field)

**Alexa+ (MCP / Agent Skill).** Using an open standard was great: the official MCP client let us test exactly what Alexa+ would call. What we missed most is a way for entrants to try a real Alexa+ against their own server. A simple test console where you paste a server URL would help a lot. We'd also love a "quiet mode" for safety skills, where Alexa replies only on screen or by vibration. Would build again: yes.

**CALL-E.** Structured results and idempotency keys are excellent. The pain points: schema errors (like nullable types) only show up when a call is placed, there's no balance check before a call, and the emergency-call policy isn't stated up front. A schema validator, a balance endpoint and a vetted path for consented safety calls would make it much easier to build on.

**A2A JS SDK.** The task lifecycle fits "agent acts now, human decides later" perfectly. It wasn't obvious that updating a task later needs the original call context, and with port 0 the agent card advertised the wrong port.

**AWS.** Not used in the product itself. The voices in our demo video are Amazon Polly.

Full details are in `docs/FRICTION-LOG.md` (9 entries).
