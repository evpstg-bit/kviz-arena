// Квиз-арена: сервер без npm-зависимостей (Node.js 18+). Запуск: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const PORT=process.env.PORT||3000,games=new Map(),APP_VERSION=require('./package.json').version;
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data'),INVITE=process.env.INVITE_CODE||'';
const rid=()=>crypto.randomBytes(6).toString('hex');
const TEAM_NAMES=['Красные','Синие','Зелёные','Золотые'];
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
    kingdoms:{enabled:true,durationMinutes:5,correctAnswersForFlag:3,kingdomCount:2}
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
    kingdoms:{enabled:k.enabled!==false,durationMinutes:clampInt(k.durationMinutes,5,20,5),correctAnswersForFlag:clampInt(k.correctAnswersForFlag,1,5,3),kingdomCount:clampInt(k.kingdomCount,2,4,2)}
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
  if(!AUTH_SECURITY_READY||!CONFIG_ADMIN||!ADMIN_SECRET||typeof t!=='string')return null;
  const m=/^cfg\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(t);if(!m)return null;
  try{
    const expected=crypto.createHmac('sha256',ADMIN_SECRET).update(m[1]).digest();
    const actual=Buffer.from(m[2],'base64url');
    if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;
    const p=JSON.parse(Buffer.from(m[1],'base64url').toString('utf8'));
    if(p.uid!==CONFIG_ADMIN.id||Number(p.exp)<=Date.now())return null;
    const userId=String(CONFIG_ADMIN.id),protectedAccount=AUTH_SECURITY_STATE.users[userId],epoch=Number(AUTH_SECURITY_STATE.epochs[userId])||0;
    if(epoch>0&&Number(p.av)!==epoch)return null;
    if(protectedAccount&&p.mfa!==true)return null;
    return CONFIG_ADMIN;
  }catch(e){return null}
}
function userOf(t){
  if(!AUTH_SECURITY_READY)return null;
  const configured=configuredUserFromToken(t);if(configured)return configured;
  const s=t&&SESS[t];if(!s)return null;if(s.exp<Date.now()){delete SESS[t];return null}
  const u=USERS.find(x=>x.id===s.uid);if(!u)return null;
  const userId=String(u.id),epoch=Number(AUTH_SECURITY_STATE.epochs[userId])||0;
  if(epoch>0&&Number(s.av)!==epoch)return null;
  if(AUTH_SECURITY_STATE.users[userId]&&s.mfa!==true)return null;
  return u;
}
function newSession(u,mfaVerified=false){
  if(u&&u.configManaged){
    const payload=Buffer.from(JSON.stringify({uid:u.id,exp:Date.now()+60*864e5,mfa:!!mfaVerified,av:Number(AUTH_SECURITY_STATE.epochs[String(u.id)])||0})).toString('base64url');
    const sig=crypto.createHmac('sha256',ADMIN_SECRET).update(payload).digest('base64url');
    return 'cfg.'+payload+'.'+sig;
  }
  const t=crypto.randomBytes(24).toString('hex');SESS[t]={uid:u.id,exp:Date.now()+60*864e5,mfa:!!mfaVerified,av:Number(AUTH_SECURITY_STATE.epochs[String(u.id)])||0};
  const mine=Object.keys(SESS).filter(k=>SESS[k].uid===u.id);if(mine.length>20)mine.slice(0,mine.length-20).forEach(k=>delete SESS[k]);
  writeJ('sessions.json',SESS);return t;
}
const FAILS=new Map();
let AUTH_SECURITY_STATE={version:1,users:{},epochs:{}},AUTH_SECURITY_READY=false,AUTH_SECURITY_PERSISTENT=false,AUTH_SECURITY_PROMISE=null,AUTH_SECURITY_ERROR='';
const TOTP_SETUP_PENDING=new Map(),TOTP_LOGIN_CHALLENGES=new Map(),TOTP_FAILS=new Map();

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
let REPORTS_INDEX_HYDRATED=false,REPORTS_INDEX_HYDRATION=null,REPORTS_PERSIST_QUEUE=Promise.resolve(),REPORTS_REMOTE_READY=false,REPORTS_STORAGE_ERROR='';

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

