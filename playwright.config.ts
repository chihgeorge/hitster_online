import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Multi-device specs open up to 4 browser contexts each against one `next dev` and one
  // `partykit dev`; 5 default workers starved them into random timeouts. 2 is stable and faster.
  workers: process.env.CI ? 1 : 2,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3456",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 12"] },
    },
  ],
  webServer: {
    command: "PORT=3456 npm run dev:next",
    url: "http://localhost:3456",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
