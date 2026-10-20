import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.E2E_CACHE_DIR,
  server: {
    port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '*.eml'] },
  },
  build: { target: 'es2023' },
  test: { include: ['src/**/*.test.ts', 'shared/**/*.test.ts', 'server/**/*.test.ts'], environment: 'node' },
});
