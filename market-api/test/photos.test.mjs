import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../../assets/board-photos.js',import.meta.url),'utf8');

function file(mime,size,name='sample'){
  const bytes=new Uint8Array(Math.max(size,12));
  if(mime==='image/jpeg')bytes.set([255,216,255]);
  if(mime==='image/png')bytes.set([137,80,78,71]);
  if(mime==='image/webp'){bytes.set(Buffer.from('RIFF'));bytes.set(Buffer.from('WEBP'),8)}
  if(mime==='image/heic'){bytes.set(Buffer.from('ftyp'),4);bytes.set(Buffer.from('heic'),8)}
  return new File([bytes],name,{type:mime,lastModified:123456});
}

function browser({nativeHeic=false,width=4000,height=3000,encode}={}){
  let serial=0;
  const objects=new Map(),revoked=[],encoded=[];
  const URL={
    createObjectURL(file){const id='blob:synthetic/'+(++serial);objects.set(id,file);return id},
    revokeObjectURL(id){revoked.push(id);objects.delete(id)}
  };
  class Image{
    constructor(){this.naturalWidth=width;this.naturalHeight=height}
    async decode(){if(objects.get(this.src)?.type==='image/heic'&&!nativeHeic)throw new Error('No native decoder')}
  }
  const document={createElement(tag){
    assert.equal(tag,'canvas');
    return {width:0,height:0,getContext(){return {drawImage(){},fillRect(){}}},toBlob(callback,mime,quality){
      encoded.push([this.width,this.height,quality]);
      const size=encode?encode(this.width,this.height,quality):Math.ceil(this.width*this.height*quality*.8);
      const bytes=new Uint8Array(size);bytes.set([255,216,255]);callback(new Blob([bytes],{type:mime}));
    }};
  }};
  const context=vm.createContext({window:{},File,Blob,URL,Image,document,Uint8Array,setTimeout,clearTimeout});
  vm.runInContext(source,context);
  return {api:context.window.VargiPhotos,encoded,revoked,objects};
}

test('gateway photos: JPEG, PNG and WebP use the real preparation algorithm with quality and dimension fallback',async()=>{
  for(const mime of ['image/jpeg','image/png','image/webp']){
    const b=browser();
    const original=file(mime,2500000,'image.original');
    const result=await b.api.preparePhoto(original,{gateway:true});
    assert.equal(result.type,'image/jpeg');
    assert.ok(result.size<=300000);
    assert.ok(b.encoded.some(([width])=>width<1800));
    assert.equal(b.revoked.length,1);
    assert.equal(b.objects.size,0);
    assert.equal(original.size,2500000);
  }
});

test('railway photos: existing photo budget and server-side HEIC conversion are unchanged',async()=>{
  const b=browser();
  const original=file('image/heic',5000000,'original.heic');
  const prepared=await b.api.preparePhoto(original);
  assert.equal(prepared.type,'image/heic');
  assert.equal(prepared.name,original.name);
  assert.equal(prepared.lastModified,original.lastModified);
  assert.deepEqual(Buffer.from(await prepared.arrayBuffer()),Buffer.from(await original.arrayBuffer()));
  assert.equal(b.encoded.length,0);
  assert.equal(b.api.totalPhotoBytes(),24*1024*1024);
  assert.equal(b.api.totalPhotoBytes(true),1850000);
});

test('gateway HEIC: successful native decoding prepares JPEG without a third-party decoder',async()=>{
  const b=browser({nativeHeic:true});
  const prepared=await b.api.preparePhoto(file('image/heic',3000000,'original.heic'),{gateway:true});
  assert.equal(prepared.type,'image/jpeg');
  assert.ok(prepared.size<=300000);
  assert.equal(b.revoked.length,1);
});

test('gateway HEIC: unsupported native decoding retains a small original and stops a large one before upload',async()=>{
  const b=browser();
  const small=file('image/heic',1000000,'original.heic');
  const prepared=await b.api.preparePhoto(small,{gateway:true});
  assert.equal(prepared.type,'image/heic');
  assert.deepEqual(Buffer.from(await prepared.arrayBuffer()),Buffer.from(await small.arrayBuffer()));
  await assert.rejects(b.api.preparePhoto(file('image/heic',2500000),{gateway:true}),e=>e.code==='HEIC_LIMIT');
  assert.equal(b.encoded.length,0);
  assert.equal(b.revoked.length,2);
  assert.equal(b.objects.size,0);
});

test('photos: MIME spoofing and excessive decoded dimensions are rejected',async()=>{
  const b=browser();
  const wrong=new File([await file('image/jpeg',1000).arrayBuffer()],'wrong.png',{type:'image/png'});
  await assert.rejects(b.api.preparePhoto(wrong,{gateway:true}),/не соответствует/);
  const large=browser({width:9000,height:9000});
  await assert.rejects(large.api.preparePhoto(file('image/jpeg',1000),{gateway:true}),/64 мегапикселей/);
  assert.equal(large.encoded.length,0);
  assert.equal(large.objects.size,0);
});

test('photos: an encoder that cannot meet the budget fails without replacing the selected original',async()=>{
  const b=browser({encode:()=>400000});
  const original=file('image/png',2500000);
  await assert.rejects(b.api.preparePhoto(original,{gateway:true}),/не удалось уменьшить/);
  assert.equal(original.size,2500000);
  assert.equal(original.type,'image/png');
  assert.equal(b.objects.size,0);
});
