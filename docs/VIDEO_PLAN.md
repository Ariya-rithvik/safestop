# SafeStop: demo video script (2:45, the best parts first)

**Screens (one laptop, side by side):** traveller console (left, big), Meena's contact page (right top), patrol desk (right bottom). Your phone ready for the CALL-E call, if you have credit.

**Automated take (what we submitted):** with the three servers running (`PATROL_SIM_SPEED=6` for the desk, `DRY_RUN=1` for SafeStop), `npm run demo:record` drives the real app in Chrome via Playwright, narrates with Amazon Polly (Kajal), and composites `demo/safestop-demo.mp4` (about 2:04) with ffmpeg. Keys and tokens live only in URLs, and a recorded page has no address bar.

**Start everything (four terminals):**
```
npm run patrol
npm run stopagent
npm start
```
Set `DRY_RUN=1` if there's no CALL-E credit, and say so on screen. Use the Settings: "Simulated: NH48 near Vellore".

| Time | Show | Say (voice-over) |
|---|---|---|
| 0:00 | Dark map, the route glowing | "11 pm, NH48. Priya is driving alone. A biker keeps signalling her to stop." |
| 0:08 | Type/say: "pineapple, a white Innova TN 09 AB 1234 is following me" | "She says a harmless word to Alexa. That's an SOS." |
| 0:15 | Red edge, timer, metrics strip (8 ms, patrol agent ms) | "Her family's screens have it in milliseconds, before any AI even runs." |
| 0:25 | Meena's page alarms; the desk shows the signed alert | "At the same moment, SafeStop's agent sends the highway patrol desk's agent a signed CAP alert, the format India's disaster authority uses. The desk's agent verified it and prepared the nearest unit in under 200 ms." |
| 0:45 | Countdown "phoning Ravi in 22 s" → call (or dry-run) | "Nobody tapped yet, so SafeStop phones her brother. Not a database, a human, and it says honestly who has and hasn't confirmed." |
| 1:05 | Meena taps "I'm on it" → "going to her, 20 min" | "Meena answers with a plan. Priya sees 'Meena is coming to you, about 20 minutes'." |
| 1:20 | Officer clicks Dispatch → green moving line on the map | "Agents act in milliseconds; the human officer decides. Only then does the unit move." |
| 1:35 | Ask "Is the Indian Oil ahead open until 6?" → 15–100 ms, signed | "When the other side is an AI too, SafeStop skips human language: agent to agent, signed, in milliseconds. No phone rings." |
| 1:50 | Toggle "no signal", press SOS, then restore signal | "Dead zones: the alert waits on her phone, says it hasn't gone, and leaves the moment one bar returns." |
| 2:05 | Agents feed + evals table | "Ten small agents. The model only labels her words; rules decide. 10 out of 10 injection attempts blocked; 93% of red flags caught." |
| 2:20 | Say "I'm safe" twice → report page | "Closing an alert takes two requests. Then a private, tamper-evident report only she can open." |
| 2:35 | Title: SafeStop Relay Network | "SafeStop: it rings a human, not a database. Patrol desk and station agent are simulated; the protocols are real." |

**Don't forget:**
- Keep the "SIMULATED" labels visible.
- Don't show the traveller key (`#tk_…`) or phone numbers.
- Keep it under 3:00.
