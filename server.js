// Квиз-арена: сервер без зависимостей (только Node.js 16+). Запуск: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const MAX_PLAYERS=100;
const PORT=process.env.PORT||3000,games=new Map();
const rid=()=>crypto.randomBytes(6).toString('hex');
const str=(s,n)=>String(s??'').slice(0,n);
// ---- библиотека тестов (хранится в файле data/quizzes.json) ----
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data'),DB_FILE=path.join(DATA_DIR,'quizzes.json');
let LIBQ=[];try{LIBQ=JSON.parse(fs.readFileSync(DB_FILE,'utf8'))}catch(e){}
function persist(){
  try{fs.mkdirSync(DATA_DIR,{recursive:true});const t=DB_FILE+'.tmp';fs.writeFileSync(t,JSON.stringify(LIBQ));fs.renameSync(t,DB_FILE);return true}
  catch(e){console.error('Не удалось сохранить тесты:',e.message);return false}
}
function cleanQuiz(z){
  const q=(Array.isArray(z.q)?z.q:[]).slice(0,100).map(x=>{
    const a=(Array.isArray(x.a)?x.a:[]).slice(0,4).map(t=>str(t,150)),T=+x.T;
    const cs=[...new Set((Array.isArray(x.cs)?x.cs:[]).map(Number))].filter(n=>Number.isInteger(n)&&n>=0&&n<4).sort((p,r)=>p-r);
    return{t:str(x.t,300),a,cs,T:T>=5?Math.min(240,T):undefined};
  });
  return{title:str(z.title,80).trim()||'Без названия',T:Math.min(120,Math.max(5,+z.T||20)),mode:z.mode==='kingdoms'?'kingdoms':'classic',K:Math.min(4,Math.max(2,+z.K||4)),q};
}
function isLocal(req){ // запрос с компьютера, на котором запущен сервер (не через прокси)
  if(req.headers['x-forwarded-for']||req.headers['forwarded'])return false;
  const ra=(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
  return ra==='127.0.0.1'||ra==='::1'||Object.values(require('os').networkInterfaces()).flat().some(i=>i.address===ra);
}
function libDenied(req,b){
  if(process.env.TEACHER_PASSWORD)return b.pass===process.env.TEACHER_PASSWORD?null:'Неверный пароль преподавателя';
  return isLocal(req)?null:'Библиотека тестов доступна только с компьютера, на котором запущен сервер. Чтобы открыть её удалённо, задайте пароль: TEACHER_PASSWORD=... node server.js';
}

const BN=7,same=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
function teams(g,R){
  if(!g.board)return null;const q=g.quiz.q[g.qi],res=g.state==='results';
  return Array.from({length:g.K},(_,k)=>{const m=R.filter(p=>p.team===k);
    return{k,cells:g.board.filter(o=>o===k).length,members:m.length,score:m.reduce((t,p)=>t+p.score,0),ok:res?m.filter(p=>p.lastQ===g.qi&&same(p.lastA,q.cs)).length:0}});
}
function initKingdoms(g){
  if(g.mode!=='kingdoms')return;
  const ids=[...g.players.keys()].sort(()=>Math.random()-.5),K=Math.max(1,Math.min(g.quiz.K,ids.length));
  g.K=K;ids.forEach((id,i)=>g.players.get(id).team=i%K);
  g.board=Array(BN*BN).fill(-1);
  const C=[0,BN-1,BN*(BN-1),BN*BN-1],pos=K===2?[0,3]:[0,1,2,3];
  g.castles=pos.slice(0,K).map(i=>C[i]);g.castles.forEach((c,k)=>g.board[c]=k);g.lastCaps=[];
}
function capture(g){
  const q=g.quiz.q[g.qi],K=g.K,N=BN,st=Array.from({length:K},()=>({m:0,ok:0,ms:0}));
  g.players.forEach(p=>{const t=st[p.team];if(!t)return;t.m++;if(p.lastQ===g.qi&&same(p.lastA,q.cs)){t.ok++;t.ms+=p.lastMs||0}});
  const rt=st.map(t=>t.m?t.ok/t.m:0),order=st.map((t,k)=>({k,avg:t.ok?t.ms/t.ok:1e9})).sort((a,b)=>rt[b.k]-rt[a.k]||a.avg-b.avg);
  const adj=i=>{const x=i%N,y=(i-x)/N,r=[];if(x>0)r.push(i-1);if(x<N-1)r.push(i+1);if(y>0)r.push(i-N);if(y<N-1)r.push(i+N);return r};
  g.lastCaps=[];
  for(const{k}of order){
    let n=Math.round(rt[k]*3);
    while(n-->0){
      const border=new Set();g.board.forEach((o,i)=>{if(o===k)adj(i).forEach(j=>{if(g.board[j]!==k)border.add(j)})});
      let cand=[...border].filter(j=>g.board[j]===-1);
      if(!cand.length)cand=[...border].filter(j=>!g.castles.includes(j)&&g.board[j]>=0&&rt[g.board[j]]<rt[k]);
      if(!cand.length)break;
      const j=cand[Math.floor(Math.random()*cand.length)];g.board[j]=k;g.lastCaps.push({i:j,k});
    }
  }
}
function ranked(g){return [...g.players.entries()].map(([id,p])=>({id,...p})).sort((a,b)=>b.score-a.score)}
function view(g,id,R0){
  const R=R0||ranked(g),host=id===g.hostId,q=g.quiz.q[g.qi];
  const v={state:g.state,pin:g.pin,qi:g.qi,total:g.quiz.q.length,title:g.quiz.title,T:g.quiz.q[g.qi].T,
    elapsed:Date.now()-g.qStart,host,top:R.slice(0,5).map(p=>({name:p.name,score:p.score}))};
  if(g.state==='question'||g.state==='results')v.q=host?{t:q.t,a:q.a,multi:q.cs.length>1}:{n:q.a.length,t:q.t,multi:q.cs.length>1};
  if(g.state==='results')v.correct=q.cs;
  if(host){
    v.names=R.map(p=>p.name);
    v.rows=R.map(p=>{const an=p.lastQ===g.qi,r={id:p.id,name:p.name,score:p.score,ans:an,team:p.team};if(g.state==='results'&&an){r.ok=same(p.lastA,q.cs);r.pts=p.lastPts}return r});v.answered=R.filter(p=>p.lastQ===g.qi).length;
    if(g.state==='results'){v.counts=[0,0,0,0];R.forEach(p=>{if(p.lastQ===g.qi)p.lastA.forEach(x=>v.counts[x]++)})}
  }else{
    const p=g.players.get(id);
    if(p)v.me={name:p.name,score:p.score,answered:p.lastQ===g.qi,lastA:p.lastQ===g.qi?p.lastA:-1,pts:p.lastQ===g.qi?p.lastPts:0,rank:R.findIndex(x=>x.id===id)+1,team:p.team,ok:g.state==='results'&&p.lastQ===g.qi&&same(p.lastA,q.cs)};
  }
  v.mode=g.mode;v.locked=!!g.locked;
  if(g.board){v.K=g.K;v.board=g.board;v.castles=g.castles;v.caps=g.state==='results'?g.lastCaps.map(c=>c.i):[];v.teams=teams(g,R)}
  else if(g.mode==='kingdoms')v.K=g.quiz.K;
  return v;
}
function push(g){const R=ranked(g);g.clients.forEach(c=>c.res.write('data: '+JSON.stringify(view(g,c.id,R))+'\n\n'))}
function startQ(g){
  g.state='question';g.qStart=Date.now();clearTimeout(g.timer);
  g.timer=setTimeout(()=>toResults(g),g.quiz.q[g.qi].T*1000+500);push(g);
}
function toResults(g){if(g.state!=='question')return;clearTimeout(g.timer);g.state='results';if(g.board)capture(g);push(g)}

function parseQuiz(z){
  if(!z||!Array.isArray(z.q)||!z.q.length||z.q.length>100)return null;
  const q=z.q.map(x=>{
    const a=(x.a||[]).slice(0,4).map(t=>str(t,150).trim()),raw=Array.isArray(x.cs)?x.cs:[x.c];
    const cs=[...new Set(raw.map(Number))].filter(n=>Number.isInteger(n)&&n>=0&&n<a.length).sort((p,r)=>p-r);
    return{t:str(x.t,300).trim(),a,cs,T:Math.min(240,Math.max(5,+x.T||+z.T||20))};
  });
  if(!q.every(x=>x.t&&x.a.length>=2&&x.a.every(Boolean)&&x.cs.length>=1))return null;
  return{title:str(z.title,80)||'Квиз',T:Math.min(120,Math.max(5,+z.T||20)),mode:z.mode==='kingdoms'?'kingdoms':'classic',K:Math.min(4,Math.max(2,+z.K||4)),q};
}
function body(req){return new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>2e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d))}catch{r({})}})})}
const json=(res,o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  const LIB={'/xlsx.js':'xlsx.mini.min.js','/qr.js':'qrcode.js','/tailwind.css':'tailwind.css'};
  if(req.method==='GET'&&LIB[u.pathname]){
    const f=[path.join(__dirname,'public',LIB[u.pathname]),path.join(__dirname,LIB[u.pathname])].find(p=>fs.existsSync(p));
    if(!f){res.writeHead(404);return res.end()}
    return fs.readFile(f,(e,b)=>{res.writeHead(200,{'Content-Type':u.pathname.endsWith('.css')?'text/css':'application/javascript','Cache-Control':'no-cache'});res.end(b)});
  }
  if(req.method==='GET'&&u.pathname==='/'){
    const f=[path.join(__dirname,'public','index.html'),path.join(__dirname,'index.html')].find(p=>fs.existsSync(p));
    if(!f){res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Не найден файл public/index.html')}
    return fs.readFile(f,(e,b)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(b)});
  }
  if(u.pathname==='/api/events'){
    const g=games.get(u.searchParams.get('pin')),id=u.searchParams.get('id');
    if(!g||(id!==g.hostId&&!g.players.has(id))){res.writeHead(404);return res.end()}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const c={res,id};g.clients.add(c);res.write('data: '+JSON.stringify(view(g,id))+'\n\n');
    const ka=setInterval(()=>res.write(': ka\n\n'),15000);
    req.on('close',()=>{clearInterval(ka);g.clients.delete(c)});return;
  }
  if(req.method==='GET'&&u.pathname==='/api/info'){
    const urls=Object.values(require('os').networkInterfaces()).flat().filter(i=>(i.family==='IPv4'||i.family===4)&&!i.internal).map(i=>'http://'+i.address+':'+PORT);
    return json(res,{urls,needPass:!!process.env.TEACHER_PASSWORD,lib:process.env.TEACHER_PASSWORD?'password':(isLocal(req)?'open':'locked')});
  }
  if(req.method!=='POST')return json(res,{},404);
  const b=await body(req);
  if(u.pathname==='/api/create'){
    if(process.env.TEACHER_PASSWORD&&b.pass!==process.env.TEACHER_PASSWORD)return json(res,{error:'Неверный пароль преподавателя'},403);
    const quiz=parseQuiz(b.quiz);if(!quiz)return json(res,{error:'Некорректный квиз'},400);
    let pin;do pin=String(Math.floor(100000+Math.random()*900000));while(games.has(pin));
    const g={pin,hostId:rid(),quiz,state:'lobby',mode:quiz.mode,qi:0,qStart:Date.now(),players:new Map(),left:[],clients:new Set(),born:Date.now()};
    games.set(pin,g);return json(res,{pin,id:g.hostId});
  }
  if(u.pathname.startsWith('/api/lib/')){
    const deny=libDenied(req,b);if(deny)return json(res,{error:deny},403);
    const op=u.pathname.slice(9),f=LIBQ.find(x=>x.id===b.id),werr=()=>json(res,{error:'Не удалось записать файл на сервере'},500);
    if(op==='list')return json(res,{items:LIBQ.map(x=>({id:x.id,title:x.quiz.title,n:x.quiz.q.length,mode:x.quiz.mode,updated:x.updated})).sort((a,c)=>c.updated-a.updated)});
    if(op==='get')return f?json(res,{quiz:f.quiz}):json(res,{error:'Тест не найден'},404);
    if(op==='save'){
      const quiz=cleanQuiz(b.quiz||{});
      if(b.id&&!f)return json(res,{error:'Тест не найден (возможно, удалён)'},404);
      let id;
      if(f){f.quiz=quiz;f.updated=Date.now();id=f.id}
      else{if(LIBQ.length>=200)return json(res,{error:'Достигнут лимит: 200 тестов'},400);id=rid();LIBQ.push({id,quiz,updated:Date.now()})}
      return persist()?json(res,{id,title:quiz.title}):werr();
    }
    if(op==='delete'){if(!f)return json(res,{error:'Тест не найден'},404);LIBQ=LIBQ.filter(x=>x!==f);return persist()?json(res,{ok:1}):werr()}
    return json(res,{error:'Неизвестная операция'},404);
  }
  const g=games.get(String(b.pin));
  if(!g)return json(res,{error:'Игра не найдена'},404);
  if(u.pathname==='/api/join'){
    const name=str(b.name,16).trim();
    if(g.players.size>=MAX_PLAYERS)return json(res,{error:'Игра заполнена (максимум '+MAX_PLAYERS+' игроков)'},400);
    if(!name)return json(res,{error:'Введите имя'},400);
    if(g.state==='final'||g.state==='ended')return json(res,{error:'Игра уже завершена'},400);
    if(g.locked)return json(res,{error:'Ведущий закрыл вход в игру'},400);
    if([...g.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase()))return json(res,{error:'Это имя занято'},400);
    const id=rid(),pl={name,score:0,lastQ:-1,lastA:[],lastPts:0,log:[]};
    if(g.board){ // вход после старта в Color Kingdoms: в самое малочисленное королевство
      const cnt=Array(g.K).fill(0);g.players.forEach(x=>{if(cnt[x.team]!==undefined)cnt[x.team]++});
      const mn=Math.min(...cnt),c=cnt.map((n,k)=>n===mn?k:-1).filter(k=>k>=0);pl.team=c[Math.floor(Math.random()*c.length)];
    }
    g.players.set(id,pl);push(g);return json(res,{id});
  }
  if(u.pathname==='/api/report'){
    if(b.id!==g.hostId)return json(res,{error:'Нет доступа'},403);
    return json(res,{mode:g.mode,teams:teams(g,ranked(g)),questions:g.quiz.q.map(q=>({t:q.t,a:q.a,cs:q.cs})),players:[...g.players.values(),...g.left].map(p=>({name:p.name,score:p.score,team:p.team,log:p.log}))});
  }
  if(u.pathname==='/api/action'){
    const host=b.id===g.hostId,p=g.players.get(b.id);
    if(host&&b.type==='start'&&g.state==='lobby'&&g.players.size){g.qi=0;initKingdoms(g);startQ(g)}
    else if(host&&b.type==='skip')toResults(g);
    else if(host&&b.type==='lock'){g.locked=!g.locked;push(g)}
    else if(host&&b.type==='next'&&g.state==='results'){
      if(g.qi>=g.quiz.q.length-1){g.state='final';push(g)}else{g.qi++;startQ(g)}
    }else if(p&&b.type==='answer'&&g.state==='question'){
      const qq=g.quiz.q[g.qi],T=qq.T*1000,el=Date.now()-g.qStart,sel=[...new Set([].concat(b.a).map(Number))].filter(Number.isInteger).sort((x,y)=>x-y);
      if(p.lastQ!==g.qi&&el<=T+300&&sel.length&&sel.every(x=>x>=0&&x<qq.a.length)){
        const okk=same(sel,qq.cs),pts=okk?Math.round(1000*(1-Math.min(el,T)/T/2)):0;
        Object.assign(p,{score:p.score+pts,lastQ:g.qi,lastA:sel,lastPts:pts,lastMs:el});p.log.push({qi:g.qi,a:sel,ok:okk,pts,ms:el});
        if([...g.players.values()].every(x=>x.lastQ===g.qi))toResults(g);else push(g);
      }
    }else if(p&&b.type==='leave'){
      g.left.push({name:p.name,score:p.score,team:p.team,log:p.log});g.players.delete(b.id);
      [...g.clients].filter(c=>c.id===b.id).forEach(c=>{c.res.end();g.clients.delete(c)});
      if(g.state==='question'&&g.players.size&&[...g.players.values()].every(x=>x.lastQ===g.qi))toResults(g);else push(g);
    }else if(host&&b.type==='kick'&&g.players.has(b.a)){
      const k=g.players.get(b.a);g.left.push({name:k.name,score:k.score,team:k.team,log:k.log});g.players.delete(b.a);
      [...g.clients].filter(c=>c.id===b.a).forEach(c=>{c.res.write('data: {"state":"kicked"}\n\n');c.res.end();g.clients.delete(c)});
      if(g.state==='question'&&g.players.size&&[...g.players.values()].every(x=>x.lastQ===g.qi))toResults(g);else push(g);
    }else if(host&&b.type==='end'){
      g.state='ended';clearTimeout(g.timer);push(g);
      setTimeout(()=>{g.clients.forEach(c=>c.res.end());games.delete(g.pin)},1500);
    }
    return json(res,{ok:1});
  }
  json(res,{},404);
}).listen(PORT,'0.0.0.0',()=>{
  console.log('Квиз-арена запущена: http://localhost:'+PORT);
  const ni=require('os').networkInterfaces();
  Object.values(ni).flat().filter(i=>i.family==='IPv4'&&!i.internal).forEach(i=>console.log('В локальной сети:  http://'+i.address+':'+PORT));
});
setInterval(()=>{for(const[k,g]of games)if(Date.now()-g.born>6*3600e3){clearTimeout(g.timer);g.clients.forEach(c=>c.res.end());games.delete(k)}},600e3);
