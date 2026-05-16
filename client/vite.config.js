import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  },
  // Expose env vars prefixed with VITE_ to the client
  // VITE_API_BASE is only needed when deploying separately (not Vercel single-deploy)
});
