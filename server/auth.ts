import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type AuthUser = { id: string; email: string; name: string };

let jwks: JWTVerifyGetKey | null = null;
let issuer = '';

/** Lets the local dev server verify tokens it minted itself. Never called in production. */
export function setVerifier(keySet: JWTVerifyGetKey, iss: string) {
  jwks = keySet;
  issuer = iss;
}

function verifier() {
  if (!jwks) {
    const base = process.env.NEON_AUTH_BASE_URL;
    if (!base) throw new Error('NEON_AUTH_BASE_URL is not set');
    jwks = createRemoteJWKSet(new URL(`${base.replace(/\/$/, '')}/.well-known/jwks.json`));
    issuer = new URL(base).origin;
  }
  return { jwks, issuer };
}

export async function authenticate(req: Request): Promise<AuthUser | null> {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const { jwks, issuer } = verifier();
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: issuer });
    const id = String(payload.sub || payload.id || '');
    const email = String(payload.email || '').toLowerCase();
    if (!id || !email) return null;
    return { id, email, name: String(payload.name || email.split('@')[0]) };
  } catch {
    return null;
  }
}
