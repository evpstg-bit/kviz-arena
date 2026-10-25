// Квиз-арена: сервер без npm-зависимостей (Node.js 18+). Запуск: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const PORT=process.env.PORT||3000,games=new Map();
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data'),INVITE=process.env.INVITE_CODE||'';
const rid=()=>crypto.randomBytes(6).toString('hex');
const str=(s,n)=>String(s??'').slice(0,n);
const same=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};

// ================= хранилище: аккаунты, сессии, личные библиотеки =================
const readJ=(f,d)=>{try{return JSON.parse(fs.readFileSync(path.join(DATA_DIR,f),'utf8'))}catch(e){return d}};
const DEFAULT_APP_SETTINGS={
  version:1,
  general:{defaultQuestionTime:20,maxPlayers:100,supportThreshold:60,autoOpenReports:true,showCorrectAnswerAfterQuestion:true},
  modes:{
    classic:{enabled:true,basePoints:1000,speedBonus:true},
    kingdoms:{enabled:true,durationMinutes:5,correctAnswersForFlag:3}
  }
};
const clampInt=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Math.round(Number(value)))):fallback;
function normalizeAppSettings(value){
  const v=value&&typeof value==='object'?value:{};
  const g=v.general&&typeof v.general==='object'?v.general:{};
  const m=v.modes&&typeof v.modes==='object'?v.modes:{};
  const c=m.classic&&typeof m.classic==='object'?m.classic:{};
  const k=m.kingdoms&&typeof m.kingdoms==='object'?m.kingdoms:{};
  return{version:1,general:{
    defaultQuestionTime:clampInt(g.defaultQuestionTime,5,120,20),
    maxPlayers:clampInt(g.maxPlayers,2,100,100),
    supportThreshold:clampInt(g.supportThreshold,0,100,60),
    autoOpenReports:g.autoOpenReports!==false,
    showCorrectAnswerAfterQuestion:g.showCorrectAnswerAfterQuestion!==false
  },modes:{
    classic:{enabled:c.enabled!==false,basePoints:clampInt(c.basePoints,100,3000,1000),speedBonus:c.speedBonus!==false},
    kingdoms:{enabled:k.enabled!==false,durationMinutes:clampInt(k.durationMinutes,5,20,5),correctAnswersForFlag:clampInt(k.correctAnswersForFlag,1,5,3)}
  }};
}
function readAppSettingsFile(){try{return normalizeAppSettings(JSON.parse(fs.readFileSync(path.join(__dirname,'app-settings.json'),'utf8')))}catch(e){return normalizeAppSettings(DEFAULT_APP_SETTINGS)}}
function writeAppSettingsFile(value){
  try{const file=path.join(__dirname,'app-settings.json'),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(normalizeAppSettings(value),null,2)+'\n','utf8');fs.renameSync(tmp,file);return true}
  catch(e){console.error('Не удалось записать app-settings.json:',e.message);return false}
}
let APP_SETTINGS=readAppSettingsFile();
function writeJ(f,v){
  try{fs.mkdirSync(DATA_DIR,{recursive:true});const p=path.join(DATA_DIR,f),t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(v));fs.renameSync(t,p);return true}
  catch(e){console.error('Не удалось записать',f+':',e.message);return false}
}
let USERS=readJ('users.json',[]),SESS=readJ('sessions.json',{}),BUILTINQ=[];
const hashPw=(pw,salt)=>crypto.scryptSync(String(pw),salt,32).toString('hex');
const checkPw=(u,pw)=>{try{return crypto.timingSafeEqual(Buffer.from(hashPw(pw,u.salt),'hex'),Buffer.from(u.hash,'hex'))}catch(e){return false}};
const pubUser=u=>({login:u.login,name:u.name,admin:!!u.admin});

// Постоянный администратор берётся из файла проекта, а не из временной папки DATA_DIR.
// Подписанная сессия этого аккаунта остаётся действительной после перезапуска Render.
function readAdminConfig(){
  try{
    const c=JSON.parse(fs.readFileSync(path.join(__dirname,'admin-credentials.json'),'utf8'));
    const login=String(c.login||'').trim(),password=String(c.password||'');
    if(!login||!password)throw new Error('нужны непустые login и password');
    return{login,password,name:String(c.name||login).slice(0,40)};
  }catch(e){console.error('Не удалось загрузить admin-credentials.json:',e.message);return null}
}
const ADMIN_CONFIG=readAdminConfig();
const ADMIN_ID=ADMIN_CONFIG?'config-admin-'+crypto.createHash('sha256').update(ADMIN_CONFIG.login.toLowerCase()).digest('hex').slice(0,12):null;
const ADMIN_SECRET=ADMIN_CONFIG?crypto.createHash('sha256').update('kviz-arena-config-admin-v1\0'+ADMIN_CONFIG.login+'\0'+ADMIN_CONFIG.password).digest():null;
let CONFIG_ADMIN=null;
if(ADMIN_CONFIG){
  const old=USERS.find(x=>String(x.login||'').toLowerCase()===ADMIN_CONFIG.login.toLowerCase());
  const salt=crypto.randomBytes(16).toString('hex');
  CONFIG_ADMIN={id:ADMIN_ID,login:ADMIN_CONFIG.login,name:ADMIN_CONFIG.name,salt,hash:hashPw(ADMIN_CONFIG.password,salt),admin:true,created:old&&old.created||Date.now(),configManaged:true};
  if(old&&old.id!==ADMIN_ID)Object.values(SESS).forEach(x=>{if(x.uid===old.id)x.uid=ADMIN_ID});
  USERS=USERS.filter(x=>String(x.login||'').toLowerCase()!==ADMIN_CONFIG.login.toLowerCase());
  USERS.push(CONFIG_ADMIN);
  if(old&&old.id!==ADMIN_ID)writeJ('sessions.json',SESS);
}
function configuredUserFromToken(t){
  if(!CONFIG_ADMIN||!ADMIN_SECRET||typeof t!=='string')return null;
  const m=/^cfg\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(t);if(!m)return null;
  try{
    const expected=crypto.createHmac('sha256',ADMIN_SECRET).update(m[1]).digest();
    const actual=Buffer.from(m[2],'base64url');
    if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;
    const p=JSON.parse(Buffer.from(m[1],'base64url').toString('utf8'));
    return p.uid===CONFIG_ADMIN.id&&Number(p.exp)>Date.now()?CONFIG_ADMIN:null;
  }catch(e){return null}
}
function userOf(t){
  const configured=configuredUserFromToken(t);if(configured)return configured;
  const s=t&&SESS[t];if(!s)return null;if(s.exp<Date.now()){delete SESS[t];return null}return USERS.find(u=>u.id===s.uid)||null;
}
function newSession(u){
  if(u&&u.configManaged){
    const payload=Buffer.from(JSON.stringify({uid:u.id,exp:Date.now()+60*864e5})).toString('base64url');
    const sig=crypto.createHmac('sha256',ADMIN_SECRET).update(payload).digest('base64url');
    return 'cfg.'+payload+'.'+sig;
  }
  const t=crypto.randomBytes(24).toString('hex');SESS[t]={uid:u.id,exp:Date.now()+60*864e5};
  const mine=Object.keys(SESS).filter(k=>SESS[k].uid===u.id);if(mine.length>20)mine.slice(0,mine.length-20).forEach(k=>delete SESS[k]);
  writeJ('sessions.json',SESS);return t;
}
const FAILS=new Map();

// командная строка: node server.js --users | --reset-password ЛОГИН НОВЫЙ_ПАРОЛЬ
if(process.argv[2]==='--users'){console.log(USERS.length?USERS.map(u=>u.login+(u.admin?' (администратор)':'')).join('\n'):'Аккаунтов пока нет.');process.exit(0)}
if(process.argv[2]==='--reset-password'){
  const u=USERS.find(x=>x.login.toLowerCase()===String(process.argv[3]).toLowerCase()),np=process.argv[4]||'';
  if(u&&u.configManaged){console.log('Этот аккаунт управляется файлом admin-credentials.json. Измените пароль в этом файле и повторно разверните проект.');process.exit(1)}
  if(!u||np.length<6){console.log('Использование: node server.js --reset-password ЛОГИН НОВЫЙ_ПАРОЛЬ  (пароль не короче 6 символов)\nСписок логинов: node server.js --users');process.exit(1)}
  u.salt=crypto.randomBytes(16).toString('hex');u.hash=hashPw(np,u.salt);Object.keys(SESS).forEach(k=>{if(SESS[k].uid===u.id)delete SESS[k]});
  writeJ('users.json',USERS);writeJ('sessions.json',SESS);console.log('Пароль пользователя «'+u.login+'» изменён.');process.exit(0);
}

