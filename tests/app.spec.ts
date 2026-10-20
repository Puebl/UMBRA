import { expect, test, type Page } from '@playwright/test';
import { artifactPath } from './artifacts';

async function nextCharacters(page:Page,count:number) {
  return page.locator('.typing-text').evaluate((element,n) => {
    const spans = [...element.children]; const index = spans.findIndex(span => span.classList.contains('cursor'));
    return spans.slice(index,index + n).map(span => span.textContent ?? '').join('');
  }, count);
}
test('guest training: strict mistakes, combo, timer, saved result and all sections', async ({page}) => {
  const errors:string[] = []; page.on('pageerror',error => errors.push(error.message));
  await page.clock.install();
  await page.goto('/'); await expect(page.getByRole('heading',{name:'Войди в свой ритм.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Войти',exact:true})).toBeEnabled();
  await page.screenshot({path:artifactPath('desktop.png'),fullPage:true});
  const input = page.getByRole('textbox',{name:'Поле тренировки печати'});
  await input.focus();
  const target = await nextCharacters(page,80);
  await page.keyboard.type('~');
  await expect(page.locator('.typing-text .cursor')).toHaveText(target[0]);
  await expect(page.locator('.typing-feedback')).toContainText('Ошибка');
  await page.keyboard.type(target);
  await expect(page.locator('.typing-feedback')).toContainText('80 верных символов');
  await expect(page.locator('.typing-feedback')).toContainText('Двойные очки');
  await expect(page.getByRole('button',{name:'Слова',exact:true})).toBeDisabled();
  await page.clock.fastForward(60000);
  await expect(page.getByRole('heading',{name:'Отличный ритм!'})).toBeVisible();
  await expect(page.locator('.result-panel')).toContainText('Прогресс сохранён');
  await page.getByRole('button',{name:'Разбор результата'}).click();
  await expect(page.getByRole('heading',{name:'Последние тренировки'})).toBeVisible();
  await page.getByRole('button',{name:'Показать данные графиков таблицей'}).click();
  await expect(page.locator('caption')).toHaveText('Данные графиков по дням');
  await page.screenshot({path:artifactPath('statistics.png'),fullPage:true});
  await page.getByRole('button',{name:/Достижения/}).first().click();
  await expect(page.getByRole('heading',{name:'Первый шаг'})).toBeVisible();
  await expect(page.locator('.achievement-card.unlocked')).toHaveCount(1);
  await page.getByRole('button',{name:'Таблица лидеров'}).click();
  await expect(page.getByRole('heading',{name:'Лига героев.'})).toBeVisible();
  await page.getByRole('button',{name:'Как тренироваться'}).click();
  await expect(page.getByRole('heading',{name:'Пальцы знают путь.'})).toBeVisible();
  await page.reload(); await expect(page.getByRole('button',{name:'Войти',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Мой прогресс'}).click();
  await expect(page.getByRole('heading',{name:'Последние тренировки'})).toBeVisible();
  expect(errors).toEqual([]);
});

test('registration, canonical session sync and login from another browser context', async ({page,browser}) => {
  const suffix = Date.now(); const name = `Тестовый ${suffix}`;
  const email = `hero-${suffix}@example.test`; const password = 'StrongPass_2026!';
  await page.clock.install(); await page.goto('/');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('textbox',{name:'Никнейм',exact:true}).fill(name);
  await page.getByRole('textbox',{name:'Электронная почта'}).fill(email);
  await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Создать аккаунт'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.header-user')).toContainText(name);
  await page.getByRole('button',{name:'30с',exact:true}).click();
  await page.getByRole('textbox',{name:'Поле тренировки печати'}).focus();
  const target = await nextCharacters(page,100); await page.keyboard.type(target);
  await page.clock.fastForward(30000);
  await expect(page.getByRole('heading',{name:'Отличный ритм!'})).toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('Прогресс в облаке');
  await page.locator('.header-user').click();
  await expect(page.locator('.number-list')).toContainText('Всё сохранено');
  await page.screenshot({path:artifactPath('account.png'),fullPage:true});
  const context = await browser.newContext(); const second = await context.newPage();
  try {
    await second.goto('/'); await second.getByRole('button',{name:'Войти',exact:true}).click();
    await second.getByRole('dialog').getByRole('button',{name:'Вход',exact:true}).click();
    await second.getByRole('textbox',{name:'Электронная почта'}).fill(email);
    await second.getByLabel('Пароль',{exact:true}).fill(password);
    await second.getByRole('dialog').getByRole('button',{name:'Войти',exact:true}).click();
    await expect(second.getByRole('dialog')).toHaveCount(0);
    await second.reload();
    await expect(second.locator('.header-user')).toContainText(name);
    await second.getByRole('button',{name:'Мой прогресс'}).click();
    await expect(second.getByRole('heading',{name:'Последние тренировки'})).toBeVisible();
    await expect(second.locator('.history-panel tbody tr')).toHaveCount(1);
    await second.getByRole('button',{name:'Таблица лидеров'}).click();
    await expect(second.locator('.ranking-person')).toContainText(name);
    await second.locator('.header-user').click();
    await second.getByRole('button',{name:'Выйти',exact:true}).click();
    await expect(second.locator('.connection-status')).toHaveText('Гостевой режим');
  } finally { await context.close(); }
});

for (const host of ['localhost', '127.0.0.1']) {
  test(`login survives a network failure and manual retry on ${host}`, async ({page}) => {
    const base = `http://${host}:5173`;
    const suffix = `${host}-${Date.now()}`;
    const name = `Сеть ${suffix}`;
    const email = `network-${suffix}@example.test`; const password = 'StrongPass_2026!';
    const created = await page.request.post(`${base}/api/auth/register`, { data: { name, email, password } });
    expect(created.status()).toBe(201);
    await page.request.post(`${base}/api/auth/logout`);
    await page.goto(base);
    await page.getByRole('button',{name:'Войти',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Вход',exact:true}).click();
    const emailInput = page.getByRole('textbox',{name:'Электронная почта'});
    const passwordInput = page.getByLabel('Пароль',{exact:true});
    const submit = page.getByRole('dialog').getByRole('button',{name:'Войти',exact:true});
    await emailInput.fill(email); await passwordInput.fill('WrongPassword_2026');
    await submit.click();
    await expect(page.getByRole('alert')).toContainText('Неверная почта или пароль.');
    await passwordInput.fill(password);
    await page.route('**/api/auth/login', route => route.abort('failed'));
    await submit.click();
    await expect(page.getByRole('alert')).toContainText('Не удалось связаться с сервером.');
    await expect(emailInput).toHaveValue(email);
    await expect(passwordInput).toHaveValue(password);
    await expect(submit).toBeEnabled();
    await page.unroute('**/api/auth/login');
    await submit.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.header-user')).toContainText(name);
    await page.reload();
    await expect(page.locator('.header-user')).toContainText(name);
    await page.locator('.header-user').click();
    await page.getByRole('button',{name:'Выйти',exact:true}).click();
    await expect(page.locator('.connection-status')).toHaveText('Гостевой режим');
  });
}

test('a stalled session check and login release the interface after 15 seconds', async ({page}) => {
  await page.clock.install();
  await page.route('**/api/me', () => {});
  const sessionRequest = page.waitForRequest('**/api/me');
  await page.goto('/'); await sessionRequest;
  const login = page.getByRole('button',{name:'Войти',exact:true});
  await expect(login).toBeDisabled();
  await page.clock.fastForward(15001);
  await expect(login).toBeEnabled();
  await login.click();
  await page.getByRole('dialog').getByRole('button',{name:'Вход',exact:true}).click();
  await page.getByRole('textbox',{name:'Электронная почта'}).fill('timeout@example.test');
  await page.getByLabel('Пароль',{exact:true}).fill('StrongPass_2026!');
  await page.route('**/api/auth/login', () => {});
  const loginRequest = page.waitForRequest('**/api/auth/login');
  await page.getByRole('dialog').getByRole('button',{name:'Войти',exact:true}).click();
  await loginRequest;
  await page.clock.fastForward(15001);
  await expect(page.getByRole('alert')).toHaveText('Сервер не ответил за 15 секунд. Попробуйте ещё раз.');
  await expect(page.getByRole('dialog').getByRole('button',{name:'Войти',exact:true})).toBeEnabled();
  await expect(page.getByLabel('Пароль',{exact:true})).toHaveValue('StrongPass_2026!');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('nickname conflict preserves the form and allows retry with a free nickname', async ({page}) => {
  const suffix = Date.now(); const taken = `Герой ${suffix}`;
  const email = `retry-${suffix}@example.test`; const password = 'StrongPass_2026!';
  const first = await page.request.post('/api/auth/register', { data: { name: taken, email: `owner-${suffix}@example.test`, password } });
  expect(first.status()).toBe(201);
  await page.request.post('/api/auth/logout');
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  const nickname = page.getByRole('textbox',{name:'Никнейм',exact:true});
  await nickname.fill(`  ${taken.toUpperCase()}  `);
  await page.getByRole('textbox',{name:'Электронная почта'}).fill(email);
  await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Создать аккаунт'}).click();
  await expect(page.getByRole('alert')).toHaveText('Никнейм уже занят. Выберите другой.');
  await expect(nickname).toHaveValue(`  ${taken.toUpperCase()}  `);
  await expect(page.getByRole('textbox',{name:'Электронная почта'})).toHaveValue(email);
  await expect(page.getByLabel('Пароль',{exact:true})).toHaveValue(password);
  await expect(page.getByRole('button',{name:'Создать аккаунт'})).toBeEnabled();
  const free = `Новый ${suffix}`;
  await nickname.fill(free);
  await page.getByRole('button',{name:'Создать аккаунт'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.header-user')).toContainText(free);
  const profile = await page.request.get('/api/profile');
  expect((await profile.json()).user).toMatchObject({ name: free, email });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('mobile layout, menu and authentication accessibility', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/');
  await expect(page.getByRole('heading',{name:'Войди в свой ритм.'})).toBeVisible();
  await page.screenshot({path:artifactPath('mobile.png'),fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Открыть меню'}).click();
  await page.getByRole('button',{name:'Мой прогресс'}).click();
  await expect(page.getByRole('heading',{name:'Твой прогресс.'})).toBeVisible();
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Войти',exact:true})).toBeFocused();
});
