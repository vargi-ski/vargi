import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { webcrypto } from 'node:crypto';

const env = process.env;
const OUT = resolve(env.ANALYTICS_OUTPUT || 'analytics-dashboard/analytics.enc.json');
const required = ['YANDEX_METRIKA_TOKEN','CLARITY_API_TOKEN','DASHBOARD_PASSWORD'];
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const iso = d => d.toISOString().slice(0,10);
const daysAgo = n => { const d=new Date(); d.setUTCDate(d.getUTCDate()-n); return iso(d); };
const num = v => Number(v||0);
const friendlyError = error => {const message=String(error?.message||error||'Неизвестная ошибка').replace(/\s+/g,' ').trim();if(/SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(message))return 'Search Console API подключается';if(/PERMISSION_DENIED|\b403\b/i.test(message))return 'Нет доступа к источнику';return message.slice(0,180)};
const safe = (fn,fallback) => fn().catch(error=>({__error:friendlyError(error),...fallback}));

async function json(url,options={}){let last;for(let i=0;i<3;i++){const r=await fetch(url,options);if(r.ok)return r.json();last=new Error(`${r.status} ${await r.text()}`);if(![429,500,502,503,504].includes(r.status))break;await sleep(800*(i+1));}throw last}
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

async function googleAccessToken(){const body=new URLSearchParams({client_id:env.GSC_CLIENT_ID,client_secret:env.GSC_CLIENT_SECRET,refresh_token:env.GSC_REFRESH_TOKEN,grant_type:'refresh_token'});const r=await json('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});return r.access_token}
async function gscQuery(token,startDate,endDate,dimensions=[]){const site=encodeURIComponent('https://xn----7sbbfg4a6clj5k.xn--p1ai/');return json(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({startDate,endDate,dimensions,type:'web',dataState:'all',rowLimit:25000})})}
async function fetchGoogleOAuth(){const token=await googleAccessToken();const [cur,prev,queries,dates]=await Promise.all([gscQuery(token,daysAgo(7),daysAgo(1)),gscQuery(token,daysAgo(14),daysAgo(8)),gscQuery(token,daysAgo(28),daysAgo(1),['query']),gscQuery(token,daysAgo(14),daysAgo(1),['date'])]);const totals=r=>(r.rows||[]).reduce((a,x)=>({clicks:a.clicks+num(x.clicks),impressions:a.impressions+num(x.impressions)}),{clicks:0,impressions:0});const c=totals(cur),p=totals(prev),dateRows=dates.rows||[];return{summary:{...c,previousClicks:p.clicks,previousImpressions:p.impressions},queries:(queries.rows||[]).slice(0,15).map(x=>({name:x.keys[0],clicks:num(x.clicks),impressions:num(x.impressions),ctr:num(x.ctr)*100,position:num(x.position)})),meta:{period:'7 последних доступных дней',lastDataAt:dateRows.at(-1)?.keys?.[0]||null}}}
async function fetchGoogleBridge(){const endpoint=url(env.GSC_BRIDGE_URL,{key:env.GSC_BRIDGE_KEY});const response=await json(endpoint);if(!response.ok)throw new Error(response.error||'Google bridge returned an error');return response.data}

async function fetchClarity(){const raw=await json('https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=Device&dimension2=Source',{headers:{Authorization:`Bearer ${env.CLARITY_API_TOKEN}`,'content-type':'application/json'}});const total=(patterns,fields)=>{const blocks=(raw||[]).filter(x=>patterns.some(pattern=>pattern.test(String(x.metricName||''))));return blocks.reduce((sum,block)=>sum+(block.information||[]).reduce((s,row)=>s+fields.reduce((n,k)=>n+num(row[k]),0),0),0)};return{summary:{deadClicks:total([/dead click/i],['deadClickCount','DeadClickCount']),rageClicks:total([/rage click/i],['rageClickCount','RageClickCount']),quickbacks:total([/quickback/i],['quickbackClickCount','QuickbackClickCount']),scriptErrors:total([/script error/i],['scriptErrorCount','ScriptErrorCount']),sessions:total([/^traffic$/i,/traffic/i],['totalSessionCount','TotalSessionCount'])},raw,meta:{period:'последние 72 часа',lastDataAt:new Date().toISOString()}}}

async function mock(){return JSON.parse(await readFile(new URL('../tests/mock-data.json',import.meta.url),'utf8'))}
async function encrypt(payload,password){const salt=webcrypto.getRandomValues(new Uint8Array(16)),iv=webcrypto.getRandomValues(new Uint8Array(12));const material=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);const key=await webcrypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt']);const data=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(payload)));const b=x=>Buffer.from(x).toString('base64');return{version:1,kdf:'PBKDF2-SHA256',iterations:250000,cipher:'AES-256-GCM',salt:b(salt),iv:b(iv),data:b(data)}}

async function main(){let payload;if(env.MOCK_MODE==='1'){payload=await mock()}else{const missing=required.filter(k=>!env[k]);if(missing.length)throw new Error(`Missing secrets: ${missing.join(', ')}`);const bridgeConfigured=['GSC_BRIDGE_URL','GSC_BRIDGE_KEY'].every(k=>env[k]);const oauthConfigured=['GSC_CLIENT_ID','GSC_CLIENT_SECRET','GSC_REFRESH_TOKEN'].every(k=>env[k]);const fetchGoogle=oauthConfigured?async()=>{try{return await fetchGoogleOAuth()}catch(error){if(bridgeConfigured)return fetchGoogleBridge();throw error}}:bridgeConfigured?fetchGoogleBridge:null;const [yandex,google,clarity]=await Promise.all([safe(fetchYandex,{summary:{},timeline:[],sources:[],pages:[],goals:[],meta:{period:'7 дней, включая сегодня'}}),fetchGoogle?safe(fetchGoogle,{summary:{},queries:[],meta:{period:'7 последних доступных дней'}}):Promise.resolve({__error:'Не подключено: Google Search Console',summary:{},queries:[],meta:{period:'7 последних доступных дней'}}),safe(fetchClarity,{summary:{},raw:[],meta:{period:'последние 72 часа'}})]);const generatedAt=new Date().toISOString();const healthFor=source=>({ok:!source.__error,message:source.__error||'Данные получены',period:source.meta?.period||'',lastDataAt:source.meta?.lastDataAt||null,dataLagSeconds:source.meta?.dataLagSeconds||0});payload={generatedAt,period:{yandex:yandex.meta?.period,google:google.meta?.period,clarity:clarity.meta?.period},yandex,google,clarity,health:{yandex:healthFor(yandex),google:healthFor(google),clarity:healthFor(clarity)}}}
  const password=env.DASHBOARD_PASSWORD||(env.MOCK_MODE==='1'?'vargi-test':'');await mkdir(dirname(OUT),{recursive:true});await writeFile(OUT,JSON.stringify(await encrypt(payload,password),null,2)+'\n');console.log(`Encrypted analytics written to ${OUT}`)}
main().catch(e=>{console.error(e);process.exit(1)});