function cleanQuiz(z){
  const q=(Array.isArray(z.q)?z.q:[]).slice(0,100).map(x=>{
    const a=(Array.isArray(x.a)?x.a:[]).slice(0,4).map(t=>str(t,150)),T=+x.T;
    const cs=[...new Set((Array.isArray(x.cs)?x.cs:[]).map(Number))].filter(n=>Number.isInteger(n)&&n>=0&&n<4).sort((p,r)=>p-r);
    return{t:str(x.t,300),a,cs,T:T>=5?Math.min(240,T):undefined};
  });
  return{title:str(z.title,80).trim()||'Без названия',T:Math.min(120,Math.max(5,+z.T||20)),mode:z.mode==='kingdoms'?'kingdoms':z.mode==='classic'?'classic':'choose',
    dur:Math.min(20,Math.max(5,Math.round(+z.dur)||5)),need:Math.min(5,Math.max(1,Math.round(+z.need)||3)),q};
}
function parseQuiz(z){
  if(!z||!Array.isArray(z.q)||!z.q.length||z.q.length>100)return null;
  const c=cleanQuiz(z);
  c.q=c.q.map(x=>({...x,t:x.t.trim(),a:x.a.map(s=>s.trim()),T:x.T||c.T}));
  if(!c.q.every(x=>x.t&&x.a.length>=2&&x.a.every(Boolean)&&x.cs.length>=1&&x.cs.every(i=>i<x.a.length)))return null;
  return c;
}

// Тесты проекта читаются из отслеживаемых Git-файлов, не из DATA_DIR.
// Поэтому их можно зафиксировать commit/push и они останутся после рестарта Render.
function loadProjectQuizFile(filename,prefix,source){
  const file=path.join(__dirname,filename);
  try{
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    const items=Array.isArray(raw)?raw:(Array.isArray(raw.items)?raw.items:[]);
    const result=[];
    for(let i=0;i<items.length;i++){
      try{
        const item=items[i],quiz=parseQuiz(item&&item.quiz?item.quiz:item);
        if(!quiz){console.warn('Пропущен тест №'+(i+1)+' в '+filename+': проверьте формат и вопросы');continue}
        const rawId=String(item&&item.id||prefix+'-'+(i+1));
        const id=/^[A-Za-z0-9_-]{1,80}$/.test(rawId)?rawId:prefix+'-'+(i+1);
        result.push({id,quiz,folderId:String(item&&item.folderId||''),builtin:true,source});
      }catch(e){console.warn('Пропущен тест №'+(i+1)+' в '+filename+': '+e.message)}
    }
    console.log(filename+': загружено тестов '+result.length);
    return result;
  }catch(e){
    console.error('Не удалось прочитать '+filename+':',e.message);
    return [];
  }
}
function loadProjectQuizzes(){
  return loadProjectQuizFile('builtin-tests.json','builtin','builtin');
}
BUILTINQ=loadProjectQuizzes();
let REPORTS=readJ('reports.json',[]);if(!Array.isArray(REPORTS))REPORTS=[];

// Файл проекта хранит папки и тесты вместе, чтобы они синхронизировались одним GitHub-коммитом.
function normalizeFolders(folders){
  const out=[],ids=new Set(),names=new Set();
  (Array.isArray(folders)?folders:[]).forEach((f,i)=>{
    if(!f||typeof f!=='object')return;
    let id=String(f.id||'folder-'+(i+1)).slice(0,80);
    const name=str(f.name,64).trim();
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||ids.has(id)||!name||names.has(name.toLocaleLowerCase()))return;
    ids.add(id);names.add(name.toLocaleLowerCase());out.push({id,name,createdAt:Number(f.createdAt)||Date.now(),updatedAt:Number(f.updatedAt)||Date.now()});
  });
  return out;
}
function readBuiltinDocument(){
  try{
    const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'builtin-tests.json'),'utf8'));
    const items=Array.isArray(raw)?raw:(Array.isArray(raw.items)?raw.items:[]);
    const folders=normalizeFolders(raw&&raw.folders),validFolders=new Set(folders.map(f=>f.id)),normalizedItems=normalizeBuiltinItems(items);normalizedItems.forEach(item=>{if(item.folderId&&!validFolders.has(item.folderId))item.folderId=''});return{app:'kviz-arena',version:3,folders,items:normalizedItems};
  }catch(e){return{app:'kviz-arena',version:3,folders:[],items:[]}}
}
function normalizeBuiltinItems(items){
  const out=[],ids=new Set();
  (Array.isArray(items)?items:[]).forEach((item,index)=>{
    const quiz=parseQuiz(item&&item.quiz?item.quiz:item);if(!quiz)return;
    let id=String(item&&item.id||'builtin-'+(index+1)).slice(0,80);
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||ids.has(id)){id='test-'+rid();while(ids.has(id))id='test-'+rid()}
    ids.add(id);const folderId=String(item&&item.folderId||'');
    out.push({id,quiz,folderId:/^[A-Za-z0-9_-]{1,80}$/.test(folderId)?folderId:''});
  });
  return out;
}
function builtinQuizzesFromItems(items){
  return normalizeBuiltinItems(items).map(x=>({id:x.id,quiz:x.quiz,folderId:x.folderId,builtin:true,source:'builtin'}));
}
function writeBuiltinDocument(items,folders){
  const previous=readBuiltinDocument();
  const doc={app:'kviz-arena',version:3,folders:normalizeFolders(folders===undefined?previous.folders:folders),items:normalizeBuiltinItems(items)};
  // Degraded/legacy data that refers to a missing folder is moved to the root.
  const folderIds=new Set(doc.folders.map(f=>f.id));doc.items.forEach(x=>{if(x.folderId&&!folderIds.has(x.folderId))x.folderId=''});
  const file=path.join(__dirname,'builtin-tests.json'),tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(doc,null,2)+'\n','utf8');fs.renameSync(tmp,file);
  BUILTINQ=loadProjectQuizzes();
  return doc;
}
const githubConfig=()=>{
  const token=String(process.env.GITHUB_TOKEN||'').trim(),repo=String(process.env.GITHUB_REPOSITORY||'').trim(),branch=String(process.env.GITHUB_BRANCH||'main').trim();
  return token&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)?{token,repo,branch}:null;
};
async function githubReadAppSettings(cfg){
  const url='https://api.github.com/repos/'+cfg.repo+'/contents/app-settings.json?ref='+encodeURIComponent(cfg.branch);
  const r=await fetch(url,{headers:{Authorization:'Bearer '+cfg.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'kviz-arena'}});
  if(r.status===404)return{sha:null,settings:readAppSettingsFile(),exists:false};
  if(!r.ok)throw new Error('Не удалось прочитать app-settings.json из GitHub (HTTP '+r.status+'). Проверьте GITHUB_TOKEN, репозиторий, ветку и Contents: read/write.');
  const data=await r.json();if(!data.content)throw new Error('GitHub вернул пустой app-settings.json');
  let parsed;try{parsed=JSON.parse(Buffer.from(String(data.content).replace(/\s/g,''),'base64').toString('utf8'))}catch(e){throw new Error('В GitHub находится некорректный app-settings.json')}
  return{sha:data.sha,settings:normalizeAppSettings(parsed),exists:true};
}
async function githubWriteAppSettings(cfg,sha,settings,message){
  const url='https://api.github.com/repos/'+cfg.repo+'/contents/app-settings.json';
  const body={message,content:Buffer.from(JSON.stringify(normalizeAppSettings(settings),null,2)+'\n','utf8').toString('base64'),branch:cfg.branch};if(sha)body.sha=sha;
  return fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+cfg.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'kviz-arena','Content-Type':'application/json'},body:JSON.stringify(body)});
}
// Hydrate global settings from GitHub once per process before the UI or a new game relies on local defaults.
let APP_SETTINGS_HYDRATED=false,APP_SETTINGS_HYDRATION=null;
async function hydrateAppSettingsFromGitHub(){
  const cfg=githubConfig();if(!cfg||APP_SETTINGS_HYDRATED)return;
  if(!APP_SETTINGS_HYDRATION){
    APP_SETTINGS_HYDRATION=(async()=>{
      const remote=await githubReadAppSettings(cfg);
      APP_SETTINGS=remote.settings;
      if(remote.exists)writeAppSettingsFile(APP_SETTINGS);
      APP_SETTINGS_HYDRATED=true;
    })().catch(e=>{console.warn('Не удалось загрузить настройки из GitHub; используется локальный app-settings.json:',e.message)}).finally(()=>{APP_SETTINGS_HYDRATION=null});
  }
  await APP_SETTINGS_HYDRATION;
}

