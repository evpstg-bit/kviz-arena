// Квиз-арена: сервер без npm-зависимостей (Node.js 18+). Запуск: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const PORT=process.env.PORT||3000,MAX_PLAYERS=100,games=new Map();
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data'),INVITE=process.env.INVITE_CODE||'';
const rid=()=>crypto.randomBytes(6).toString('hex');
const str=(s,n)=>String(s??'').slice(0,n);
const same=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};

// ================= хранилище: аккаунты, сессии, личные библиотеки =================
const readJ=(f,d)=>{try{return JSON.parse(fs.readFileSync(path.join(DATA_DIR,f),'utf8'))}catch(e){return d}};
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
    dur:Math.min(10,Math.max(1,Math.round(+z.dur)||5)),need:Math.min(5,Math.max(1,Math.round(+z.need)||3)),q};
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
        result.push({id,quiz,builtin:true,source});
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

// Нормализованная модель файла: { app, version, items: [{ id, quiz }] }.
// Файл хранится в репозитории, а не в DATA_DIR, чтобы его можно было версионировать.
function readBuiltinDocument(){
  try{
    const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'builtin-tests.json'),'utf8'));
    const items=Array.isArray(raw)?raw:(Array.isArray(raw.items)?raw.items:[]);
    return{app:'kviz-arena',version:2,items};
  }catch(e){return{app:'kviz-arena',version:2,items:[]}}
}
function normalizeBuiltinItems(items){
  const out=[],ids=new Set();
  (Array.isArray(items)?items:[]).forEach((item,index)=>{
    const quiz=parseQuiz(item&&item.quiz?item.quiz:item);if(!quiz)return;
    let id=String(item&&item.id||'builtin-'+(index+1)).slice(0,80);
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||ids.has(id)){id='test-'+rid();while(ids.has(id))id='test-'+rid()}
    ids.add(id);out.push({id,quiz});
  });
  return out;
}
function builtinQuizzesFromItems(items){
  return normalizeBuiltinItems(items).map(x=>({id:x.id,quiz:x.quiz,builtin:true,source:'builtin'}));
}
function writeBuiltinDocument(items){
  const doc={app:'kviz-arena',version:2,items:normalizeBuiltinItems(items)};
  const file=path.join(__dirname,'builtin-tests.json'),tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(doc,null,2)+'\n','utf8');fs.renameSync(tmp,file);
  BUILTINQ=loadProjectQuizzes();
  return doc;
}
const githubConfig=()=>{
  const token=String(process.env.GITHUB_TOKEN||'').trim(),repo=String(process.env.GITHUB_REPOSITORY||'').trim(),branch=String(process.env.GITHUB_BRANCH||'main').trim();
  return token&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)?{token,repo,branch}:null;
};
async function githubReadBuiltin(cfg){
  const url='https://api.github.com/repos/'+cfg.repo+'/contents/builtin-tests.json?ref='+encodeURIComponent(cfg.branch);
  const r=await fetch(url,{headers:{Authorization:'Bearer '+cfg.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'kviz-arena'}});
  if(r.status===404)return{sha:null,items:normalizeBuiltinItems(readBuiltinDocument().items)};
  if(!r.ok)throw new Error('GitHub не смог прочитать builtin-tests.json (HTTP '+r.status+'). Проверьте GITHUB_TOKEN, репозиторий, ветку и разрешение Contents: read/write.');
  const data=await r.json();
  if(!data.content)throw new Error('GitHub вернул пустой файл builtin-tests.json');
  let raw;try{raw=JSON.parse(Buffer.from(String(data.content).replace(/\s/g,''),'base64').toString('utf8'))}catch(e){throw new Error('В GitHub находится некорректный builtin-tests.json')}
  const items=Array.isArray(raw)?raw:(Array.isArray(raw.items)?raw.items:[]);
  return{sha:data.sha,items:normalizeBuiltinItems(items)};
}
async function githubWriteBuiltin(cfg,sha,items,message){
  const url='https://api.github.com/repos/'+cfg.repo+'/contents/builtin-tests.json';
  const doc={app:'kviz-arena',version:2,items:normalizeBuiltinItems(items)};
  const body={message,content:Buffer.from(JSON.stringify(doc,null,2)+'\n','utf8').toString('base64'),branch:cfg.branch};
  if(sha)body.sha=sha;
  return fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+cfg.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'kviz-arena','Content-Type':'application/json'},body:JSON.stringify(body)});
}
// Применяет изменение к проектному файлу и, если заданы GITHUB_TOKEN / GITHUB_REPOSITORY,
// автоматически создаёт коммит в GitHub. При отсутствии секрета меняется файл текущего сервера.
async function mutateBuiltinItems(mutator,message){
  const cfg=githubConfig();
  if(cfg){
    for(let attempt=0;attempt<3;attempt++){
      const remote=await githubReadBuiltin(cfg),out=mutator(remote.items.map(x=>({id:x.id,quiz:x.quiz})));
      if(out.noChange)return{persistedToGitHub:true,itemCount:remote.items.length,...(out.data||{})};
      const next=normalizeBuiltinItems(out.items);
      const wr=await githubWriteBuiltin(cfg,remote.sha,next,message);
      if((wr.status===409||wr.status===422)&&attempt<2)continue;
      if(!wr.ok){const detail=await wr.text().catch(()=> '');throw new Error('Не удалось сохранить тесты в GitHub (HTTP '+wr.status+'). '+detail.slice(0,220))}
      try{writeBuiltinDocument(next)}catch(e){BUILTINQ=builtinQuizzesFromItems(next);console.warn('GitHub файл обновлён, но локальную копию не удалось записать:',e.message)}
      return{persistedToGitHub:true,itemCount:next.length,...(out.data||{})};
    }
    throw new Error('Файл изменился одновременно в GitHub. Повторите операцию.');
  }
  const local=normalizeBuiltinItems(readBuiltinDocument().items),out=mutator(local.map(x=>({id:x.id,quiz:x.quiz})));
  if(out.noChange)return{persistedToGitHub:false,itemCount:local.length,...(out.data||{})};
  const doc=writeBuiltinDocument(out.items);
  return{persistedToGitHub:false,itemCount:doc.items.length,...(out.data||{})};
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
  g.left.push({name:p.name,score:p.score,team:p.team,placed:p.placed,correctN:p.correctN,answeredN:p.answeredN,log:p.log});
  g.players.delete(id);
  [...g.clients].filter(c=>c.id===id).forEach(c=>{if(msg)c.res.write('data: '+JSON.stringify(msg)+'\n\n');c.res.end();g.clients.delete(c)});
  if(g.state==='question'&&g.players.size&&[...g.players.values()].every(x=>x.lastQ===g.qi))toResults(g);else push(g);
}

