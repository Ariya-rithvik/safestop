// The machine language between agents: the Common Alerting Protocol (CAP 1.2, OASIS), the format
// India's NDMA uses for public alerts (SACHET). SafeStop does not invent its own language: a published,
// checkable format means a real authority system could read these messages without any change.
// Every message is signed (JWS, EdDSA/Ed25519) so the receiving agent can prove it came from SafeStop
// and was not changed on the way.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CompactSign, compactVerify, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { PLAYBOOKS } from './playbooks.js';
import type { Incident } from './incident.js';

export type CapStatus = 'Actual' | 'Exercise' | 'Test';

export interface CapAlert {
  identifier: string;
  sender: string;
  sent: string;
  status: CapStatus;
  msgType: 'Alert' | 'Update' | 'Cancel';
  scope: 'Restricted';
  restriction: string;
  references?: string;
  info: {
    language: 'en-IN';
    category: ['Safety'];
    event: string;
    urgency: 'Immediate';
    severity: 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
    /** A traveller's own report, not verified by anyone: never more than "Possible". */
    certainty: 'Possible';
    headline: string;
    description: string;
    instruction: string;
    parameter: { valueName: string; value: string }[];
    area: { areaDesc: string; circle: string[] };
  };
}

const SEVERITY = { high: 'Severe', medium: 'Moderate', low: 'Minor' } as const;

/**
 * The incident as a CAP alert for an authorised authority agent (pure; tested).
 * Exact location is included because only authorised agencies the traveller agreed to may receive it.
 */
export function toCap(inc: Incident, o: { sender: string; status: CapStatus; at: number; first: boolean }): CapAlert | null {
  if (!inc.location) return null; // nothing an authority can act on yet
  const pb = inc.playbook ? PLAYBOOKS[inc.playbook] : null;
  const facts = Object.entries(inc.facts ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  const ack = inc.contacts.filter((c) => c.state === 'acknowledged').length;
  const closed = inc.status !== 'open';
  return {
    identifier: `safestop-${inc.id}`,
    sender: o.sender,
    sent: new Date(o.at).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    status: o.status,
    msgType: closed ? 'Cancel' : o.first ? 'Alert' : 'Update',
    scope: 'Restricted',
    restriction: 'Authorised highway safety agencies the traveller agreed to share with',
    ...(o.first ? {} : { references: `${o.sender},safestop-${inc.id}` }),
    info: {
      language: 'en-IN',
      category: ['Safety'],
      event: 'Traveller requested help on the road',
      urgency: 'Immediate',
      severity: inc.severity ? SEVERITY[inc.severity] : 'Unknown',
      certainty: 'Possible',
      headline: closed ? `Closed: ${inc.safeConfirmedAt ? 'traveller confirmed safe' : 'alert ended'}` : `Traveller alert${pb ? `: ${pb.title.toLowerCase()}` : ''}`,
      description: [pb ? `Reported: ${pb.title}.` : 'No details yet.', facts.length ? `Details: ${facts.join('; ')}.` : '', 'Unverified report from the traveller herself.'].filter(Boolean).join(' '),
      instruction: closed ? 'No action needed.' : 'Approach with care. The traveller has been told to stay in the vehicle with doors locked.',
      parameter: [
        { valueName: 'incidentId', value: inc.id },
        { valueName: 'pressedAt', value: new Date(inc.pressedAt ?? inc.createdAt).toISOString() },
        { valueName: 'trustedContactsAcknowledged', value: String(ack) },
        { valueName: 'locationAt', value: new Date(inc.location.at).toISOString() },
      ],
      area: {
        areaDesc: 'Traveller position (shared with consent)',
        // CAP circle: "lat,lon radius_km"; radius = reported GPS accuracy, at least 0.1 km.
        circle: [`${inc.location.lat.toFixed(5)},${inc.location.lon.toFixed(5)} ${Math.max(0.1, (inc.location.accuracyM ?? 100) / 1000).toFixed(1)}`],
      },
    },
  };
}

/** Signing key for this SafeStop server. The public half is published at /.well-known/jwks.json. */
export async function makeSigner(kid = 'safestop-1', file?: string) {
  // The key is kept (when a file is given) so authorities that cached our public key keep verifying after a restart.
  let privateKey: CryptoKey;
  let jwk: JWK;
  if (file && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { priv: JWK; pub: JWK };
    privateKey = (await importJWK(saved.priv, 'EdDSA')) as CryptoKey;
    jwk = saved.pub;
  } else {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: 'EdDSA', use: 'sig' } as JWK;
    if (file) writeFileSync(file, JSON.stringify({ priv: await exportJWK(pair.privateKey), pub: jwk }), { mode: 0o600 });
  }
  return {
    jwks: { keys: [jwk] },
    sign: async (payload: unknown) =>
      new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid ?? kid, typ: 'cap+json' }).sign(privateKey),
  };
}

/** Verify a signed CAP alert against a sender's published keys; returns the alert or throws. */
export async function verifySigned(jws: string, jwks: { keys: JWK[] }): Promise<CapAlert> {
  const { payload } = await compactVerify(jws, async (h) => {
    if (h.alg !== 'EdDSA') throw new Error('unexpected algorithm');
    const k = jwks.keys.find((x) => x.kid === h.kid);
    if (!k) throw new Error('unknown key');
    return importJWK(k, 'EdDSA');
  });
  return JSON.parse(new TextDecoder().decode(payload)) as CapAlert;
}

/** Verify any JWS from an agent against its published keys (same rules as alerts). */
export const verifyJws = verifySigned as unknown as <T = Record<string, unknown>>(jws: string, jwks: { keys: JWK[] }) => Promise<T>;

/** The same alert as CAP 1.2 XML, for systems that read XML (pure). */
export function capXml(a: CapAlert): string {
  const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const t = (k: string, v: string) => `<${k}>${e(v)}</${k}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">${t('identifier', a.identifier)}${t('sender', a.sender)}${t('sent', a.sent)}${t('status', a.status)}${t('msgType', a.msgType)}${t('scope', a.scope)}${t('restriction', a.restriction)}${a.references ? t('references', a.references) : ''}<info>${t('language', a.info.language)}${t('category', 'Safety')}${t('event', a.info.event)}${t('urgency', a.info.urgency)}${t('severity', a.info.severity)}${t('certainty', a.info.certainty)}${t('headline', a.info.headline)}${t('description', a.info.description)}${t('instruction', a.info.instruction)}${a.info.parameter.map((p) => `<parameter>${t('valueName', p.valueName)}${t('value', p.value)}</parameter>`).join('')}<area>${t('areaDesc', a.info.area.areaDesc)}${a.info.area.circle.map((c) => t('circle', c)).join('')}</area></info></alert>`;
}