async function githubReadBuiltin(cfg){
  const url='https://api.github.com/repos/'+cfg.repo+'/contents/builtin-tests.json?ref='+encodeURIComponent(cfg.branch);
  const r=await fetch(url,{headers:{Authorization:'Bearer '+cfg.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'kviz-arena'}});
  if(r.status===404){const local=readBuiltinDocument();return{sha:null,items:local.items,folders:local.folders}}
  if(!r.ok)throw new Error('GitHub не смог прочитать builtin-tests.json (HTTP '+r.status+'). Проверьте GITHUB_TOKEN, репозиторий, ветку и разрешение Contents: read/write.');
  const data=await r.json();
  if(!data.content)throw new Error('GitHub вернул пустой файл builtin-tests.json');
  let raw;try{raw=JSON.parse(Buffer.from(String(data.content).replace(/\s/g,''),'base64').toString('utf8'))}catch(e){throw new Error('В GitHub находится некорректный builtin-tests.json')}
  const items=Array.isArray(raw)?raw:(Array.isArray(raw.items)?raw.items:[]);
  const folders=normalizeFolders(raw&&raw.folders),validFolders=new Set(folders.map(f=>f.id)),normalizedItems=normalizeBuiltinItems(items);normalizedItems.forEach(item=>{if(item.folderId&&!validFolders.has(item.folderId))item.folderId=''});return{sha:data.sha,items:normalizedItems,folders};
}
async function githubWriteBuiltin(cfg,sha,items,folders,message){
  const url='https://api.github.com/repos/'+cfg.repo+'/contents/builtin-tests.json';
  const folderList=normalizeFolders(folders),folderIds=new Set(folderList.map(f=>f.id));
  const itemList=normalizeBuiltinItems(items);itemList.forEach(x=>{if(x.folderId&&!folderIds.has(x.folderId))x.folderId=''});
  const doc={app:'kviz-arena',version:3,folders:folderList,items:itemList};
  const body={message,content:Buffer.from(JSON.stringify(doc,null,2)+'\n','utf8').toString('base64'),branch:cfg.branch};
  if(sha)body.sha=sha;
  return fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+cfg.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'kviz-arena','Content-Type':'application/json'},body:JSON.stringify(body)});
}
async function mutateBuiltinDocument(mutator,message){
  const cfg=githubConfig();
  if(cfg){
    for(let attempt=0;attempt<3;attempt++){
      const remote=await githubReadBuiltin(cfg),out=mutator({items:remote.items.map(x=>({...x,quiz:x.quiz})),folders:remote.folders.map(x=>({...x}))});
      if(out.noChange)return{persistedToGitHub:true,itemCount:remote.items.length,folderCount:remote.folders.length,...(out.data||{})};
      const nextItems=normalizeBuiltinItems(out.items===undefined?remote.items:out.items),nextFolders=normalizeFolders(out.folders===undefined?remote.folders:out.folders);
      const wr=await githubWriteBuiltin(cfg,remote.sha,nextItems,nextFolders,message);
      if((wr.status===409||wr.status===422)&&attempt<2)continue;
      if(!wr.ok){const detail=await wr.text().catch(()=> '');throw new Error('Не удалось сохранить библиотеку в GitHub (HTTP '+wr.status+'). '+detail.slice(0,220))}
      try{writeBuiltinDocument(nextItems,nextFolders)}catch(e){BUILTINQ=builtinQuizzesFromItems(nextItems);console.warn('GitHub файл обновлён, но локальную копию не удалось записать:',e.message)}
      return{persistedToGitHub:true,itemCount:nextItems.length,folderCount:nextFolders.length,...(out.data||{})};
    }
    throw new Error('Файл изменился одновременно в GitHub. Повторите операцию.');
  }
  const local=readBuiltinDocument(),out=mutator({items:local.items.map(x=>({...x})),folders:local.folders.map(x=>({...x}))});
  if(out.noChange)return{persistedToGitHub:false,itemCount:local.items.length,folderCount:local.folders.length,...(out.data||{})};
  const doc=writeBuiltinDocument(out.items===undefined?local.items:out.items,out.folders===undefined?local.folders:out.folders);
  return{persistedToGitHub:false,itemCount:doc.items.length,folderCount:doc.folders.length,...(out.data||{})};
}
// Mutations that only affect tests retain the current folder tree.
async function mutateBuiltinItems(mutator,message){
  return mutateBuiltinDocument(doc=>{const out=mutator(doc.items);return{...out,items:out.items===undefined?doc.items:out.items,folders:doc.folders}},message);
}
// ================= игры =================
const ranked=g=>[...g.players.entries()].map(([id,p])=>({id,...p})).sort((a,b)=>b.score-a.score);
const playerOnline=(g,id)=>[...g.clients].some(c=>c.id===id);
function newPlayer(g,name){
  const p={name,score:0,lastQ:-1,lastA:[],lastPts:0,log:[]};
  if(g.mode==='kingdoms'){
    Object.assign(p,{team:0,prog:0,flags:0,placed:0,correctN:0,answeredN:0,qn:0,fb:null,queue:[],qi:0,cur:0});
    if(g.kb){const c=[0,1].map(t=>[...g.players.values()].filter(x=>x.team===t).length);p.team=c[0]<c[1]?0:c[1]<c[0]?1:Math.round(Math.random());initQ(g,p)}
  }
  return p;
}
function removePlayer(g,id,msg){
  const p=g.players.get(id);if(!p)return;
  g.left.push({id,name:p.name,score:p.score,team:p.team,placed:p.placed,correctN:p.correctN,answeredN:p.answeredN,log:Array.isArray(p.log)?p.log.map(l=>({...l,a:Array.isArray(l.a)?[...l.a]:[]})):[]});
  g.players.delete(id);
  [...g.clients].filter(c=>c.id===id).forEach(c=>{if(msg)safeSseWrite(g,c,msg);try{if(!c.res.destroyed&&!c.res.writableEnded)c.res.end()}catch(e){}g.clients.delete(c)});
  if(g.state==='question'&&g.players.size&&[...g.players.values()].every(x=>x.lastQ===g.qi))toResults(g);else push(g);
}