// ---- Classic ----
function view(g,id,R0){
  const R=R0||ranked(g),host=id===g.hostId,q=g.quiz.q[g.qi];
  const v={state:g.state,pin:g.pin,qi:g.qi,total:g.quiz.q.length,title:g.quiz.title,T:q.T,mode:g.mode,locked:!!g.locked,dur:g.quiz.dur,need:g.quiz.need,
    elapsed:Date.now()-g.qStart,host,top:R.slice(0,5).map(p=>({name:p.name,score:p.score}))};
  if(g.state==='question'||g.state==='results')v.q=host?{t:q.t,a:q.a,multi:q.cs.length>1}:{n:q.a.length,t:q.t,multi:q.cs.length>1};
  if(g.state==='results')v.correct=q.cs;
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
  const n=ids.length,N=n<=10?7:n<=40?9:11;
  const kb=g.kb={N,round:1,trophies:[0,0],need:g.quiz.need,dur:g.quiz.dur*60000,banner:null,winner:null};
  resetBoard(kb);kb.endsAt=Date.now()+kb.dur;g.state='playing';clearTimeout(g.timer);g.timer=setTimeout(()=>finishK(g),kb.dur+200);push(g);
}
function finishK(g){
  if(g.state!=='playing')return;clearTimeout(g.timer);const kb=g.kb,t=[0,1].map(k=>kb.board.filter(o=>o===k).length);
  if(t[0]!==t[1])kb.trophies[t[0]>t[1]?0:1]++;           // время вышло: у кого больше клеток — тот берёт трофей
  kb.winner=kb.trophies[0]!==kb.trophies[1]?(kb.trophies[0]>kb.trophies[1]?0:1):(t[0]!==t[1]?(t[0]>t[1]?0:1):-1);
  g.state='final';push(g);
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
  return{state:g.state,mode:'kingdoms',pin:g.pin,title:g.quiz.title,N:kb.N,board:kb.board,rooks:kb.rooks,hot:kb.hot,round:kb.round,need:kb.need,dur:kb.dur,
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
function push(g){
  const R=ranked(g),C=g.mode==='kingdoms'&&g.kb&&g.state!=='lobby'?commonK(g,R):null;
  g.clients.forEach(c=>c.res.write('data: '+JSON.stringify(viewAny(g,c.id,R,C))+'\n\n'));
}
const pushOne=(g,id)=>{const R=ranked(g),C=g.kb?commonK(g,R):null;g.clients.forEach(c=>{if(c.id===id)c.res.write('data: '+JSON.stringify(viewAny(g,id,R,C))+'\n\n')})};
const sched=g=>{if(g.pend)return;g.pend=setTimeout(()=>{g.pend=0;push(g)},180)};

// ================= HTTP =================
function body(req){return new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>2e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d))}catch{r({})}})})}
const json=(res,o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
const LIBFILES={'/xlsx.js':'xlsx.mini.min.js','/qr.js':'qrcode.js','/tailwind.css':'tailwind.css','/ui.css':'ui.css','/liquid-glass.css':'liquid-glass.css'};

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  if(req.method==='GET'&&LIBFILES[u.pathname]){
    const f=[path.join(__dirname,'public',LIBFILES[u.pathname]),path.join(__dirname,LIBFILES[u.pathname])].find(p=>fs.existsSync(p));
    if(!f){res.writeHead(404);return res.end()}
    return fs.readFile(f,(e,b)=>{res.writeHead(200,{'Content-Type':u.pathname.endsWith('.css')?'text/css':'application/javascript','Cache-Control':'no-cache'});res.end(b)});
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
    const c={res,id};g.clients.add(c);const R=ranked(g);res.write('data: '+JSON.stringify(viewAny(g,id,R))+'\n\n');
    // Broadcast connection status so the host's participant panel updates immediately.
    push(g);
    const ka=setInterval(()=>res.write(': ka\n\n'),15000);
    req.on('close',()=>{clearInterval(ka);g.clients.delete(c);setImmediate(()=>{if(games.get(g.pin)===g)push(g)})});return;
  }
  if(req.method==='GET'&&u.pathname==='/api/info'){
    const urls=Object.values(os.networkInterfaces()).flat().filter(i=>(i.family==='IPv4'||i.family===4)&&!i.internal).map(i=>'http://'+i.address+':'+PORT);
    return json(res,{urls,hasUsers:USERS.length>0,regOpen:USERS.length===0||!!INVITE,needInvite:USERS.length>0&&!!INVITE});
  }
  if(req.method!=='POST')return json(res,{},404);
  const b=await body(req),werr=()=>json(res,{error:'Не удалось записать файл на сервере (проверьте права на папку data)'},500);

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
    if(op==='list')return json(res,{items:BUILTINQ.map(x=>({id:x.id,title:x.quiz.title,n:x.quiz.q.length,mode:x.quiz.mode,builtin:true,source:'builtin'}))});
    if(op==='get')return builtin?json(res,{quiz:builtin.quiz,builtin:true}):json(res,{error:'Тест не найден'},404);
    if(op==='export')return json(res,{app:'kviz-arena',version:2,items:normalizeBuiltinItems(readBuiltinDocument().items)});
    if(['import','update','copy','delete'].includes(op)&&!me.admin)return json(res,{error:'Редактировать библиотеку может только администратор'},403);
    try{
      if(op==='import'){
        const incoming=Array.isArray(b.items)?b.items:[];
        if(!incoming.length)return json(res,{error:'Не получены тесты для импорта'},400);
        if(incoming.length>200)return json(res,{error:'За один импорт допускается не более 200 тестов'},400);
        const parsed=[];for(let i=0;i<incoming.length;i++){const item=incoming[i],quiz=parseQuiz(item&&item.quiz?item.quiz:item);if(quiz)parsed.push(quiz)}
        if(!parsed.length)return json(res,{error:'Нет корректных тестов. Проверьте вопросы, варианты ответов и правильные ответы.'},400);
        const addedIds=parsed.map(()=> 'test-'+rid());
        const result=await mutateBuiltinItems(items=>({items:[...items,...parsed.map((quiz,i)=>({id:addedIds[i],quiz}))],data:{added:parsed.length,skipped:incoming.length-parsed.length}}),'Import tests into builtin-tests.json');
        return json(res,{ok:true,...result});
      }
      if(op==='update'){
        const quiz=parseQuiz(b.quiz);if(!quiz)return json(res,{error:'Тест не прошёл проверку. Убедитесь, что у каждого вопроса есть варианты и правильный ответ.'},400);
        const result=await mutateBuiltinItems(items=>{const index=items.findIndex(item=>item.id===b.id);if(index<0)return{items,noChange:true,data:{id:b.id,updated:false}};const next=items.slice();next[index]={id:next[index].id,quiz};return{items:next,data:{id:b.id,updated:true}}},'Edit built-in quiz '+String(b.id||''));
        return result.updated?json(res,{ok:true,...result}):json(res,{error:'Тест не найден'},404);
      }
      if(op==='copy'){
        const newId='test-'+rid();
        const result=await mutateBuiltinItems(items=>{const source=items.find(item=>item.id===b.id);if(!source)return{items,noChange:true,data:{id:null,copied:false}};const quiz={...source.quiz,title:(String(source.quiz.title||'Тест')+' — копия').slice(0,80),q:source.quiz.q.map(q=>({...q,a:[...q.a],cs:[...q.cs]}))};return{items:[...items,{id:newId,quiz}],data:{id:newId,copied:true}}},'Copy built-in quiz '+String(b.id||''));
        return result.copied?json(res,{ok:true,...result}):json(res,{error:'Тест не найден'},404);
      }
      if(op==='delete'){
        const result=await mutateBuiltinItems(items=>{const next=items.filter(item=>item.id!==b.id),removed=next.length!==items.length;return{items:next,noChange:!removed,data:{id:b.id,removed}}},'Delete built-in quiz '+String(b.id||''));
        return result.removed?json(res,{ok:true,...result}):json(res,{error:'Тест не найден'},404);
      }
    }catch(e){console.error('Ошибка изменения builtin-tests.json:',e.message);return json(res,{error:e.message||'Не удалось изменить библиотеку'},500)}
    return json(res,{error:'Неизвестная операция'},404);
  }

  // ---------- создание игры ----------
  if(u.pathname==='/api/create'){
    const me=userOf(b.token);if(!me)return json(res,{error:'Войдите в личный кабинет, чтобы запустить игру',code:401},401);
    const source=BUILTINQ.find(x=>x.id===b.sourceId);if(!source)return json(res,{error:'Можно запускать только тесты из библиотеки проекта.'},403);
    const requestedMode=String(b.mode||'');
    if(!['classic','kingdoms'].includes(requestedMode))return json(res,{error:'Выберите режим игры перед запуском теста.'},400);
    const quiz=parseQuiz(source.quiz);if(!quiz)return json(res,{error:'Тест некорректен. Проверьте библиотеку тестов.'},400);
    quiz.mode=requestedMode;
    let pin;do pin=String(Math.floor(100000+Math.random()*900000));while(games.has(pin));
    const g={pin,hostId:rid(),owner:me.id,quiz,state:'lobby',mode:requestedMode,qi:0,qStart:Date.now(),players:new Map(),left:[],clients:new Set(),born:Date.now()};
    games.set(pin,g);return json(res,{pin,id:g.hostId});
  }

  const g=games.get(String(b.pin));
  if(u.pathname==='/api/alive')return json(res,{alive:!!g&&(b.id===g.hostId||g.players.has(b.id))});
  if(!g)return json(res,{error:'Игра не найдена'},404);
  if(u.pathname==='/api/join'){
    const name=str(b.name,16).trim();
    if(g.players.size>=MAX_PLAYERS)return json(res,{error:'Игра заполнена (максимум '+MAX_PLAYERS+' игроков)'},400);
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
    if(host&&b.type==='start'&&g.state==='lobby'&&g.players.size){if(KM)startK(g);else{g.qi=0;startQ(g)}}
    else if(host&&b.type==='skip'){if(KM)finishK(g);else toResults(g)}
    else if(host&&b.type==='lock'){g.locked=!g.locked;push(g)}
    else if(host&&!KM&&b.type==='next'&&g.state==='results'){
      if(g.qi>=g.quiz.q.length-1){g.state='final';push(g)}else{g.qi++;startQ(g)}
    }else if(p&&KM&&g.state==='playing'&&b.type==='answer'){
      if(answerK(g,p,b)){pushOne(g,b.id);sched(g)}
    }else if(p&&KM&&g.state==='playing'&&b.type==='place'){
      if(placeK(g,p,b.tile))push(g);else{pushOne(g,b.id);return json(res,{error:'Сюда нельзя поставить флаг'})}
    }else if(p&&!KM&&b.type==='answer'&&g.state==='question'){
      const qq=g.quiz.q[g.qi],T=qq.T*1000,el=Date.now()-g.qStart,sel=[...new Set([].concat(b.a).map(Number))].filter(Number.isInteger).sort((x,y)=>x-y);
      if(p.lastQ!==g.qi&&el<=T+300&&sel.length&&sel.every(x=>x>=0&&x<qq.a.length)){
        const okk=same(sel,qq.cs),pts=okk?Math.round(1000*(1-Math.min(el,T)/T/2)):0;
        Object.assign(p,{score:p.score+pts,lastQ:g.qi,lastA:sel,lastPts:pts,lastMs:el});p.log.push({qi:g.qi,a:sel,ok:okk,pts,ms:el});
        if([...g.players.values()].every(x=>x.lastQ===g.qi))toResults(g);else push(g);
      }
    }else if(p&&b.type==='leave')removePlayer(g,b.id);
    else if(host&&b.type==='kick'&&g.players.has(b.a))removePlayer(g,b.a,{state:'kicked'});
    else if(host&&b.type==='end'){
      g.state='ended';clearTimeout(g.timer);clearTimeout(g.pend);push(g);
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
