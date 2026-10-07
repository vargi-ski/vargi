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

const proxy='https://xn----7sbbfg4a6clj5k.xn--p1ai/api/market';
const primary='https://market.xn----7sbbfg4a6clj5k.xn--p1ai';
const fallback='https://market-api-production-d9ab.up.railway.app';
const missingProxy=(status=404)=>new Response('<!doctype html><title>Not found</title>',{
  status,headers:{'Content-Type':'text/html; charset=utf-8'}
});

test('connection: absent proxy HTML cannot conceal network failures from both real API routes',async()=>{
  const calls=[];
  const api=client(async url=>{
    calls.push(url);
    if(url.startsWith(proxy))return missingProxy();
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(api.request('/listings'),e=>e.code==='NETWORK');
  assert.deepEqual(calls,[proxy+'/listings',primary+'/listings',fallback+'/listings']);
});

test('connection: absent proxy HTML cannot conceal timeouts from the real API routes',async()=>{
  let calls=0;
  const api=client(async url=>{
    calls++;
    if(url.startsWith(proxy))return missingProxy();
    throw Object.assign(new Error('Aborted'),{name:'AbortError'});
  });
  await assert.rejects(api.request('/listings'),e=>e.code==='TIMEOUT');
  assert.equal(calls,3);
});

test('connection: an absent proxy cannot conceal failures after a real API was selected earlier',async()=>{
  for(const preferred of [primary,fallback]){
    let failing=false;
    const calls=[];
    const api=client(async url=>{
      calls.push(url);
      if(url.startsWith(proxy))return missingProxy();
      if(failing||!url.startsWith(preferred))throw new TypeError('Failed to fetch');
      return json({ok:true,listings:[]});
    });
    await api.request('/listings');
    assert.equal(api.base,preferred);
    calls.length=0;failing=true;
    await assert.rejects(api.request('/listings'),e=>e.code==='NETWORK');
    assert.equal(calls.length,3);
    assert.equal(calls[0],preferred+'/listings');
    assert.deepEqual(new Set(calls),new Set([proxy+'/listings',primary+'/listings',fallback+'/listings']));
    assert.equal(api.base,preferred);
  }
});

test('connection: idempotent upload reports network failure after the absent HTML proxy',async()=>{
  const data=new FormData();data.append('requestId','stable-key');
  const seen=[];
  const api=client(async(url,options)=>{
    seen.push([url,options.body]);
    if(url.startsWith(proxy))return missingProxy(405);
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(api.send(data),e=>e.code==='NETWORK');
  assert.deepEqual(seen.map(([url])=>url),[proxy+'/submit',primary+'/submit',fallback+'/submit']);
  assert.ok(seen.every(([,body])=>body===data));
});

test('connection: genuine API 404 and authentication errors are returned without another fallback',async()=>{
  for(const status of [400,401,403,404,429]){
    const calls=[];
    const api=client(async url=>{
      calls.push(url);
      if(url.startsWith(proxy))return missingProxy();
      return json({ok:false,error:'Actual API response'},status,{'Content-Type':'application/json'});
    });
    const response=await api.request('/listings/missing');
    assert.equal(response.status,status);
    assert.equal((await response.json()).error,'Actual API response');
    assert.deepEqual(calls,[proxy+'/listings/missing',primary+'/listings/missing']);
    assert.equal(api.base,primary);
  }
});

test('connection: genuine proxy JSON errors remain available if the other routes fail',async()=>{
  const api=client(async url=>{
    if(url.startsWith(proxy))return json({ok:false,error:'Genuine proxy response'},404,{'Content-Type':'application/json'});
    throw new TypeError('Failed to fetch');
  });
  const response=await api.request('/listings/missing');
  assert.equal(response.status,404);
  assert.equal((await response.json()).error,'Genuine proxy response');
});

test('connection: genuine API server errors remain available after a later network failure',async()=>{
  const api=client(async url=>{
    if(url.startsWith(proxy))return missingProxy();
    if(url.startsWith(primary))return json({ok:false,error:'API unavailable'},503,{'Content-Type':'application/json'});
    throw new TypeError('Failed to fetch');
  });
  const response=await api.request('/listings');
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,'API unavailable');
});

test('connection: an absent proxy cannot replace a genuine server error from an already selected API',async()=>{
  let failing=false;
  const calls=[];
  const api=client(async url=>{
    calls.push(url);
    if(url.startsWith(proxy))return missingProxy();
    if(url.startsWith(primary))return failing
      ?json({ok:false,error:'Actual API unavailable'},503,{'Content-Type':'application/json'})
      :json({ok:true,listings:[]});
    throw new TypeError('Failed to fetch');
  });
  await api.request('/listings');
  assert.equal(api.base,primary);
  calls.length=0;failing=true;
  const response=await api.request('/listings');
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,'Actual API unavailable');
  assert.deepEqual(calls,[primary+'/listings',proxy+'/listings',fallback+'/listings']);
});

test('connection: non-idempotent writes and explicitly disabled retries keep their single-response contract',async()=>{
  for(const [method,config] of [['POST',{}],['PUT',{}],['GET',{safeRetry:false}]]){
    const calls=[];
    const api=client(async(url,options)=>{
      calls.push([url,options.method]);
      return missingProxy();
    });
    const response=await api.request('/admin/action',{method},config);
    assert.equal(response.status,404);
    assert.equal(response.headers.get('Content-Type'),'text/html; charset=utf-8');
    assert.deepEqual(calls,[[proxy+'/admin/action',method]]);
  }
});