const reportsStoreConfig=()=>{
  const cfg=githubConfig();if(!cfg)return null;
  const branch=String(process.env.REPORTS_BRANCH||'kviz-arena-reports').trim();
  const secret=String(process.env.REPORTS_ENCRYPTION_KEY||cfg.token);
  if(!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)||branch.includes('..')||branch.startsWith('/')||branch.endsWith('/'))throw new Error('Некорректное имя REPORTS_BRANCH');
  if(!secret)return null;
  return{...cfg,reportsBranch:branch,secret};
};
const reportsApiBase=()=>String(process.env.GITHUB_API_BASE||'https://api.github.com').replace(/\/$/,'');
async function reportsGithubFetch(cfg,endpoint,{method='GET',body,accept='application/vnd.github+json'}={}){
  const headers={Authorization:'Bearer '+cfg.token,Accept:accept,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'kviz-arena'};
  const options={method,headers,signal:AbortSignal.timeout(15000)};
  if(body!==undefined){headers['Content-Type']='application/json';options.body=JSON.stringify(body)}
  return fetch(reportsApiBase()+'/repos/'+cfg.repo+'/'+endpoint,options);
}
function reportCryptoKey(cfg){return crypto.createHash('sha256').update('kviz-arena-encrypted-report-store-v1\0'+cfg.secret,'utf8').digest()}
function encryptReportPayload(value,cfg){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',reportCryptoKey(cfg),iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return JSON.stringify({version:1,algorithm:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')})+'\n';
}
function decryptReportPayload(encoded,cfg){
  const envelope=JSON.parse(String(encoded||''));
  if(!envelope||envelope.version!==1||envelope.algorithm!=='aes-256-gcm')throw new Error('Неизвестный формат зашифрованного хранилища отчётов');
  const decipher=crypto.createDecipheriv('aes-256-gcm',reportCryptoKey(cfg),Buffer.from(envelope.iv,'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const plain=Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}
function reportMeta(r){
  const questionCount=Number(r.questionCount)||0,participantCount=Number(r.participantCount)||0;
  const accuracy=String(r.mode||'classic')==='classic'&&r.summary?successPercent(r.summary.totalCorrect,questionCount*participantCount):Number(r.summary&&r.summary.accuracy!==undefined?r.summary.accuracy:r.accuracy)||0;
  return{id:String(r.id),pin:String(r.pin||''),sourceId:String(r.sourceId||''),ownerId:String(r.ownerId||''),title:String(r.title||''),mode:String(r.mode||'classic'),modeName:String(r.modeName||r.mode||'Classic'),completedAt:Number(r.completedAt)||Date.now(),incomplete:!!r.incomplete,questionCount,participantCount,accuracy,averageScore:Number(r.summary&&r.summary.averageScore!==undefined?r.summary.averageScore:r.averageScore)||0};
}
async function reportsApiJson(res,what){
  const txt=await res.text().catch(()=> '');
  if(!res.ok)throw new Error(what+' (HTTP '+res.status+'). '+txt.slice(0,180));
  try{return JSON.parse(txt)}catch(e){throw new Error(what+': GitHub вернул некорректный ответ')}
}
async function githubEnsureReportsBranch(cfg){
  const name=encodeURIComponent(cfg.reportsBranch);
  let r=await reportsGithubFetch(cfg,'git/ref/heads/'+name);
  if(r.ok)return await r.json();
  if(r.status!==404)await reportsApiJson(r,'Не удалось проверить ветку хранилища отчётов');
  const base=await reportsGithubFetch(cfg,'git/ref/heads/'+encodeURIComponent(cfg.branch));
  if(!base.ok)await reportsApiJson(base,'Не удалось найти исходную ветку GitHub');
  const baseRef=await base.json();
  const create=await reportsGithubFetch(cfg,'git/refs',{method:'POST',body:{ref:'refs/heads/'+cfg.reportsBranch,sha:baseRef.object.sha}});
  if(!create.ok&&create.status!==422)await reportsApiJson(create,'Не удалось создать ветку хранилища отчётов');
  const check=await reportsGithubFetch(cfg,'git/ref/heads/'+name);
  return reportsApiJson(check,'Не удалось открыть ветку хранилища отчётов');
}
async function githubReadReportsIndexAt(cfg,ref){
  const r=await reportsGithubFetch(cfg,'contents/reports-index.enc.json?ref='+encodeURIComponent(ref));
  if(r.status===404)return{items:[],sha:null};
  const data=await reportsApiJson(r,'Не удалось прочитать индекс отчётов');
  if(!data.content)throw new Error('Индекс отчётов пуст или превышает доступный размер ответа GitHub API');
  const raw=Buffer.from(String(data.content).replace(/\s/g,''),'base64').toString('utf8');
  const parsed=decryptReportPayload(raw,cfg);
  if(!parsed||!Array.isArray(parsed.items))throw new Error('В зашифрованном индексе отчётов отсутствует список');
  return{items:parsed.items,sha:data.sha};
}
async function githubReadReportIndex(cfg){
  const ref=await githubEnsureReportsBranch(cfg);
  return githubReadReportsIndexAt(cfg,ref.object.sha);
}
function reportPath(id){
  const value=String(id||'');
  if(!/^report-[A-Za-z0-9_-]{1,140}$/.test(value))throw new Error('Некорректный идентификатор отчёта');
  return'reports/'+value+'.enc.json';
}
async function githubReadReport(cfg,id,ref){
  const r=await reportsGithubFetch(cfg,'contents/'+reportPath(id)+'?ref='+encodeURIComponent(ref),{accept:'application/vnd.github.raw+json'});
  if(r.status===404)return null;
  if(!r.ok)await reportsApiJson(r,'Не удалось загрузить отчёт');
  const txt=await r.text();
  let encrypted=txt;
  try{const wrapper=JSON.parse(txt);if(wrapper&&typeof wrapper.content==='string')encrypted=Buffer.from(wrapper.content.replace(/\s/g,''),'base64').toString('utf8')}catch(e){}
  const report=decryptReportPayload(encrypted,cfg);
  if(!report||report.id!==id)throw new Error('Содержимое отчёта не совпало с его идентификатором');
  return report;
}
async function githubWriteReportBatch(cfg,reports){
  if(!reports.length)return;
  for(let attempt=0;attempt<4;attempt++){
    const branchRef=await githubEnsureReportsBranch(cfg),parent=branchRef.object.sha;
    const indexState=await githubReadReportsIndexAt(cfg,parent);
    const known=new Map(indexState.items.filter(x=>x&&x.id).map(x=>[String(x.id),x]));
    const full=new Map();
    REPORTS.filter(x=>x&&x.id&&Array.isArray(x.questions)&&Array.isArray(x.participants)).forEach(x=>full.set(String(x.id),x));
    reports.forEach(x=>full.set(String(x.id),x));
    full.forEach((value,id)=>{if(!known.has(id))known.set(id,reportMeta(value))});
    reports.forEach(x=>known.set(String(x.id),reportMeta(x)));
    const ordered=[...known.values()].sort((a,b)=>(Number(b.completedAt)||0)-(Number(a.completedAt)||0)).slice(0,500);
    const keep=new Set(ordered.map(x=>String(x.id)));
    const treeEntries=[];
    const toWrite=new Map();
    full.forEach((r,id)=>{if(keep.has(id)&&(!indexState.items.some(x=>String(x.id)===id)||reports.some(x=>String(x.id)===id)))toWrite.set(id,r)});
    for(const [id,r] of toWrite){
      const b=await reportsGithubFetch(cfg,'git/blobs',{method:'POST',body:{content:encryptReportPayload(r,cfg),encoding:'utf-8'}});
      const blob=await reportsApiJson(b,'Не удалось подготовить зашифрованный отчёт');
      treeEntries.push({path:reportPath(id),mode:'100644',type:'blob',sha:blob.sha});
    }
    const indexBlobResponse=await reportsGithubFetch(cfg,'git/blobs',{method:'POST',body:{content:encryptReportPayload({version:1,items:ordered},cfg),encoding:'utf-8'}});
    const indexBlob=await reportsApiJson(indexBlobResponse,'Не удалось подготовить индекс отчётов');
    treeEntries.push({path:'reports-index.enc.json',mode:'100644',type:'blob',sha:indexBlob.sha});
    const removed=indexState.items.filter(x=>x&&x.id&&!keep.has(String(x.id)));
    removed.forEach(x=>treeEntries.push({path:reportPath(x.id),mode:'100644',type:'blob',sha:null}));
    const commitRes=await reportsGithubFetch(cfg,'git/commits/'+parent);
    const baseCommit=await reportsApiJson(commitRes,'Не удалось прочитать текущий коммит хранилища отчётов');
    const treeRes=await reportsGithubFetch(cfg,'git/trees',{method:'POST',body:{base_tree:baseCommit.tree.sha,tree:treeEntries}});
    const tree=await reportsApiJson(treeRes,'Не удалось подготовить обновление хранилища отчётов');
    const commitCreate=await reportsGithubFetch(cfg,'git/commits',{method:'POST',body:{message:'Save encrypted quiz reports',tree:tree.sha,parents:[parent]}});
    const newCommit=await reportsApiJson(commitCreate,'Не удалось сохранить зашифрованные отчёты');
    const update=await reportsGithubFetch(cfg,'git/refs/heads/'+encodeURIComponent(cfg.reportsBranch),{method:'PATCH',body:{sha:newCommit.sha,force:false}});
    if(update.ok){REPORTS_REMOTE_READY=true;REPORTS_INDEX_HYDRATED=true;REPORTS_STORAGE_ERROR='';return}
    if((update.status===409||update.status===422)&&attempt<3)continue;
    await reportsApiJson(update,'Не удалось обновить ветку хранилища отчётов');
  }
  throw new Error('Хранилище отчётов изменилось одновременно несколько раз. Повторите действие.');
}
async function githubDeleteReportBatch(cfg,ids){
  if(!cfg)throw new Error('Постоянное хранилище отчётов не настроено');
  const wanted=new Set(ids.map(String));
  for(let attempt=0;attempt<4;attempt++){
    const branchRef=await githubEnsureReportsBranch(cfg),parent=branchRef.object.sha;
    const indexState=await githubReadReportsIndexAt(cfg,parent);
    const removed=indexState.items.filter(x=>x&&x.id&&wanted.has(String(x.id)));
    if(!removed.length){REPORTS_REMOTE_READY=true;REPORTS_INDEX_HYDRATED=true;REPORTS_STORAGE_ERROR='';return{deletedFromRemote:0}}
    const kept=indexState.items.filter(x=>!x||!x.id||!wanted.has(String(x.id)));
    const indexBlobResponse=await reportsGithubFetch(cfg,'git/blobs',{method:'POST',body:{content:encryptReportPayload({version:1,items:kept},cfg),encoding:'utf-8'}});
    const indexBlob=await reportsApiJson(indexBlobResponse,'Не удалось подготовить обновлённый индекс отчётов');
    const treeEntries=[{path:'reports-index.enc.json',mode:'100644',type:'blob',sha:indexBlob.sha}];
    removed.forEach(x=>treeEntries.push({path:reportPath(x.id),mode:'100644',type:'blob',sha:null}));
    const commitRes=await reportsGithubFetch(cfg,'git/commits/'+parent);
    const base=await reportsApiJson(commitRes,'Не удалось прочитать текущее хранилище отчётов');
    const treeRes=await reportsGithubFetch(cfg,'git/trees',{method:'POST',body:{base_tree:base.tree.sha,tree:treeEntries}});
    const tree=await reportsApiJson(treeRes,'Не удалось подготовить удаление отчётов');
    const commitCreate=await reportsGithubFetch(cfg,'git/commits',{method:'POST',body:{message:'Delete encrypted quiz reports',tree:tree.sha,parents:[parent]}});
    const newCommit=await reportsApiJson(commitCreate,'Не удалось зафиксировать удаление отчётов');
    const update=await reportsGithubFetch(cfg,'git/refs/heads/'+encodeURIComponent(cfg.reportsBranch),{method:'PATCH',body:{sha:newCommit.sha,force:false}});
    if(update.ok){REPORTS_REMOTE_READY=true;REPORTS_INDEX_HYDRATED=true;REPORTS_STORAGE_ERROR='';return{deletedFromRemote:removed.length}}
    if((update.status===409||update.status===422)&&attempt<3)continue;
    await reportsApiJson(update,'Не удалось обновить ветку хранилища отчётов');
  }
  throw new Error('Хранилище отчётов изменилось одновременно несколько раз. Повторите удаление.');
}
function queueReportsDeletion(ids){
  const run=REPORTS_PERSIST_QUEUE.then(()=>githubDeleteReportBatch(reportsStoreConfig(),ids));
  REPORTS_PERSIST_QUEUE=run.catch(()=>{});
  return run;
}
function queueReportsPersistence(report){
  const run=REPORTS_PERSIST_QUEUE.then(()=>githubWriteReportBatch(reportsStoreConfig(),[report]));
  REPORTS_PERSIST_QUEUE=run.catch(()=>{});
  return run;
}
async function hydrateReportsFromGitHub({force=false}={}){
  const cfg=reportsStoreConfig();
  if(!cfg){REPORTS_REMOTE_READY=false;REPORTS_STORAGE_ERROR='Постоянное хранилище не настроено: задайте GITHUB_TOKEN и GITHUB_REPOSITORY, а токену выдайте Contents: Read and write.';return}
  // Reports history can outlive the in-memory process cache (for example after a Render restart).
  // A user opening the history can explicitly force a fresh read of the encrypted remote index.
  if(force){REPORTS_INDEX_HYDRATED=false;REPORTS_REMOTE_READY=false;REPORTS_STORAGE_ERROR=''}
  if(REPORTS_INDEX_HYDRATED&&REPORTS_REMOTE_READY&&!REPORTS_STORAGE_ERROR)return;
  if(REPORTS_INDEX_HYDRATION)return REPORTS_INDEX_HYDRATION;
  REPORTS_INDEX_HYDRATION=(async()=>{
    const remote=await githubReadReportIndex(cfg),known=new Map(remote.items.map(x=>[String(x.id),x]));
    const localFull=REPORTS.filter(x=>x&&x.id&&Array.isArray(x.questions)&&Array.isArray(x.participants));
    localFull.forEach(x=>known.set(String(x.id),x));
    REPORTS=[...known.values()].sort((a,b)=>(Number(b.completedAt)||0)-(Number(a.completedAt)||0)).slice(0,500);
    REPORTS_INDEX_HYDRATED=true;REPORTS_REMOTE_READY=true;REPORTS_STORAGE_ERROR='';
    const remoteIds=new Set(remote.items.map(x=>String(x.id)));
    const toMigrate=localFull.filter(x=>!remoteIds.has(String(x.id)));
    if(toMigrate.length)await queueReportsPersistence(toMigrate[0]);
  })().catch(e=>{REPORTS_REMOTE_READY=false;REPORTS_STORAGE_ERROR=e.message||'Не удалось загрузить отчёты из постоянного хранилища';console.error('Не удалось синхронизировать хранилище отчётов:',REPORTS_STORAGE_ERROR)}).finally(()=>{REPORTS_INDEX_HYDRATION=null});
  return REPORTS_INDEX_HYDRATION;
}

function emptyAuthSecurityState(){return{version:1,users:{},epochs:{}}}
function normalizeAuthSecurityState(value){
  const out=emptyAuthSecurityState(),users=value&&typeof value==='object'&&value.users&&typeof value.users==='object'?value.users:{};
  const epochs=value&&typeof value==='object'&&value.epochs&&typeof value.epochs==='object'?value.epochs:{};
  Object.entries(epochs).forEach(([id,epoch])=>{if(/^[A-Za-z0-9_-]{1,100}$/.test(id)&&Number.isInteger(Number(epoch))&&Number(epoch)>=0)out.epochs[id]=Number(epoch)});
  Object.entries(users).forEach(([id,record])=>{
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(id)||!record||typeof record!=='object')return;
    const secret=String(record.secret||'').replace(/=+$/,'').toUpperCase();
    if(!/^[A-Z2-7]{20,64}$/.test(secret))return;
    const recoveryHashes=Array.isArray(record.recoveryHashes)?record.recoveryHashes.map(String).filter(x=>/^[a-f0-9]{64}$/i.test(x)).slice(0,12):[];
    out.users[id]={secret,enabledAt:Number(record.enabledAt)||Date.now(),recoveryHashes};
  });
  return out;
}
const TOTP_BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer){
  let bits=0,value=0,out='';
  for(const byte of buffer){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=TOTP_BASE32[(value>>>(bits-5))&31];bits-=5;}value&=(1<<bits)-1;}
  if(bits)out+=TOTP_BASE32[(value<<(5-bits))&31];
  return out;
}
function base32Decode(input){
  const text=String(input||'').replace(/=+$/,'').toUpperCase();
  if(!text||!/^[A-Z2-7]+$/.test(text))throw new Error('Некорректный секрет двухфакторной аутентификации');
  let bits=0,value=0;const out=[];
  for(const ch of text){value=(value<<5)|TOTP_BASE32.indexOf(ch);bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;value&=(1<<bits)-1;}}
  return Buffer.from(out);
}
function generateTotpSecret(){return base32Encode(crypto.randomBytes(20))}
function totpAt(secret,timeMs=Date.now()){
  const counter=BigInt(Math.floor(timeMs/30000)),msg=Buffer.alloc(8);msg.writeBigUInt64BE(counter);
  const digest=crypto.createHmac('sha1',base32Decode(secret)).update(msg).digest(),offset=digest[digest.length-1]&15;
  const binary=digest.readUInt32BE(offset)&0x7fffffff;
  return String(binary%1000000).padStart(6,'0');
}
function verifyTotp(secret,code){
  const candidate=String(code||'').replace(/\s+/g,'');
  if(!/^\d{6}$/.test(candidate))return false;
  const received=Buffer.from(candidate,'ascii');
  for(const offset of [-1,0,1]){
    const expected=Buffer.from(totpAt(secret,Date.now()+offset*30000),'ascii');
    if(received.length===expected.length&&crypto.timingSafeEqual(received,expected))return true;
  }
  return false;
}
function authSecurityRecord(userId){return AUTH_SECURITY_STATE.users[String(userId)]||null}
function totpAuthUrl(user,secret){
  const issuer='Квиз-арена',label=encodeURIComponent(issuer+':'+String(user.login||user.name||'user'));
  return'otpauth://totp/'+label+'?secret='+secret+'&issuer='+encodeURIComponent(issuer)+'&algorithm=SHA1&digits=6&period=30';
}
function normalizeRecoveryCode(code){return String(code||'').toUpperCase().replace(/[^A-F0-9]/g,'')}
function hashRecoveryCode(code){return crypto.createHash('sha256').update(normalizeRecoveryCode(code),'utf8').digest('hex')}
function findRecoveryCode(record,code){
  const normalized=normalizeRecoveryCode(code);
  if(!/^[A-F0-9]{20}$/.test(normalized)||!record||!Array.isArray(record.recoveryHashes))return null;
  const digest=Buffer.from(hashRecoveryCode(normalized),'hex');
  let found=-1;
  record.recoveryHashes.forEach((hash,index)=>{try{const expected=Buffer.from(String(hash),'hex');if(expected.length===digest.length&&crypto.timingSafeEqual(expected,digest))found=index}catch(e){}});
  return found<0?null:{index:found,hash:digest.toString('hex')};
}
function makeRecoveryCodes(count=8){
  const codes=Array.from({length:count},()=>crypto.randomBytes(10).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'));
  return{codes,hashes:codes.map(hashRecoveryCode)};
}
async function readAuthSecurityAt(cfg,ref){
  const r=await reportsGithubFetch(cfg,'contents/auth-security.enc.json?ref='+encodeURIComponent(ref));
  if(r.status===404)return{state:emptyAuthSecurityState(),sha:null};
  const data=await reportsApiJson(r,'Не удалось прочитать защищённые настройки входа');
  if(!data.content)throw new Error('Файл защищённых настроек входа пуст');
  const raw=Buffer.from(String(data.content).replace(/\s/g,''),'base64').toString('utf8');
  const state=normalizeAuthSecurityState(decryptReportPayload(raw,cfg));
  return{state,sha:data.sha||null};
}
async function ensureAuthSecurityLoaded(){
  if(AUTH_SECURITY_READY)return true;
  if(AUTH_SECURITY_PROMISE)return AUTH_SECURITY_PROMISE;
  AUTH_SECURITY_PROMISE=(async()=>{
    const cfg=reportsStoreConfig();
    if(!cfg){
      if(String(process.env.AUTH_SECURITY_REQUIRED||'').toLowerCase()==='true')throw new Error('Не настроено постоянное защищённое хранилище двухфакторной аутентификации');
      AUTH_SECURITY_STATE=emptyAuthSecurityState();AUTH_SECURITY_PERSISTENT=false;AUTH_SECURITY_READY=true;AUTH_SECURITY_ERROR='';return true;
    }
    const ref=await githubEnsureReportsBranch(cfg),remote=await readAuthSecurityAt(cfg,ref.object.sha);
    AUTH_SECURITY_STATE=remote.state;AUTH_SECURITY_PERSISTENT=true;AUTH_SECURITY_READY=true;AUTH_SECURITY_ERROR='';return true;
  })().catch(e=>{
    AUTH_SECURITY_READY=false;AUTH_SECURITY_PERSISTENT=false;AUTH_SECURITY_ERROR=e.message||'Не удалось загрузить защищённые настройки входа';
    console.error('Не удалось загрузить настройки двухфакторной аутентификации:',AUTH_SECURITY_ERROR);
    return false;
  }).finally(()=>{AUTH_SECURITY_PROMISE=null});
  return AUTH_SECURITY_PROMISE;
}
async function persistAuthSecurityMutation(mutate){
  const cfg=reportsStoreConfig();
  if(!cfg)throw new Error('Для двухфакторной защиты нужно настроить GITHUB_TOKEN и GITHUB_REPOSITORY. Добавьте также стабильный REPORTS_ENCRYPTION_KEY для шифрования.');
  for(let attempt=0;attempt<4;attempt++){
    const branchRef=await githubEnsureReportsBranch(cfg),parent=branchRef.object.sha;
    const current=await readAuthSecurityAt(cfg,parent),next=normalizeAuthSecurityState(current.state);
    await mutate(next);
    const blobRes=await reportsGithubFetch(cfg,'git/blobs',{method:'POST',body:{content:encryptReportPayload(next,cfg),encoding:'utf-8'}});
    const blob=await reportsApiJson(blobRes,'Не удалось зашифровать настройки двухфакторной защиты');
    const commitRes=await reportsGithubFetch(cfg,'git/commits/'+parent);
    const base=await reportsApiJson(commitRes,'Не удалось прочитать защищённое хранилище');
    const treeRes=await reportsGithubFetch(cfg,'git/trees',{method:'POST',body:{base_tree:base.tree.sha,tree:[{path:'auth-security.enc.json',mode:'100644',type:'blob',sha:blob.sha}]}});
    const tree=await reportsApiJson(treeRes,'Не удалось подготовить защищённые настройки');
    const commitCreate=await reportsGithubFetch(cfg,'git/commits',{method:'POST',body:{message:'Update encrypted account security settings',tree:tree.sha,parents:[parent]}});
    const commit=await reportsApiJson(commitCreate,'Не удалось сохранить защищённые настройки');
    const update=await reportsGithubFetch(cfg,'git/refs/heads/'+encodeURIComponent(cfg.reportsBranch),{method:'PATCH',body:{sha:commit.sha,force:false}});
    if(update.ok){
      AUTH_SECURITY_STATE=next;AUTH_SECURITY_READY=true;AUTH_SECURITY_PERSISTENT=true;AUTH_SECURITY_ERROR='';return next;
    }
    if((update.status===409||update.status===422)&&attempt<3)continue;
    await reportsApiJson(update,'Не удалось обновить защищённое хранилище настроек');
  }
  throw new Error('Настройки безопасности одновременно изменились. Повторите операцию.');
}
function cleanupAuthTransientMaps(){
  const now=Date.now();
  for(const [key,value] of TOTP_SETUP_PENDING)if(value.expires<=now)TOTP_SETUP_PENDING.delete(key);
  for(const [key,value] of TOTP_LOGIN_CHALLENGES)if(value.expires<=now)TOTP_LOGIN_CHALLENGES.delete(key);
  for(const [key,value] of TOTP_FAILS)if((value.until&&value.until<=now)||(!value.until&&now-(value.last||0)>5*60000))TOTP_FAILS.delete(key);
  while(TOTP_FAILS.size>2000)TOTP_FAILS.delete(TOTP_FAILS.keys().next().value);
  while(TOTP_SETUP_PENDING.size>200)TOTP_SETUP_PENDING.delete(TOTP_SETUP_PENDING.keys().next().value);
  while(TOTP_LOGIN_CHALLENGES.size>500)TOTP_LOGIN_CHALLENGES.delete(TOTP_LOGIN_CHALLENGES.keys().next().value);
}
function authRequestIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim().slice(0,100)}
function passwordMatches(user,password){return !!user&&checkPw(user,String(password||''))}
function mfaFailureKey(req,userId){return authRequestIp(req)+'|'+String(userId)}
function recordMfaFailure(key){
  const now=Date.now(),old=TOTP_FAILS.get(key),n=(old&&old.n||0)+1;
  TOTP_FAILS.set(key,n>=5?{n:0,until:now+60000,last:now}:{n,until:0,last:now});
}
function reportsStorageState(){
  const configured=!!githubConfig();
  return{configured,persistent:configured&&REPORTS_REMOTE_READY&&!REPORTS_STORAGE_ERROR,error:REPORTS_STORAGE_ERROR||''};
}
async function githubLoadFullReport(id){
  const cfg=reportsStoreConfig();if(!cfg)return null;
  const ref=await githubEnsureReportsBranch(cfg);
  return githubReadReport(cfg,id,ref.object.sha);
}

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
function leastPopulatedTeam(counts){
  const min=Math.min(...counts),choices=[];
  counts.forEach((n,i)=>{if(n===min)choices.push(i)});
  return choices[Math.floor(Math.random()*choices.length)];
}
function leastPopulatedKingdom(g,count){
  const sizes=Array(count).fill(0);
  for(const player of g.players.values()){
    if(Number.isInteger(player.team)&&player.team>=0&&player.team<count)sizes[player.team]++;
  }
  return leastPopulatedTeam(sizes);
}
function newPlayer(g,name){
  const p={name,score:0,lastQ:-1,lastA:[],lastPts:0,log:[]};
  if(g.mode==='kingdoms'){
    Object.assign(p,{team:0,prog:0,flags:0,placed:0,correctN:0,answeredN:0,qn:0,fb:null,queue:[],qi:0,cur:0});
    if(g.kb){const count=clampInt(g.kb.kingdomCount,2,4,2);p.team=leastPopulatedKingdom(g,count);initQ(g,p)}
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
function successPercent(correctCount,totalCount){
  const total=Math.max(0,Number(totalCount)||0),correct=Math.max(0,Number(correctCount)||0);
  return total?Math.round(Math.min(correct,total)/total*100):0;
}
function makeGameReport(g,{incomplete=false}={}){
  const roster=[...g.players.entries()].map(([id,p])=>({id,...p,removed:false})).concat((g.left||[]).map(p=>({...p,removed:true,log:Array.isArray(p.log)?p.log:[]})));
  const questions=(g.quiz.q||[]).map((q,qi)=>{
    const attempts=[];const respondents=new Set();
    roster.forEach(p=>(p.log||[]).forEach(l=>{if(Number(l.qi)===qi){attempts.push({name:p.name,playerId:p.id||'',ok:!!l.ok,answers:Array.isArray(l.a)?l.a:[],points:Number(l.pts)||0,ms:Number(l.ms)||0});respondents.add(p.id||p.name)}}));
    const answerCounts=q.a.map((text,ai)=>({index:ai,text,count:attempts.reduce((n,l)=>n+(l.answers.includes(ai)?1:0),0),correct:(q.cs||[]).includes(ai)}));
    const correctCount=attempts.filter(a=>a.ok).length,incorrectCount=attempts.length-correctCount;
    const groupAccuracy=roster.length?Math.round(correctCount/roster.length*1000)/10:0;
    const belowGroupThreshold=roster.length>0&&(correctCount/roster.length)<0.4;
    return{index:qi+1,t:q.t,a:[...q.a],correct:[...q.cs],correctText:q.cs.map(i=>q.a[i]),responseCount:attempts.length,respondentCount:respondents.size,correctCount,incorrectCount,accuracy:successPercent(correctCount,g.mode==='classic'?roster.length:attempts.length),groupAccuracy,belowGroupThreshold,answerCounts,attempts};
  });
  const participants=roster.map(p=>{
    const logs=Array.isArray(p.log)?p.log:[],correctCount=logs.filter(l=>l.ok).length,incorrectCount=logs.length-correctCount;
    const uniqueQuestions=new Set(logs.map(l=>Number(l.qi)).filter(qi=>Number.isInteger(qi)&&qi>=0&&qi<questions.length)).size;
    const classicUnanswered=g.mode==='classic'?Math.max(0,questions.length-uniqueQuestions):null;
        return{id:p.id||'',name:String(p.name||'Участник'),score:Number(p.score)||0,team:Number.isInteger(p.team)?p.team:null,placed:Number(p.placed)||0,correctCount,incorrectCount,answeredCount:logs.length,unansweredCount:classicUnanswered,accuracy:successPercent(correctCount,g.mode==='classic'?questions.length:logs.length),removed:!!p.removed,log:logs.map(l=>({qi:Number(l.qi),a:Array.isArray(l.a)?[...l.a]:[],ok:!!l.ok,pts:Number(l.pts)||0,ms:Number(l.ms)||0}))};
  }).sort((a,b)=>g.mode==='kingdoms'?(b.placed-a.placed||b.correctCount-a.correctCount||a.name.localeCompare(b.name)):(b.score-a.score||b.correctCount-a.correctCount||a.name.localeCompare(b.name)));
  participants.forEach((p,i)=>p.rank=i+1);
  const totalAnswers=questions.reduce((n,q)=>n+q.responseCount,0),totalCorrect=questions.reduce((n,q)=>n+q.correctCount,0),totalIncorrect=questions.reduce((n,q)=>n+q.incorrectCount,0);
  const totalPossible=g.mode==='classic'?participants.length*questions.length:null;
  const teamKeys=[...new Set(participants.map(p=>p.team).filter(Number.isInteger))].sort((a,b)=>a-b);
  const teams=teamKeys.map(k=>{const members=participants.filter(p=>p.team===k),tiles=g.kb&&g.kb.board?g.kb.board.filter(x=>x===k).length:0,answers=members.reduce((n,p)=>n+p.answeredCount,0),correctCount=members.reduce((n,p)=>n+p.correctCount,0);return{k,name:TEAM_NAMES[k]||('Королевство '+(k+1)),members:members.length,points:members.reduce((n,p)=>n+p.score,0),correctCount,incorrectCount:members.reduce((n,p)=>n+p.incorrectCount,0),answers,accuracy:successPercent(correctCount,answers),flags:members.reduce((n,p)=>n+p.placed,0),tiles,trophies:g.kb&&g.kb.trophies?Number(g.kb.trophies[k])||0:0};});
  const accuracies=participants.map(p=>g.mode==='classic'?(questions.length?p.correctCount/questions.length*100:0):(p.answeredCount?p.correctCount/p.answeredCount*100:0));
  const completedAt=Date.now(),startedAt=Number(g.startedAt)||Number(g.born)||completedAt,playedSeconds=Math.max(0,Math.round((completedAt-startedAt)/1000));
  return{id:'report-'+g.pin+'-'+completedAt.toString(36)+'-'+rid(),pin:g.pin,sourceId:g.sourceId||'',ownerId:g.owner,title:g.quiz.title,mode:g.mode,modeName:g.mode==='kingdoms'?'Color Kingdoms':'Classic',supportThreshold:((g.appSettings||APP_SETTINGS).general.supportThreshold),startedAt,completedAt,incomplete:!!incomplete,questionCount:questions.length,participantCount:participants.length,questions,participants,teams,summary:{participantCount:participants.length,questionCount:questions.length,totalAnswers,totalCorrect,totalIncorrect,accuracy:successPercent(totalCorrect,g.mode==='classic'?totalPossible:totalAnswers),averageScore:participants.length?Math.round(participants.reduce((n,p)=>n+p.score,0)/participants.length):0,averageParticipantAccuracy:accuracies.length?Math.round(accuracies.reduce((a,b)=>a+b,0)/accuracies.length):0,unanswered:g.mode==='classic'?Math.max(0,(totalPossible||0)-totalAnswers):null,playedSeconds,winner:g.kb?g.kb.winner:null}};
}
async function saveGameReport(g,options={}){
  if(g.reportSavePromise)return g.reportSavePromise;
  if(g.reportId)return g.reportId;
  const report=makeGameReport(g,options);
  g.reportId=report.id;g.report=report;REPORTS=[report,...REPORTS.filter(x=>x.id!==report.id)].slice(0,500);
  if(!writeJ('reports.json',REPORTS))console.warn('Не удалось записать локальную копию отчёта reports.json');
  g.reportSavePromise=(async()=>{
    let cfg=null;
    try{cfg=reportsStoreConfig()}catch(e){REPORTS_STORAGE_ERROR=e.message||'Ошибка настройки хранилища отчётов'}
    if(!cfg){
      if(!REPORTS_STORAGE_ERROR)REPORTS_STORAGE_ERROR='Постоянное хранилище не настроено: задайте GITHUB_TOKEN и GITHUB_REPOSITORY, а токену выдайте Contents: Read and write.';
      console.warn('Отчёт '+report.id+' сохранён только локально: '+REPORTS_STORAGE_ERROR);
      return report.id;
    }
    try{await queueReportsPersistence(report)}
    catch(e){REPORTS_REMOTE_READY=false;REPORTS_STORAGE_ERROR=e.message||'Не удалось сохранить отчёт в постоянное хранилище';console.error('Не удалось сохранить отчёт '+report.id+' в GitHub:',REPORTS_STORAGE_ERROR)}
    return report.id;
  })();
  return g.reportSavePromise;
}

// ---- Classic ----
function view(g,id,R0){
  const R=R0||ranked(g),host=id===g.hostId,q=g.quiz.q[g.qi];
  const v={state:g.state,resultEndsAt:g.resultEndsAt||0,pin:g.pin,qi:g.qi,total:g.quiz.q.length,title:g.quiz.title,T:q.T,mode:g.mode,locked:!!g.locked,dur:g.quiz.dur,need:g.quiz.need,
    elapsed:Date.now()-g.qStart,host,kingdomCount:clampInt((g.appSettings||APP_SETTINGS).modes.kingdoms.kingdomCount,2,4,2),top:R.slice(0,10).map(p=>({name:p.name,score:p.score,roundPts:p.lastQ===g.qi?(Number(p.lastPts)||0):0}))};
  if(host&&g.state==='lobby'){const app=g.appSettings||APP_SETTINGS;v.lobbySettings={classic:{basePoints:app.modes.classic.basePoints,speedBonus:app.modes.classic.speedBonus},kingdoms:{durationMinutes:g.quiz.dur,correctAnswersForFlag:g.quiz.need,kingdomCount:clampInt(app.modes.kingdoms.kingdomCount,2,4,2)}}}
  if(host&&g.reportId)v.reportId=g.reportId;
  if(g.mode==='classic'&&g.state==='final')v.finalRows=R.map((p,i)=>({rank:i+1,name:p.name,score:p.score}));
  if(g.state==='question'||g.state==='results')v.q=host?{t:q.t,a:q.a,multi:q.cs.length>1}:{n:q.a.length,t:q.t,multi:q.cs.length>1};
  if(g.state==='results'&&(host||(g.appSettings||APP_SETTINGS).general.showCorrectAnswerAfterQuestion))v.correct=q.cs;
  if(host){
    v.names=R.map(p=>p.name);
    v.rows=R.map(p=>{
      const an=p.lastQ===g.qi,answeredN=(p.log||[]).length,correctN=(p.log||[]).reduce((n,l)=>n+(l.ok?1:0),0);
      const r={id:p.id,name:p.name,score:p.score,ans:an,team:Number.isInteger(p.team)?p.team:null,online:playerOnline(g,p.id),answeredN,correctN,accuracy:successPercent(correctN,g.mode==='classic'?g.quiz.q.length:answeredN)};
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
  if(g.qi===0||!g.startedAt)g.startedAt=Date.now();
  g.state='question';g.resultEndsAt=0;g.qStart=Date.now();clearTimeout(g.timer);
  g.timer=setTimeout(()=>toResults(g),g.quiz.q[g.qi].T*1000+500);push(g);
}
function toResults(g){
  if(g.state!=='question')return;
  clearTimeout(g.timer);
  g.state='results';
  g.resultEndsAt=Date.now()+3000;
  push(g);
  // Keep the intermediate ranking visible for three seconds, then advance without host input.
  g.timer=setTimeout(()=>{
    if(g.state!=='results')return;
    if(g.qi>=g.quiz.q.length-1){
      const saved=saveGameReport(g);
      g.state='final';g.resultEndsAt=0;push(g);
      Promise.resolve(saved).then(()=>push(g)).catch(e=>console.error('Не удалось сохранить итоговый отчёт:',e.message));
      return;
    }
    g.qi++;
    startQ(g);
  },3000);
}

// ---- Color Kingdoms: six-neighbour hex map and 2–4 kingdoms ----
const adjN=(i,N)=>{
  const x=i%N,y=Math.floor(i/N),r=[];
  if(x>0)r.push(i-1);if(x<N-1)r.push(i+1);
  const diagonals=y%2===0?[-1,0]:[0,1];
  for(const yy of [y-1,y+1]){
    if(yy<0||yy>=N)continue;
    for(const dx of diagonals){const xx=x+dx;if(xx>=0&&xx<N)r.push(yy*N+xx)}
  }
  return r;
};
function resetBoard(kb){
  const N=kb.N,R=N-1-Math.round(N/4),r=Math.round(N/4),count=kb.kingdomCount||2;
  const forts=[
    {y:r,x:r,arms:[[0,0],[0,1],[1,0]]},
    {y:R,x:R,arms:[[0,0],[0,-1],[-1,0]]},
    {y:r,x:R,arms:[[0,0],[0,-1],[1,0]]},
    {y:R,x:r,arms:[[0,0],[0,1],[-1,0]]}
  ];
  kb.board=Array(N*N).fill(-1);kb.rooks=Array(count).fill(-1);
  forts.slice(0,count).forEach((fort,team)=>{
    kb.rooks[team]=fort.y*N+fort.x;
    fort.arms.forEach(([dy,dx])=>{
      const yy=fort.y+dy,xx=fort.x+dx;
      if(yy>=0&&yy<N&&xx>=0&&xx<N)kb.board[yy*N+xx]=team;
    });
  });
  kb.hot=[];
}
function initQ(g,p){p.queue=shuffle(g.quiz.q.map((_,i)=>i));p.qi=0;p.cur=p.queue[0]}
function nextQ(g,p){
  p.qi++;
  if(p.qi>=p.queue.length){const last=p.cur;p.queue=shuffle(g.quiz.q.map((_,i)=>i));if(p.queue.length>1&&p.queue[0]===last)p.queue.push(p.queue.shift());p.qi=0}
  p.cur=p.queue[p.qi];
}
function startK(g){
  const ids=shuffle([...g.players.keys()]),n=ids.length,N=n<=10?9:n<=20?11:n<=35?15:n<=60?17:19;
  const cfg=(g.appSettings||APP_SETTINGS).modes.kingdoms||APP_SETTINGS.modes.kingdoms;
  const kingdomCount=clampInt(cfg.kingdomCount,2,4,2),durationMinutes=clampInt(g.quiz.dur,5,20,cfg.durationMinutes),need=clampInt(g.quiz.need,1,5,cfg.correctAnswersForFlag);
  g.startedAt=Date.now();
  const kb=g.kb={N,kingdomCount,round:1,trophies:Array(kingdomCount).fill(0),need,dur:durationMinutes*60000,banner:null,winner:null};
  resetBoard(kb);const teamCounts=Array(kingdomCount).fill(0);ids.forEach(id=>{const p=g.players.get(id);p.team=leastPopulatedTeam(teamCounts);teamCounts[p.team]++;initQ(g,p)});
  kb.endsAt=Date.now()+kb.dur;g.state='playing';clearTimeout(g.timer);g.timer=setTimeout(()=>finishK(g),kb.dur+200);push(g);
}
async function finishK(g){
  if(g.state!=='playing')return;
  clearTimeout(g.timer);
  const kb=g.kb,count=kb.kingdomCount||2,tiles=Array.from({length:count},(_,k)=>kb.board.filter(o=>o===k).length),maxTiles=Math.max(...tiles);
  const territorialLeaders=tiles.map((n,k)=>n===maxTiles?k:-1).filter(k=>k>=0);
  // If no rook was captured in the final active round, settle that round by occupied territory.
  // A unique territory leader wins one trophy; equal cell counts make the round a draw.
  kb.roundWinner=territorialLeaders.length===1?territorialLeaders[0]:-1;
  kb.roundWinReason='territory';
  if(territorialLeaders.length===1)kb.trophies[territorialLeaders[0]]++;
  const maxTrophies=Math.max(...kb.trophies),trophyLeaders=kb.trophies.map((n,k)=>n===maxTrophies?k:-1).filter(k=>k>=0);
  if(trophyLeaders.length===1)kb.winner=trophyLeaders[0];
  else kb.winner=territorialLeaders.length===1?territorialLeaders[0]:-1;
  g.state='final';await saveGameReport(g);push(g);
}
const validTiles=(kb,team)=>{const r=[];for(let i=0;i<kb.board.length;i++)if(kb.board[i]!==team&&!kb.rooks.includes(i)&&adjN(i,kb.N).some(j=>kb.board[j]===team))r.push(i);return r};
function enclose(kb,team){
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
  const captured=kb.rooks.map((rook,team)=>({rook,team})).filter(x=>x.team!==p.team&&caught.includes(x.rook));
  if(captured.length){kb.trophies[p.team]+=captured.length;kb.banner={team:p.team,at:Date.now()};kb.round++;resetBoard(kb)}
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
  const kb=g.kb,now=Date.now(),count=kb.kingdomCount||2;
  const stats=Array.from({length:count},(_,t)=>{const m=R.filter(p=>p.team===t);return{k:t,name:TEAM_NAMES[t]||('Королевство '+(t+1)),tiles:kb.board.filter(o=>o===t).length,members:m.length,trophies:kb.trophies[t],correct:m.reduce((s,p)=>s+p.correctN,0),flags:m.reduce((s,p)=>s+p.placed,0)}});
  return{state:g.state,mode:'kingdoms',pin:g.pin,title:g.quiz.title,N:kb.N,kingdomCount:count,board:kb.board,rooks:kb.rooks,hot:kb.hot,round:kb.round,need:kb.need,dur:kb.dur,reportId:g.reportId||null,
    left:g.state==='playing'?Math.max(0,kb.endsAt-now):0,stats,winner:kb.winner,roundWinner:kb.roundWinner===undefined?null:kb.roundWinner,roundWinReason:kb.roundWinReason||null,locked:!!g.locked,total:g.quiz.q.length,
    banner:kb.banner&&now-kb.banner.at<4500?{team:kb.banner.team,age:now-kb.banner.at,n:kb.round}:null,
    top:R.slice().sort((a,b)=>b.placed-a.placed||b.correctN-a.correctN).slice(0,8).map(p=>({name:p.name,team:p.team,placed:p.placed,correct:p.correctN}))};
}
function viewK(g,id,C){
  const host=id===g.hostId,v={...C,host};
  if(host)v.rows=[...g.players.entries()].map(([i,p])=>({
    id:i,name:p.name,team:p.team,placed:p.placed,flags:p.placed||0,score:p.score||0,
    correct:p.correctN||0,correctN:p.correctN||0,answered:p.answeredN||0,answeredN:p.answeredN||0,
    accuracy:successPercent(p.correctN||0,p.answeredN||0),
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
const LIBFILES={'/xlsx.js':'xlsx.mini.min.js','/qr.js':'qrcode.js','/tailwind.css':'tailwind.css','/ui.css':'ui.css','/liquid-glass.css':'liquid-glass.css','/responsive-v2.css':'responsive-v2.css','/lobby.css':'lobby.css','/favicon.svg':'favicon.svg','/favicon.png':'favicon.png','/favicon.ico':'favicon.ico','/apple-touch-icon.png':'apple-touch-icon.png'};

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
    return json(res,{urls,hasUsers:USERS.length>0,regOpen:USERS.length===0||!!INVITE,needInvite:USERS.length>0&&!!INVITE,settings:APP_SETTINGS,version:APP_VERSION});
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

  // ---------- аккаунты и двухфакторная аутентификация ----------
  if(u.pathname.startsWith('/api/auth/')){
    const loaded=await ensureAuthSecurityLoaded();
    if(!loaded)return json(res,{error:'Не удалось загрузить настройки безопасности. Повторите попытку позже.'},503);
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
      cleanupAuthTransientMaps();
      const login=str(b.login,40).trim(),ip=authRequestIp(req),key=ip+'|'+login.toLowerCase(),now=Date.now(),f=FAILS.get(key);
      if(f&&f.until>now)return json(res,{error:'Слишком много неудачных попыток. Подождите минуту.'},429);
      const nu=USERS.find(x=>x.login.toLowerCase()===login.toLowerCase());
      if(!nu||!checkPw(nu,b.pass)){const n=(f?f.n:0)+1;FAILS.set(key,n>=5?{n:0,until:now+60000}:{n,until:0});return json(res,{error:'Неверный логин или пароль'},401)}
      FAILS.delete(key);
      if(authSecurityRecord(nu.id)){
        const challenge=crypto.randomBytes(32).toString('hex');
        TOTP_LOGIN_CHALLENGES.set(challenge,{uid:nu.id,expires:Date.now()+5*60000,ip,tries:0});
        return json(res,{twoFactorRequired:true,challenge});
      }
      return json(res,{token:newSession(nu,false),user:pubUser(nu)});
    }
    if(op==='verify-2fa'){
      cleanupAuthTransientMaps();
      const challenge=String(b.challenge||''),pending=TOTP_LOGIN_CHALLENGES.get(challenge);
      if(!pending||pending.expires<=Date.now())return json(res,{error:'Сеанс подтверждения истёк. Войдите снова.'},401);
      const u=USERS.find(x=>String(x.id)===String(pending.uid)),record=authSecurityRecord(pending.uid);
      if(!u||!record){TOTP_LOGIN_CHALLENGES.delete(challenge);return json(res,{error:'Настройка двухфакторной защиты не найдена. Войдите снова.'},401)}
      const failureKey=mfaFailureKey(req,pending.uid),failure=TOTP_FAILS.get(failureKey);
      if(failure&&failure.until>Date.now())return json(res,{error:'Слишком много неверных кодов. Подождите минуту.'},429);
      const input=String(b.code||'').trim();
      let valid=verifyTotp(record.secret,input),backup=null;
      if(!valid){backup=findRecoveryCode(record,input);valid=!!backup}
      if(!valid){
        recordMfaFailure(failureKey);pending.tries=(pending.tries||0)+1;
        if(pending.tries>=5)TOTP_LOGIN_CHALLENGES.delete(challenge);
        return json(res,{error:pending.tries>=5?'Слишком много неверных кодов. Начните вход заново.':'Неверный код приложения или резервный код.'},401);
      }
      if(backup){
        try{
          await persistAuthSecurityMutation(state=>{
            const live=state.users[String(pending.uid)];
            if(!live||!Array.isArray(live.recoveryHashes))throw new Error('Резервный код уже использован');
            const index=live.recoveryHashes.indexOf(backup.hash);
            if(index<0)throw new Error('Резервный код уже использован');
            live.recoveryHashes.splice(index,1);
          });
        }catch(e){return json(res,{error:'Не удалось безопасно отметить резервный код как использованный. Повторите попытку.'},503)}
      }
      TOTP_LOGIN_CHALLENGES.delete(challenge);TOTP_FAILS.delete(failureKey);
      return json(res,{token:newSession(u,true),user:pubUser(u)});
    }
    if(op==='2fa/status'){
      const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход',code:401},401);
      return json(res,{enabled:!!authSecurityRecord(me.id),persistent:AUTH_SECURITY_PERSISTENT,storageNotice:AUTH_SECURITY_PERSISTENT?'':'Для включения 2FA необходимо настроить постоянное зашифрованное хранилище GitHub (GITHUB_TOKEN и GITHUB_REPOSITORY; рекомендуется REPORTS_ENCRYPTION_KEY).'});
    }
    if(op==='2fa/setup'){
      const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход',code:401},401);
      if(!passwordMatches(me,b.password))return json(res,{error:'Неверный пароль'},401);
      if(!AUTH_SECURITY_PERSISTENT||!reportsStoreConfig())return json(res,{error:'Для включения 2FA нужно настроить GITHUB_TOKEN и GITHUB_REPOSITORY. Добавьте также стабильный REPORTS_ENCRYPTION_KEY для шифрования.'},503);
      if(authSecurityRecord(me.id))return json(res,{error:'Двухфакторная защита уже включена. Сначала отключите её с подтверждением.'},409);
      cleanupAuthTransientMaps();
      const secret=generateTotpSecret(),setupToken=crypto.randomBytes(24).toString('hex');
      TOTP_SETUP_PENDING.set(setupToken,{uid:me.id,secret,expires:Date.now()+10*60000});
      return json(res,{setupToken,secret,otpauthUrl:totpAuthUrl(me,secret),expiresIn:600});
    }
    if(op==='2fa/confirm'){
      const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход',code:401},401);
      const setupToken=String(b.setupToken||''),pending=TOTP_SETUP_PENDING.get(setupToken);
      if(!pending||String(pending.uid)!==String(me.id)||pending.expires<=Date.now()){TOTP_SETUP_PENDING.delete(setupToken);return json(res,{error:'Сеанс настройки истёк. Начните настройку заново.'},401)}
      if(!verifyTotp(pending.secret,b.code))return json(res,{error:'Неверный код. Проверьте время на телефоне и попробуйте ещё раз.'},400);
      const recovery=makeRecoveryCodes(8),userId=String(me.id);
      try{
        await persistAuthSecurityMutation(state=>{
          if(state.users[userId])throw new Error('Двухфакторная защита уже включена');
          state.epochs[userId]=(Number(state.epochs[userId])||0)+1;
          state.users[userId]={secret:pending.secret,enabledAt:Date.now(),recoveryHashes:recovery.hashes};
        });
      }catch(e){return json(res,{error:'Не удалось сохранить настройки 2FA. Проверьте постоянное хранилище и повторите попытку.'},503)}
      TOTP_SETUP_PENDING.delete(setupToken);
      return json(res,{ok:true,enabled:true,recoveryCodes:recovery.codes});
    }
    if(op==='2fa/disable'){
      const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход',code:401},401);
      const record=authSecurityRecord(me.id);
      if(!record)return json(res,{error:'Двухфакторная защита уже отключена.'},400);
      if(!passwordMatches(me,b.password))return json(res,{error:'Неверный пароль'},401);
      const input=String(b.code||'').trim(),totpOk=verifyTotp(record.secret,input),backup=findRecoveryCode(record,input);
      if(!totpOk&&!backup)return json(res,{error:'Неверный код приложения или резервный код.'},401);
      const userId=String(me.id);
      try{
        await persistAuthSecurityMutation(state=>{
          const live=state.users[userId];
          if(!live)throw new Error('Двухфакторная защита уже отключена');
          if(backup){
            const index=Array.isArray(live.recoveryHashes)?live.recoveryHashes.indexOf(backup.hash):-1;
            if(index<0)throw new Error('Резервный код уже использован');
          }
          delete state.users[userId];
          state.epochs[userId]=(Number(state.epochs[userId])||0)+1;
        });
      }catch(e){return json(res,{error:'Не удалось сохранить изменение настроек безопасности. Повторите попытку.'},503)}
      return json(res,{ok:true,enabled:false});
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
    await hydrateReportsFromGitHub({force:!!b.forceRefresh});
    const items=REPORTS.filter(r=>me.admin||r.ownerId===me.id).map(r=>({id:r.id,pin:r.pin,title:r.title,sourceId:r.sourceId,mode:r.mode,modeName:r.modeName,completedAt:r.completedAt,incomplete:!!r.incomplete,questionCount:r.questionCount,participantCount:r.participantCount,accuracy:r.summary&&r.summary.accuracy!==undefined?r.summary.accuracy:r.accuracy,averageScore:r.summary&&r.summary.averageScore!==undefined?r.summary.averageScore:r.averageScore}));
    return json(res,{items,storage:reportsStorageState()});
  }
  if(u.pathname==='/api/reports/delete'){
    const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход в аккаунт',code:401},401);
    const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(x=>String(x||'')))]:[];
    if(!ids.length||ids.length>500||ids.some(id=>!/^report-[A-Za-z0-9_-]{1,140}$/.test(id)))return json(res,{error:'Выберите от 1 до 500 корректных отчётов'},400);
    await hydrateReportsFromGitHub();
    if(REPORTS_STORAGE_ERROR||!REPORTS_REMOTE_READY)return json(res,{error:'Не удалось проверить постоянное хранилище. Удаление отменено, чтобы не потерять отчёты.',storage:reportsStorageState()},503);
    const byId=new Map(REPORTS.filter(r=>r&&r.id).map(r=>[String(r.id),r]));
    for(const id of ids){
      const report=byId.get(id);
      if(!report)return json(res,{error:'Один из выбранных отчётов больше не найден. Обновите список и повторите попытку.'},404);
      if(!me.admin&&String(report.ownerId)!==String(me.id))return json(res,{error:'Нет доступа к удалению одного из выбранных отчётов'},403);
    }
    try{
      const result=await queueReportsDeletion(ids);
      REPORTS=REPORTS.filter(r=>!ids.includes(String(r&&r.id)));
      writeJ('reports.json',REPORTS);
      console.log('Удалено отчётов:',ids.length,'(постоянное хранилище:',result.deletedFromRemote,')');
      return json(res,{ok:true,deleted:ids.length,deletedFromRemote:result.deletedFromRemote,storage:reportsStorageState()});
    }catch(e){
      REPORTS_REMOTE_READY=false;REPORTS_STORAGE_ERROR=e.message||'Не удалось удалить отчёты из постоянного хранилища';
      console.error('Не удалось удалить отчёты:',REPORTS_STORAGE_ERROR);
      return json(res,{error:REPORTS_STORAGE_ERROR,storage:reportsStorageState()},500);
    }
  }
  if(u.pathname==='/api/reports/export'){
    const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход в аккаунт',code:401},401);
    const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(x=>String(x||'')))]:[];
    if(!ids.length||ids.length>100||ids.some(id=>!/^report-[A-Za-z0-9_-]{1,140}$/.test(id)))return json(res,{error:'Выберите от 1 до 100 корректных отчётов для экспорта'},400);
    await hydrateReportsFromGitHub();
    const byId=new Map(REPORTS.filter(r=>r&&r.id).map(r=>[String(r.id),r]));
    const selected=[];
    let hydrated=false;
    for(const id of ids){
      let report=byId.get(id);
      if(!report)return json(res,{error:'Один из выбранных отчётов больше не найден. Обновите список и повторите попытку.'},404);
      if(!me.admin&&String(report.ownerId)!==String(me.id))return json(res,{error:'Нет доступа к одному из выбранных отчётов'},403);
      if(!Array.isArray(report.questions)||!Array.isArray(report.participants)){
        try{
          report=await githubLoadFullReport(id);
          if(!report)return json(res,{error:'Полный отчёт не найден в постоянном хранилище: '+id,storage:reportsStorageState()},404);
          hydrated=true;
          byId.set(id,report);
        }catch(e){
          REPORTS_REMOTE_READY=false;REPORTS_STORAGE_ERROR=e.message||'Не удалось загрузить полный отчёт';
          console.error('Не удалось загрузить отчёт для экспорта '+id+':',REPORTS_STORAGE_ERROR);
          return json(res,{error:'Не удалось загрузить все выбранные отчёты. '+REPORTS_STORAGE_ERROR,storage:reportsStorageState()},503);
        }
      }
      selected.push(report);
    }
    if(hydrated){
      REPORTS=[...byId.values()].sort((a,b)=>Number(b.completedAt||0)-Number(a.completedAt||0)).slice(0,500);
      writeJ('reports.json',REPORTS);
    }
    return json(res,{reports:selected,storage:reportsStorageState()});
  }
  if(u.pathname==='/api/reports/get'){
    const me=userOf(b.token);if(!me)return json(res,{error:'Требуется вход в аккаунт',code:401},401);
    await hydrateReportsFromGitHub();
    let report=REPORTS.find(r=>r.id===b.reportId);
    if(!report)return json(res,{error:'Отчёт не найден',storage:reportsStorageState()},404);
    if(!me.admin&&report.ownerId!==me.id)return json(res,{error:'Нет доступа'},403);
    if(!Array.isArray(report.questions)||!Array.isArray(report.participants)){
      try{
        report=await githubLoadFullReport(String(b.reportId));
        if(!report)return json(res,{error:'Полный отчёт не найден в постоянном хранилище',storage:reportsStorageState()},404);
        REPORTS=[report,...REPORTS.filter(x=>x.id!==report.id)].sort((a,b)=>Number(b.completedAt||0)-Number(a.completedAt||0)).slice(0,500);
        writeJ('reports.json',REPORTS);
      }catch(e){
        REPORTS_REMOTE_READY=false;REPORTS_STORAGE_ERROR=e.message||'Не удалось загрузить полный отчёт';
        console.error('Не удалось загрузить отчёт '+String(b.reportId)+':',REPORTS_STORAGE_ERROR);
        return json(res,{error:'Не удалось загрузить сохранённый отчёт. '+REPORTS_STORAGE_ERROR,storage:reportsStorageState()},503);
      }
    }
    return json(res,{report,storage:reportsStorageState()});
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
    return json(res,{mode:g.mode,title:g.quiz.title,playedSeconds:Math.max(0,Math.round((Date.now()-(g.startedAt||g.born||Date.now()))/1000)),teams:K?commonK(g,R).stats:null,questions:g.quiz.q.map(q=>({t:q.t,a:q.a,cs:q.cs})),
      players:[...g.players.values(),...g.left].map(p=>({name:p.name,score:p.score,team:p.team,placed:p.placed,correctN:p.correctN,answeredN:p.answeredN,log:p.log}))});
  }
  if(u.pathname==='/api/action'){
    const host=b.id===g.hostId,p=g.players.get(b.id),KM=g.mode==='kingdoms';
    // Handle moderation before the mode-specific action chain, so kicking works
    // the same way in the lobby, Classic and Color Kingdoms.
    if(b.type==='kick'){
      if(!host)return json(res,{error:'Только ведущий может исключать игроков'},403);
      const targetId=String(b.a||''),target=g.players.get(targetId);
      if(!target)return json(res,{error:'Игрок уже отсутствует в этой комнате. Обновите список участников.'},409);
      const removed={id:targetId,name:target.name};
      removePlayer(g,targetId,{state:'kicked'});
      console.log('Ведущий исключил игрока «'+removed.name+'» из комнаты '+g.pin);
      return json(res,{ok:1,removed});
    }
    if(b.type==='lobby-settings'){
      if(!host)return json(res,{error:'Изменять настройки лобби может только ведущий'},403);
      if(g.state!=='lobby')return json(res,{error:'Настройки можно менять только до начала игры'},400);
      const incoming=b.settings&&typeof b.settings==='object'?b.settings:{},next=normalizeAppSettings(g.appSettings||APP_SETTINGS);
      if(KM){
        const value=incoming.kingdoms&&typeof incoming.kingdoms==='object'?incoming.kingdoms:{};
        next.modes.kingdoms.durationMinutes=clampInt(value.durationMinutes,5,20,next.modes.kingdoms.durationMinutes);
        next.modes.kingdoms.correctAnswersForFlag=clampInt(value.correctAnswersForFlag,1,5,next.modes.kingdoms.correctAnswersForFlag);
        next.modes.kingdoms.kingdomCount=clampInt(value.kingdomCount,2,4,next.modes.kingdoms.kingdomCount);
        g.quiz.dur=next.modes.kingdoms.durationMinutes;g.quiz.need=next.modes.kingdoms.correctAnswersForFlag;
      }else{
        const value=incoming.classic&&typeof incoming.classic==='object'?incoming.classic:{};
        next.modes.classic.basePoints=clampInt(value.basePoints,100,3000,next.modes.classic.basePoints);
        if(typeof value.speedBonus==='boolean')next.modes.classic.speedBonus=value.speedBonus;
      }
      g.appSettings=next;push(g);return json(res,{ok:1});
    }
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
    else if(host&&b.type==='skip'){if(KM)await finishK(g);else toResults(g)}
    else if(host&&b.type==='lock'){g.locked=!g.locked;push(g)}
    else if(host&&!KM&&b.type==='next'&&g.state==='results'){
      // Kept as a no-op for stale clients: Classic advances automatically after the ranking overlay.
      return json(res,{ok:1,autoAdvance:true});
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
    else if(host&&b.type==='end'){
      await saveGameReport(g,{incomplete:g.state!=='final'});g.state='ended';clearTimeout(g.timer);clearTimeout(g.pend);push(g);
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
