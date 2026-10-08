// Only the packaged helper is used; no npm install, camera, preferences or history.
// node packaged-room-smoke.mjs <extracted game folder> [--online]
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
const game=resolve(process.argv[2]),runtime=join(game,'room-server');
const WebSocket=createRequire(join(runtime,'package.json'))('ws');
const suffix=process.platform==='win32'?'-x64.exe':process.arch==='arm64'?'-arm64':'-x64';
const node=join(runtime,'node'+suffix),relay=join(runtime,'cloudflared'+suffix);
const folder=mkdtempSync(join(tmpdir(),'hearthside-package-check-'));
const configPath=join(folder,'host.json'),statusPath=join(folder,'online.json');
const port=32000+process.pid%5000,origin=`http://127.0.0.1:${port}`,ownerKey='isolated-owner-'+process.pid,inviteKey='isolated-invite-'+process.pid;
writeFileSync(configPath,JSON.stringify({roomMode:'house',roomName:'Windows acceptance',port,ownerKey,inviteKey,online:false,statusPath,tunnelExecutable:relay}),{mode:0o600});
const server=spawn(node,[join(runtime,'server.js'),'--local-room','--host-config='+configPath,'--parent-pid='+process.pid],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
const clients=[];
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async(fn,label,limit=10000)=>{const end=Date.now()+limit;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label+'; helper: '+output.slice(-1500));};
const post=async path=>{const result=await fetch(origin+path,{method:'POST',headers:{'X-Hearthside-Owner':ownerKey}});assert.equal(result.status,200);return result.json();};
const status=()=>{try{return JSON.parse(readFileSync(statusPath,'utf8'));}catch{return {};}};
function connect(url,name,key=''){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(url);clients.push(ws);const messages=[];const timer=setTimeout(()=>{ws.terminate();reject(Error('WebSocket join timeout'));},12000);
  ws.on('open',()=>ws.send(JSON.stringify({type:'join',name,ownerKey:key,capabilities:{hallLayouts:1,stateDelta:1}})));
  ws.on('error',error=>{clearTimeout(timer);reject(error);});ws.on('message',raw=>{const data=JSON.parse(raw);messages.push(data);if(data.type==='welcome'){clearTimeout(timer);resolve({ws,welcome:data,messages});}});
 });
}
function refused(url){return new Promise((resolve,reject)=>{
 const ws=new WebSocket(url);clients.push(ws);let refused=false;
 const timer=setTimeout(()=>{ws.terminate();reject(Error('Refusal/close timeout'));},10000);
 ws.on('open',()=>{clearTimeout(timer);ws.terminate();reject(Error('Wrong invitation was accepted'));});
 ws.on('unexpected-response',(_request,response)=>{
  refused=response.statusCode===403;
  // A custom unexpected-response handler owns handshake cleanup. Merely draining
  // the HTTP body leaves ws CONNECTING and its public TLS socket alive.
  if(!refused){clearTimeout(timer);reject(Error('Expected invitation403, got '+response.statusCode));}
  ws.terminate();
 });
 ws.on('close',()=>{clearTimeout(timer);if(refused)resolve();});
 ws.on('error',error=>{if(!refused){clearTimeout(timer);reject(error);}});
});}
async function getStatus(url){const response=await fetch(url);await response.arrayBuffer();return response.status;}
function relayDescendants(){
 let rows;
 if(process.platform==='win32'){
  rows=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true}));
 }else{
  rows=execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return {ProcessId:Number(m[1]),ParentProcessId:Number(m[2]),Name:m[3]};});
 }
 const children=new Set([server.pid]);for(let n=0;n<4;n++)for(const row of rows)if(children.has(row.ParentProcessId))children.add(row.ProcessId);
 return rows.filter(row=>children.has(row.ProcessId)&&/cloudflared/i.test(row.Name)).map(row=>row.ProcessId);
}
try{
 await until(()=>output.includes('Hearthside room:'),'helper startup');
 assert.equal(await getStatus(origin),403);await refused(origin.replace('http:','ws:')+'/?invite=wrong');
 const local=origin.replace('http:','ws:')+'/?invite='+inviteKey;
 const owner=await connect(local,'Owner',ownerKey),guest=await connect(local,'Guest');
 assert.equal(owner.welcome.isHomeOwner,true);assert.equal(guest.welcome.isHomeOwner,false);assert.equal(guest.welcome.protocol,9);
 const marker='packaged-room-chat-'+process.pid;owner.ws.send(JSON.stringify({type:'chat',text:marker}));
 await until(()=>guest.messages.some(m=>m.type==='chat'&&m.text===marker),'two-client room chat');
 console.log('PACKAGED_ROOM_LOCAL_PASS owner/guest handshake, private secret rejection, two-client chat');
 if(process.argv.includes('--online')){
  await post('/tunnel/retry');
  await until(()=>{const s=status();if(s.state==='error')throw Error(s.message+' '+s.diagnostic);return s.state==='ready';},'public relay readiness',160000);
  const publicUrl=status().publicUrl;assert.match(publicUrl,/^wss:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  await refused(publicUrl+'/?invite=wrong');
  const remote=await connect(publicUrl+'/?invite='+inviteKey,'Public guest',ownerKey);
  assert.equal(remote.welcome.isHomeOwner,false,'forwarded owner key must not grant local host authority');
  const publicMarker='public-roundtrip-'+process.pid;remote.ws.send(JSON.stringify({type:'chat',text:publicMarker}));
  await until(()=>owner.messages.some(m=>m.type==='chat'&&m.text===publicMarker),'public-to-local chat');
  const relays=relayDescendants();assert.equal(relays.length,1,'scoped owned relay visible');
  await post('/tunnel/stop');await until(()=>relays.every(pid=>!alive(pid)),'relay cleanup after IPC stop');
  assert.equal(status().state,'off');assert.equal(await getStatus(origin+'/?invite='+inviteKey),200);
  console.log('PACKAGED_ROOM_PUBLIC_PASS verified TLS, valid invite roundtrip, invalid invite403, no remote ownership, relay cleanup, local room preserved');
 }
 await post('/shutdown');await until(()=>!alive(server.pid),'server graceful shutdown');
 console.log('PACKAGED_ROOM_PASS '+process.platform);
}finally{
 for(const ws of clients)ws.terminate();
 if(alive(server.pid))server.kill('SIGTERM');
 await until(()=>clients.every(ws=>ws.readyState===WebSocket.CLOSED),'test WebSocket cleanup',3000);
 await new Promise(r=>setTimeout(r,2000));rmSync(folder,{recursive:true,force:true});
}
