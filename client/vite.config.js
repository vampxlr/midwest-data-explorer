import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // Local dev: proxy /api to the Express server
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    extensions: ['.jsx', '.js', '.json'],
    alias: {
      // Points to convex/_generated once `npx convex dev` has been run
      '@convex': path.resolve(__dirname, '../convex/_generated'),
    },
  },
});
