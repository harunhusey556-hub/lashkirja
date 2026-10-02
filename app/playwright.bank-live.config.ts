import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e-bank-live',workers:1,retries:0,timeout:600_000,
 use:{baseURL:process.env.PLAYWRIGHT_BASE_URL,headless:false,trace:'off',video:'off',screenshot:'off',launchOptions:process.env.PLAYWRIGHT_CHROMIUM_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH}:undefined},
 reporter:'list',
});
