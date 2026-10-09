// Windows-only integration check: never modifies the input package or real user profile.
// Usage: node updater-smoke.mjs "path/to/extracted/Hearthside Study"
// Uses the genuine packaged Godot executable, with a test-only Node preload adding
// --headless and direct stdout/stderr capture to the updater's relaunch. Production updater is unmodified.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';

if(process.platform!=='win32') {
  console.log('UPDATER_INSTALL_SKIPPED: run this file on Windows; other platforms do not validate Windows locks.');
  process.exit(0);
}
if(!process.argv[2])throw Error('Pass the extracted Windows game directory.');
const source=await fs.realpath(process.argv[2]);
const sourceManifest=JSON.parse(await fs.readFile(path.join(source,'manifest.json'),'utf8'));
assert.equal(sourceManifest.platform,'windows-x64');
const originalHelper=path.join(source,'room-server/update.mjs');
await fs.access(originalHelper);
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hearthside-update-ci-')));
const target=path.join(root,'Hearthside Study'), staging=path.join(root,'.hearthside-update-test'), staged=path.join(staging,'Hearthside Study');
const backup=path.join(root,`.hearthside-backup-${crypto.randomUUID()}`), job=path.join(root,'updater-job');
const profile=path.join(root,'profile'), releaseParent=path.join(root,'release-parent'), restartFile=path.join(root,'restart-pid.json'), gameLog=path.join(root,'restarted-game.log');
const sentinel=path.join(profile,'Godot/app_userdata/Hearthside Study/study-history-preserved.json');
const evidence=path.resolve('evidence');await fs.mkdir(evidence,{recursive:true});
let parent,installer,restartedPid;
const observerEvents=path.join(root,'relaunch-events.jsonl');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function waitFor(fn,label,timeout=45000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){last=e;}await sleep(100);}
  throw Error(`Timed out: ${label}${last?` (${last.message})`:''}`);
}
function run(command,args,options={}) {
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],...options});let output='';
  child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal,output}));});
  return {child,done};
}
try {
  await fs.mkdir(job,{recursive:true});await fs.mkdir(path.dirname(sentinel),{recursive:true});
  await fs.writeFile(sentinel,'{"studyBlocks":[{"id":"preserve-me","seconds":1234}]}');
  const originalHistory=await fs.readFile(sentinel);
  await fs.writeFile(path.join(root,'unrelated-sibling.txt'),'must survive');
  await fs.cp(source,target,{recursive:true});await fs.cp(source,staged,{recursive:true});
  await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify({...sourceManifest,version:'0.0.0'}));
  await fs.writeFile(path.join(target,'install-marker.txt'),'old install');await fs.writeFile(path.join(staged,'install-marker.txt'),'new install');
  const node=path.join(job,'node.exe'),helper=path.join(job,'update.mjs');
  await fs.copyFile(path.join(source,'room-server/node-x64.exe'),node);await fs.copyFile(originalHelper,helper);
  const parentScript=path.join(job,'parent.cjs');
  await fs.writeFile(parentScript,`const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},100);`);
  // The old runtime executable and cwd deliberately live inside the installation.
  parent=run(path.join(target,'room-server/node-x64.exe'),[parentScript,releaseParent],{cwd:target});
  const request={current:'0.0.0',target,parentPid:parent.child.pid,editor:false};
  await fs.writeFile(path.join(job,'request.json'),JSON.stringify(request));
  await fs.writeFile(path.join(job,'prepared.json'),JSON.stringify({target,staged,staging,backup,platform:'win32',version:sourceManifest.version,parentPid:parent.child.pid}));
  const preload=path.join(job,'relaunch-observer.cjs');
  await fs.writeFile(preload,`
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const original=cp.spawn;
const record=data=>fs.appendFileSync(process.env.UPDATER_TEST_EVENTS,JSON.stringify({time:new Date().toISOString(),...data})+'\\n');
cp.spawn=function(command,args,options){
  const isGame=path.resolve(command).toLowerCase()===path.resolve(process.env.UPDATER_TEST_EXE).toLowerCase();
  let output;
  if(isGame){
    args=[...args,'--headless'];
    output=fs.openSync(process.env.UPDATER_TEST_LOG,'a');
    options={...options,stdio:['ignore',output,output]};
    record({event:'launch-request',executable:command,args,cwd:options.cwd,detached:options.detached});
  }
  let child;
  try{child=original.call(this,command,args,options);}finally{if(output!==undefined)fs.closeSync(output);}
  if(isGame){
    child.once('spawn',()=>{fs.writeFileSync(process.env.UPDATER_TEST_PID,JSON.stringify({pid:child.pid,executable:command,args}));record({event:'spawn',pid:child.pid});});
    child.once('error',error=>record({event:'error',code:error.code,message:error.message}));
    child.once('exit',(code,signal)=>record({event:'exit',code,signal}));
    process.once('exit',code=>record({event:'installer-exit',code,childPid:child.pid}));
  }
  return child;
};
require('node:module').syncBuiltinESMExports();
`);
  const env={...process.env,APPDATA:profile,LOCALAPPDATA:path.join(root,'local-profile'),NODE_OPTIONS:`--require ${JSON.stringify(preload)}`,UPDATER_TEST_EXE:path.join(target,'Hearthside Study.exe'),UPDATER_TEST_LOG:gameLog,UPDATER_TEST_PID:restartFile,UPDATER_TEST_EVENTS:observerEvents};
  // Starting in target catches the cwd-lock regression; helper must chdir(job).
  installer=run(node,[helper,'install',job],{cwd:target,env});
  await waitFor(async()=>{const s=await json(path.join(job,'status.json'));if(s.state==='error')throw Error(s.message);return s.state==='waiting';},'installer waits for old parent');
  await sleep(500);
  assert.equal(alive(parent.child.pid),true);assert.equal(await fs.readFile(path.join(target,'install-marker.txt'),'utf8'),'old install');
  await assert.rejects(fs.access(backup));
  await fs.writeFile(releaseParent,'exit');
  assert.equal((await parent.done).code,0,'old runtime must release its file handles');
  let installTimeout;
  const result=await Promise.race([installer.done,new Promise((_,reject)=>{installTimeout=setTimeout(()=>reject(Error('Install command exceeded 60 seconds')),60000);})]).finally(()=>clearTimeout(installTimeout));
  assert.equal(result.code,0,JSON.stringify(await json(path.join(job,'status.json')))+result.output);
  const status=await json(path.join(job,'status.json'));assert.equal(status.state,'installed');
  assert.equal(await fs.readFile(path.join(target,'install-marker.txt'),'utf8'),'new install');
  assert.equal(await fs.readFile(path.join(backup,'install-marker.txt'),'utf8'),'old install');
  const restart=await waitFor(()=>json(restartFile),'actual game relaunch');restartedPid=restart.pid;
  await waitFor(async()=>{
    const text=await fs.readFile(gameLog,'utf8');
    if(!alive(restartedPid))throw Error('Relaunched game exited before TITLE_READY; output: '+text);
    return text.includes('TITLE_READY menu=true connected=false local_helper=-1');
  },'restarted packaged game reaches its title');
  assert.equal(alive(restartedPid),true,'restarted packaged game exited unexpectedly');
  assert.deepEqual(await fs.readFile(sentinel),originalHistory);assert.equal(await fs.readFile(path.join(root,'unrelated-sibling.txt'),'utf8'),'must survive');
  // Acknowledgement validates the installed app before deleting its old backup.
  await fs.writeFile(path.join(job,'request.json'),JSON.stringify({...request,parentPid:restartedPid,current:sourceManifest.version}));
  const ack=run(node,[helper,'ack',job],{cwd:job,env});const ackResult=await ack.done;
  assert.equal(ackResult.code,0,ackResult.output);assert.equal((await json(path.join(job,'status.json'))).state,'current');await assert.rejects(fs.access(backup));
  assert.deepEqual(await fs.readFile(sentinel),originalHistory);
  await fs.copyFile(gameLog,path.join(evidence,'updater-restarted-game.log'));
  await fs.copyFile(observerEvents,path.join(evidence,'updater-relaunch-events.jsonl'));
  const report={result:'UPDATER_WINDOWS_INSTALL_PASS',version:sourceManifest.version,parentWait:true,inheritedCwdReleased:true,realPackagedGameRestarted:true,isolatedHistoryPreserved:true,backupRemovedAfterAck:true};
  await fs.writeFile(path.join(evidence,'updater-install.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
} catch(e) {
  for(const [name,file] of [['updater-status.json',path.join(job,'status.json')],['updater-restarted-game.log',gameLog],['updater-relaunch-events.jsonl',observerEvents],['updater-restart-pid.json',restartFile]])try{await fs.copyFile(file,path.join(evidence,name));}catch{}
  console.error(`UPDATER_INSTALL_FAILED: ${e.stack}`);
  for(const [label,file] of [['GAME OUTPUT',gameLog],['RELAUNCH EVENTS',observerEvents]])try{console.error(label+'\n'+await fs.readFile(file,'utf8'));}catch{}
  process.exitCode=1;
} finally {
  if(!restartedPid)try{restartedPid=(await json(restartFile)).pid;}catch{}
  for(const pid of [restartedPid,installer?.child.pid,parent?.child.pid])if(pid&&alive(pid))try{process.kill(pid);}catch{}
  for(let i=0;i<30;i++){try{await fs.rm(root,{recursive:true,force:true});break;}catch(e){if(i===29){console.error('Temporary test folder cleanup failed: '+root);process.exitCode=1;}await sleep(200);}}
}
