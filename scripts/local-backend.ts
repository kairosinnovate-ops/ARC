// Local development backend (npm run dev). Never deployed.
// Uses LOCAL_DATABASE_URL (default postgres://arc:arc@localhost/arc), stores files in .local-files/,
// and signs people in with a throwaway key so the app can be tried without Neon.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import pg from 'pg';
import { handle } from '../server/api.ts';
import { setQuery } from '../server/db.ts';
import { setVerifier } from '../server/auth.ts';
import { setStorage } from '../server/storage.ts';

const ISS = 'http://local-auth.arc';
const ORIGIN = 'http://127.0.0.1:5173';
const root = join(process.cwd(), '.local-files');

const pool = new pg.Pool({ connectionString: process.env.LOCAL_DATABASE_URL || 'postgres://arc:arc@localhost/arc' });
setQuery(async (text, params = []) => (await pool.query(text, params as any[])).rows);

setStorage({
  uploadUrl: async (key) => `${ORIGIN}/dev-storage/${encodeURIComponent(key)}`,
  downloadUrl: async (key, _name, inline) => `${ORIGIN}/dev-storage/${encodeURIComponent(key)}${inline ? '?inline=1' : ''}`,
  size: async (key) => {
    const p = join(root, key);
    return existsSync(p) ? statSync(p).size : null;
  },
  remove: async (keys) => {
    for (const k of keys) rmSync(join(root, k), { force: true });
  },
});

const keys = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'local', alg: 'EdDSA' };
setVerifier(createLocalJWKSet({ keys: [jwk] }), ISS);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url || '';
  try {
    if (url.startsWith('/dev-auth/token') && req.method === 'POST') {
      const { email, name } = JSON.parse((await readBody(req)).toString() || '{}');
      const e = String(email || '').toLowerCase();
      const id = 'local-' + createHash('sha256').update(e).digest('hex').slice(0, 24);
      const token = await new SignJWT({ email: e, name: name || e.split('@')[0] })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'local' })
        .setSubject(id)
        .setIssuer(ISS)
        .setAudience(ISS)
        .setIssuedAt()
        .setExpirationTime('12h')
        .sign(keys.privateKey);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token, user: { id, email: e, name: name || e.split('@')[0] } }));
      return;
    }
    if (url.startsWith('/dev-storage/')) {
      const key = decodeURIComponent(url.slice('/dev-storage/'.length).split('?')[0]);
      if (key.includes('..')) throw new Error('bad key');
      const p = join(root, key);
      if (req.method === 'PUT') {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, await readBody(req));
        res.end();
      } else {
        const inline = url.includes('?inline=1');
        res.setHeader('content-disposition', inline ? 'inline' : 'attachment');
        if (inline) res.setHeader('content-type', 'application/pdf');
        res.end(readFileSync(p));
      }
      return;
    }
    if (url.startsWith('/api/')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await handle(new Request(ORIGIN + url, { method: req.method, headers, body }));
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end('local backend error');
    return;
  }
  next();
}
