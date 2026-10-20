// Browser-only inspection of the standalone documentation; no app API or test runner.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.DOCS_URL || 'http://127.0.0.1:4180';
const origin = new URL(base).origin;
const browser = await chromium.launch({ headless: true });
const errors = [];
async function context(options = {}) {
  const next = await browser.newContext({ serviceWorkers: 'block', ...options });
  await next.route('**/*', route => new URL(route.request().url()).origin === origin && ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
  next.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return next;
}
try {
  const desktop = await context({ viewport: { width: 1440, height: 1000 } });
  const page = await desktop.newPage();
  const response = await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#hero-title').waitFor();
  await page.waitForFunction(() => document.getElementById('gallery-status').textContent.includes('Показано'), null, { timeout: 20000 });
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/documentation-desktop.png', import.meta.url)) });
  const manifest = JSON.parse(await readFile(new URL('../documentation/screenshots.json', import.meta.url), 'utf8'));
  const captured = manifest.screens.filter(screen => screen.status === 'captured');
  const missing = [];
  for (const screen of captured) {
    const result = await page.request.head(new URL(screen.file, `${base}/`).href);
    if (!result.ok()) missing.push({ id: screen.id, status: result.status() });
  }
  const gallery = await page.locator('#gallery-status').textContent();
  const sections = await page.locator('#screen-section option').allTextContents();
  if (sections.length > 1) await page.locator('#screen-section').selectOption({ index: 1 });
  const filtered = await page.locator('.screen-card').count();
  await page.locator('#screen-section').selectOption('all');
  await page.locator('#screen-search').fill(captured[0].title);
  await page.waitForFunction(() => document.querySelectorAll('.screen-card').length > 0 && document.getElementById('gallery-status').textContent.includes('Показано'));
  // Wait for the page's event-driven debounce, rather than sleeping an arbitrary interval.
  await page.waitForFunction(title => document.querySelector('.screen-caption h3')?.textContent === title, captured[0].title);
  const link = page.locator('.screen-button').first();
  await link.click();
  const dialogOpened = await page.locator('#screen-dialog').evaluate(node => node.open);
  await page.keyboard.press('Escape');
  const dialogClosed = await page.locator('#screen-dialog').evaluate(node => !node.open);
  const focusRestored = await link.evaluate(node => document.activeElement === node);
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

  const mobile = await context({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const phone = await mobile.newPage();
  await phone.goto(base, { waitUntil: 'networkidle' });
  await phone.locator('#hero-title').waitFor();
  await phone.screenshot({ path: fileURLToPath(new URL('../artifacts/documentation-mobile.png', import.meta.url)) });
  const mobileOverflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const reducedMotion = await phone.locator('#hero-title').evaluate(node => ({ animation: getComputedStyle(node).animationName, scrolling: getComputedStyle(document.documentElement).scrollBehavior }));
  await phone.locator('.mobile-toggle').click();
  const mobileMenuOpened = await phone.locator('.mobile-toggle').getAttribute('aria-expanded');
  await phone.locator('.toc a[href="#architecture"]').click();
  const mobileMenuClosed = await phone.locator('.mobile-toggle').getAttribute('aria-expanded');

  const plain = await context({ viewport: { width: 1440, height: 1000 }, javaScriptEnabled: false });
  const readable = await plain.newPage();
  await readable.goto(base, { waitUntil: 'networkidle' });
  const withoutJavaScript = await readable.locator('#hero-title').isVisible() && await readable.locator('.toc').isVisible();
  console.log(JSON.stringify({ status: response.status(), gallery, sections, captured: captured.length, blocked: manifest.screens.filter(screen => screen.status === 'blocked').length, missing, filtered, dialogOpened, dialogClosed, focusRestored, desktopOverflow, mobileOverflow, mobileMenuOpened, mobileMenuClosed, reducedMotion, withoutJavaScript, browserErrors: errors }, null, 2));
} finally {
  await browser.close();
}