// Build an immutable teacher report from the completed game. Reports are private to the owner.
function makeGameReport(g,{incomplete=false}={}){
  const roster=[...g.players.entries()].map(([id,p])=>({id,...p,removed:false})).concat((g.left||[]).map(p=>({...p,removed:true,log:Array.isArray(p.log)?p.log:[]})));
  const questions=(g.quiz.q||[]).map((q,qi)=>{
    const attempts=[];const respondents=new Set();
    roster.forEach(p=>(p.log||[]).forEach(l=>{if(Number(l.qi)===qi){attempts.push({name:p.name,playerId:p.id||'',ok:!!l.ok,answers:Array.isArray(l.a)?l.a:[],points:Number(l.pts)||0,ms:Number(l.ms)||0});respondents.add(p.id||p.name)}}));
    const answerCounts=q.a.map((text,ai)=>({index:ai,text,count:attempts.reduce((n,l)=>n+(l.answers.includes(ai)?1:0),0),correct:(q.cs||[]).includes(ai)}));
    const correctCount=attempts.filter(a=>a.ok).length,incorrectCount=attempts.length-correctCount;
    const groupAccuracy=roster.length?Math.round(correctCount/roster.length*1000)/10:0;
    const belowGroupThreshold=roster.length>0&&(correctCount/roster.length)<0.4;
    return{index:qi+1,t:q.t,a:[...q.a],correct:[...q.cs],correctText:q.cs.map(i=>q.a[i]),responseCount:attempts.length,respondentCount:respondents.size,correctCount,incorrectCount,accuracy:attempts.length?Math.round(correctCount/attempts.length*100):0,groupAccuracy,belowGroupThreshold,answerCounts,attempts};
  });
  const participants=roster.map(p=>{
    const logs=Array.isArray(p.log)?p.log:[],correctCount=logs.filter(l=>l.ok).length,incorrectCount=logs.length-correctCount;
    const uniqueQuestions=new Set(logs.map(l=>Number(l.qi))).size;
    const classicUnanswered=g.mode==='classic'?Math.max(0,questions.length-uniqueQuestions):null;
    return{id:p.id||'',name:String(p.name||'Участник'),score:Number(p.score)||0,team:Number.isInteger(p.team)?p.team:null,placed:Number(p.placed)||0,correctCount,incorrectCount,answeredCount:logs.length,unansweredCount:classicUnanswered,accuracy:logs.length?Math.round(correctCount/logs.length*100):0,removed:!!p.removed,log:logs.map(l=>({qi:Number(l.qi),a:Array.isArray(l.a)?[...l.a]:[],ok:!!l.ok,pts:Number(l.pts)||0,ms:Number(l.ms)||0}))};
  }).sort((a,b)=>g.mode==='kingdoms'?(b.placed-a.placed||b.correctCount-a.correctCount||a.name.localeCompare(b.name)):(b.score-a.score||b.correctCount-a.correctCount||a.name.localeCompare(b.name)));
  participants.forEach((p,i)=>p.rank=i+1);
  const totalAnswers=questions.reduce((n,q)=>n+q.responseCount,0),totalCorrect=questions.reduce((n,q)=>n+q.correctCount,0),totalIncorrect=questions.reduce((n,q)=>n+q.incorrectCount,0);
  const totalPossible=g.mode==='classic'?participants.length*questions.length:null;
  const teamKeys=[...new Set(participants.map(p=>p.team).filter(Number.isInteger))].sort((a,b)=>a-b);
  const teams=teamKeys.map(k=>{const members=participants.filter(p=>p.team===k),tiles=g.kb&&g.kb.board?g.kb.board.filter(x=>x===k).length:0,answers=members.reduce((n,p)=>n+p.answeredCount,0),correctCount=members.reduce((n,p)=>n+p.correctCount,0);return{k,name:k===0?'Красные':'Синие',members:members.length,points:members.reduce((n,p)=>n+p.score,0),correctCount,incorrectCount:members.reduce((n,p)=>n+p.incorrectCount,0),answers,accuracy:answers?Math.round(correctCount/answers*100):0,flags:members.reduce((n,p)=>n+p.placed,0),tiles,trophies:g.kb&&g.kb.trophies?Number(g.kb.trophies[k])||0:0};});
  const accuracies=participants.filter(p=>p.answeredCount>0).map(p=>p.accuracy);
  return{id:'report-'+g.pin+'-'+Date.now().toString(36)+'-'+rid(),pin:g.pin,sourceId:g.sourceId||'',ownerId:g.owner,title:g.quiz.title,mode:g.mode,modeName:g.mode==='kingdoms'?'Color Kingdoms':'Classic',supportThreshold:((g.appSettings||APP_SETTINGS).general.supportThreshold),completedAt:Date.now(),incomplete:!!incomplete,questionCount:questions.length,participantCount:participants.length,questions,participants,teams,summary:{participantCount:participants.length,questionCount:questions.length,totalAnswers,totalCorrect,totalIncorrect,accuracy:totalAnswers?Math.round(totalCorrect/totalAnswers*100):0,averageScore:participants.length?Math.round(participants.reduce((n,p)=>n+p.score,0)/participants.length):0,averageParticipantAccuracy:accuracies.length?Math.round(accuracies.reduce((a,b)=>a+b,0)/accuracies.length):0,unanswered:g.mode==='classic'?Math.max(0,(totalPossible||0)-totalAnswers):null,completionRate:g.mode==='classic'&&totalPossible?Math.round(totalAnswers/totalPossible*100):null,playedSeconds:Math.max(0,Math.round((Date.now()-(g.born||Date.now()))/1000)),winner:g.kb?g.kb.winner:null}};
}
function saveGameReport(g,options={}){
  if(g.reportId)return g.reportId;
  const report=makeGameReport(g,options);g.reportId=report.id;g.report=report;REPORTS=[report,...REPORTS].slice(0,500);
  if(!writeJ('reports.json',REPORTS))console.warn('Отчёт сохранён только в памяти процесса: не удалось записать data/reports.json');
  return report.id;
}

// ---- Classic ----
function view(g,id,R0){
  const R=R0||ranked(g),host=id===g.hostId,q=g.quiz.q[g.qi];
  const v={state:g.state,pin:g.pin,qi:g.qi,total:g.quiz.q.length,title:g.quiz.title,T:q.T,mode:g.mode,locked:!!g.locked,dur:g.quiz.dur,need:g.quiz.need,
    elapsed:Date.now()-g.qStart,host,top:R.slice(0,5).map(p=>({name:p.name,score:p.score}))};
  if(host&&g.reportId)v.reportId=g.reportId;
  if(g.state==='question'||g.state==='results')v.q=host?{t:q.t,a:q.a,multi:q.cs.length>1}:{n:q.a.length,t:q.t,multi:q.cs.length>1};
  if(g.state==='results'&&(host||(g.appSettings||APP_SETTINGS).general.showCorrectAnswerAfterQuestion))v.correct=q.cs;
  if(host){
    v.names=R.map(p=>p.name);
    v.rows=R.map(p=>{
      const an=p.lastQ===g.qi,answeredN=(p.log||[]).length,correctN=(p.log||[]).reduce((n,l)=>n+(l.ok?1:0),0);
      const r={id:p.id,name:p.name,score:p.score,ans:an,team:Number.isInteger(p.team)?p.team:null,online:playerOnline(g,p.id),answeredN,correctN,accuracy:answeredN?Math.round(correctN/answeredN*100):0};
      if(g.state==='results'&&an){r.ok=same(p.lastA,q.cs);r.pts=p.lastPts}
      return r;
    });
    v.answered=R.filter(p=>p.lastQ===g.qi).length;
    v.totalAnswered=R.reduce((n,p)=>n+(p.log||[]).length,0);
    v.totalCorrect=R.reduce((n,p)=>n+(p.log||[]).filter(l=>l.ok).length,0);
    v.online=R.filter(p=>playerOnline(g,p.id)).length;
    if(g.state==='results'){v.counts=[0,0,0,0];R.forEach(p=>{if(p.lastQ===g.qi)p.lastA.forEach(x=>v.counts[x]++)})}
  }else{
    const p=g.players.get(id);
    if(p)v.me={name:p.name,score:p.score,answered:p.lastQ===g.qi,pts:p.lastQ===g.qi?p.lastPts:0,rank:R.findIndex(x=>x.id===id)+1,ok:g.state==='results'&&p.lastQ===g.qi&&same(p.lastA,q.cs)};
  }
  return v;
}
function startQ(g){
  g.state='question';g.qStart=Date.now();clearTimeout(g.timer);
  g.timer=setTimeout(()=>toResults(g),g.quiz.q[g.qi].T*1000+500);push(g);
}
function toResults(g){if(g.state!=='question')return;clearTimeout(g.timer);g.state='results';push(g)}

