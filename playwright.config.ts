import { defineConfig } from '@playwright/test'

// Uses a preinstalled Chromium when PLAYWRIGHT_CHROMIUM_PATH (or the cloud
// sandbox's /opt/pw-browsers/chromium) exists; otherwise Playwright's own.
import { existsSync } from 'node:fs'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    viewport: { width: 1600, height: 1000 },
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
