import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../../assets/board-connection.js',import.meta.url),'utf8');
function client(fetch,online=true){const scope=vm.createContext({window:{},navigator:{onLine:online},fetch,AbortController,setTimeout,clearTimeout,TypeError});vm.runInContext(source,scope);return scope.window.VargiConnection}
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});
test('connection: offline does not upload and network failures carry a distinct code',async()=>{
  let calls=0;const offline=client(async()=>{calls++},false);await assert.rejects(offline.send(new FormData()),e=>e.code==='OFFLINE');assert.equal(calls,0);
  const network=client(async()=>{throw new TypeError('Failed to fetch')});await assert.rejects(network.send(new FormData()),e=>e.code==='NETWORK');assert.equal(await network.health(),false);
});
test('connection: timeout aborts the request without automatic duplicate uploads',async()=>{
  let calls=0;const api=client(async(url,options)=>{calls++;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'}))))});
  await assert.rejects(api.send(new FormData(),10),e=>e.code==='TIMEOUT');assert.equal(calls,1);
});
test('connection: server rejection, malformed reply and rate limit retain diagnostics',async()=>{
  await assert.rejects(client(async()=>json({ok:false,error:'Ошибка проверки'},400,{'X-Request-Id':'trace-1'})).send(new FormData()),e=>e.code==='SERVER'&&e.trace==='trace-1'&&e.status===400);
  await assert.rejects(client(async()=>new Response('gateway failed',{status:502})).send(new FormData()),e=>e.code==='RESPONSE'&&e.status===502);
  await assert.rejects(client(async()=>json({ok:false,retryAfter:120},429)).send(new FormData()),e=>e.code==='RATE_LIMIT'&&e.message.includes('2 мин'));
  await assert.rejects(client(async()=>json({ok:true})).send(new FormData()),e=>e.code==='SERVER');
});
test('connection: only a persisted receipt is success; body/request key is reused on retry',async()=>{
  const data=new FormData();data.append('requestId','stable-key');let seen=[];
  const api=client(async(url,options)=>{seen.push(options.body);if(seen.length===1)throw new TypeError('Lost response');return json({ok:true,id:'saved-id',duplicate:true})});
  await assert.rejects(api.send(data));const result=await api.send(data);assert.equal(result.id,'saved-id');assert.equal(result.duplicate,true);assert.deepEqual(seen,[data,data]);
});
