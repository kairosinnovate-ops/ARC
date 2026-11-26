import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Local-only backend: runs the same API handler the Netlify function uses, but
 * against a local Postgres, a folder on disk for files and a throwaway sign-in.
 * Enabled with ARC_LOCAL=1 (npm run dev). None of this is part of the deployed site.
 */
function localBackend(): Plugin {
  return {
    name: 'arc-local-backend',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (process.env.ARC_LOCAL !== '1') return;
      let mod: Promise<any> | null = null;
      server.middlewares.use((req, res, next) => {
        const u = req.url || '';
        if (!u.startsWith('/api/') && !u.startsWith('/dev-auth/') && !u.startsWith('/dev-storage/')) return next();
        mod ??= server.ssrLoadModule('/scripts/local-backend.ts');
        mod.then((m) => m.middleware(req, res, next)).catch((e) => {
          mod = null;
          console.error(e);
          res.statusCode = 500;
          res.end('local backend failed to load');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localBackend()],
  server: { port: 5173, host: '127.0.0.1' },
});
