import { getStore } from '@netlify/blobs';

const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'}});
const sessions=()=>getStore('shanshen-sessions-v1');
const scores=()=>getStore('shanshen-scores-v1');
const uuid=/^[a-f0-9-]{36}$/i;

const getDay=(time=Date.now())=>{
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const startWeek=day=>{
 const d=new Date(`${day}T12:00:00+08:00`);
 const delta=(d.getUTCDay()+6)%7;
 d.setUTCDate(d.getUTCDate()-delta);
 return getDay(d.getTime());
};
const sanitize=n=>typeof n==='string'?n.trim().replace(/\s+/g,' ').slice(0,30):'';
const validName=n=>n&&[...n].length<=12&&!/[<>\u0000-\u001f]/.test(n);
const validId=n=>typeof n==='string'&&uuid.test(n);
async function parseBody(request){
 const len=Number(request.headers.get('content-length')||0);
 if(len>1600)throw new Error('too large');
 return await request.json();
}
async function readScores(period){
 const store=scores(), today=getDay();
 const prefixes=period==='today'?[`scores/${today}/`]:period==='week'?(()=>{
   const monday=startWeek(today),day=new Date(`${monday}T12:00:00+08:00`),days=[];
   for(let i=0;i<7;i++){const d=new Date(day);d.setUTCDate(d.getUTCDate()+i);const s=getDay(d.getTime());if(s<=today)days.push(`scores/${s}/`);}return days;
 })():['scores/'];
 const all=[];
 for(const prefix of prefixes){
   const {blobs}=await store.list({prefix});
   // This casual-game backend is intentionally small-scale. If the site exceeds
   // 10,000 runs, move the leaderboard to a transactional database.
   const keys=blobs.slice(0,10000).map(x=>x.key);
   for(let i=0;i<keys.length;i+=60){
     const rows=await Promise.all(keys.slice(i,i+60).map(async key=>{try{return await store.get(key,{type:'json'});}catch{return null;}}));
     for(const row of rows){if(row&&Number.isFinite(row.score)&&validId(row.playerId))all.push(row);}
   }
 }
 const byPlayer=new Map();
 for(const e of all){const old=byPlayer.get(e.playerId);if(!old||e.score>old.score||(e.score===old.score&&(e.combo>old.combo||(e.combo===old.combo&&e.created<old.created))))byPlayer.set(e.playerId,e);}
 return [...byPlayer.values()].sort((a,b)=>b.score-a.score||b.combo-a.combo||a.created-b.created);
}

export default async function handler(request){
 const url=new URL(request.url),action=url.searchParams.get('action')||'leaderboard';
 try{
 if(request.method==='GET'&&action==='leaderboard'){
   const period=['today','week','all'].includes(url.searchParams.get('period'))?url.searchParams.get('period'):'today';
   const playerId=url.searchParams.get('playerId')||'';
   const board=await readScores(period);
   const mineIndex=validId(playerId)?board.findIndex(e=>e.playerId===playerId):-1;
   return json({period,total:board.length,entries:board.slice(0,30).map(({name,score,combo,elapsed,day})=>({name,score,combo,elapsed,date:day})),mine:mineIndex<0?null:{rank:mineIndex+1,score:board[mineIndex].score}});
 }
 if(request.method==='POST'&&action==='session'){
   const payload=await parseBody(request),name=sanitize(payload.name),playerId=payload.playerId;
   if(!validName(name)||!validId(playerId))return json({error:'暱稱或玩家資料格式有誤'},400);
   const token=crypto.randomUUID();
   await sessions().setJSON(token,{name,playerId,startedAt:Date.now()},{onlyIfNew:true});
   return json({token});
 }
 if(request.method==='POST'&&action==='score'){
   const p=await parseBody(request),token=p.token,name=sanitize(p.name),playerId=p.playerId;
   const score=p.score,combo=p.combo,elapsed=p.elapsed;
   if(!validId(token)||!validId(playerId)||!validName(name)||!Number.isInteger(score)||score<0||score>1000||!Number.isInteger(combo)||combo<0||combo>score||!Number.isInteger(elapsed)||elapsed<0||elapsed>7200)return json({error:'戰績格式錯誤'},400);
   const session=await sessions().get(token,{type:'json'});
   if(!session||session.name!==name||session.playerId!==playerId)return json({error:'挑戰憑證無效'},403);
   const age=Date.now()-session.startedAt;
   if(age<Math.max(1500,score*580)||age>1000*60*60*3||elapsed>age/1000+5||elapsed<score*.55)return json({error:'成績驗證失敗'},400);
   const now=Date.now(),day=getDay(now),record={name,playerId,score,combo,elapsed,created:now,day};
   // One saved score per issued session token. The client never writes directly to storage.
   try{const saved=await scores().setJSON(`scores/${day}/${token}`,record,{onlyIfNew:true});if(saved&&saved.modified===false)return json({error:'這場成績已經送出'},409);}
   catch{return json({error:'這場成績已經送出'},409);}
   let rank=null;try{const board=await readScores('all');const index=board.findIndex(e=>e.playerId===playerId);if(index>=0)rank=index+1;}catch{}
   return json({ok:true,rank});
 }
 return json({error:'不支援的操作'},405);
 }catch(error){console.error('Leaderboard API:',error);return json({error:'排行榜服務暫時忙碌'},500);}
}
