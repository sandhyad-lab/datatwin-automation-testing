import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: 'https://stage.datatwin.ai',
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
});