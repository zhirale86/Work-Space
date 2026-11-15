import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Флаг демонстрационной сборки (vite.demo.config.ts); в обычной сборке — пустая строка,
  // поэтому ветка демо-режима и весь код web/src/demo в dist не попадают.
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify(mode === 'demo' ? '1' : '') },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3100', changeOrigin: false } },
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3100', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
}));
