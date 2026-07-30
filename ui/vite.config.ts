import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    port: 4089,
    proxy: {
      '/api': 'http://127.0.0.1:4088',
      '/agent': 'http://127.0.0.1:4088',
    },
  },
});
