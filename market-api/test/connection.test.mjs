import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../../assets/board-connection.js',import.meta.url),'utf8');
const siteOrigin='https://xn----7sbbfg4a6clj5k.xn--p1ai';
const proxy=siteOrigin+'/api/market';
const primary='https://market.xn----7sbbfg4a6clj5k.xn--p1ai';
const fallback='https://market-api-production-d9ab.up.railway.app';
function client(fetch,online=true,mode='legacy'){
  const scope=vm.createContext({
    window:{location:{origin:siteOrigin},VARGI_MARKET_CONFIG:mode?{mode}:undefined},
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

test('connection: same-origin reads use the local API and return HTTP failures without failover',async()=>{
  for(const status of [200,404,503]){
    const calls=[];
    const api=client(async url=>{
      calls.push(url);
      return json(status===200?{ok:true,listings:[]}:{ok:false},status);
    },true,'same-origin');
    const response=await api.request('/listings');
    assert.equal(response.status,status);
    assert.deepEqual(calls,[proxy+'/listings']);
    assert.deepEqual(Array.from(api.endpoints),[proxy]);
    assert.equal(api.base,proxy);
  }
});

test('connection: same-origin network failures do not try old data stores',async()=>{
  const calls=[];
  const api=client(async url=>{
    calls.push(url);
    throw new TypeError('Failed to fetch');
  },true,'same-origin');
  await assert.rejects(api.request('/listings'),e=>e.code==='NETWORK');
  assert.deepEqual(calls,[proxy+'/listings']);
});

test('connection: a missing or invalid deployment config cannot expose the old data stores',async()=>{
  for(const mode of [null,'unknown']){
    const calls=[];
    const api=client(async url=>{
      calls.push(url);
      throw new TypeError('Failed to fetch');
    },true,mode);
    await assert.rejects(api.request('/listings'),e=>e.code==='NETWORK');
    const data=new FormData();data.append('requestId','stable-key');
    await assert.rejects(api.send(data),e=>e.code==='NETWORK');
    assert.deepEqual(calls,[proxy+'/listings',proxy+'/submit']);
    assert.equal(api.mode,'same-origin');
    assert.equal(api.alternateUrl(primary+'/photos/photo.jpg'),'');
  }
});

test('connection: same-origin idempotent submissions stay local after network and HTTP errors',async()=>{
  const data=new FormData();data.append('requestId','stable-key');
  for(const failure of ['network','server']){
    const calls=[];
    const api=client(async(url,options)=>{
      calls.push([url,options.body]);
      if(failure==='network')throw new TypeError('Failed to fetch');
      return json({ok:false,error:'Сервер недоступен.'},503);
    },true,'same-origin');
    await assert.rejects(api.send(data),e=>e.code===(failure==='network'?'NETWORK':'SERVER'));
    assert.equal(calls.length,1);
    assert.equal(calls[0][0],proxy+'/submit');
    assert.equal(calls[0][1],data);
    assert.equal(api.active,proxy);
  }
});

test('connection: same-origin accepted submissions keep the idempotency body and local endpoint',async()=>{
  const data=new FormData();data.append('requestId','stable-key');
  const calls=[];
  const api=client(async(url,options)=>{
    calls.push([url,options.body]);
    return json({ok:true,id:'local-id',duplicate:true});
  },true,'same-origin');
  const result=await api.send(data);
  assert.equal(result.id,'local-id');
  assert.equal(result.duplicate,true);
  assert.deepEqual(calls,[[proxy+'/submit',data]]);
});

test('connection: same-origin health success, HTTP errors and network errors remain local',async()=>{
  for(const outcome of ['healthy','unhealthy','network']){
    const calls=[];
    const api=client(async url=>{
      calls.push(url);
      if(outcome==='network')throw new TypeError('DNS failed');
      return json({ok:outcome==='healthy'},outcome==='healthy'?200:503);
    },true,'same-origin');
    assert.equal(await api.health(),outcome==='healthy');
    assert.deepEqual(calls,[proxy+'/health']);
  }
});

test('connection: migrated photo URLs stay local and have no Railway alternate',()=>{
  const api=client(async()=>{},true,'same-origin');
  for(const base of [proxy,primary,fallback]){
    const photo=base+'/photos/listing/photo.jpg?size=small#preview';
    assert.equal(api.assetUrl(photo),proxy+'/photos/listing/photo.jpg?size=small#preview');
    assert.equal(api.alternateUrl(photo),'');
  }
  assert.equal(api.assetUrl('/api/market/photos/listing/photo.jpg'),'/api/market/photos/listing/photo.jpg');
  assert.equal(api.alternateUrl('/api/market/photos/listing/photo.jpg'),'');
});

test('connection: photo rewriting requires the full known endpoint boundary in both modes',()=>{
  const unrelated=[
    primary+'.example.org/photos/photo.jpg',
    fallback+'@example.org/photos/photo.jpg',
    proxy+'-other/photos/photo.jpg',
    'https://example.org/photos/photo.jpg'
  ];
  for(const mode of ['legacy','same-origin']){
    const api=client(async()=>{},true,mode);
    for(const photo of unrelated){
      assert.equal(api.assetUrl(photo),photo);
      assert.equal(api.alternateUrl(photo),'');
    }
  }
});

test('connection: legacy photos still follow the active fallback and expose a valid alternate',async()=>{
  const api=client(async url=>url.startsWith(proxy)?json({ok:false},404):json({ok:true,listings:[]}));
  await api.request('/listings');
  assert.equal(api.assetUrl(fallback+'/photos/photo.jpg'),primary+'/photos/photo.jpg');
  assert.equal(api.alternateUrl(primary+'/photos/photo.jpg'),fallback+'/photos/photo.jpg');
});
