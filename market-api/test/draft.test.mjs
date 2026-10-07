import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const [connectionSource,photosSource,draftSource,html]=await Promise.all([
  readFile(new URL('../../assets/board-connection.js',import.meta.url),'utf8'),
  readFile(new URL('../../assets/board-photos.js',import.meta.url),'utf8'),
  readFile(new URL('../../assets/board-draft.js',import.meta.url),'utf8'),
  readFile(new URL('../../board/submit/index.html',import.meta.url),'utf8')
]);
const pageSource=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match=>match[1]).find(code=>code.includes('let photos=[]'));
assert.ok(pageSource,'The submission page script is present');
const gateway='https://gateway.example.test';
const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});

// IndexedDB structured cloning preserves File bytes and metadata. Node's
// structuredClone does not preserve File.name, so model the browser contract.
function clone(value){
  if(value instanceof File)return new File([value],value.name,{type:value.type,lastModified:value.lastModified});
  if(Array.isArray(value))return value.map(clone);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)]));
  return value;
}
function indexedDB(memory){
  let created=false;
  const database={close(){},createObjectStore(){},transaction(){
    const tx={objectStore(){
      function request(action){
        const result={};
        queueMicrotask(()=>{result.result=action();tx.oncomplete?.()});
        return result;
      }
      return {
        get:key=>request(()=>clone(memory.get(key))),
        put:(value,key)=>request(()=>{memory.set(key,clone(value));return key}),
        delete:key=>request(()=>memory.delete(key))
      };
    }};
    return tx;
  }};
  return {open(){
    const request={result:database};
    queueMicrotask(()=>{if(!created){created=true;request.onupgradeneeded?.()}request.onsuccess?.()});
    return request;
  }};
}

const ad={kind:'sell',category:'skis',title:'Лыжи для теста',city:'Мурманск',price:5000,
  description:'Описание\nсохраняется',contactName:'Тест',publicContact:'@test_user',condition:'Хорошее',
  length:'190',style:'Коньковые',structureKind:'unknown',consent:'true'};

function page(memory,{failSubmit=false}={}){
  let blobId=0;
  const objects=new Map(),encoded=[],packets=[],elements=new Map();
  class BrowserURL extends URL{
    static createObjectURL(file){const id='blob:test/'+(++blobId);objects.set(id,file);return id}
    static revokeObjectURL(id){objects.delete(id)}
  }
  class Image{
    constructor(){this.naturalWidth=4000;this.naturalHeight=3000}
    async decode(){if(objects.get(this.src)?.type==='image/heic')throw new Error('No native HEIC codec')}
  }
  function element(selector){
    if(!elements.has(selector))elements.set(selector,{value:'',type:'text',hidden:false,disabled:false,
      classList:{add(){},remove(){}},addEventListener(){},focus(){},scrollIntoView(){}});
    return elements.get(selector);
  }
  const fields=Object.entries(ad).map(([name,value])=>({name,value:String(value),type:name==='consent'?'checkbox':'text',checked:name==='consent'}));
  fields.namedItem=name=>fields.find(field=>field.name===name);
  element('#adForm').elements=fields;
  for(const field of fields){elements.set('#'+field.name,field);elements.set('[name="'+field.name+'"]',field)}
  const document={querySelector:element,addEventListener(){},createElement(tag){
    assert.equal(tag,'canvas');
    return {width:0,height:0,getContext(){return {drawImage(){},fillRect(){}}},toBlob(callback,mime,quality){
      encoded.push([this.width,this.height,quality]);
      const bytes=new Uint8Array(240000);bytes.set([255,216,255]);callback(new Blob([bytes],{type:mime}));
    }};
  }};
  const location={origin:'https://xn----7sbbfg4a6clj5k.xn--p1ai',href:''};
  const context=vm.createContext({window:{location,addEventListener(){},VARGI_MARKET_CONFIG:{transport:'gateway',gatewayEndpoint:gateway}},
    navigator:{onLine:true},location,document,indexedDB:indexedDB(memory),Image,URL:BrowserURL,crypto:webcrypto,
    File,Blob,FormData,Request,Response,AbortController,TypeError,Uint8Array,setTimeout,clearTimeout,scrollTo(){},alert(){},
    async fetch(url,options){
      if(url.endsWith('/health'))return json({ok:true});
      assert.equal(url,gateway+'/submit');
      assert.ok(options.body instanceof Blob);
      packets.push(await new Request(url,{method:'POST',body:options.body,headers:options.headers}).formData());
      if(failSubmit)throw new TypeError('Connection closed after upload');
      return json({ok:true,id:'saved-id',duplicate:true});
    }
  });
  for(const source of [connectionSource,photosSource,draftSource])vm.runInContext(source,context);
  Object.assign(context,context.window);
  vm.runInContext(pageSource,context);
  const run=code=>vm.runInContext(code,context);
  return {context,run,encoded,packets,element,location,async ready(){await run('VargiDraft.load()');await Promise.resolve()}};
}
async function bytes(file){return Buffer.from(await file.arrayBuffer())}

