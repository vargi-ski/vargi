import { execFile as execFileCallback } from 'node:child_process';
import { createSign, webcrypto } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const env = process.env;
const OUT_RELATIVE = env.ANALYTICS_OUTPUT || 'analytics-dashboard/analytics.enc.json';
const OUT = resolve(OUT_RELATIVE);
const required = ['YANDEX_METRIKA_TOKEN','CLARITY_API_TOKEN','DASHBOARD_PASSWORD'];
const execFile = promisify(execFileCallback);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const iso = d => d.toISOString().slice(0,10);
const daysAgo = n => { const d=new Date(); d.setUTCDate(d.getUTCDate()-n); return iso(d); };
const num = v => Number(v||0);
const googleAppsScriptAccessError = message => {
  const value=String(message||'');
  if(!/\b403\b/i.test(value))return '';
  if(/Authorization is required|needs your permission|Требуется авторизация/i.test(value))return 'Требуется повторная авторизация Google Apps Script';
  if(/accounts\.google\.com|ServiceLogin|Sign in with Google|Войдите в аккаунт/i.test(value))return 'Google Apps Script требует повторный вход владельца';
  if(/You need access|Request access|Access denied|permission to access|нет доступа|запросить доступ/i.test(value))return 'Закрыт доступ к веб-приложению Google Apps Script';
  if(/<!doctype html|<html/i.test(value))return 'Google Apps Script отклонил вызов до запуска моста (403)';
  return '';
};
const friendlyError = error => {
  const message=String(error?.message||error||'Неизвестная ошибка').replace(/\s+/g,' ').trim();
  const appsScriptError=googleAppsScriptAccessError(message);
  if(appsScriptError)return appsScriptError;
  if(/invalid_grant|expired or revoked|token has been revoked/i.test(message))return 'OAuth refresh token истёк или отозван (частая причина — OAuth-приложение осталось в режиме Testing)';
  if(/Authorization is required|needs your permission|Требуется авторизация/i.test(message))return 'Требуется повторная авторизация Google Apps Script';
  if(/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i.test(message))return 'OAuth Google выдан без права чтения Search Console';
  if(/GSC_PROPERTY_NOT_FOUND/i.test(message))return 'Google-аккаунт не имеет доступа к ресурсу варги-стая.рф';
  if(/SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(message)){
    const project=message.match(/project(?:=|\s)(\d{6,})/i)?.[1];
    return project?`Search Console API выключен в проекте ${project}`:'Search Console API подключается';
  }
  if(/PERMISSION_DENIED|\b403\b/i.test(message))return 'Google отклонил доступ к Search Console (403)';
  return message.slice(0,180);
};
const safe = (fn,fallback) => fn().catch(error=>({__error:friendlyError(error),...fallback}));

async function json(url,options={}){let last;for(let i=0;i<3;i++){const r=await fetch(url,options);if(r.ok)return r.json();const body=(await r.text()).replace(/\s+/g,' ').slice(0,1200);last=new Error(`${r.status} ${body}`);if(![429,500,502,503,504].includes(r.status))break;await sleep(800*(i+1));}throw last}
function url(base,params){const u=new URL(base);Object.entries(params).forEach(([k,v])=>v!==undefined&&u.searchParams.set(k,String(v)));return u}

