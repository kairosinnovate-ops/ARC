// Applies db/schema.sql (idempotent). Usage: npm run db:migrate
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const text = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const statements = text.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
await sql.transaction(statements.map((s) => sql.query(s)));
const rows = await sql`select table_name from information_schema.tables where table_schema='public' order by 1`;
console.log('tables:', rows.map((r) => r.table_name).join(', '));
