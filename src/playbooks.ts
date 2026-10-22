// Five roadside playbooks. Deterministic, reviewed text: no AI writes safety advice at run time.
// Wording rule: describe what to do, never accuse anyone of a crime ("could be a trick", not "a robbery").

export const PLAYBOOK_IDS = ['suspicious_breakdown', 'object_thrown', 'road_obstruction', 'authority_claim', 'followed'] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

export interface Playbook {
  id: PlaybookId;
  title: string;
  /** One sentence Alexa says first. */
  say: string;
  steps: string[];
  /** Numbers to offer (never dialled automatically). */
  call: { number: string; who: string }[];
}

const EMERGENCY = { number: '112', who: 'India emergency (police, fire, ambulance)' };
const NHAI = { number: '1033', who: 'NHAI national highway helpline (breakdowns, accidents on national highways)' };

export const PLAYBOOKS: Record<PlaybookId, Playbook> = {
  suspicious_breakdown: {
    id: 'suspicious_breakdown',
    title: 'Someone is waving you down',
    say: 'Stay in the car with the doors locked. You can help without stopping here.',
    steps: [
      'Keep doors locked and windows up. Do not get out.',
      'If you want to help, drive on to the next fuel station, toll plaza or dhaba and report it there.',
      'Call 1033 so the highway patrol can reach them.',
      'If anyone blocks your car or follows you, call 112.',
    ],
    call: [NHAI, EMERGENCY],
  },
  object_thrown: {
    id: 'object_thrown',
    title: 'Something hit your windshield',
    say: 'If you can still see the road, do not stop here. Drive slowly to a busy, lit place.',
    steps: [
      'Slow down, hazard lights on, keep driving if you can see safely.',
      'Do not get out to check the glass on an empty stretch.',
      'If the glass is smeared, do not spray washer fluid on it; it can make it worse.',
      'Stop at the next fuel station, toll plaza or police post, then check.',
    ],
    call: [EMERGENCY, NHAI],
  },
  road_obstruction: {
    id: 'road_obstruction',
    title: 'Something is blocking the road',
    say: 'Do not get out to clear it. Stay in the car and look for a safe way to turn back.',
    steps: [
      'Stop at a distance, doors locked, engine running.',
      'If it is safe, turn around and use another route or wait near other vehicles.',
      'Report the obstruction: 1033 on national highways, 112 if you feel unsafe.',
    ],
    call: [NHAI, EMERGENCY],
  },
  authority_claim: {
    id: 'authority_claim',
    title: 'Someone says they are police or an official',
    say: 'You can stay inside and check first. Ask to see identification through the closed window.',
    steps: [
      'Keep the window up or open only a little. Doors locked.',
      'Ask for identification and the officer’s name and station.',
      'Call 112 to confirm a check is real; it is fine to say you will follow them to the nearest police station.',
      'Prefer stopping where there are lights and other people.',
    ],
    call: [EMERGENCY],
  },
  followed: {
    id: 'followed',
    title: 'You think you are being followed',
    say: 'Do not drive home. Head for a police station or a busy fuel station.',
    steps: [
      'Keep driving to a busy, lit place: police station, fuel station, toll plaza.',
      'Do not stop in an empty place, do not confront them.',
      'Call 112 and keep the line open. Your trusted contact can see your status.',
    ],
    call: [EMERGENCY],
  },
};

// Keyword rules for English, Hindi (Latin script as people type/speak it) and a little Tamil.
const RULES: { id: PlaybookId; words: RegExp }[] = [
  { id: 'object_thrown', words: /\b(windshield|windscreen|glass|egg|stone|rock|brick|threw|thrown|hit (my|the) car)\b|शीशा|अंडा|पत्थर/i },
  { id: 'authority_claim', words: /\b(police|cop|officer|official|inspector|uniform|checking|check ?post|rto)\b|पुलिस|अफसर/i },
  { id: 'followed', words: /\b(follow(ed|ing)?|chas(e|ed|ing)|behind me|tailing|same (car|bike))\b|पीछा/i },
  { id: 'road_obstruction', words: /\b(block(ed|ing)?|obstruct(ion|ed)?|log|tree|branch|barricade|stones? on the road|road ?block)\b|रास्ता बंद/i },
  { id: 'suspicious_breakdown', words: /\b(wav(e|ing)|flag(ged|ging)?|lift|stranded|broke ?down|breakdown|flat tyre|puncture|asking (for )?help|stop(ped)? me)\b|मदद|गाड़ी खराब/i },
];

/** Which playbook fits what the traveller said (deterministic; null when nothing matches). */
export function triage(text: string): PlaybookId | null {
  const t = text.normalize('NFC');
  for (const r of RULES) if (r.words.test(t)) return r.id;
  return null;
}