async function yandexReport(params){return json(url('https://api-metrika.yandex.net/stat/v1/data',{id:'111210969',accuracy:'full',filters:"ym:s:isRobot=='No'",limit:100,...params}),{headers:{Authorization:`OAuth ${env.YANDEX_METRIKA_TOKEN}`}})}
const metric = (report,index=0) => num(report?.totals?.[index]);
async function fetchYandex(){
  const metrics='ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:avgVisitDurationSeconds';
  const [current,previous,timeline,sources,pages,goalsInfo]=await Promise.all([
    yandexReport({date1:'6daysAgo',date2:'today',metrics}),yandexReport({date1:'13daysAgo',date2:'7daysAgo',metrics}),
    yandexReport({date1:'13daysAgo',date2:'today',metrics:'ym:s:visits',dimensions:'ym:s:date',sort:'ym:s:date'}),
    yandexReport({date1:'6daysAgo',date2:'today',metrics:'ym:s:visits',dimensions:'ym:s:lastTrafficSource',sort:'-ym:s:visits'}),
    yandexReport({date1:'6daysAgo',date2:'today',metrics:'ym:pv:pageviews',dimensions:'ym:pv:URLPathFull',sort:'-ym:pv:pageviews'}),
    json('https://api-metrika.yandex.net/management/v1/counter/111210969/goals',{headers:{Authorization:`OAuth ${env.YANDEX_METRIKA_TOKEN}`}})
  ]);
  const goals=(goalsInfo.goals||[]).filter(g=>!g.is_retargeting).slice(0,20);let goalRows=[],previousReaches=0;
  if(goals.length){const names=goals.map(g=>`ym:s:goal${g.id}reaches`).join(',');const [gr,prevGr]=await Promise.all([yandexReport({date1:'6daysAgo',date2:'today',metrics:names}),yandexReport({date1:'13daysAgo',date2:'7daysAgo',metrics:names})]);goalRows=goals.map((g,i)=>({name:g.name,reaches:num(gr.totals?.[i])})).sort((a,b)=>b.reaches-a.reaches);previousReaches=(prevGr.totals||[]).reduce((s,x)=>s+num(x),0)}
  const reaches=goalRows.reduce((s,x)=>s+x.reaches,0),previousVisits=metric(previous,0);
  const timelineRows=(timeline.data||[]).map(x=>({date:x.dimensions[0].name,visits:num(x.metrics[0])}));
  return {summary:{visits:metric(current,0),users:metric(current,1),pageviews:metric(current,2),bounceRate:metric(current,3),avgDuration:metric(current,4),conversionRate:metric(current,0)?reaches/metric(current,0)*100:0,previousVisits,previousUsers:metric(previous,1),previousPageviews:metric(previous,2),previousConversionRate:previousVisits?previousReaches/previousVisits*100:0},timeline:timelineRows,sources:(sources.data||[]).slice(0,8).map(x=>({name:x.dimensions[0].name,visits:num(x.metrics[0])})),pages:(pages.data||[]).slice(0,10).map(x=>({name:x.dimensions[0].name,views:num(x.metrics[0])})),goals:goalRows,meta:{period:'7 дней, включая сегодня',dataLagSeconds:num(current.data_lag),lastDataAt:timelineRows.at(-1)?.date||iso(new Date())}};
}

