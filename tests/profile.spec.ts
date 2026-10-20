import { expect, test, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { nickname } from '../shared/nickname';
import { artifactPath } from './artifacts';

// Seed only the isolated E2E database, without consuming the real registration quota.
// Registration and rate limiting remain covered by the existing app/API suites.
async function createAccount(page: Page, prefix: string) {
  const path = process.env.E2E_DB_PATH;
  if (!path || resolve(path) === resolve('data','hero-type.sqlite')) throw new Error('An isolated E2E database is required');
  const suffix = randomUUID().slice(0,8); const name = `${prefix} ${suffix}`;
  const email = `${prefix.toLowerCase()}-${suffix}@example.test`; const password = 'StrongPass_2026!';
  const id = randomUUID(); const salt = randomBytes(16).toString('hex'); const token = randomBytes(32).toString('hex');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    db.prepare('INSERT INTO users (id,name,name_key,email,password_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run(id,name,nickname(name)!.key,email,`${salt}:${scryptSync(password,salt,64).toString('hex')}`,Date.now());
    db.prepare('INSERT INTO auth_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'),id,Date.now()+86400000);
    db.exec('COMMIT');
  } finally { db.close(); }
  await page.context().addCookies([{name:'hero_session',value:token,url:'http://127.0.0.1:5173',httpOnly:true,sameSite:'Strict'}]);
  return {user:{id,name},email,password};
}
function result(id: string) {
  return {id,createdAt:new Date().toISOString(),mode:'words',language:'ru',difficulty:'easy',durationMs:30000,correct:100,errors:0,maxCombo:20,score:200,cpm:200,wpm:40,accuracy:100,xp:135,mistakes:[]};
}
async function queue(page: Page, userId: string, id: string) {
  await page.evaluate(({userId,session}) => {
    localStorage.setItem(`hero-type:v1:pending:${userId}`,JSON.stringify([session]));
    window.dispatchEvent(new Event('online'));
  },{userId,session:result(id)});
}

test('profile settings persist, control leaderboard visibility and survive sync in either response order', async ({page}) => {
  test.setTimeout(90000);
  const {user,email,password} = await createAccount(page,'Settings');
  await page.goto('/'); await page.locator('.header-user').click();
  const form = page.locator('.profile-settings');
  let releaseSync!: () => void; let capturedSync!: () => void;
  const syncGate = new Promise<void>(resolve => {releaseSync=resolve;});
  const syncCaptured = new Promise<void>(resolve => {capturedSync=resolve;});
  await page.route('**/api/sessions', async route => {
    const response = await route.fetch(); capturedSync(); await syncGate; await route.fulfill({response});
  });
  await queue(page,user.id,`settings-sync-${Date.now()}`); await syncCaptured;
  const changed = `Edited ${Date.now()}`;
  await form.getByRole('textbox',{name:'Никнейм'}).fill(changed);
  await form.getByRole('button',{name:'Молния',exact:true}).click();
  await form.getByLabel('Язык интерфейса').selectOption('en');
  await form.getByRole('checkbox').uncheck();
  await form.getByRole('button',{name:'Сохранить настройки'}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(form.getByRole('button',{name:'Save settings'})).toBeEnabled();
  releaseSync();
  await expect(page.locator('.number-list').getByText('135 XP',{exact:true})).toBeVisible();
  await expect(page.locator('.header-user')).toContainText(changed);
  await expect(page.locator('.header-user [data-avatar]')).toHaveAttribute('data-avatar','bolt');
  await expect(form.getByRole('checkbox')).not.toBeChecked();
  await page.unroute('**/api/sessions');
  const ranking = await page.request.get('/api/leaderboard?metric=xp&period=all');
  expect((await ranking.json()).entries.some((entry:{userId:string}) => entry.userId === user.id)).toBe(false);

  let releasePatch!: () => void; let capturedPatch!: () => void;
  const patchGate = new Promise<void>(resolve => {releasePatch=resolve;});
  const patchCaptured = new Promise<void>(resolve => {capturedPatch=resolve;});
  await page.route('**/api/profile', async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    const response = await route.fetch(); capturedPatch(); await patchGate; await route.fulfill({response});
  });
  const newest = `Latest ${Date.now()}`;
  await form.getByRole('textbox',{name:'Nickname'}).fill(newest);
  await form.getByRole('button',{name:'Save settings'}).click(); await patchCaptured;
  await queue(page,user.id,`settings-sync2-${Date.now()}`);
  await expect(page.locator('.number-list').getByText('270 XP',{exact:true})).toBeVisible();
  releasePatch();
  await expect(form.getByRole('button',{name:'Save settings'})).toBeEnabled();
  await expect(page.locator('.number-list').getByText('270 XP',{exact:true})).toBeVisible();
  await expect(page.locator('.header-user')).toContainText(newest);
  await page.unroute('**/api/profile');
  await form.getByRole('checkbox').check();
  await form.getByRole('button',{name:'Save settings'}).click();
  await expect(page.getByText('Settings saved.',{exact:true})).toBeVisible();
  const visible = await page.request.get('/api/leaderboard?metric=xp&period=all');
  expect((await visible.json()).entries.find((entry:{userId:string}) => entry.userId === user.id)).toMatchObject({name:newest,avatar:'bolt'});
  await page.reload(); await expect(page.locator('.header-user')).toContainText(newest);
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await page.locator('.header-user').click();
  await expect(page.locator('.number-list').getByText('270 XP',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.locator('.header-login')).toBeVisible();
  await page.locator('.interface-language select').selectOption('ru');
  await expect(page.locator('html')).toHaveAttribute('lang','ru');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Вход',exact:true}).click();
  await page.getByRole('textbox',{name:'Электронная почта'}).fill(email);
  await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('dialog').getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('.header-user')).toContainText(newest);
  await page.screenshot({path:artifactPath('profile-settings-en.png'),fullPage:true});
});

