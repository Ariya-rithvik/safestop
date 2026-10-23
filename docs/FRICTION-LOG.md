# Friction log: SafeStop Relay Network (Alexa+ track)

Each entry: task, steps, expected vs actual, severity, workaround, suggestion.

## 1. Alexa+ MCP: no way to test against a real Alexa+ without preview access
- **Task:** connect our MCP server to Alexa+.
- **Steps:** read the track resources; built a Streamable HTTP MCP server on spec 2025-11-25.
- **Expected:** a sandbox or developer console where an MCP server URL can be registered and tried with Alexa+.
- **Actual:** no self-serve path for hackathon entrants; the track allows a simulated Alexa+ instead.
- **Severity:** high. We can't show the real voice surface.
- **Workaround:** a simulated Alexa+ web app that reaches SafeStop *only* through the official MCP client over Streamable HTTP, the same path Alexa+ would use.
- **Suggestion:** a public "Alexa+ MCP test console": paste a server URL and token, talk to it, see tool calls.

## 2. MCP TypeScript SDK: stateless server pattern needs care
- **Task:** run the MCP server statelessly behind a plain Node HTTP server.
- **Expected:** one server object handling many requests.
- **Actual:** stateless Streamable HTTP means a fresh `McpServer` + transport per request. Anything that must remember across calls (our "say I'm safe twice" policy) has to live outside it.
- **Severity:** medium.
- **Workaround:** shared `Policy` and `Store` objects passed into each per-request server.
- **Suggestion:** an official example of stateless servers with shared state.

## 3. A2A JS SDK v1.x: TaskStore needs the call context; card URL with port 0
- **Task:** update an A2A task later, when a human officer decides.
- **Actual (1):** `TaskStore.load/save` require the original `ServerCallContext`; outside the executor you have to keep it yourself.
- **Actual (2):** with `listen(0)`, the agent card still advertised port 0, and the client then failed with "fetch failed".
- **Severity:** medium.
- **Workaround:** store the context per case; rewrite the card URL after `listen`.
- **Suggestion:** a "long-running task updated by a human" sample, and derive the card URL at listen time.

## 4. Windows: test runner + undici sockets → libuv assertion at exit
- **Actual:** `node --test --test-force-exit` crashes at exit with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after an A2A `sendMessage`. Every test passed, but the file was reported failed.
- **Severity:** low (tests only), but confusing.
- **Workaround:** short keep-alive via `undici.setGlobalDispatcher`, plus a 300 ms pause in `after()`.

## 5. CALL-E: balance errors only surface at call time
- **Actual:** `402 insufficient_balance` arrives when the call is placed, in the middle of an emergency flow.
- **Severity:** high for a safety product.
- **Workaround:** SafeStop marks the call "failed", moves down the ladder and tells the traveller to call 112.
- **Suggestion:** a balance endpoint, so apps can warn *before* an incident.

## 6. OpenStreetMap: Overpass often times out; phone numbers rarely present in India
- **Actual:** all four public Overpass mirrors timed out on several days. Of 17 fuel stations near Vellore found via Nominatim, **0** had a phone number or opening hours.
- **Workaround:** a disk cache that serves the last real answer, labelled with its age; stops opt in with their own number.
- **Suggestion:** none for Amazon. Noted for anyone building India road-safety tools.

## 7. Free LLM tiers: burst rate limits
- **Actual:** Gemini 2.5 Flash returned 429 after about 6 rapid calls, which dragged an eval run down to rules-only answers.
- **Workaround:** pause Gemini for 60 s after a 429 and go straight to the Groq fallback; pace evals.

## 8. CALL-E: `result_schema` rejects nullable types
- **Task:** first live escalation call with the new key (2026-10-23).
- **Actual:** `400 result_schema_invalid: unsupported JSON Schema type at $.properties.eta_min: ['integer', 'null']`. The call never left, in the middle of an alert.
- **Severity:** high: a schema detail silently breaks a safety call at the worst moment.
- **Workaround:** `eta_min` is now a plain optional `integer`; SafeStop marked the call failed and moved down the ladder, as designed.
- **Suggestion:** validate `result_schema` at key-setup time (or a `POST /v1/schemas/validate`), and document the supported JSON Schema subset.

## 9. CALL-E declines emergency calls by policy
- **Actual:** `422 call_not_ready: I can't place calls for urgent or emergency safety situations. Please contact local emergency services or a trusted person.`
- **What we did:** we did **not** reword the task to get around this. The escalation ladder records "call failed" and tells her to call 112, the same as any failed call. CALL-E is still used where it fits: one non-emergency question to a stop ("Are you open right now?"), answered once and shared with every traveller. That call ran live in our video.
- **Suggestion:** document the policy up front, and offer a vetted path for safety apps (for example, verified trusted-contact calls with the user's consent on file).

## What worked well
- The MCP SDK client + server pair: the official client drove every end-to-end test.
- The A2A SDK's task model maps cleanly onto "agent acts in ms, human decides later".
- CAP 1.2 as the machine language: a ready-made, auditable format, no need to invent one.