test('gateway draft: prepared photo and requestId survive a failed upload, page restart and actual page retry',async()=>{
  const memory=new Map();
  const first=page(memory,{failSubmit:true});
  await first.ready();
  const original=new Uint8Array(2500000);original.set([137,80,78,71]);
  first.context.upload=new File([original],'original.png',{type:'image/png',lastModified:123456});
  first.context.ad=ad;
  await first.run('addPhoto(upload)');
  first.run('showPreview(ad)');
  await first.run('saveDraft()');
  const prepared=first.run('photos[0].file');
  const requestId=first.run('preparedSubmission.requestId');
  assert.equal(prepared.type,'image/jpeg');
  assert.ok(first.encoded.length>0);
  await first.element('#sendButton').onclick();
  assert.match(first.element('#sendStatus').textContent,/NETWORK/);
  assert.equal(first.location.href,'');
  assert.equal(memory.get('current').preparedSubmission.requestId,requestId);

  const restarted=page(memory);
  await restarted.ready();
  restarted.element('#restoreDraft').onclick();
  assert.equal(restarted.run('preparedSubmission.requestId'),requestId);
  assert.equal(restarted.run('photos[0].file.name'),prepared.name);
  assert.equal(restarted.run('photos[0].file.lastModified'),prepared.lastModified);
  assert.deepEqual(await bytes(restarted.run('photos[0].file')),await bytes(prepared));
  restarted.context.ad=ad;
  restarted.run('showPreview(ad)');
  assert.equal(restarted.run('preparedSubmission.requestId'),requestId);
  await restarted.element('#sendButton').onclick();
  assert.equal(restarted.encoded.length,0,'Restoring and retrying never recompresses saved files');
  assert.equal(first.packets.length,1);
  assert.equal(restarted.packets.length,1);
  for(const packet of [...first.packets,...restarted.packets]){
    assert.equal(packet.get('requestId'),requestId);
    assert.equal(packet.get('description'),'Описание\r\nсохраняется');
    assert.equal(packet.get('photos').name,prepared.name);
    assert.deepEqual(await bytes(packet.get('photos')),await bytes(prepared));
  }
  assert.equal(restarted.location.href,'/board/submit/success/');
  assert.equal(memory.has('current'),false,'Successful submission clears the stored draft');
});

test('gateway draft: an oversized legacy draft stays intact and is blocked before upload',async()=>{
  const memory=new Map();
  const bytes=new Uint8Array(3000000);bytes.set(Buffer.from('ftyp'),4);bytes.set(Buffer.from('heic'),8);
  const original=new File([bytes],'old-photo.heic',{type:'image/heic',lastModified:123456});
  const fingerprint=JSON.stringify([ad,1]);
  memory.set('current',{version:1,savedAt:Date.now(),fields:Object.entries(ad),photos:[original],photoRevision:1,
    preparedSubmission:{requestId:'saved-request-id',fingerprint,message:'Saved message'}});
  const restored=page(memory);
  await restored.ready();
  restored.element('#restoreDraft').onclick();
  restored.context.ad=ad;
  restored.run('showPreview(ad)');
  await restored.element('#sendButton').onclick();
  assert.match(restored.element('#sendStatus').textContent,/PAYLOAD_LIMIT/);
  assert.equal(restored.packets.length,0);
  assert.equal(restored.encoded.length,0);
  assert.equal(restored.run('preparedSubmission.requestId'),'saved-request-id');
  assert.equal(memory.get('current').preparedSubmission.requestId,'saved-request-id');
  assert.deepEqual(Buffer.from(await memory.get('current').photos[0].arrayBuffer()),Buffer.from(bytes));
  assert.equal(restored.location.href,'');
});
