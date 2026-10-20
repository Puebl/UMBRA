import { expect, test, type Page } from '@playwright/test';
import { artifactPath } from './artifacts';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const password = 'OriginalPass_2026!';
const replacement = 'ReplacementPass_2026!';
const mailDir = process.env.E2E_MAIL_DIR!;
async function recoveryLink(email: string) {
  let link = '';
  await expect.poll(async () => {
    const files = await readdir(mailDir);
    for (const file of files.filter(name => name.endsWith('.eml'))) {
      const text = await readFile(join(mailDir, file), 'utf8');
      if (!text.includes(email)) continue;
      link = text.match(/http:\/\/127\.0\.0\.1:5173\/#reset-password=[a-f0-9]{64}/)?.[0] ?? '';
      if (link) return true;
    }
    return false;
  }, { message: 'Локальное письмо восстановления должно появиться', timeout: 10000 }).toBe(true);
  return link;
}
async function forgot(page: Page, email: string) {
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Вход', exact: true }).click();
  await dialog.getByRole('button', { name: 'Забыли пароль?' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Электронная почта' })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Электронная почта' }).fill(email);
  await dialog.getByRole('button', { name: 'Получить ссылку' }).click();
  await expect(dialog.getByRole('heading', { name: 'Проверь почту.' })).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('Если аккаунт с такой почтой существует');
}
async function reset(page: Page, link: string) {
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Новый пароль.' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('Новый пароль', { exact: true }).fill(replacement);
  await page.getByLabel('Повтори новый пароль', { exact: true }).fill(replacement);
  await page.getByRole('button', { name: 'Сохранить новый пароль' }).click();
  await expect(page.getByRole('heading', { name: 'Пароль обновлён.' })).toBeVisible();
}

test('recovery email, password confirmation, revoked browser sessions and preserved profile', async ({ page, browser }) => {
  const suffix = Date.now(); const email = `recover-${suffix}@example.test`; const name = `Возврат ${suffix}`;
  const registered = await page.request.post('/api/auth/register', { data: { email, name, password } });
  expect(registered.status()).toBe(201);
  const saved = await page.request.post('/api/sessions', { data: { id: `recovery-${suffix}`, mode: 'words', language: 'en', difficulty: 'easy', durationMs: 30000, correct: 30, errors: 0, maxCombo: 30, score: 300, mistakes: [] } });
  expect(saved.status()).toBe(200);
  const original = (await saved.json()).user;
  const oldContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    expect((await oldContext.request.post('/api/auth/login', { data: { email, password } })).status()).toBe(200);
    const second = await guestContext.newPage();
    await second.setViewportSize({ width: 390, height: 844 });
    await second.goto('/');
    await forgot(second, email.toUpperCase());
    const link = await recoveryLink(email);
    await second.goto(link);
    await expect(second.getByRole('heading', { name: 'Новый пароль.' })).toBeVisible();
    expect(new URL(second.url()).hash).toBe('');
    await expect(second.getByLabel('Новый пароль', { exact: true })).toBeFocused();
    await second.getByLabel('Новый пароль', { exact: true }).fill(replacement);
    await second.getByLabel('Повтори новый пароль', { exact: true }).fill('DifferentPass_2026!');
    await second.getByRole('button', { name: 'Сохранить новый пароль' }).click();
    await expect(second.getByRole('alert')).toHaveText('Пароли не совпадают. Повторите новый пароль.');
    await second.getByLabel('Повтори новый пароль', { exact: true }).fill(replacement);
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await second.screenshot({ path: artifactPath('recovery-reset-mobile.png'), fullPage: true });
    await second.getByRole('button', { name: 'Сохранить новый пароль' }).click();
    await expect(second.getByRole('heading', { name: 'Пароль обновлён.' })).toBeVisible();
    expect((await page.request.get('/api/me')).status()).toBe(200);
    expect((await (await page.request.get('/api/me')).json()).user).toBeNull();
    expect((await (await oldContext.request.get('/api/me')).json()).user).toBeNull();
    expect((await guestContext.request.post('/api/auth/login', { data: { email, password } })).status()).toBe(401);
    await second.getByRole('button', { name: 'Войти с новым паролем' }).click();
    await second.getByRole('textbox', { name: 'Электронная почта' }).fill(email);
    await second.getByLabel('Пароль', { exact: true }).fill(replacement);
    await second.getByRole('dialog').getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(second.getByRole('dialog')).toHaveCount(0);
    await expect(second.locator('.header-user')).toContainText(name);
    expect((await (await guestContext.request.get('/api/profile')).json()).user).toEqual(original);
    await second.goto(link);
    await second.getByLabel('Новый пароль', { exact: true }).fill('AnotherPass_2026!');
    await second.getByLabel('Повтори новый пароль', { exact: true }).fill('AnotherPass_2026!');
    await second.getByRole('button', { name: 'Сохранить новый пароль' }).click();
    await expect(second.getByRole('heading', { name: 'Ссылка недействительна.' })).toBeVisible();
    await second.keyboard.press('Escape');
    await expect(second.getByRole('dialog')).toHaveCount(0);
    await expect(second.locator('.header-user')).toBeFocused();
  } finally { await oldContext.close(); await guestContext.close(); }
});

