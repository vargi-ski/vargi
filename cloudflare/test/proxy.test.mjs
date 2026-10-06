import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const origin = 'https://market-api-production-d9ab.up.railway.app';
const run = (path, init={}) => worker.fetch(new Request('https://test.example/api/market'+path, init), {}, {});

test('catalogue forwards query and caches only anonymous successful responses', async t => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    captured={url,init}; return Response.json({ok:true,listings:[]});
  });
  const response=await run('/listings?category=skis');
  assert.equal(captured.url, origin+'/listings?category=skis');
  assert.equal(captured.init.cf.cacheTtlByStatus['200'],60);
  assert.equal(captured.init.cf.cacheTtlByStatus['201-599'],-1);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('cards and photos recheck origin after removal without caching contacts or images', async t => {
  let removed=false;
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    calls.push(init);
    return removed ? new Response(null,{status:404}) : new Response('published',{headers:{'cache-control':'public, max-age=2592000'}});
  });
  for(const path of ['/listings/id','/listings/id/photos/photo.jpg']){
    removed=false;
    const first=await run(path);
    assert.equal(first.status,200);
    assert.equal(first.headers.get('cache-control'),'no-store');
    removed=true;
    const second=await run(path);
    assert.equal(second.status,404);
    assert.equal(second.headers.get('cache-control'),'no-store');
  }
  for(const init of calls){assert.equal(init.cache,'no-store');assert.equal(init.cf,undefined);}
});

test('authenticated catalogue bypasses edge cache', async t=>{
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(init.cache,'no-store');assert.equal(init.cf,undefined);
    return Response.json({ok:true});
  });
  await run('/listings',{headers:{authorization:'Bearer synthetic-test-token'}});
  await run('/listings',{headers:{cookie:'synthetic=test'}});
});

test('admin authorization and status are preserved without cache',async t=>{
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,origin+'/admin/status');
    assert.equal(init.headers.get('authorization'),'Bearer synthetic-test-token');
    assert.equal(init.cache,'no-store');
    return Response.json({ok:false},{status:401});
  });
  const response=await run('/admin/status',{headers:{authorization:'Bearer synthetic-test-token'}});
  assert.equal(response.status,401);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('multipart submission forwards body and retry key',async t=>{
  const form=new FormData(); form.set('title','Synthetic test');form.set('photos',new Blob(['photo'],{type:'image/jpeg'}),'test.jpg');
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,origin+'/submit');assert.equal(init.method,'POST');
    assert.equal(init.headers.get('x-idempotency-key'),'synthetic-key');
    assert.match(init.headers.get('content-type'),/^multipart\/form-data; boundary=/);
    assert.match(await new Response(init.body).text(),/Synthetic test/);
    assert.equal(init.cache,'no-store');
    return Response.json({ok:true,id:'synthetic-id'},{status:201});
  });
  const response=await run('/submit',{method:'POST',body:form,headers:{'x-idempotency-key':'synthetic-key'}});
  assert.equal(response.status,201);assert.equal((await response.json()).id,'synthetic-id');
});

test('upstream network failure returns identifiable 502 without cache',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('network');});
  const response=await run('/health');
  assert.equal(response.status,502);
  assert.equal((await response.json()).error,'edge_upstream_unreachable');
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('prefix lookalikes are not sent upstream',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('unexpected upstream');});
  const response=await worker.fetch(new Request('https://test.example/api/market-other/listings'),{},{});
  assert.equal(response.status,404);
});

test('catalogue CSP permits the same-origin market endpoint',async()=>{
  const html=await readFile(new URL('../../board/index.html',import.meta.url),'utf8');
  const csp=html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp,/(?:^|;)\s*connect-src\s+[^;]*'self'/);
});
