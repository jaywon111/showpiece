import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist', chunkSizeWarningLimit: 1000 },
});
