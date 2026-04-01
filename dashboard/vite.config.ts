import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 6876,
    strictPort: true,
    proxy: {
      '/dashboard': {
        target: 'http://127.0.0.1:4765',
        changeOrigin: false,
      },
      '/status': {
        target: 'http://127.0.0.1:4765',
        changeOrigin: false,
      },
      '/health': {
        target: 'http://127.0.0.1:4765',
        changeOrigin: false,
      },
    },
  },
});