// ---- Color Kingdoms (две команды, темп у каждого свой) ----
const adjN=(i,N)=>{const x=i%N,y=(i-x)/N,r=[];if(x>0)r.push(i-1);if(x<N-1)r.push(i+1);if(y>0)r.push(i-N);if(y<N-1)r.push(i+N);return r};
function resetBoard(kb){
  const N=kb.N,R=N-1-Math.round(N/4),r=Math.round(N/4);
  kb.board=Array(N*N).fill(-1);
  [[r,r,1],[R,R,-1]].forEach(([y,x,d],t)=>{[[y,x],[y,x+d],[y+d,x]].forEach(([yy,xx])=>kb.board[yy*N+xx]=t)});
  kb.rooks=[r*N+r,R*N+R];kb.hot=[];
}
function initQ(g,p){p.queue=shuffle(g.quiz.q.map((_,i)=>i));p.qi=0;p.cur=p.queue[0]}
function nextQ(g,p){
  p.qi++;
  if(p.qi>=p.queue.length){const last=p.cur;p.queue=shuffle(g.quiz.q.map((_,i)=>i));if(p.queue.length>1&&p.queue[0]===last)p.queue.push(p.queue.shift());p.qi=0}
  p.cur=p.queue[p.qi];
}
function startK(g){
  const ids=shuffle([...g.players.keys()]);ids.forEach((id,i)=>{const p=g.players.get(id);p.team=i%2;initQ(g,p)});
  const n=ids.length,N=n<=10?9:n<=20?11:n<=35?15:n<=60?17:19;
  const kb=g.kb={N,round:1,trophies:[0,0],need:g.quiz.need,dur:g.quiz.dur*60000,banner:null,winner:null};
  resetBoard(kb);kb.endsAt=Date.now()+kb.dur;g.state='playing';clearTimeout(g.timer);g.timer=setTimeout(()=>finishK(g),kb.dur+200);push(g);
}
function finishK(g){
  if(g.state!=='playing')return;clearTimeout(g.timer);const kb=g.kb,t=[0,1].map(k=>kb.board.filter(o=>o===k).length);
  if(t[0]!==t[1])kb.trophies[t[0]>t[1]?0:1]++;           // время вышло: у кого больше клеток — тот берёт трофей
  kb.winner=kb.trophies[0]!==kb.trophies[1]?(kb.trophies[0]>kb.trophies[1]?0:1):(t[0]!==t[1]?(t[0]>t[1]?0:1):-1);
  g.state='final';saveGameReport(g);push(g);
}
const validTiles=(kb,team)=>{const r=[];for(let i=0;i<kb.board.length;i++)if(kb.board[i]!==team&&!kb.rooks.includes(i)&&adjN(i,kb.N).some(j=>kb.board[j]===team))r.push(i);return r};
function enclose(kb,team){ // клетки, полностью окружённые территорией команды (край поля не считается стеной)
  const N=kb.N,b=kb.board,seen=new Uint8Array(N*N),st=[],add=i=>{if(b[i]!==team&&!seen[i]){seen[i]=1;st.push(i)}};
  for(let k=0;k<N;k++){add(k);add((N-1)*N+k);add(k*N);add(k*N+N-1)}
  while(st.length){const i=st.pop();adjN(i,N).forEach(add)}
  const out=[];for(let i=0;i<N*N;i++)if(b[i]!==team&&!seen[i])out.push(i);return out;
}
function placeK(g,p,tile){
  const kb=g.kb;tile=Number(tile);
  if(!(p.flags>0)||!Number.isInteger(tile)||!validTiles(kb,p.team).includes(tile))return false;
  kb.board[tile]=p.team;p.flags--;p.placed++;
  const caught=enclose(kb,p.team);caught.forEach(i=>{kb.board[i]=p.team});kb.hot=[tile,...caught];
  if(caught.includes(kb.rooks[1-p.team])){kb.trophies[p.team]++;kb.banner={team:p.team,at:Date.now()};kb.round++;resetBoard(kb)}
  return true;
}
function answerK(g,p,b){
  const qq=g.quiz.q[p.cur],sel=[...new Set([].concat(b.a).map(Number))].filter(Number.isInteger).sort((x,y)=>x-y);
  if(Number(b.qn)!==p.qn||!sel.length||!sel.every(x=>x>=0&&x<qq.a.length))return false;
  const ok=same(sel,qq.cs);p.answeredN++;
  if(ok){p.correctN++;p.prog++;if(p.prog>=g.kb.need){p.prog=0;p.flags++}}
  if(p.log.length<1000)p.log.push({qi:p.cur,a:sel,ok});
  p.lastAnswerOk=ok;p.lastAnswerAt=Date.now();p.fb={id:p.qn,ok,correct:qq.cs,ans:qq.cs.map(i=>qq.a[i])};p.qn++;nextQ(g,p);return true;
}
function commonK(g,R){
  const kb=g.kb,now=Date.now();
  const stats=[0,1].map(t=>{const m=R.filter(p=>p.team===t);return{k:t,tiles:kb.board.filter(o=>o===t).length,members:m.length,trophies:kb.trophies[t],correct:m.reduce((s,p)=>s+p.correctN,0),flags:m.reduce((s,p)=>s+p.placed,0)}});
  return{state:g.state,mode:'kingdoms',pin:g.pin,title:g.quiz.title,N:kb.N,board:kb.board,rooks:kb.rooks,hot:kb.hot,round:kb.round,need:kb.need,dur:kb.dur,reportId:g.reportId||null,
    left:g.state==='playing'?Math.max(0,kb.endsAt-now):0,stats,winner:kb.winner,locked:!!g.locked,total:g.quiz.q.length,
    banner:kb.banner&&now-kb.banner.at<4500?{team:kb.banner.team,age:now-kb.banner.at,n:kb.round}:null,
    top:R.slice().sort((a,b)=>b.placed-a.placed||b.correctN-a.correctN).slice(0,8).map(p=>({name:p.name,team:p.team,placed:p.placed,correct:p.correctN}))};
}
function viewK(g,id,C){
  const host=id===g.hostId,v={...C,host};
  if(host)v.rows=[...g.players.entries()].map(([i,p])=>({
    id:i,name:p.name,team:p.team,placed:p.placed,flags:p.placed||0,score:p.score||0,
    correct:p.correctN||0,correctN:p.correctN||0,answered:p.answeredN||0,answeredN:p.answeredN||0,
    accuracy:p.answeredN?Math.round((p.correctN||0)/p.answeredN*100):0,
    online:playerOnline(g,i),lastOk:typeof p.lastAnswerOk==='boolean'?p.lastAnswerOk:null
  }));
  else{
    const p=g.players.get(id);
    if(p){
      v.me={name:p.name,team:p.team,prog:p.prog,flags:p.flags,placed:p.placed,correct:p.correctN,answered:p.answeredN,qn:p.qn,fb:p.fb};
      if(g.state==='playing'){const qq=g.quiz.q[p.cur];v.q={t:qq.t,a:qq.a,multi:qq.cs.length>1};if(p.flags>0)v.valid=validTiles(g.kb,p.team)}
    }
  }
  return v;
}
function viewAny(g,id,R,C){return g.mode==='kingdoms'&&g.kb&&g.state!=='lobby'?viewK(g,id,C||commonK(g,R)):view(g,id,R)}
function safeSseWrite(g,c,payload){
  const res=c&&c.res;
  if(!res||res.destroyed||res.writableEnded){if(g&&g.clients)g.clients.delete(c);return false}
  try{res.write('data: '+JSON.stringify(payload)+'\n\n');return true}
  catch(e){
    // A mobile client may drop its SSE connection just as a large board update is broadcast.
    // Never let a closed stream crash the whole game process and erase every in-memory room.
    if(g&&g.clients)g.clients.delete(c);
    try{if(!res.destroyed&&!res.writableEnded)res.end()}catch(_){}
    console.warn('SSE-клиент отключён при отправке обновления:',e.message);
    return false;
  }
}
function push(g){
  try{
    const R=ranked(g),C=g.mode==='kingdoms'&&g.kb&&g.state!=='lobby'?commonK(g,R):null;
    [...g.clients].forEach(c=>{try{safeSseWrite(g,c,viewAny(g,c.id,R,C))}catch(e){g.clients.delete(c);try{if(!c.res.destroyed&&!c.res.writableEnded)c.res.end()}catch(_){}console.error('Ошибка обновления клиента:',e.message)}});
  }catch(e){console.error('Ошибка рассылки состояния игры '+g.pin+':',e.stack||e.message)}
}
const pushOne=(g,id)=>{try{const R=ranked(g),C=g.kb?commonK(g,R):null;g.clients.forEach(c=>{if(c.id===id){try{safeSseWrite(g,c,viewAny(g,id,R,C))}catch(e){g.clients.delete(c);console.error('Ошибка персонального обновления:',e.message)}}})}catch(e){console.error('Ошибка персональной рассылки '+g.pin+':',e.stack||e.message)}};
const sched=g=>{if(g.pend)return;g.pend=setTimeout(()=>{g.pend=0;push(g)},180)};

