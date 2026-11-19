import react from '@vitejs/plugin-react';
import { defineConfig, type Connect, type Plugin } from 'vite';

/** Serves admin.html for /admin and /admin/, as the server does in production. */
const adminEntryRewrite: Connect.NextHandleFunction = (request, _response, next) => {
  const [path, query] = (request.url ?? '').split('?');
  if (path === '/admin' || path === '/admin/') request.url = `/admin.html${query ? `?${query}` : ''}`;
  next();
};

function adminEntry(): Plugin {
  return {
    name: 'agt-admin-entry',
    configureServer(server) { server.middlewares.use(adminEntryRewrite); },
    configurePreviewServer(server) { server.middlewares.use(adminEntryRewrite); },
  };
}

// The API is proxied so the browser sees one origin, as in production (TEST-1).
const apiProxy = {
  '/api/': { target: 'http://localhost:8082' },
};

export default defineConfig({
  plugins: [react(), adminEntry()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      // Two entries (FE-1): the public UI and the admin dashboard. The public
      // bundle never imports admin code.
      input: {
        main: 'index.html',
        admin: 'admin.html',
      },
    },
  },
});
