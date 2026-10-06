import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import sharp from 'sharp';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const origin = 'https://xn----7sbbfg4a6clj5k.xn--p1ai';
const jpeg = await sharp({create:{width:120,height:80,channels:3,background:'#8fd0ef'}}).jpeg().toBuffer();
const png = await sharp(jpeg).png().toBuffer();
const webp = await sharp(jpeg).webp().toBuffer();
const fields = () => ({requestId:randomUUID(),title:'ТЕСТ — синтетическое объявление',city:'Тестовый город',categoryKey:'clothes',category:'Одежда и аксессуары',condition:'Б/у',priceValue:'1000',price:'1000 ₽',description:'Автоматический тест, не реальный товар.',contactName:'Тест',publicContact:'@test_do_not_contact',consent:'true',consentVersion:'board-submit-2026-10-05'});

async function server(dataDir) {
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{PATH:process.env.PATH,PORT:String(port),DATA_ROOT:dataDir,SITE_ORIGIN:origin,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>{logs+=b});child.stderr.on('data',b=>{logs+=b});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Server startup timeout: '+logs))},10000);
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited: '+code+' '+logs))});
    child.stdout.on('data',b=>{if(b.toString().includes('listening on')){clearTimeout(timer);resolve()}});
  });
  return {url:`http://127.0.0.1:${port}`,logs:()=>logs,async stop(){const exited=once(child,'exit');child.kill('SIGTERM');await exited}};
}
async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'vargi-submit-test-'));
  let app=await server(dataDir);
  t.after(async()=>{await app.stop();await rm(dataDir,{recursive:true,force:true})});
  return {get app(){return app},dataDir,async restart(){await app.stop();app=await server(dataDir)}};
}
async function post(app,values=fields(),photos=[{bytes:jpeg,type:'image/jpeg'}]) {
  const form=new FormData();for(const [key,value] of Object.entries(values))if(value!==undefined)form.append(key,String(value));
  photos.forEach((p,i)=>form.append('photos',new Blob([p.bytes],{type:p.type}),`synthetic-${i}.jpg`));
  const response=await fetch(app.url+'/submit',{method:'POST',headers:{Origin:origin},body:form,signal:AbortSignal.timeout(10000)});
  return {status:response.status,headers:response.headers,body:await response.json()};
}