test('local recovery emails cannot be fetched through Vite static or filesystem URLs', async ({ page }) => {
  const suffix = Date.now(); const email = `private-${suffix}@example.test`;
  expect((await page.request.post('/api/auth/register', { data: { email, name: `Приватность ${suffix}`, password } })).status()).toBe(201);
  const before = new Set(await readdir(mailDir));
  expect((await page.request.post('/api/auth/forgot-password', { data: { email } })).status()).toBe(200);
  let file = '';
  await expect.poll(async () => {
    file = (await readdir(mailDir)).find(name => !before.has(name) && name.endsWith('.eml')) ?? '';
    return Boolean(file);
  }, { message: 'Приватное тестовое письмо создано', timeout: 10000 }).toBe(true);
  await recoveryLink(email);
  // Also verify an in-project file when MAIL_PREVIEW_DIR is on another drive.
  // This fixture is deliberately not a real recovery message or token.
  await mkdir(join(process.cwd(), 'data'), { recursive: true });
  const fixtureDir = await mkdtemp(join(process.cwd(), 'data', 'eml-deny-'));
  try {
    const fixture = join(fixtureDir, 'preview.eml');
    await writeFile(fixture, 'Private preview test fixture', { flag: 'wx' });
    const paths = [resolve(mailDir, file), fixture];
    for (const path of paths) {
      const urls = [`/@fs/${encodeURI(path.split(sep).join('/'))}`];
      const projectPath = relative(process.cwd(), path);
      if (!isAbsolute(projectPath) && !projectPath.startsWith('..')) urls.push(`/${encodeURI(projectPath.split(sep).join('/'))}`);
      for (const url of urls) {
        const response = await page.request.get(url);
        if (path === fixture) expect(response.status()).toBe(403);
        // Windows cross-drive /@fs URLs may fall back to app HTML, never mail content.
        else expect((await response.text()).includes('#reset-password=')).toBe(false);
      }
    }
  } finally { await rm(fixtureDir, { recursive: true, force: true }); }
});

test('unknown email gets a neutral confirmation and malformed link stays accessible', async ({ page }) => {
  await page.goto('/');
  const email = `unknown-${Date.now()}@example.test`;
  await forgot(page, email);
  await page.screenshot({ path: artifactPath('recovery-sent.png'), fullPage: true });
  await page.getByRole('button', { name: 'Вернуться ко входу' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeFocused();
  await page.goto('/#reset-password=broken');
  await expect(page.getByRole('heading', { name: 'Ссылка недействительна.' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button', { name: 'Запросить новую ссылку' }).click();
  await expect(page.getByRole('textbox', { name: 'Электронная почта' })).toBeFocused();
  const files = await readdir(mailDir);
  expect((await Promise.all(files.filter(f => f.endsWith('.eml')).map(f => readFile(join(mailDir, f), 'utf8')))).some(text => text.includes(email))).toBe(false);
});

test('reset refreshes current auth but keeps its pending training queue for next login', async ({ page }) => {
  const suffix = Date.now(); const email = `queued-${suffix}@example.test`;
  const registered = await page.request.post('/api/auth/register', { data: { email, name: `Очередь ${suffix}`, password } });
  const owner = (await registered.json()).user;
  await page.goto('/'); await expect(page.locator('.header-user')).toBeVisible();
  const pending = { id: `pending-${suffix}`, createdAt: new Date().toISOString(), mode: 'words', language: 'en', difficulty: 'easy', durationMs: 30000, correct: 40, errors: 0, maxCombo: 40, score: 400, xp: 70, cpm: 80, wpm: 16, accuracy: 100, mistakes: [] };
  await page.evaluate(({ id, result }) => localStorage.setItem(`hero-type:v1:pending:${id}`, JSON.stringify([result])), { id: owner.id, result: pending });
  await page.route('**/api/sessions', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  expect((await page.request.post('/api/auth/forgot-password', { data: { email } })).status()).toBe(200);
  await reset(page, await recoveryLink(email));
  await expect(page.locator('.connection-status')).toHaveText('Гостевой режим');
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`hero-type:v1:pending:${id}`) ?? '[]'), owner.id)).toEqual([pending]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hero-type:v1:guest') ?? '[]'))).toEqual([]);
  await page.unroute('**/api/sessions');
  await page.getByRole('button', { name: 'Войти с новым паролем' }).click();
  await page.getByRole('textbox', { name: 'Электронная почта' }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(replacement);
  await page.getByRole('dialog').getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get('/api/profile')).json()).user.sessions.length).toBe(1);
  await expect(page.locator('.connection-status')).toHaveText('Прогресс в облаке');
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`hero-type:v1:pending:${id}`) ?? '[]'), owner.id)).toEqual([]);
});

test('a stale initial me response cannot restore the revoked account after reset', async ({ page }) => {
  const suffix = Date.now(); const email = `stale-${suffix}@example.test`;
  const registered = await page.request.post('/api/auth/register', { data: { email, name: `Ответ ${suffix}`, password } });
  const owner = (await registered.json()).user;
  expect((await page.request.post('/api/auth/forgot-password', { data: { email } })).status()).toBe(200);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let intercepted = false; let delivered = false;
  await page.route('**/api/me', async route => {
    if (!intercepted) {
      intercepted = true; await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: owner }) });
      delivered = true;
    } else await route.continue();
  });
  try {
    await reset(page, await recoveryLink(email));
    await expect(page.locator('.connection-status')).toHaveText('Гостевой режим');
    release();
    await expect.poll(() => delivered).toBe(true);
    await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeEnabled();
    await expect(page.locator('.header-user')).toHaveCount(0);
  } finally { release(); }
});
