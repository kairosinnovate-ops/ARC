import { createAuthClient } from '@neon/neon-js/auth';

export type SessionUser = { id: string; email: string; name: string };

type AuthResult = { error?: string };

export interface Auth {
  current(): Promise<SessionUser | null>;
  token(): Promise<string | null>;
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(name: string, email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
}

/** Real sign-in through Neon Auth. The browser talks to it directly; our API checks its tokens. */
function neonAuth(url: string): Auth {
  const client: any = createAuthClient(url, { fetchOptions: { credentials: 'include' } } as any);
  let cached: { token: string; exp: number } | null = null;

  async function session() {
    const { data } = await client.getSession();
    if (!data?.session || !data?.user) {
      cached = null;
      return null;
    }
    const token: string | undefined = data.session.token;
    if (token) {
      try {
        const exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;
        cached = { token, exp };
      } catch {
        cached = { token, exp: Date.now() + 60_000 };
      }
    }
    return data;
  }

  const msg = (e: any) => (e ? e.message || 'Something went wrong. Try again.' : undefined);

  return {
    async current() {
      const d = await session();
      return d ? { id: d.user.id, email: d.user.email, name: d.user.name || d.user.email } : null;
    },
    async token() {
      if (cached && cached.exp - Date.now() > 60_000) return cached.token;
      await session();
      return cached?.token ?? null;
    },
    async signIn(email, password) {
      const r = await client.signIn.email({ email, password });
      cached = null;
      return { error: msg(r.error) };
    },
    async signUp(name, email, password) {
      const r = await client.signUp.email({ name, email, password });
      cached = null;
      return { error: msg(r.error) };
    },
    async signOut() {
      cached = null;
      await client.signOut();
    },
  };
}

/** Throwaway sign-in for `npm run dev` only. Any email works; no password check. */
function devAuth(): Auth {
  const KEY = 'arc-dev-session';
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
      return null;
    }
  };
  async function login(email: string, name?: string) {
    const r = await fetch('/dev-auth/token', { method: 'POST', body: JSON.stringify({ email, name }) });
    localStorage.setItem(KEY, JSON.stringify(await r.json()));
    return {};
  }
  return {
    async current() {
      return read()?.user ?? null;
    },
    async token() {
      return read()?.token ?? null;
    },
    signIn: (email) => login(email),
    signUp: (name, email) => login(email, name),
    async signOut() {
      localStorage.removeItem(KEY);
    },
  };
}

export const auth: Auth =
  import.meta.env.VITE_DEV_AUTH === '1' ? devAuth() : neonAuth(import.meta.env.VITE_NEON_AUTH_URL as string);
