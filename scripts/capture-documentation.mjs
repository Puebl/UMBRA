import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Frontend only. Every API request is fulfilled or rejected before navigation.
// No persistent browser, backend, database, exercise execution or media access.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'documentation/assets/screenshots');
const inspect = process.argv.includes('--inspect');
const modes = ['words','sentences','code','symbols','custom','story','boss','benchmark','prompt'];
const labels = ['Слова','Предложения','Код','Символы','Свой текст','История','Босс','Бенчмарк','По запросу'];
const sessions = Array.from({length:18}, (_,i) => ({id:`capture-session-${i}`,createdAt:new Date(Date.now()-(17-i)*86400000).toISOString(),mode:modes[i%4],language:i%2?'en':'ru',difficulty:'medium',durationMs:60000,correct:240+i*7,errors:3+i%4,maxCombo:45+i,score:2800+i*110,xp:350,cpm:240+i*7,wpm:48+i*1.4,accuracy:97+i%3,mistakes:[{expected:';',count:2},{expected:'о',count:1}]}));
const user = {id:'documentation-account',name:'Alex Rhythm',email:'alex@example.invalid',avatar:'orbit',interfaceLanguage:'ru',showInLeaderboard:true,xp:6300,sessions,profileVersion:1};
const screens = [], errors = [];
const manifestPath = path.join(root, 'documentation/screenshots.json');
const startedAt = new Date().toISOString();
const resume = process.argv.includes('--resume');
if (resume) { try { screens.push(...JSON.parse(await readFile(manifestPath, 'utf8')).screens); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
let completed = false, mediaRequests = 0;
const persist = async () => writeFile(manifestPath, JSON.stringify({generatedAt:new Date().toISOString(),startedAt,completed,caption:'Реальный интерфейс приложения. Данные подготовлены для документации.',safety:{frontendOnly:true,syntheticAccount:true,serviceWorkers:'blocked',mediaRequests},errors,screens},null,2)+'\n');
const record = async screen => { const index=screens.findIndex(s=>s.id===screen.id);if(index<0)screens.push(screen);else screens[index]=screen;await persist(); };
const blocked = async (id,title,section,route,message,extra={}) => { await record({id,title,section,route,...extra,description:message,source:'prepared',status:'blocked'});console.log(`BLOCKED ${id}: ${message}`); };
await mkdir(output,{recursive:true});
await blocked('camera-live','Камера — живой видеопоток','Арена','/arena/room/capture-consent','Не выполнялось: доступ к камере и микрофону запрещён для документации; поток не запрашивался.');
await blocked('camera-manual-scenario','Камера — ручной сценарий нарушения','Арена','/arena/room/capture-consent','Не выполнялось: ручное подтверждение требует активной камеры. Камера не включалась, нарушение и санкции не создавались.');
const freePort = await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const origin = `http://127.0.0.1:${freePort}`;
const vite = spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(freePort),'--strictPort'],{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
vite.stdout.on('data',d=>process.stderr.write(d));vite.stderr.on('data',d=>process.stderr.write(d));
console.log(JSON.stringify({frontend:origin,pid:vite.pid}));
let browser;
try {
  for(let i=0;i<100;i++){try{const r=await fetch(origin);if(r.ok)break;}catch{}if(vite.exitCode!==null)throw new Error('Vite exited');await new Promise(r=>setTimeout(r,150));}
  await access(chromium.executablePath());
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1400,height:1000},deviceScaleFactor:1,locale:'ru-RU',serviceWorkers:'block',permissions:[],reducedMotion:'reduce'});
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname==='/api'||url.pathname.startsWith('/api/')){
      if(url.origin===origin && req.method()==='GET' && url.pathname==='/api/me')return route.fulfill({json:{user}});
      if(url.origin===origin && req.method()==='GET' && url.pathname==='/api/leaderboard')return route.fulfill({json:{entries:Array.from({length:8},(_,i)=>({userId:`capture-player-${i}`,name:['Nova','Alex Rhythm','keystorm','Луна','Sakura','Orbit','Ada','Echo'][i],avatar:['orbit','bolt','shield','flame','crown','initials'][i%6],cpm:450-i*21,accuracy:99-i*.2,xp:8400-i*500,sessions:34-i*2})),updatedAt:new Date().toISOString()}});
      errors.push(`Blocked API: ${req.method()} ${url.pathname}`);return route.abort('blockedbyclient');
    }
    if(url.origin!==origin){errors.push(`Blocked external: ${url.origin}`);return route.abort('blockedbyclient');}
    return route.continue();
  });
  if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
  await context.addInitScript(()=>{window.__documentationMediaRequests=0;const deny=()=>{window.__documentationMediaRequests++;return Promise.reject(new DOMException('Disabled for documentation capture','NotAllowedError'));};if(navigator.mediaDevices){navigator.mediaDevices.getUserMedia=deny;navigator.mediaDevices.getDisplayMedia=deny;}navigator.getUserMedia=(_constraints,_success,error)=>{window.__documentationMediaRequests++;error?.(new DOMException('Disabled for documentation capture','NotAllowedError'));};});
  const page=await context.newPage();
  page.setDefaultTimeout(7000);page.setDefaultNavigationTimeout(20000);
  page.on('pageerror',e=>errors.push(`Page: ${e.message}`));
  const ready=async()=>{await page.locator('#main-content').waitFor();await page.waitForFunction(()=>!document.querySelector('vite-error-overlay')&&!document.querySelector('#main-content [role="status"]')?.textContent?.includes('Загружаем'));await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(180);};
  const go=async route=>{await page.goto(origin+route,{waitUntil:'networkidle'});await ready();};
  await go('/');
  await page.evaluate(async ({sessions,modes})=>{
    const {createProductState}=await import('/src/features/product/fixtures.ts');
    const {makeTask}=await import('/src/features/product/learning.ts');
    const {makeRoom}=await import('/src/features/product/arena-helpers.ts');
    const s=createProductState();s.archive=sessions;s.players[0].bio='Точность, спокойный ритм и ежедневная практика.';s.players[0].xp=6300;
    s.blocked=['p35'];
    s.invitations.push({id:'capture-outgoing',from:'me',to:'p3',kind:'room',targetId:'capture-lobby',status:'pending',expiresAt:new Date(Date.now()+86400000).toISOString()});
    const lobby=makeRoom({id:'capture-lobby',name:'Evening Rhythm',description:'Совместная практика в спокойном ритме.',access:'private',cameraCheckEnabled:false,members:[{playerId:'me',ready:true,moderator:false,team:0},{playerId:'p1',ready:true,moderator:false,team:1}],customText:'A steady rhythm helps us practice with care and focus.'});s.rooms.push(lobby);
    const camera=makeRoom({id:'capture-consent',name:'Private consent',access:'private',cameraCheckEnabled:true});s.rooms.push(camera);
    for(const [i,mode] of modes.entries())s.tasks.push(makeTask({id:`capture-task-${mode}`,mode,language:'en',seed:20261020+i,parameters:{length:180,stage:1},...(mode==='custom'?{text:'A steady rhythm helps us practice with care. Keep your eyes on the next character, breathe, and continue one small step at a time.'}:{})}));
    s.drills=sessions.slice(-6).map((r,i)=>({id:`capture-drill-${i}`,taskId:`capture-task-${r.mode}`,mode:r.mode,language:r.language,difficulty:r.difficulty,cpm:r.cpm,accuracy:r.accuracy,correct:r.correct,errors:r.errors,durationMs:r.durationMs,maxCombo:r.maxCombo,createdAt:r.createdAt,events:[]}));
    // Explicitly synthetic history; the manifest labels every frame as prepared.
    s.matches[0].source='measured';
    s.savedTexts.push({id:'capture-text',name:'Ровный ритм',text:'Точность важнее спешки. Каждый день начинается с одного небольшого шага.',createdAt:new Date().toISOString()});
    for(const category of ['rewards','system'])s.notifications.push({id:`capture-${category}`,title:category==='rewards'?'Новая цель для практики':'Настройки пространства сохранены',en:'Workspace update',category,target:'/progress',read:false,createdAt:new Date().toISOString()});
    const t=s.tournaments[1];for(const [i,status]of ['groups','finished'].entries())s.tournaments.push({...structuredClone(t),id:`capture-tournament-${status}`,name:status==='groups'?'Team Circuit':'Completed Circuit',status,rounds:t.rounds.map(r=>({...r,id:r.id+status,winner:status==='finished'?r.left:null}))});
    localStorage.setItem('umbra:product:v1:documentation-account',JSON.stringify(s));
  },{sessions,modes});
  await go('/');
  if(inspect){console.log((await page.locator('main').innerText()).slice(0,1500));console.log('INSPECT_READY');}
  else {
    await mkdir(output,{recursive:true});
    const capture=async(id,title,section,route,extra={})=>{
      try{
        if(resume&&screens.some(s=>s.id===id&&s.status==='captured')){const file=screens.find(s=>s.id===id).file;await access(path.join(root,'documentation',file));console.log(`RESUMED ${id}`);return;}
        await ready();const text=await page.locator('main').innerText();if(await page.locator('vite-error-overlay').count()||text.trim().length<100||/Задание не найдено|Раздел арены не найден|Раздел обучения не найден|Что-то пошло не так|Application error|Internal Server Error/.test(text))throw new Error('Missing, blank or error screen');
        mediaRequests+=await page.evaluate(()=>{const count=window.__documentationMediaRequests||0;window.__documentationMediaRequests=0;return count;});
        const file=`assets/screenshots/${id}.png`;await page.screenshot({path:path.join(root,'documentation',file),fullPage:true,animations:'disabled',caret:'hide'});
        const image=await readFile(path.join(root,'documentation',file));if(image.length<1000||image.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Invalid PNG');
        await record({id,title,section,route,...extra,file,description:`${title}. Подготовленный аккаунт и локальные данные; реальный интерфейс UMBRA.`,source:'prepared',status:'captured',validation:{mainTextLength:text.length,pngBytes:image.length}});console.log(`CAPTURED ${id}`);
      }catch(e){errors.push(`${id}: ${e.message}`);await blocked(id,title,section,route,String(e.message),extra);}
    };
    const scenario=async(id,title,section,route,action,extra={})=>{try{await action();await capture(id,title,section,route,extra);}catch(e){errors.push(`${id}: ${e.message}`);await blocked(id,title,section,route,String(e.message),extra);}};
    const view=async(id,title,section,route,extra={})=>scenario(id,title,section,route,()=>go(route),extra);
    const tab=async(id,title,section,route,label,scope='.product-tabs',extra={})=>scenario(id,title,section,route,()=>page.locator(scope).locator('button').filter({hasText:new RegExp('^'+label+'(?:\\s|\\d|$)')}).first().click(),{tab:label,...extra});
    await view('home','Главная','Главная','/');
    await go('/training');
    for(let i=0;i<4;i++){await page.locator('.mode-tabs').getByRole('button',{name:labels[i],exact:true}).click();await capture(`training-${modes[i]}`,`Тренажёр — ${labels[i]}`,'Тренажёр','/training',{mode:modes[i]});}
    await page.locator('.mode-tabs').getByRole('button',{name:'Код',exact:true}).click();
    for(const lang of ['javascript','python','html']){await page.getByLabel('Язык программирования',{exact:true}).selectOption(lang);await capture(`training-code-${lang}`,`Тренажёр — ${lang}`,'Тренажёр','/training',{mode:`code:${lang}`});}
    for(const [route,id,title]of [['/statistics','statistics','Статистика'],['/analytics','analytics','Аналитика'],['/account','account','Аккаунт'],['/settings','settings','Настройки'],['/guide','guide','Руководство'],['/leaderboard','leaderboard','Таблица лидеров'],['/reports','reports','Честная игра'],['/achievements','achievements-legacy','Достижения — базовый раздел']])await view(id,title,title,route);
    await go('/profile');for(const [id,label]of [['overview','Обзор'],['account','Аккаунт'],['privacy','Приватность'],['achievements','Достижения']])await tab(`profile-${id}`,`Профиль — ${label}`,'Профиль','/profile',label,'[role="tablist"]');
    await go('/progress');for(const [id,label]of [['workspace','Пространство'],['training','Базовые тренировки']])await tab(`progress-${id}`,`Достижения — ${label}`,'Достижения','/progress',label);
    await go('/players/me');for(const [id,label]of [['overview','Обзор'],['matches','Матчи'],['modes','По режимам'],['achievements','Достижения']])await tab(`player-${id}`,`Игрок — ${label}`,'Игроки','/players/me',label,'.social-tabs');
    for(const [id,route,title]of [['catalog','/learn','Режимы обучения'],['forge','/learn/generator','Кузница'],['coach','/learn/coach','Тренер'],['skills','/learn/skills','Навыки'],['plan','/learn/plan','План'],['daily','/learn/daily','Миссии'],['library','/learn/library','Библиотека']])await view(`learn-${id}`,title,'Лаборатория',route);
    await go('/learn/library');for(const label of ['Мои тексты','Снимки заданий'])await tab(`library-${label==='Мои тексты'?'texts':'tasks'}`,`Библиотека — ${label}`,'Лаборатория','/learn/library',label,'.learning-tools');
    for(let i=0;i<modes.length;i++)await view(`practice-${modes[i]}`,`Практика — ${labels[i]}`,'Лаборатория',`/learn/practice/capture-task-${modes[i]}`,{mode:modes[i]});
    for(const mode of ['story','boss'])for(const stage of [2,3]){
      await page.evaluate(async({mode,stage})=>{const {makeTask}=await import('/src/features/product/learning.ts');const key='umbra:product:v1:documentation-account',s=JSON.parse(localStorage.getItem(key));s.tasks.push(makeTask({id:`capture-task-${mode}-stage-${stage}`,mode,language:'en',difficulty:mode==='boss'&&stage===3?'hard':'medium',seed:20261020+stage,parameters:{length:180+stage*20,stage,chain:`capture-${mode}`}}));localStorage.setItem(key,JSON.stringify(s));},{mode,stage});
      await view(`practice-${mode}-stage-${stage}`,`Практика — ${mode==='story'?'История':'Босс'}, этап ${stage}`,'Лаборатория',`/learn/practice/capture-task-${mode}-stage-${stage}`,{mode,stage,fixture:'Изолированный снимок задания; прохождение предыдущего этапа не утверждается.'});
    }
    await go('/learn/generator');const forgeLabels=['Контекстная кузница','Смена языков','Двойник кода','Конструктор сложности','Тренажёр документов','Сложные сочетания','По запросу','Сюжет','Наставник по коду'];
    for(const [i,forge]of ['context','bilingual','twin','composer','document','adversarial','prompt','story','mentor'].entries()){await page.getByRole('group',{name:'Инструменты кузницы'}).getByRole('button',{name:forgeLabels[i],exact:true}).click();await capture(`forge-${forge}`,`Кузница — ${forgeLabels[i]}`,'Лаборатория','/learn/generator',{mode:forge});}
    for(const language of ['typescript','javascript','python','cpp','java','sql','html','css'])await scenario(`learn-code-${language}`,`Практика кода — ${language}`,'Лаборатория','/learn',async()=>{await go('/learn');await page.getByLabel('Язык кода',{exact:true}).selectOption(language);await page.locator('.learning-card').filter({has:page.getByRole('heading',{name:'Код',exact:true})}).getByRole('button',{name:'Начать',exact:true}).click();await page.waitForURL('**/learn/practice/**');},{mode:`code:${language}`});
    for(const [id,route,label]of [['list','/friends','Друзья'],['search','/friends/search','Поиск игроков'],['incoming','/friends/incoming','Входящие запросы'],['outgoing','/friends/outgoing','Исходящие запросы'],['invitations','/friends/invitations','Приглашения'],['blocked','/friends/blocked','Блокировки']])await view(`friends-${id}`,label,'Друзья',route);
    await go('/friends/invitations');await tab('invitations-outgoing','Исходящие приглашения','Друзья','/friends/invitations','От меня','.social-tabs');
    await view('clans','Каталог кланов','Кланы','/clans');for(const [id,label]of [['overview','Обзор'],['members','Участники'],['achievements','Достижения'],['battles','Битвы'],['manage','Управление'],['activity','Активность']])await view(`clan-${id}`,`Клан — ${label}`,'Кланы',`/clans/c1/${id}`,{tab:id});
    for(const [id,route,title]of [['rooms','/arena/rooms','Комнаты'],['create','/arena/create','Создать лобби'],['lobby','/arena/room/capture-lobby','Своё лобби'],['consent','/arena/room/capture-consent','Приватное лобби — камера выключена'],['history','/arena/history','История матчей'],['match','/arena/match/m1','Подробности матча'],['rankings','/arena/rankings','Рейтинги игроков'],['tournaments','/arena/tournaments','Турниры'],['registration','/arena/tournament/t1','Регистрация на турнир'],['playoffs','/arena/tournament/t2','Плей-офф'],['groups','/arena/tournament/capture-tournament-groups','Групповой этап'],['finished','/arena/tournament/capture-tournament-finished','Завершённый турнир']])await view(`arena-${id}`,title,'Арена',route);
    await scenario('arena-camera-consent-dialog','Камера — диалог согласия без включения','Арена','/arena/room/capture-consent',async()=>{await go('/arena/room/capture-consent');await page.getByRole('button',{name:'Включить веб-камеру',exact:true}).click();await page.getByRole('dialog').waitFor();},{tab:'Согласие',media:'Не запрашивалось'});
    await go('/arena/rankings');await page.getByLabel('Рейтинг',{exact:true}).selectOption('clans');await capture('rankings-clans','Рейтинги кланов','Арена','/arena/rankings',{tab:'Кланы'});
    // Seed only browser-local task snapshots with the app's own room/task helpers.
    for(let i=0;i<modes.length;i++){
      const mode=modes[i];await page.evaluate(async mode=>{const {makeRoom,beginRound}=await import('/src/features/product/arena-helpers.ts');const key='umbra:product:v1:documentation-account',s=JSON.parse(localStorage.getItem(key));const r=makeRoom({id:`capture-race-${mode}`,name:`Rhythm / ${mode}`,mode,access:'private',cameraCheckEnabled:false,duration:120,customText:'Practice with care, keep your focus, and let each word follow the last.',members:[{playerId:'me',ready:true,moderator:false,team:0},{playerId:'p1',ready:true,moderator:false,team:1}]});s.rooms.push(r);beginRound(s,r,Date.now()-5200);localStorage.setItem(key,JSON.stringify(s));},mode);
      await view(`arena-task-${mode}`,`Заезд — ${labels[i]}`,'Арена',`/arena/room/capture-race-${mode}`,{mode});
    }
    await go('/arena/create');for(let i=0;i<modes.length;i++){await page.getByLabel('Тип задания',{exact:true}).selectOption(modes[i]);await capture(`arena-create-${modes[i]}`,`Параметры лобби — ${labels[i]}`,'Арена','/arena/create',{mode:modes[i]});}
    await go('/notifications');await capture('notifications-all','Все уведомления','Уведомления','/notifications');
    for(const category of ['social','clans','matches','rewards','system']){await page.getByLabel('Категория',{exact:true}).selectOption(category);await capture(`notifications-${category}`,`Уведомления — ${category}`,'Уведомления','/notifications',{tab:category});}
    await go('/arena/create');for(const format of ['casual','ranked','team','friends','clan']){await page.getByLabel('Формат',{exact:true}).selectOption(format);await capture(`arena-format-${format}`,`Формат комнаты — ${format}`,'Арена','/arena/create',{mode:format});}
    await go('/analytics');for(const source of ['training','studio','match']){await page.getByLabel('Источник',{exact:true}).selectOption(source);await capture(`analytics-${source}`,`Аналитика — ${source}`,'Аналитика','/analytics',{tab:source});}await page.getByLabel('Источник',{exact:true}).selectOption('all');await page.locator('details summary').filter({hasText:'Данные графика таблицей'}).click();await capture('analytics-table','Данные аналитики таблицей','Аналитика','/analytics',{tab:'Таблица'});
    await go('/statistics');for(const summary of await page.locator('details summary').all())await summary.click();await capture('statistics-tables','Статистика — доступные таблицы','Статистика','/statistics',{tab:'Таблицы'});
    await go('/players/p1');for(const [id,label]of [['overview','Обзор'],['matches','Матчи'],['modes','По режимам'],['achievements','Достижения']])await tab(`public-player-${id}`,`Публичный игрок — ${label}`,'Игроки','/players/p1',label,'.social-tabs');
    await page.setViewportSize({width:390,height:844});for(const [id,route,title]of [['home','/','Главная'],['training','/training','Тренажёр'],['learn','/learn','Лаборатория'],['arena','/arena/rooms','Арена'],['profile','/profile','Профиль']])await view(`mobile-${id}`,`${title} — мобильный экран`,'Мобильный интерфейс',route);
    for(const screen of screens.filter(s=>s.status==='captured')){const image=await readFile(path.join(root,'documentation',screen.file));if(image.length<1000||image.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error(`Invalid captured path ${screen.file}`);}
    completed=true;await persist();
    console.log(JSON.stringify({captured:screens.filter(s=>s.status==='captured').length,blocked:screens.filter(s=>s.status==='blocked'),errors},null,2));
  }
  await context.close();
} catch(e) { errors.push(`Fatal: ${e.stack||e.message}`);process.exitCode=1;console.error(e); } finally { await persist();if(browser)await browser.close();vite.kill();console.log(JSON.stringify({cleanup:{ownedFrontendPid:vite.pid,browserClosed:true},captured:screens.filter(s=>s.status==='captured').length,blocked:screens.filter(s=>s.status==='blocked').length,completed,mediaRequests}));}