test('guest UI language persists without changing an active exercise or its keyboard', async ({page}) => {
  await page.clock.install(); await page.goto('/');
  await expect(page.locator('.header-login')).toBeEnabled();
  await page.evaluate(() => localStorage.setItem('hero-type:v1:interface-language','invalid'));
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang','ru');
  const input = page.getByRole('textbox',{name:'Поле тренировки печати'});
  const characters = await page.locator('.typing-text').evaluate(element => [...element.children].slice(0,6).map(span => span.textContent).join(''));
  await input.focus(); await page.keyboard.type(characters);
  await page.clock.fastForward(5000);
  const text = await page.locator('.typing-text').textContent();
  const timer = await page.locator('.time-metric strong').textContent();
  const config = await page.evaluate(() => localStorage.getItem('hero-type:v1:config'));
  await page.locator('.interface-language select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('.typing-text')).toHaveText(text!);
  expect(await page.locator('.typing-text .typed').count()).toBe(6);
  expect((await page.locator('.time-metric strong').textContent())?.replace(/[^0-9]/g,''))
    .toBe(timer?.replace(/[^0-9]/g,''));
  expect(await page.evaluate(() => localStorage.getItem('hero-type:v1:config'))).toBe(config);
  await expect(page.locator('.exercise-options select').first()).toHaveValue('ru');
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('.header-login')).toHaveText('Sign in');
  await page.locator('.header-login').click();
  await page.locator('.auth-tabs button').nth(1).click();
  await page.locator('input[name="email"]').fill('no-account@example.test');
  await page.locator('input[name="password"]').fill('WrongPassword_2026!');
  await page.route('**/api/auth/login',route => route.fulfill({status:401,contentType:'application/json',body:'{}'}));
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('alert')).not.toContainText(/[А-Яа-яЁё]/);
  await page.locator('.interface-language select').selectOption('ru');
  await expect(page.getByRole('alert')).toContainText('Неверная почта или пароль.');
});

test('nickname conflict keeps the settings draft and saves no partial changes on mobile', async ({page}) => {
  const taken = await createAccount(page,'Taken');
  const current = await createAccount(page,'Draft');
  await page.setViewportSize({width:390,height:844});
  await page.goto('/'); await page.locator('.header-user').click();
  const form = page.locator('.profile-settings');
  const nickname = form.getByRole('textbox',{name:'Никнейм'});
  await nickname.fill(taken.user.name.toUpperCase());
  await form.getByRole('button',{name:'Корона',exact:true}).click();
  await form.getByRole('button',{name:'Сохранить настройки'}).click();
  await expect(page.getByRole('alert')).toHaveText('Никнейм уже занят. Выберите другой.');
  await expect(nickname).toHaveValue(taken.user.name.toUpperCase());
  await expect(form.getByRole('button',{name:'Корона',exact:true})).toHaveAttribute('aria-pressed','true');
  const unchanged = await page.request.get('/api/profile');
  expect((await unchanged.json()).user).toMatchObject({name:current.user.name,avatar:'initials',profileVersion:0});
  await nickname.fill(`Ready ${Date.now()}`);
  await form.getByRole('button',{name:'Сохранить настройки'}).click();
  await expect(page.getByText('Настройки сохранены.',{exact:true})).toBeVisible();
  await expect(page.locator('.header-user [data-avatar]')).toHaveAttribute('data-avatar','crown');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:artifactPath('profile-settings-mobile.png'),fullPage:true});
});

test('a delayed settings response cannot restore the account after logout', async ({page}) => {
  await createAccount(page,'Logout'); await page.goto('/'); await page.locator('.header-user').click();
  let release!: () => void; let captured!: () => void;
  const gate = new Promise<void>(resolve => {release=resolve;});
  const received = new Promise<void>(resolve => {captured=resolve;});
  await page.route('**/api/profile',async route => {
    const response = await route.fetch(); captured(); await gate; await route.fulfill({response});
  });
  await page.locator('.interface-language select').selectOption('en'); await received;
  await page.getByRole('button',{name:'Выйти',exact:true}).click();
  await expect(page.locator('.header-login')).toBeVisible();
  release();
  await expect(page.locator('.interface-language select')).toBeEnabled();
  await expect(page.locator('.header-user')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('lang','ru');
  const me = await page.request.get('/api/me'); expect((await me.json()).user).toBeNull();
});
