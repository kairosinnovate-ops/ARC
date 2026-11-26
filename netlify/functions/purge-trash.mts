import type { Config } from '@netlify/functions';
import { purgeExpired } from '../../server/api.ts';

// Daily: permanently remove projects that have been in Trash for more than 30 days, with their stored files.
export default async () => {
  const r = await purgeExpired();
  console.log(`purged ${r.projects} projects and ${r.files} files`);
  return new Response('ok');
};

export const config: Config = { schedule: '@daily' };