// ================= HTTP =================
function body(req){return new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>2e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d))}catch{r({})}})})}
const json=(res,o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
const LIBFILES={'/xlsx.js':'xlsx.mini.min.js','/qr.js':'qrcode.js','/tailwind.css':'tailwind.css','/ui.css':'ui.css','/liquid-glass.css':'liquid-glass.css','/responsive-v2.css':'responsive-v2.css','/favicon.svg':'favicon.svg','/favicon.png':'favicon.png','/favicon.ico':'favicon.ico','/apple-touch-icon.png':'apple-touch-icon.png'};

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  if(req.method==='GET'&&LIBFILES[u.pathname]){
    const f=[path.join(__dirname,'public',LIBFILES[u.pathname]),path.join(__dirname,LIBFILES[u.pathname])].find(p=>fs.existsSync(p));
    if(!f){res.writeHead(404);return res.end()}
    return fs.readFile(f,(e,b)=>{const type=u.pathname.endsWith('.css')?'text/css':u.pathname.endsWith('.svg')?'image/svg+xml':u.pathname.endsWith('.png')?'image/png':u.pathname.endsWith('.ico')?'image/x-icon':'application/javascript';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});res.end(b)});
  }
  if(req.method==='GET'&&u.pathname==='/'){
    const f=[path.join(__dirname,'public','index.html'),path.join(__dirname,'index.html')].find(p=>fs.existsSync(p));
    if(!f){res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Не найден файл public/index.html')}
    return fs.readFile(f,(e,b)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(b)});
  }
  if(u.pathname==='/api/events'){
    const g=games.get(u.searchParams.get('pin')),id=u.searchParams.get('id');
    if(!g||(id!==g.hostId&&!g.players.has(id))){res.writeHead(404);return res.end()}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const c={res,id};g.clients.add(c);
    try{const R=ranked(g);if(!safeSseWrite(g,c,viewAny(g,id,R))){try{res.end()}catch(_){};return}}
    catch(e){g.clients.delete(c);console.error('Не удалось отправить начальное состояние игры:',e.stack||e.message);try{res.end()}catch(_){};return}
    // Broadcast connection status so the host's participant panel updates immediately.
    push(g);
    const ka=setInterval(()=>{try{if(res.destroyed||res.writableEnded){clearInterval(ka);g.clients.delete(c);return}res.write(': ka\n\n')}catch(e){clearInterval(ka);g.clients.delete(c);try{if(!res.destroyed&&!res.writableEnded)res.end()}catch(_){}}},15000);
    req.on('close',()=>{clearInterval(ka);g.clients.delete(c);setImmediate(()=>{if(games.get(g.pin)===g)push(g)})});return;
  }
  if(req.method==='GET'&&u.pathname==='/api/info'){
    await hydrateAppSettingsFromGitHub();
    const urls=Object.values(os.networkInterfaces()).flat().filter(i=>(i.family==='IPv4'||i.family===4)&&!i.internal).map(i=>'http://'+i.address+':'+PORT);
    return json(res,{urls,hasUsers:USERS.length>0,regOpen:USERS.length===0||!!INVITE,needInvite:USERS.length>0&&!!INVITE,settings:APP_SETTINGS});
  }
  if(req.method!=='POST')return json(res,{},404);
  const b=await body(req),werr=()=>json(res,{error:'Не удалось записать файл на сервере (проверьте права на папку data)'},500);

  // ---------- global platform settings ----------
  if(u.pathname.startsWith('/api/settings/')){
    const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход в аккаунт',code:401},401);
    if(!me.admin)return json(res,{error:'Настройки платформы доступны только администратору'},403);
    const op=u.pathname.slice('/api/settings/'.length),cfg=githubConfig();
    try{
      if(op==='get'){
        if(cfg){const remote=await githubReadAppSettings(cfg);APP_SETTINGS=remote.settings;APP_SETTINGS_HYDRATED=true;writeAppSettingsFile(APP_SETTINGS);return json(res,{settings:APP_SETTINGS,persistedToGitHub:remote.exists,source:remote.exists?'github':'local',notice:remote.exists?'':'Файл настроек пока не найден в GitHub. Сохраните настройки, чтобы создать его.'})}
        APP_SETTINGS=readAppSettingsFile();return json(res,{settings:APP_SETTINGS,persistedToGitHub:false,source:'local'});
      }
      if(op==='save'){
        const next=normalizeAppSettings(b.settings);
        if(!next.modes.classic.enabled&&!next.modes.kingdoms.enabled)return json(res,{error:'Включите хотя бы один игровой режим.'},400);
        if(cfg){
          for(let attempt=0;attempt<3;attempt++){
            const remote=await githubReadAppSettings(cfg),wr=await githubWriteAppSettings(cfg,remote.sha,next,'Update platform settings');
            if((wr.status===409||wr.status===422)&&attempt<2)continue;
            if(!wr.ok){const detail=await wr.text().catch(()=> '');throw new Error('Не удалось сохранить настройки в GitHub (HTTP '+wr.status+'). '+detail.slice(0,220))}
            APP_SETTINGS=next;APP_SETTINGS_HYDRATED=true;writeAppSettingsFile(next);
            return json(res,{ok:true,settings:APP_SETTINGS,persistedToGitHub:true,source:'github'});
          }
          throw new Error('Настройки одновременно изменились в GitHub. Повторите сохранение.');
        }
        if(!writeAppSettingsFile(next))return json(res,{error:'Не удалось записать app-settings.json'},500);
        APP_SETTINGS=next;APP_SETTINGS_HYDRATED=true;return json(res,{ok:true,settings:APP_SETTINGS,persistedToGitHub:false,source:'local',notice:'Настройки записаны только в локальный файл. Для постоянного хранения на Render настройте GitHub-синхронизацию.'});
      }
    }catch(e){console.error('Ошибка настроек платформы:',e.message);return json(res,{error:e.message||'Не удалось обработать настройки'},500)}
    return json(res,{error:'Неизвестная операция настроек'},404);
  }

  // ---------- аккаунты ----------
  if(u.pathname.startsWith('/api/auth/')){
    const op=u.pathname.slice(10);
    if(op==='register'){
      const login=str(b.login,40).trim(),pw=String(b.pass||'');
      if(!/^[\p{L}\p{N}_.@-]{3,40}$/u.test(login))return json(res,{error:'Логин: 3–40 символов (буквы, цифры, _ . - @)'},400);
      if(pw.length<6||pw.length>100)return json(res,{error:'Пароль должен быть не короче 6 символов'},400);
      if(USERS.length&&(!INVITE||b.code!==INVITE))return json(res,{error:INVITE?'Неверный код приглашения':'Регистрация закрыта: аккаунт администратора уже создан. Чтобы разрешить новые регистрации, задайте INVITE_CODE при запуске сервера'},403);
      if(USERS.some(x=>x.login.toLowerCase()===login.toLowerCase()))return json(res,{error:'Такой логин уже занят'},400);
      const salt=crypto.randomBytes(16).toString('hex'),nu={id:rid(),login,name:str(b.name,40).trim()||login,salt,hash:hashPw(pw,salt),admin:!USERS.length,created:Date.now()};
      USERS.push(nu);
      if(!writeJ('users.json',USERS)){USERS.pop();return werr()}
      return json(res,{token:newSession(nu),user:pubUser(nu)});
    }
    if(op==='login'){
      const login=str(b.login,40).trim(),ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim(),key=ip+'|'+login.toLowerCase(),now=Date.now(),f=FAILS.get(key);
      if(f&&f.until>now)return json(res,{error:'Слишком много неудачных попыток. Подождите минуту.'},429);
      const nu=USERS.find(x=>x.login.toLowerCase()===login.toLowerCase());
      if(!nu||!checkPw(nu,b.pass)){const n=(f?f.n:0)+1;FAILS.set(key,n>=5?{n:0,until:now+60000}:{n,until:0});return json(res,{error:'Неверный логин или пароль'},401)}
      FAILS.delete(key);
      return json(res,{token:newSession(nu),user:pubUser(nu)});
    }
    if(op==='me'){const me=userOf(b.token);return me?json(res,{user:pubUser(me)}):json(res,{error:'Требуется вход',code:401},401)}
    if(op==='logout'){delete SESS[b.token];writeJ('sessions.json',SESS);return json(res,{ok:1})}
    return json(res,{error:'Неизвестная операция'},404);
  }

  // ---------- встроенная библиотека тестов из builtin-tests.json ----------
  if(u.pathname.startsWith('/api/lib/')){
    const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход в аккаунт',code:401},401);
    const op=u.pathname.slice(9),builtin=BUILTINQ.find(x=>x.id===b.id);
    if(op==='list'){const doc=readBuiltinDocument();return json(res,{folders:doc.folders.map(f=>({...f,count:BUILTINQ.filter(q=>q.folderId===f.id).length})),items:BUILTINQ.map(x=>({id:x.id,title:x.quiz.title,n:x.quiz.q.length,mode:x.quiz.mode,folderId:x.folderId||'',builtin:true,source:'builtin'}))});}
    if(op==='get')return builtin?json(res,{quiz:builtin.quiz,folderId:builtin.folderId||'',builtin:true}):json(res,{error:'Тест не найден'},404);
    if(op==='export'){const doc=readBuiltinDocument();return json(res,{app:'kviz-arena',version:3,folders:doc.folders,items:doc.items});}
    if(['import','create','update','copy','delete','folders/create','folders/update','folders/delete','move','reorder'].includes(op)&&!me.admin)return json(res,{error:'Редактировать библиотеку может только администратор'},403);
    if(op==='folders/list'){const doc=readBuiltinDocument();return json(res,{folders:doc.folders.map(f=>({...f,count:BUILTINQ.filter(q=>q.folderId===f.id).length}))});}
    try{
      if(op==='folders/create'){
        const name=str(b.name,64).trim();if(!name)return json(res,{error:'Введите название папки'},400);
        const id='folder-'+rid();
        const result=await mutateBuiltinDocument(doc=>{if(doc.folders.some(f=>f.name.toLocaleLowerCase()===name.toLocaleLowerCase()))return{items:doc.items,folders:doc.folders,noChange:true,data:{created:false,reason:'duplicate'}};return{items:doc.items,folders:[...doc.folders,{id,name,createdAt:Date.now(),updatedAt:Date.now()}],data:{created:true,id,name}}},'Create quiz folder '+name);
        if(result.reason==='duplicate')return json(res,{error:'Папка с таким названием уже существует'},409);
        return json(res,{ok:true,...result});
      }
      if(op==='folders/update'){
        const name=str(b.name,64).trim(),id=String(b.id||'');if(!name)return json(res,{error:'Введите название папки'},400);
        const result=await mutateBuiltinDocument(doc=>{const idx=doc.folders.findIndex(f=>f.id===id);if(idx<0)return{items:doc.items,folders:doc.folders,noChange:true,updated:false};if(doc.folders.some((f,i)=>i!==idx&&f.name.toLocaleLowerCase()===name.toLocaleLowerCase()))return{items:doc.items,folders:doc.folders,noChange:true,data:{reason:'duplicate'}};const folders=doc.folders.map((f,i)=>i===idx?{...f,name,updatedAt:Date.now()}:f);return{items:doc.items,folders,data:{updated:true,id,name}}},'Rename quiz folder '+name);
        if(result.reason==='duplicate')return json(res,{error:'Папка с таким названием уже существует'},409);
        return result.updated?json(res,{ok:true,...result}):json(res,{error:'Папка не найдена'},404);
      }
      if(op==='folders/delete'){
        const id=String(b.id||'');
        const result=await mutateBuiltinDocument(doc=>{const folders=doc.folders.filter(f=>f.id!==id),removed=folders.length!==doc.folders.length;if(!removed)return{items:doc.items,folders:doc.folders,noChange:true,removed:false};let moved=0;const items=doc.items.map(item=>{if(item.folderId===id){moved++;return{...item,folderId:''}}return item});return{items,folders,data:{removed:true,id,moved}}},'Delete quiz folder '+id);
        return result.removed?json(res,{ok:true,...result}):json(res,{error:'Папка не найдена'},404);
      }
      if(op==='move'){
        const id=String(b.id||''),folderId=String(b.folderId||'');
        const result=await mutateBuiltinDocument(doc=>{const index=doc.items.findIndex(item=>item.id===id);if(index<0)return{items:doc.items,folders:doc.folders,noChange:true,moved:false};if(folderId&&!doc.folders.some(f=>f.id===folderId))return{items:doc.items,folders:doc.folders,noChange:true,data:{reason:'folder-not-found'}};const items=doc.items.map((item,i)=>i===index?{...item,folderId}:item);return{items,folders:doc.folders,data:{moved:true,id,folderId}}},'Move quiz '+id+' to folder '+(folderId||'root'));
        if(result.reason==='folder-not-found')return json(res,{error:'Папка не найдена'},404);
        return result.moved?json(res,{ok:true,...result}):json(res,{error:'Тест не найден'},404);
      }
      if(op==='reorder'){
        const folderId=String(b.folderId||''),ids=Array.isArray(b.ids)?b.ids.map(x=>String(x)):[];
        if(!folderId||!ids.length||ids.length>5000)return json(res,{error:'Некорректный порядок тестов.'},400);
        const result=await mutateBuiltinDocument(doc=>{
          if(!doc.folders.some(f=>f.id===folderId))return{items:doc.items,folders:doc.folders,noChange:true,data:{reason:'folder-not-found'}};
          const current=doc.items.filter(item=>item.folderId===folderId),currentIds=current.map(item=>item.id);
          if(ids.length!==currentIds.length||new Set(ids).size!==ids.length||!ids.every(id=>currentIds.includes(id)))return{items:doc.items,folders:doc.folders,noChange:true,data:{reason:'invalid-order'}};
          const byId=new Map(current.map(item=>[item.id,item])),ordered=ids.map(id=>byId.get(id));let i=0;
          const items=doc.items.map(item=>item.folderId===folderId?ordered[i++]:item);
          return{items,folders:doc.folders,data:{reordered:true,folderId}};
        },'Reorder quizzes in folder '+folderId);
        if(result.reason==='folder-not-found')return json(res,{error:'Папка не найдена'},404);
        if(result.reason==='invalid-order')return json(res,{error:'Список тестов изменился. Обновите папку и повторите попытку.'},409);
        return result.reordered?json(res,{ok:true,...result}):json(res,{error:'Не удалось изменить порядок тестов.'},500);
      }
      if(op==='import'){
        const incoming=Array.isArray(b.items)?b.items:[];
        if(!incoming.length)return json(res,{error:'Не получены тесты для импорта'},400);
        if(incoming.length>200)return json(res,{error:'За один импорт допускается не более 200 тестов'},400);
        const parsed=[];for(let i=0;i<incoming.length;i++){const item=incoming[i],quiz=parseQuiz(item&&item.quiz?item.quiz:item);if(quiz)parsed.push({quiz,sourceFolderId:String(item&&item.folderId||'')})}
        if(!parsed.length)return json(res,{error:'Нет корректных тестов. Проверьте вопросы, варианты ответов и правильные ответы.'},400);
        const addedIds=parsed.map(()=> 'test-'+rid()),requestedFolder=String(b.folderId||''),incomingFolders=normalizeFolders(b.folders);
        const result=await mutateBuiltinDocument(doc=>{
          const folders=doc.folders.map(f=>({...f})),folderMap={};
          folders.forEach(folder=>{folderMap[folder.id]=folder.id});
          for(const source of incomingFolders){
            let target=folders.find(f=>f.name.toLocaleLowerCase()===source.name.toLocaleLowerCase());
            if(!target){target={id:'folder-'+rid(),name:source.name,createdAt:Date.now(),updatedAt:Date.now()};folders.push(target)}
            folderMap[source.id]=target.id;
          }
          const targetFolder=requestedFolder&&folders.some(f=>f.id===requestedFolder)?requestedFolder:'';
          const items=[...doc.items,...parsed.map((entry,i)=>({id:addedIds[i],quiz:entry.quiz,folderId:targetFolder||folderMap[entry.sourceFolderId]||''}))];
          return{items,folders,data:{added:parsed.length,skipped:incoming.length-parsed.length,folderId:targetFolder,importedFolders:incomingFolders.length}};
        },'Import tests into builtin-tests.json');
        return json(res,{ok:true,...result});
      }
      if(op==='create'){
        const quiz=parseQuiz(b.quiz);if(!quiz)return json(res,{error:'Тест не прошёл проверку. Убедитесь, что у каждого вопроса есть варианты и правильный ответ.'},400);
        const folderId=String(b.folderId||'');
        const result=await mutateBuiltinDocument(doc=>{
          if(folderId&&!doc.folders.some(f=>f.id===folderId))return{items:doc.items,folders:doc.folders,noChange:true,data:{reason:'folder-not-found'}};
          const id='test-'+rid();
          return{items:[...doc.items,{id,quiz,folderId}],folders:doc.folders,data:{created:true,id,folderId}};
        },'Create built-in quiz '+String(quiz.title||'Untitled'));
        if(result.reason==='folder-not-found')return json(res,{error:'Папка не найдена'},404);
        return result.created?json(res,{ok:true,...result}):json(res,{error:'Не удалось создать тест'},500);
      }
      if(op==='update'){
        const quiz=parseQuiz(b.quiz);if(!quiz)return json(res,{error:'Тест не прошёл проверку. Убедитесь, что у каждого вопроса есть варианты и правильный ответ.'},400);
        const result=await mutateBuiltinItems(items=>{const index=items.findIndex(item=>item.id===b.id);if(index<0)return{items,noChange:true,data:{id:b.id,updated:false}};const next=items.slice();next[index]={id:next[index].id,quiz,folderId:next[index].folderId||''};return{items:next,data:{id:b.id,updated:true,folderId:next[index].folderId||''}}},'Edit built-in quiz '+String(b.id||''));
        return result.updated?json(res,{ok:true,...result}):json(res,{error:'Тест не найден'},404);
      }
      if(op==='copy'){
        const newId='test-'+rid();
        const result=await mutateBuiltinItems(items=>{const source=items.find(item=>item.id===b.id);if(!source)return{items,noChange:true,data:{id:null,copied:false}};const quiz={...source.quiz,title:(String(source.quiz.title||'Тест')+' — копия').slice(0,80),q:source.quiz.q.map(q=>({...q,a:[...q.a],cs:[...q.cs]}))};return{items:[...items,{id:newId,quiz,folderId:source.folderId||''}],data:{id:newId,copied:true,folderId:source.folderId||''}}},'Copy built-in quiz '+String(b.id||''));
        return result.copied?json(res,{ok:true,...result}):json(res,{error:'Тест не найден'},404);
      }
      if(op==='delete'){
        const result=await mutateBuiltinItems(items=>{const next=items.filter(item=>item.id!==b.id),removed=next.length!==items.length;return{items:next,noChange:!removed,data:{id:b.id,removed}}},'Delete built-in quiz '+String(b.id||''));
        return result.removed?json(res,{ok:true,...result}):json(res,{error:'Тест не найден'},404);
      }
    }catch(e){console.error('Ошибка изменения builtin-tests.json:',e.message);return json(res,{error:e.message||'Не удалось изменить библиотеку'},500)}
    return json(res,{error:'Неизвестная операция'},404);
  }

  // ---------- teacher reports history ----------
  if(u.pathname==='/api/reports/list'){
    const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход в аккаунт',code:401},401);
    const items=REPORTS.filter(r=>me.admin||r.ownerId===me.id).map(r=>({id:r.id,pin:r.pin,title:r.title,sourceId:r.sourceId,mode:r.mode,modeName:r.modeName,completedAt:r.completedAt,incomplete:!!r.incomplete,questionCount:r.questionCount,participantCount:r.participantCount,accuracy:r.summary&&r.summary.accuracy,averageScore:r.summary&&r.summary.averageScore}));
    return json(res,{items});
  }
  if(u.pathname==='/api/reports/get'){
    const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход в аккаунт',code:401},401);
    const report=REPORTS.find(r=>r.id===b.reportId);
    if(!report)return json(res,{error:'Отчёт не найден'},404);
    if(!me.admin&&report.ownerId!==me.id)return json(res,{error:'Нет доступа'},403);
    return json(res,{report});
  }

  // ---------- создание игры ----------
  if(u.pathname==='/api/create'){
    await hydrateAppSettingsFromGitHub();
    const me=userOf(b.token);if(!me)return json(res,{error:'Войдите в личный кабинет, чтобы запустить игру',code:401},401);
    const source=BUILTINQ.find(x=>x.id===b.sourceId);if(!source)return json(res,{error:'Можно запускать только тесты из библиотеки проекта.'},403);
    const requestedMode=String(b.mode||'');
    if(!['classic','kingdoms'].includes(requestedMode))return json(res,{error:'Выберите режим игры перед запуском теста.'},400);
    const modeSettings=APP_SETTINGS.modes[requestedMode];if(!modeSettings||!modeSettings.enabled)return json(res,{error:'Этот режим отключён в общих настройках платформы.'},403);
    const quiz=parseQuiz(source.quiz);if(!quiz)return json(res,{error:'Тест некорректен. Проверьте библиотеку тестов.'},400);
    quiz.mode=requestedMode;
    if(requestedMode==='kingdoms'){quiz.dur=APP_SETTINGS.modes.kingdoms.durationMinutes;quiz.need=APP_SETTINGS.modes.kingdoms.correctAnswersForFlag;}
    const gameSettings=JSON.parse(JSON.stringify(APP_SETTINGS));
    let pin;do pin=String(Math.floor(100000+Math.random()*900000));while(games.has(pin));
    const g={pin,hostId:rid(),owner:me.id,sourceId:source.id,quiz,state:'lobby',mode:requestedMode,appSettings:gameSettings,qi:0,qStart:Date.now(),players:new Map(),left:[],clients:new Set(),born:Date.now()};
    games.set(pin,g);return json(res,{pin,id:g.hostId});
  }

  const g=games.get(String(b.pin));
  if(u.pathname==='/api/alive')return json(res,{alive:!!g&&(b.id===g.hostId||g.players.has(b.id))});
  if(!g)return json(res,{error:'Игра не найдена'},404);
  if(u.pathname==='/api/join'){
    const name=str(b.name,16).trim();
    const playerLimit=(g.appSettings||APP_SETTINGS).general.maxPlayers;if(g.players.size>=playerLimit)return json(res,{error:'Игра заполнена (максимум '+playerLimit+' игроков)'},400);
    if(!name)return json(res,{error:'Введите имя'},400);
    if(g.state==='final'||g.state==='ended')return json(res,{error:'Игра уже завершена'},400);
    if(g.locked)return json(res,{error:'Ведущий закрыл вход в игру'},400);
    if([...g.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase()))return json(res,{error:'Это имя занято'},400);
    const id=rid();g.players.set(id,newPlayer(g,name));push(g);return json(res,{id});
  }
  if(u.pathname==='/api/report'){
    if(b.id!==g.hostId)return json(res,{error:'Нет доступа'},403);
    const R=ranked(g),K=g.mode==='kingdoms'&&g.kb;
    return json(res,{mode:g.mode,title:g.quiz.title,teams:K?commonK(g,R).stats:null,questions:g.quiz.q.map(q=>({t:q.t,a:q.a,cs:q.cs})),
      players:[...g.players.values(),...g.left].map(p=>({name:p.name,score:p.score,team:p.team,placed:p.placed,correctN:p.correctN,answeredN:p.answeredN,log:p.log}))});
  }
  if(u.pathname==='/api/action'){
    const host=b.id===g.hostId,p=g.players.get(b.id),KM=g.mode==='kingdoms';
    if(host&&b.type==='start'&&g.state==='lobby'&&g.players.size){
      try{
        if(KM)startK(g);else{g.qi=0;startQ(g)}
      }catch(e){
        console.error('Не удалось запустить игру '+g.pin+' ('+g.mode+'):',e.stack||e.message);
        clearTimeout(g.timer);g.timer=null;
        if(KM){g.kb=null;g.state='lobby'}else{g.state='lobby';g.qi=0}
        return json(res,{error:'Не удалось запустить игру. Комната сохранена; попробуйте ещё раз. Подробности записаны в журнал сервера.'},500);
      }
    }
    else if(host&&b.type==='skip'){if(KM)finishK(g);else toResults(g)}
    else if(host&&b.type==='lock'){g.locked=!g.locked;push(g)}
    else if(host&&!KM&&b.type==='next'&&g.state==='results'){
      if(g.qi>=g.quiz.q.length-1){g.state='final';saveGameReport(g);push(g)}else{g.qi++;startQ(g)}
    }else if(p&&KM&&g.state==='playing'&&b.type==='answer'){
      if(answerK(g,p,b)){pushOne(g,b.id);sched(g)}
    }else if(p&&KM&&g.state==='playing'&&b.type==='place'){
      if(placeK(g,p,b.tile))push(g);else{pushOne(g,b.id);return json(res,{error:'Сюда нельзя поставить флаг'})}
    }else if(p&&!KM&&b.type==='answer'&&g.state==='question'){
      const qq=g.quiz.q[g.qi],T=qq.T*1000,el=Date.now()-g.qStart,sel=[...new Set([].concat(b.a).map(Number))].filter(Number.isInteger).sort((x,y)=>x-y);
      if(p.lastQ!==g.qi&&el<=T+300&&sel.length&&sel.every(x=>x>=0&&x<qq.a.length)){
        const okk=same(sel,qq.cs),classicSettings=(g.appSettings||APP_SETTINGS).modes.classic,pts=okk?Math.round(classicSettings.basePoints*(classicSettings.speedBonus?1-Math.min(el,T)/T/2:1)):0;
        Object.assign(p,{score:p.score+pts,lastQ:g.qi,lastA:sel,lastPts:pts,lastMs:el});p.log.push({qi:g.qi,a:sel,ok:okk,pts,ms:el});
        if([...g.players.values()].every(x=>x.lastQ===g.qi))toResults(g);else push(g);
      }
    }else if(p&&b.type==='leave')removePlayer(g,b.id);
    else if(host&&b.type==='kick'&&g.players.has(b.a))removePlayer(g,b.a,{state:'kicked'});
    else if(host&&b.type==='end'){
      saveGameReport(g,{incomplete:g.state!=='final'});g.state='ended';clearTimeout(g.timer);clearTimeout(g.pend);push(g);
      setTimeout(()=>{g.clients.forEach(c=>c.res.end());games.delete(g.pin)},1500);
    }
    return json(res,{ok:1});
  }
  json(res,{},404);
}).listen(PORT,'0.0.0.0',()=>{
  console.log('Квиз-арена запущена: http://localhost:'+PORT);
  Object.values(os.networkInterfaces()).flat().filter(i=>(i.family==='IPv4'||i.family===4)&&!i.internal).forEach(i=>console.log('В локальной сети:  http://'+i.address+':'+PORT));
  console.log(USERS.length?'Аккаунтов: '+USERS.length+(INVITE?' (регистрация по коду приглашения)':' (регистрация закрыта)'):'Аккаунтов пока нет — первый созданный аккаунт станет администратором.');
});
setInterval(()=>{
  for(const[k,g]of games)if(Date.now()-g.born>6*3600e3){clearTimeout(g.timer);clearTimeout(g.pend);g.clients.forEach(c=>c.res.end());games.delete(k)}
  const now=Date.now();let ch=false;for(const t of Object.keys(SESS))if(SESS[t].exp<now){delete SESS[t];ch=true}if(ch)writeJ('sessions.json',SESS);
},600e3);
