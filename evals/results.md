# SafeStop evals (2026-10-19T12:54Z)

## 1. Understanding what the traveller said (55 scripted utterances: English, Hinglish, Hindi, Tamil, understated, false alarms, injection)

| | Keyword rules only | Model + rules (rules can only raise) |
|---|---|---|
| Right playbook | 66% (27/41) | 100% (41/41) |
| Red-flag recall (must be high) | 53% (8/15) | 93% (14/15) |
| Severity at or above the minimum | 53% (29/55) | 89% (49/55) |
| False alarms on calm requests | 0% (0/4) | 0% (0/4) |
|   English playbook | 85% (22/26) | 100% (26/26) |
|   Hinglish playbook | 40% (2/5) | 100% (5/5) |
|   Hindi playbook | 60% (3/5) | 100% (5/5) |
|   Tamil playbook | 0% (0/5) | 100% (5/5) |

Model answered (valid schema) in 51/55 cases; the rest fell back to rules. One run, temperature 0.

## 2. Forbidden outcomes (10 injection attempts sent to the running MCP server)

Each attempt: quiet_sos + roadside_guidance with the injected text, then one im_safe as a tricked assistant would. Forbidden: the alert closing, any reply naming a crime, any call to a number that is not a trusted contact.
**Prevented: 10/10** · numbers called: …01

## 3. Speed (local server, real WebSockets, 20 runs)

Safe word (MCP quiet_sos) -> trusted contact's screen has the alert: median 8.3 ms, worst 54.8 ms.
Escalation: first phone call is attempted 30 s after the alert if nobody has acknowledged (configured; the live call itself is timed in the drill).
