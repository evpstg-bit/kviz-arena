// Квиз-арена: сервер без зависимостей (только Node.js 16+). Запуск: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const MAX_PLAYERS=100;
const PORT=process.env.PORT||3000,games=new Map();
const rid=()=>crypto.randomBytes(6).toString('hex');
const str=(s,n)=>String(s??'').slice(0,n);

function ranked(g){return [...g.players.entries()].map(([id,p])=>({id,...p})).sort((a,b)=>b.score-a.score)}
function view(g,id,R0){
  const R=R0||ranked(g),host=id===g.hostId,q=g.quiz.q[g.qi];
  const v={state:g.state,pin:g.pin,qi:g.qi,total:g.quiz.q.length,title:g.quiz.title,T:g.quiz.q[g.qi].T,
    elapsed:Date.now()-g.qStart,host,top:R.slice(0,5).map(p=>({name:p.name,score:p.score}))};
  if(g.state==='question'||g.state==='results')v.q=host?{t:q.t,a:q.a}:{n:q.a.length,t:q.t};
  if(g.state==='results')v.correct=q.c;
  if(host){
    v.names=R.map(p=>p.name);v.answered=R.filter(p=>p.lastQ===g.qi).length;
    if(g.state==='results'){v.counts=[0,0,0,0];R.forEach(p=>{if(p.lastQ===g.qi&&p.lastA>=0)v.counts[p.lastA]++})}
  }else{
    const p=g.players.get(id);
    if(p)v.me={name:p.name,score:p.score,answered:p.lastQ===g.qi,lastA:p.lastQ===g.qi?p.lastA:-1,pts:p.lastQ===g.qi?p.lastPts:0,rank:R.findIndex(x=>x.id===id)+1};
  }
  return v;
}
function push(g){const R=ranked(g);g.clients.forEach(c=>c.res.write('data: '+JSON.stringify(view(g,c.id,R))+'\n\n'))}
function startQ(g){
  g.state='question';g.qStart=Date.now();clearTimeout(g.timer);
  g.timer=setTimeout(()=>toResults(g),g.quiz.q[g.qi].T*1000+500);push(g);
}
function toResults(g){if(g.state!=='question')return;clearTimeout(g.timer);g.state='results';push(g)}

function parseQuiz(z){
  if(!z||!Array.isArray(z.q)||!z.q.length||z.q.length>100)return null;
  const q=z.q.map(x=>({t:str(x.t,300).trim(),a:(x.a||[]).slice(0,4).map(s=>str(s,150).trim()),c:+x.c,T:Math.min(240,Math.max(5,+x.T||+z.T||20))}));
  if(!q.every(x=>x.t&&x.a.length>=2&&x.a.every(Boolean)&&x.c>=0&&x.c<x.a.length))return null;
  return{title:str(z.title,80)||'Квиз',T:Math.min(120,Math.max(5,+z.T||20)),q};
}
function body(req){return new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>2e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d))}catch{r({})}})})}
const json=(res,o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  if(req.method==='GET'&&u.pathname==='/xlsx.js'){
    const f=[path.join(__dirname,'public','xlsx.mini.min.js'),path.join(__dirname,'xlsx.mini.min.js')].find(p=>fs.existsSync(p));
    if(!f){res.writeHead(404);return res.end()}
    return fs.readFile(f,(e,b)=>{res.writeHead(200,{'Content-Type':'application/javascript'});res.end(b)});
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
  if(req.method!=='POST')return json(res,{},404);
  const b=await body(req);
  if(u.pathname==='/api/create'){
    const quiz=parseQuiz(b.quiz);if(!quiz)return json(res,{error:'Некорректный квиз'},400);
    let pin;do pin=String(Math.floor(100000+Math.random()*900000));while(games.has(pin));
    const g={pin,hostId:rid(),quiz,state:'lobby',qi:0,qStart:Date.now(),players:new Map(),clients:new Set(),born:Date.now()};
    games.set(pin,g);return json(res,{pin,id:g.hostId});
  }
  const g=games.get(String(b.pin));
  if(!g)return json(res,{error:'Игра не найдена'},404);
  if(u.pathname==='/api/join'){
    const name=str(b.name,16).trim();
    if(g.players.size>=MAX_PLAYERS)return json(res,{error:'Игра заполнена (максимум '+MAX_PLAYERS+' игроков)'},400);
    if(!name||g.state!=='lobby')return json(res,{error:g.state!=='lobby'?'Игра уже началась':'Введите имя'},400);
    if([...g.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase()))return json(res,{error:'Это имя занято'},400);
    const id=rid();g.players.set(id,{name,score:0,lastQ:-1,lastA:-1,lastPts:0});push(g);return json(res,{id});
  }
  if(u.pathname==='/api/action'){
    const host=b.id===g.hostId,p=g.players.get(b.id);
    if(host&&b.type==='start'&&g.state==='lobby'&&g.players.size){g.qi=0;startQ(g)}
    else if(host&&b.type==='skip')toResults(g);
    else if(host&&b.type==='next'&&g.state==='results'){
      if(g.qi>=g.quiz.q.length-1){g.state='final';push(g)}else{g.qi++;startQ(g)}
    }else if(p&&b.type==='answer'&&g.state==='question'){
      const T=g.quiz.q[g.qi].T*1000,el=Date.now()-g.qStart,j=+b.a;
      if(p.lastQ!==g.qi&&el<=T+300&&j>=0&&j<4){
        const pts=j===g.quiz.q[g.qi].c?Math.round(1000*(1-Math.min(el,T)/T/2)):0;
        Object.assign(p,{score:p.score+pts,lastQ:g.qi,lastA:j,lastPts:pts});
        if([...g.players.values()].every(x=>x.lastQ===g.qi))toResults(g);else push(g);
      }
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
