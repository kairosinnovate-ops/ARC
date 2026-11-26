import { neon } from '@neondatabase/serverless';

export type Row = Record<string, any>;
export type Query = (text: string, params?: unknown[]) => Promise<Row[]>;

let query: Query | null = null;

/** Lets the local dev server swap in a plain Postgres pool. */
export function setQuery(q: Query) {
  query = q;
}

export function db(): Query {
  if (!query) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const sql = neon(url);
    query = (text, params = []) => sql.query(text, params as any[]) as Promise<Row[]>;
  }
  return query;
}

export async function one(text: string, params: unknown[] = []): Promise<Row | undefined> {
  const rows = await db()(text, params);
  return rows[0];
}

export async function many(text: string, params: unknown[] = []): Promise<Row[]> {
  return db()(text, params);
}
