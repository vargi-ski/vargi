import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../../assets/board-connection.js',import.meta.url),'utf8');
function client(fetch,online=true){
  const scope=vm.createContext({window:{},navigator:{onLine:online},fetch,AbortController,setTimeout,clearTimeout,TypeError});
  vm.runInContext(source,scope);
  return scope.window.VargiConnection;
}
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});

test('connection: offline does not upload and complete network failure is explicit',async()=>{
  let calls=0;
  const offline=client(async()=>{calls++},false);
  await assert.rejects(offline.send(new FormData()),e=>e.code==='OFFLINE');
  assert.equal(calls,0);

  const data=new FormData();data.append('requestId','stable-key');
  const network=client(async()=>{calls++;throw new TypeError('Failed to fetch')});
  await assert.rejects(network.send(data),e=>e.code==='NETWORK'&&e.message.includes('резерв'));
  assert.equal(calls,2);
  assert.equal(await network.health(),false);
});

test('connection: submission without requestId is never retried automatically after timeout',async()=>{
  let calls=0;
  const api=client(async(url,options)=>{
    calls++;
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'}))));
  });
  await assert.rejects(api.send(new FormData(),20),e=>e.code==='TIMEOUT');
  assert.equal(calls,1);
});

test('connection: idempotent submission falls back to Railway and reuses the same body',async()=>{
  const data=new FormData();data.append('requestId','stable-key');
  const seen=[];
  const api=client(async(url,options)=>{
    seen.push([url,options.body]);
    if(url.startsWith('https://market.xn----7sbbfg4a6clj5k.xn--p1ai'))throw new TypeError('DNS failed');
    return json({ok:true,id:'saved-id',duplicate:false});
  });
  const result=await api.send(data);
  assert.equal(result.id,'saved-id');
  assert.equal(seen.length,2);
  assert.equal(seen[0][1],data);
  assert.equal(seen[1][1],data);
  assert.equal(api.base,'https://market-api-production-d9ab.up.railway.app');
});

test('connection: GET requests automatically fail over and remember the working endpoint',async()=>{
  const calls=[];
  const api=client(async url=>{
    calls.push(url);
    if(url.startsWith('https://market.xn----7sbbfg4a6clj5k.xn--p1ai'))throw new TypeError('DNS failed');
    return json({ok:true,listings:[]});
  });
  const response=await api.request('/listings',{cache:'no-store'},{timeoutMs:1000});
  assert.equal(response.status,200);
  assert.equal(calls.length,2);
  assert.equal(api.base,'https://market-api-production-d9ab.up.railway.app');
});

test('connection: server rejection, malformed reply and rate limit retain diagnostics',async()=>{
  await assert.rejects(client(async()=>json({ok:false,error:'Ошибка проверки'},400,{'X-Request-Id':'trace-1'})).send(new FormData()),e=>e.code==='SERVER'&&e.trace==='trace-1'&&e.status===400);
  await assert.rejects(client(async()=>new Response('gateway failed',{status:502})).send(new FormData()),e=>e.code==='RESPONSE'&&e.status===502);
  await assert.rejects(client(async()=>json({ok:false,retryAfter:120},429)).send(new FormData()),e=>e.code==='RATE_LIMIT'&&e.message.includes('2 мин'));
  await assert.rejects(client(async()=>json({ok:true})).send(new FormData()),e=>e.code==='SERVER');
});
