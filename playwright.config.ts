import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const runId = randomUUID();
const dbPath = process.env.E2E_DB_PATH ?? resolve('data', `e2e-${runId}.sqlite`);
if (resolve(dbPath) === resolve('data', 'hero-type.sqlite') || (process.env.DB_PATH && resolve(dbPath) === resolve(process.env.DB_PATH))) throw new Error('E2E must use a separate test database');
process.env.E2E_DB_PATH = dbPath;
const mailDir = process.env.E2E_MAIL_DIR ?? resolve('data', `e2e-mail-${runId}`);
process.env.E2E_MAIL_DIR = mailDir;

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  use: {baseURL:'http://127.0.0.1:5173',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects: [{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer: {
    command:'npm run dev',url:'http://127.0.0.1:5173/api/health',reuseExistingServer:false,timeout:30000,
    env: {NODE_ENV:'development',DB_PATH:dbPath,MAIL_TRANSPORT:'file-preview',MAIL_PREVIEW_DIR:mailDir,APP_ORIGIN:'http://127.0.0.1:5173'},
  },
});