test('client: verified MIME is retained, 48 MP resizes, >64 MP is rejected',async()=>{
  const source=await readFile(join(root,'../board/submit/index.html'),'utf8');
  const code=source.slice(source.indexOf('async function signature('),source.indexOf('async function addPhoto('));
  let width=120,height=80,canvas;
  const scope=vm.createContext({File,Blob,URL,Uint8Array,Image:class {naturalWidth=width;naturalHeight=height;async decode(){}},document:{createElement(){canvas={getContext(){return{drawImage(){}}},toBlob(cb){cb(new Blob([jpeg],{type:'image/jpeg'}))}};return canvas}}});
  vm.runInContext(code,scope);
  for(const type of ['image/jpeg','','image/jpg','application/octet-stream']){scope.file=new File([jpeg],'test.jpg',{type});const result=await vm.runInContext('compressPhoto(file)',scope);assert.equal(result.type,'image/jpeg')}
  width=8000;height=6000;scope.file=new File([jpeg],'48mp.jpg',{type:'image/jpeg'});
  const resized=await vm.runInContext('compressPhoto(file)',scope);assert.equal(resized.type,'image/jpeg');assert.equal(canvas.width,1800);assert.equal(canvas.height,1350);
  width=10000;height=7000;await assert.rejects(()=>vm.runInContext('compressPhoto(file)',scope),/64 мегапикселей/);
  assert.match(source,/VargiConnection.send\(data\)/);assert.match(source,/data.append\('requestId'/);assert.match(source,/data.append\('consent','true'\)/);
});

test('JPEG, PNG and WebP save pending; metadata records consent and private fields stay private',async t=>{
  const f=await fixture(t);
  for(const [bytes,type] of [[jpeg,'image/jpeg'],[png,'image/png'],[webp,'image/webp']]){
    const values=fields();const r=await post(f.app,values,[{bytes,type}]);assert.equal(r.status,201);
    const saved=JSON.parse(await readFile(join(f.dataDir,'submissions',r.body.id,'submission.json'),'utf8'));
    assert.equal(saved.status,'pending');assert.equal(saved.photos[0].mimeType,'image/jpeg');assert.equal(saved.requestId,values.requestId);assert.equal(saved.consent.accepted,true);
    assert.equal(saved.contact,'Тест — @test_do_not_contact');
  }
  const publicResponse=await fetch(f.app.url+'/listings');assert.deepEqual((await publicResponse.json()).listings,[]);
  assert.equal((await fetch(f.app.url+'/admin/submissions')).status,401);
});

test('unknown/alias MIME is detected by signature; mismatched or damaged files fail clearly',async t=>{
  const f=await fixture(t);
  for(const type of ['', 'image/jpg'])assert.equal((await post(f.app,fields(),[{bytes:jpeg,type}])).status,201);
  assert.equal((await post(f.app,fields(),[{bytes:png,type:'image/jpeg'}])).status,400);
  const bad=await post(f.app,fields(),[{bytes:Buffer.from([255,216,255,0,0,0,0,0,0,0,0,0]),type:'image/jpeg'}]);
  assert.equal(bad.status,400);assert.match(bad.body.error,/фото №1/);
  const unsupported=await post(f.app,fields(),[{bytes:Buffer.from('not an image'),type:'text/plain'}]);assert.equal(unsupported.status,400);assert.match(unsupported.body.error,/Неподдерживаемый/);
  assert.equal((await readdir(join(f.dataDir,'submissions'))).length,2);
});

for(const [name,changes] of Object.entries({city:{city:''},category:{categoryKey:'invalid'},price:{priceValue:'-1'},fractionalPrice:{priceValue:'1.5'},name:{contactName:''},contact:{publicContact:'a'},description:{description:''},consent:{consent:undefined},requestId:{requestId:'invalid'},skis:{categoryKey:'skis',style:'Коньковые',length:'999'}})){
  test('server validation: '+name,async t=>{const f=await fixture(t);assert.equal((await post(f.app,{...fields(),...changes})).status,400);assert.deepEqual(await readdir(join(f.dataDir,'submissions')),[])});
}

test('retry, concurrent duplicate, changed payload and restart are handled without extra submissions',async t=>{
  const f=await fixture(t),values=fields();
  const first=await post(f.app,values);assert.equal(first.status,201);
  const retry=await post(f.app,values);assert.equal(retry.status,200);assert.equal(retry.body.id,first.body.id);assert.equal(retry.body.duplicate,true);
  assert.equal((await post(f.app,{...values,title:'Другие данные с тем же ключом'})).status,409);
  const parallelValues=fields();const parallel=await Promise.all([post(f.app,parallelValues),post(f.app,parallelValues)]);
  assert.deepEqual(parallel.map(r=>r.status).sort(),[200,201]);assert.equal(parallel[0].body.id,parallel[1].body.id);
  assert.equal((await readdir(join(f.dataDir,'submissions'))).length,2);
  await f.restart();const afterRestart=await post(f.app,values);assert.equal(afterRestart.status,200);assert.equal(afterRestart.body.id,first.body.id);
});

test('file count, byte limits, required photo and rate-limit response remain enforced',async t=>{
  const f=await fixture(t);
  assert.equal((await post(f.app,fields(),Array.from({length:7},()=>({bytes:jpeg,type:'image/jpeg'})))).status,413);
  assert.equal((await post(f.app,fields(),[{bytes:Buffer.concat([jpeg,Buffer.alloc(8*1024*1024)]),type:'image/jpeg'}])).status,413);
  assert.equal((await post(f.app,fields(),[])).status,400);
  for(let i=0;i<3;i++)assert.equal((await post(f.app,{...fields(),title:''})).status,400);
  const limited=await post(f.app);assert.equal(limited.status,429);assert(limited.body.retryAfter>0);assert(limited.headers.get('access-control-expose-headers').includes('Retry-After'));
});

test('real 48 MP JPEG is safely resized by server and CORS remains restricted',async t=>{
  const f=await fixture(t);
  const large=await sharp({create:{width:8000,height:6000,channels:3,background:'#8fd0ef'}}).jpeg().toBuffer();
  const r=await post(f.app,fields(),[{bytes:large,type:'image/jpeg'}]);assert.equal(r.status,201);
  const metadata=await sharp(join(f.dataDir,'submissions',r.body.id,'photo-01.jpg')).metadata();assert.equal(metadata.width,1800);assert.equal(metadata.height,1350);
  const allowed=await fetch(f.app.url+'/submit',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST'}});assert.equal(allowed.status,204);assert.equal(allowed.headers.get('access-control-allow-origin'),origin);
  const denied=await fetch(f.app.url+'/submit',{method:'OPTIONS',headers:{Origin:'https://example.invalid','Access-Control-Request-Method':'POST'}});assert.equal(denied.status,400);assert.equal(denied.headers.get('access-control-allow-origin'),null);
});

test('health checks actual storage and failed writes cannot report a healthy service',async t=>{
  const f=await fixture(t);
  let response=await fetch(f.app.url+'/health');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).version,'2026-10-06');
  const data=join(f.dataDir,'submissions');await rename(data,data+'-saved');await writeFile(data,'not a directory');
  response=await fetch(f.app.url+'/health');assert.equal(response.status,503);assert.equal((await response.json()).ok,false);
});

test('submission response trace is exposed and logged without private fields',async t=>{
  const f=await fixture(t),values={...fields(),publicContact:'private-contact-should-not-appear'};
  const response=await post(f.app,values);const trace=response.headers.get('x-request-id');
  assert.match(trace,/^[a-f0-9-]{36}$/);assert(response.headers.get('access-control-expose-headers').includes('X-Request-Id'));
  const until=Date.now()+1000;while(!f.app.logs().includes('status=201')&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  assert(f.app.logs().includes('submission_request trace='+trace));assert(f.app.logs().includes('status=201'));assert(!f.app.logs().includes(values.publicContact));
});