const GSC_HOST='xn----7sbbfg4a6clj5k.xn--p1ai';
const GA4_PROPERTY_ID='554020457';
async function googleAccessToken(){const body=new URLSearchParams({client_id:env.GSC_CLIENT_ID,client_secret:env.GSC_CLIENT_SECRET,refresh_token:env.GSC_REFRESH_TOKEN,grant_type:'refresh_token'});const r=await json('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});return r.access_token}
const b64url=value=>Buffer.from(value).toString('base64url');
function serviceAccountCredentials(){
  const raw=env.GSC_SERVICE_ACCOUNT_JSON;
  if(!raw)return null;
  let credentials;
  try{credentials=JSON.parse(raw)}catch{
    try{credentials=JSON.parse(Buffer.from(raw,'base64').toString('utf8'))}catch{throw new Error('GSC_SERVICE_ACCOUNT_JSON содержит некорректный JSON')}
  }
  if(!credentials.client_email||!credentials.private_key)throw new Error('В GSC_SERVICE_ACCOUNT_JSON отсутствуют client_email или private_key');
  return credentials;
}
async function googleServiceAccountAccessToken(){
  const credentials=serviceAccountCredentials();
  const now=Math.floor(Date.now()/1000);
  const tokenUrl=credentials.token_uri||'https://oauth2.googleapis.com/token';
  const header=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claims=b64url(JSON.stringify({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly',aud:tokenUrl,iat:now,exp:now+3600}));
  const unsigned=`${header}.${claims}`;
  const signer=createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion=`${unsigned}.${signer.sign(credentials.private_key).toString('base64url')}`;
  const body=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion});
  const response=await json(tokenUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  return response.access_token;
}
const gscHost=siteUrl=>{try{const value=String(siteUrl||'').replace(/^sc-domain:/i,'');return (siteUrl?.startsWith('sc-domain:')?value:new URL(value).hostname).toLowerCase().replace(/^www\./,'')}catch{return ''}};
async function resolveGscProperty(token){
  const response=await json('https://www.googleapis.com/webmasters/v3/sites',{headers:{Authorization:`Bearer ${token}`}});
  const entries=(response.siteEntry||[]).filter(x=>x.permissionLevel!=='siteUnverifiedUser'&&gscHost(x.siteUrl)===GSC_HOST);
  const preferred=entries.sort((a,b)=>Number(b.siteUrl.startsWith('sc-domain:'))-Number(a.siteUrl.startsWith('sc-domain:')))[0];
  if(!preferred)throw new Error('GSC_PROPERTY_NOT_FOUND');
  console.log(`Search Console: найден ресурс ${preferred.siteUrl} (${preferred.permissionLevel})`);
  return preferred.siteUrl;
}
async function gscQuery(token,siteUrl,startDate,endDate,dimensions=[]){const site=encodeURIComponent(siteUrl);return json(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({startDate,endDate,dimensions,type:'web',dataState:'all',rowLimit:25000})})}
async function fetchGoogleOAuth(){const token=await googleAccessToken();const siteUrl=await resolveGscProperty(token);const [cur,prev,queries,dates]=await Promise.all([gscQuery(token,siteUrl,daysAgo(7),daysAgo(1)),gscQuery(token,siteUrl,daysAgo(14),daysAgo(8)),gscQuery(token,siteUrl,daysAgo(28),daysAgo(1),['query']),gscQuery(token,siteUrl,daysAgo(14),daysAgo(1),['date'])]);const totals=r=>(r.rows||[]).reduce((a,x)=>({clicks:a.clicks+num(x.clicks),impressions:a.impressions+num(x.impressions)}),{clicks:0,impressions:0});const c=totals(cur),p=totals(prev),dateRows=dates.rows||[];return{summary:{...c,previousClicks:p.clicks,previousImpressions:p.impressions},queries:(queries.rows||[]).slice(0,15).map(x=>({name:x.keys[0],clicks:num(x.clicks),impressions:num(x.impressions),ctr:num(x.ctr)*100,position:num(x.position)})),meta:{period:'7 последних доступных дней',lastDataAt:dateRows.at(-1)?.keys?.[0]||null,property:siteUrl}}}
async function fetchGoogleServiceAccount(){const token=await googleServiceAccountAccessToken();const siteUrl=await resolveGscProperty(token);const [cur,prev,queries,dates]=await Promise.all([gscQuery(token,siteUrl,daysAgo(7),daysAgo(1)),gscQuery(token,siteUrl,daysAgo(14),daysAgo(8)),gscQuery(token,siteUrl,daysAgo(28),daysAgo(1),['query']),gscQuery(token,siteUrl,daysAgo(14),daysAgo(1),['date'])]);const totals=r=>(r.rows||[]).reduce((a,x)=>({clicks:a.clicks+num(x.clicks),impressions:a.impressions+num(x.impressions)}),{clicks:0,impressions:0});const c=totals(cur),p=totals(prev),dateRows=dates.rows||[];return{summary:{...c,previousClicks:p.clicks,previousImpressions:p.impressions},queries:(queries.rows||[]).slice(0,15).map(x=>({name:x.keys[0],clicks:num(x.clicks),impressions:num(x.impressions),ctr:num(x.ctr)*100,position:num(x.position)})),meta:{period:'7 последних доступных дней',lastDataAt:dateRows.at(-1)?.keys?.[0]||null,property:siteUrl}}}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fetchGoogleOAuthWithRetry(){let error;for(let attempt=1;attempt<=3;attempt++){try{return await fetchGoogleOAuth()}catch(current){error=current;if(!/SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(String(current?.message||current))||attempt===3)throw current;console.log(`Search Console API ещё активируется, повтор ${attempt}/2 через 20 секунд`);await wait(20000)}}throw error}
async function fetchGoogleBridge(){const endpoint=url(env.GSC_BRIDGE_URL,{key:env.GSC_BRIDGE_KEY,fresh:Date.now()});const response=await json(endpoint,{headers:{'cache-control':'no-cache'}});if(!response.ok)throw new Error(response.error||'Google bridge returned an error');return response.data}
async function fetchGoogle(){
  const methods=[];
  if(env.GSC_SERVICE_ACCOUNT_JSON)methods.push(['service account',fetchGoogleServiceAccount]);
  if(['GSC_CLIENT_ID','GSC_CLIENT_SECRET','GSC_REFRESH_TOKEN'].every(k=>env[k]))methods.push(['OAuth refresh token',fetchGoogleOAuthWithRetry]);
  if(['GSC_BRIDGE_URL','GSC_BRIDGE_KEY'].every(k=>env[k]))methods.push(['Apps Script bridge',fetchGoogleBridge]);
  if(!methods.length)throw new Error('Не подключено: Google Search Console');
  const errors=[];
  for(const [name,fetcher] of methods){
    try{const data=await fetcher();console.log(`Search Console: авторизация через ${name} работает`);return data}
    catch(error){const message=friendlyError(error);errors.push(`${name}: ${message}`);console.log(`::warning title=Google Search Console (${name})::${message}`)}
  }
  throw new Error(errors.join('; '));
}

async function ga4Report(token,body){return json(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})}
const ga4Metric=(row,index=0)=>num(row?.metricValues?.[index]?.value);
async function fetchGa4(){
  if(!env.GSC_SERVICE_ACCOUNT_JSON)throw new Error('Для GA4 не подключён сервисный аккаунт');
  const token=await googleServiceAccountAccessToken();
  const metrics=['activeUsers','sessions','screenPageViews','eventCount'].map(name=>({name}));
  const [current,previous,timeline,sources,pages]=await Promise.all([
    ga4Report(token,{dateRanges:[{startDate:'6daysAgo',endDate:'today'}],metrics}),
    ga4Report(token,{dateRanges:[{startDate:'13daysAgo',endDate:'7daysAgo'}],metrics}),
    ga4Report(token,{dateRanges:[{startDate:'13daysAgo',endDate:'today'}],dimensions:[{name:'date'}],metrics:[{name:'sessions'}],orderBys:[{dimension:{dimensionName:'date'}}]}),
    ga4Report(token,{dateRanges:[{startDate:'6daysAgo',endDate:'today'}],dimensions:[{name:'sessionDefaultChannelGroup'}],metrics:[{name:'sessions'}],orderBys:[{metric:{metricName:'sessions'},desc:true}],limit:'8'}),
    ga4Report(token,{dateRanges:[{startDate:'6daysAgo',endDate:'today'}],dimensions:[{name:'pagePathPlusQueryString'}],metrics:[{name:'screenPageViews'}],orderBys:[{metric:{metricName:'screenPageViews'},desc:true}],limit:'10'})
  ]);
  const cur=current.rows?.[0],prev=previous.rows?.[0];
  console.log('GA4: авторизация через service account работает');
  return {summary:{users:ga4Metric(cur,0),sessions:ga4Metric(cur,1),views:ga4Metric(cur,2),events:ga4Metric(cur,3),previousUsers:ga4Metric(prev,0),previousSessions:ga4Metric(prev,1),previousViews:ga4Metric(prev,2),previousEvents:ga4Metric(prev,3)},timeline:(timeline.rows||[]).map(x=>({date:String(x.dimensionValues?.[0]?.value||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'),sessions:ga4Metric(x)})),sources:(sources.rows||[]).map(x=>({name:x.dimensionValues?.[0]?.value||'Не определено',sessions:ga4Metric(x)})),pages:(pages.rows||[]).map(x=>({name:x.dimensionValues?.[0]?.value||'/',views:ga4Metric(x)})),meta:{period:'7 дней, включая сегодня',lastDataAt:new Date().toISOString()}};
}

async function fetchClarity(){const raw=await json('https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=Device&dimension2=Source',{headers:{Authorization:`Bearer ${env.CLARITY_API_TOKEN}`,'content-type':'application/json'}});const total=(patterns,fields)=>{const blocks=(raw||[]).filter(x=>patterns.some(pattern=>pattern.test(String(x.metricName||''))));return blocks.reduce((sum,block)=>sum+(block.information||[]).reduce((s,row)=>s+fields.reduce((n,k)=>n+num(row[k]),0),0),0)};return{summary:{deadClicks:total([/dead click/i],['deadClickCount','DeadClickCount']),rageClicks:total([/rage click/i],['rageClickCount','RageClickCount']),quickbacks:total([/quickback/i],['quickbackClickCount','QuickbackClickCount']),scriptErrors:total([/script error/i],['scriptErrorCount','ScriptErrorCount']),sessions:total([/^traffic$/i,/traffic/i],['totalSessionCount','TotalSessionCount'])},raw,meta:{period:'последние 72 часа',lastDataAt:new Date().toISOString()}}}

async function mock(){return JSON.parse(await readFile(new URL('../tests/mock-data.json',import.meta.url),'utf8'))}
const b64=s=>Uint8Array.from(Buffer.from(s,'base64'));
async function encryptionKey(password,salt,iterations=250000){const material=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return webcrypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function encrypt(payload,password){const salt=webcrypto.getRandomValues(new Uint8Array(16)),iv=webcrypto.getRandomValues(new Uint8Array(12));const key=await encryptionKey(password,salt);const data=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(payload)));const b=x=>Buffer.from(x).toString('base64');return{version:1,kdf:'PBKDF2-SHA256',iterations:250000,cipher:'AES-256-GCM',salt:b(salt),iv:b(iv),data:b(data)}}
async function decrypt(bundle,password){const key=await encryptionKey(password,b64(bundle.salt),Number(bundle.iterations||250000));const plain=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:b64(bundle.iv)},key,b64(bundle.data));return JSON.parse(new TextDecoder().decode(plain))}

async function* payloadCandidates(password){
  try{yield await decrypt(JSON.parse(await readFile(OUT,'utf8')),password)}catch{}
  let commits=[];
  try{const {stdout}=await execFile('git',['log','--format=%H','-n','200','--',OUT_RELATIVE],{maxBuffer:1024*1024});commits=stdout.trim().split(/\s+/).filter(Boolean)}catch{}
  for(const sha of commits){
    try{const {stdout}=await execFile('git',['show',`${sha}:${OUT_RELATIVE}`],{maxBuffer:2*1024*1024});yield await decrypt(JSON.parse(stdout),password)}catch{}
  }
}
async function restoreLastSuccessful(payload,password){
  const failed=['yandex','google','ga4','clarity'].filter(name=>!payload.health[name]?.ok);
  if(!failed.length)return payload;
  const pending=new Set(failed);
  for await(const previous of payloadCandidates(password)){
    for(const name of [...pending]){
      const source=previous?.[name],health=previous?.health?.[name];
      if(!source||(!health?.ok&&!source?.meta?.lastSuccessfulAt))continue;
      const error=payload[name].__error;
      const lastSuccessfulAt=source.meta?.lastSuccessfulAt||previous.generatedAt||source.meta?.lastDataAt;
      payload[name]={...source,__error:error,__stale:true,meta:{...source.meta,lastSuccessfulAt}};
      payload.health[name]={...payload.health[name],stale:true,lastDataAt:source.meta?.lastDataAt||null,lastSuccessfulAt,message:`Свежий сбор не удался: ${error}. Показаны последние успешные данные.`};
      console.log(`::warning title=${name} analytics::Свежий сбор не удался; сохранены последние успешные данные`);
      pending.delete(name);
    }
    if(!pending.size)break;
  }
  return payload;
}

async function main(){let payload;const password=env.DASHBOARD_PASSWORD||(env.MOCK_MODE==='1'?'vargi-test':'');if(env.MOCK_MODE==='1'){payload=await mock()}else{const missing=required.filter(k=>!env[k]);if(missing.length)throw new Error(`Missing secrets: ${missing.join(', ')}`);const [yandex,google,ga4,clarity]=await Promise.all([safe(fetchYandex,{summary:{},timeline:[],sources:[],pages:[],goals:[],meta:{period:'7 дней, включая сегодня'}}),safe(fetchGoogle,{summary:{},queries:[],meta:{period:'7 последних доступных дней'}}),safe(fetchGa4,{summary:{},timeline:[],sources:[],pages:[],meta:{period:'7 дней, включая сегодня'}}),safe(fetchClarity,{summary:{},raw:[],meta:{period:'последние 72 часа'}})]);const generatedAt=new Date().toISOString();for(const source of [yandex,google,ga4,clarity])if(!source.__error)source.meta={...source.meta,lastSuccessfulAt:generatedAt};const healthFor=source=>({ok:!source.__error,stale:false,message:source.__error||'Данные получены',period:source.meta?.period||'',lastDataAt:source.meta?.lastDataAt||null,lastSuccessfulAt:source.meta?.lastSuccessfulAt||null,dataLagSeconds:source.meta?.dataLagSeconds||0});payload={generatedAt,period:{yandex:yandex.meta?.period,google:google.meta?.period,ga4:ga4.meta?.period,clarity:clarity.meta?.period},yandex,google,ga4,clarity,health:{yandex:healthFor(yandex),google:healthFor(google),ga4:healthFor(ga4),clarity:healthFor(clarity)}};payload=await restoreLastSuccessful(payload,password)}
  await mkdir(dirname(OUT),{recursive:true});await writeFile(OUT,JSON.stringify(await encrypt(payload,password),null,2)+'\n');console.log(`Encrypted analytics written to ${OUT}`)}
main().catch(e=>{console.error(e);process.exit(1)});
