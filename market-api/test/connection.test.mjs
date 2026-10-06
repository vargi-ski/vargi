import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../../assets/board-connection.js',import.meta.url),'utf8');
function client(fetch,online=true){
  const scope=vm.createContext({
    window:{location:{origin:'https://xn----7sbbfg4a6clj5k.xn--p1ai'}},
    navigator:{onLine:online},fetch,AbortController,setTimeout,clearTimeout,TypeError
  });
  vm.runInContext(source,scope);
  return scope.window.VargiConnection;
}
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});

test('connection: offline does not upload',async()=>{
  let calls=0;
  const offline=client(async()=>{calls++},false);
  await assert.rejects(offline.send(new FormData()),e=>e.code==='OFFLINE');
  assert.equal(calls,0);
});

test('connection: GET prefers same-origin proxy and falls back if route is absent',async()=>{
  const calls=[];
  const api=client(async url=>{
    calls.push(url);
    if(url.startsWith('https://xn----7sbbfg4a6clj5k.xn--p1ai/api/market')) return json({ok:false},404);
    return json({ok:true,listings:[]});
  });
  const response=await api.request('/listings',{cache:'no-store'},{timeoutMs:1000});
  assert.equal(response.status,200);
  assert.equal(calls.length,2);
  assert.ok(calls[0].includes('/api/market/listings'));
  assert.equal(api.base,'https://market.xn----7sbbfg4a6clj5k.xn--p1ai');
});

test('connection: total network failure tries proxy plus both Railway routes',async()=>{
  const data=new FormData();data.append('requestId','stable-key');
  let calls=0;
  const network=client(async()=>{calls++;throw new TypeError('Failed to fetch')});
  await assert.rejects(network.send(data),e=>e.code==='NETWORK');
  assert.equal(calls,3);
  assert.equal(await network.health(),false);
});

test('connection: idempotent submission can fail over without duplicating body',async()=>{
  const data=new FormData();data.append('requestId','stable-key');
  const seen=[];
  const api=client(async(url,options)=>{
    seen.push([url,options.body]);
    if(url.includes('/api/market/')) return json({ok:false},404);
    if(url.startsWith('https://market.xn----7sbbfg4a6clj5k.xn--p1ai')) throw new TypeError('DNS failed');
    return json({ok:true,id:'saved-id',duplicate:false});
  });
  const result=await api.send(data);
  assert.equal(result.id,'saved-id');
  assert.equal(seen.length,3);
  assert.equal(seen[0][1],data);
  assert.equal(seen[1][1],data);
  assert.equal(seen[2][1],data);
  assert.equal(api.base,'https://market-api-production-d9ab.up.railway.app');
});

test('connection: submission without requestId is never retried automatically',async()=>{
  let calls=0;
  const api=client(async(url,options)=>{
    calls++;
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'}))));
  });
  await assert.rejects(api.send(new FormData(),20),e=>e.code==='TIMEOUT');
  assert.equal(calls,1);
});
