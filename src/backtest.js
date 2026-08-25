const BASE="https://api.bybit.com/v5/market/kline";
const BACKTEST_SYMBOLS=["SOLUSDT"];
const BACKTEST_LEVERAGES=[10];

function J(x,s=200){
  return new Response(JSON.stringify(x,null,2),{
    status:s,
    headers:{
      "content-type":"application/json; charset=UTF-8",
      "access-control-allow-origin":"*",
      "cache-control":"no-store"
    }
  });
}

export async function handleBacktestRequest(req, env, ctx){
  const u=new URL(req.url);
  if(u.pathname!=="/backtest"&&u.pathname!=="/backtest/api"){
    return J({error:true,message:"Backtest route not found"},404);
  }

  try{
    const days=Math.min(Math.max(Number(u.searchParams.get("days")||30),7),90);
    const modeRaw=String(u.searchParams.get("mode")||"both").toLowerCase();
    const mode=["both","long","short"].includes(modeRaw)?modeRaw:"both";
    const symbol="SOLUSDT";
    const leverage=10;
    const strategyRaw="short";
    const strategy=["swing","short"].includes(strategyRaw)?strategyRaw:"swing";
    const stopMode="C";
    const costRaw=Number(u.searchParams.get("costbps"));
    const costBps=[0,8,12,20].includes(costRaw)?costRaw:(strategy==="short"?12:8);

    const cache=caches.default;
    const cacheKey=new Request(
      new URL(`/__backtest_v820_sol_regime_runner?days=${days}&mode=${mode}&strategy=${strategy}&costbps=${costBps}`,req.url).toString(),
      {method:"GET"}
    );

    const cached=await cache.match(cacheKey);
    if(cached){
      const result=await cached.json();
      const output={...result,cache:"HIT"};
      if(u.pathname==="/backtest/api")return J(output);
      return new Response(backtestPage(output),{headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
    }

    const result=await runBacktestStaged({days,mode,symbol,leverage,strategy,costBps,stopMode,requestUrl:req.url});

    if(result.pending){
      if(u.pathname==="/backtest/api")return J(result,202);
      return new Response(backtestProgressPage(result),{
        status:202,
        headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}
      });
    }

    await cache.put(cacheKey,new Response(JSON.stringify(result),{
      headers:{"content-type":"application/json","cache-control":"public, max-age=900"}
    }));

    const output={...result,cache:"MISS"};
    if(u.pathname==="/backtest/api")return J(output);
    return new Response(backtestPage(output),{headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
  }catch(e){
    if(u.pathname==="/backtest/api")return J({error:true,message:e?.message||String(e),time:new Date().toISOString()},500);
    return new Response(backtestErrorPage(e),{
      status:500,
      headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}
    });
  }
}

const BT_CHUNK_MS = 15*24*60*60*1000;
const BT_WARMUP_MS = 50*24*60*60*1000;
const BT_MAX_CHUNKS_PER_INVOCATION = 2;

async function runBacktestStaged({days=30,mode="both",symbol="SOLUSDT",leverage=10,strategy="short",costBps=12,stopMode="C",requestUrl}={}){
  const now=Date.now(),coreStart=now-days*86400e3,dataStart=coreStart-BT_WARMUP_MS;
  const prep=await ensureHistoryBundles(dataStart,now,requestUrl,"SOLUSDT");
  if(!prep.complete)return{pending:true,version:"8.2.0-regime-runner",symbol:"SOLUSDT",leverage:10,strategy:"short",costBps,stopMode:"C",days,tradeMode:mode,progress:prep};
  const raw=await loadHistoryRange(dataStart,now,requestUrl,"SOLUSDT");
  const f=buildIndicators(raw.m5),m=buildIndicators(raw.m15);
  const variants=[
    {id:"V8L",name:"V8 Long",description:"15m bias · 5m multi-trigger"},
    {id:"V8S",name:"V8 Short",description:"15m bias · 5m multi-trigger"},
    {id:"V8C",name:"V8 Combined",description:"SOL 5m 多訊號引擎"}
  ];
  let results=variants.map(v=>simulateV8Sol(f,m,v,mode,{tradeStartTs:coreStart,tradeEndTs:now,costBps}));
  results=results.map(applyPositionSizing);
  return{
    ok:true,symbol:"SOLUSDT",version:"8.2.0-regime-runner",strategy:"short",costBps,stopMode:"C",days,tradeMode:mode,leverage:10,
    positionSizing:{initialEquity:100,fixedMargin:5,leverage:10,baseNotional:50,winNextMarginPct:5,rule:"第一單/上一單非盈利：固定5U；上一單盈利：下一單使用當前本金5%"},
    sharedRules:{
      bias:"15m EMA20/50 + EMA20 slope defines directional bias; neutral allows both sides only with stronger trigger score",
      entry:"候選訊號：5m multi-trigger >=2；實際進場：Quality Score >=6 + 15m 同向 + 強觸發",
      frequencyGoal:"KPI 分離：候選訊號維持 10+/日；Quality Gate 只讓高品質訊號成交",
      stop:"5m ATR/structure hybrid；拒絕過寬 stop",tp1:"1.0R / 40%",tp2:"無固定 TP2",runner:"60% / 1.3 ATR trail；+0.7R 後保本；30m Time Stop",
      cooldown:"同方向 15 分鐘；出場後不設 30 分鐘全域冷卻"
    },
    results
  };
}
function compactPeriodResult(r){return {trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,netR:r.netR,endingEquity:r.endingEquity,maxDrawdownPct:r.maxDrawdownPct,long:r.long,short:r.short};}
function aggregateVariantRuns(v,runs,leverage=5){const all=runs.flatMap(r=>r.__trades||[]).sort((a,b)=>a.entryTs-b.entryTs),diag={};for(const r of runs)for(const[k,val]of Object.entries(r.diagnostics||{}))diag[k]=(diag[k]||0)+(Number(val)||0);return {variant:v.id,name:v.name,description:v.description,...summarizeTradeSequence(all,leverage),diagnostics:diag,periods:runs.map((r,i)=>({index:i+1,trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,netR:r.netR,maxDrawdownPct:r.maxDrawdownPct,long:r.long,short:r.short})),recentTrades:all.slice(-10).map(t=>({side:t.side,entryTs:t.entryTs,exitTs:t.exitTs,entry:t.entry,exit:t.exitPrice,r:t.r,risk:t.risk,forcedClose:!!t.forcedClose})),__trades:all};}
function applyPositionSizing(result){
  const trades=[...(result.__trades||[])].sort((a,b)=>a.entryTs-b.entryTs);
  if(!trades.length)return {...result,endingEquity:100,maxDrawdownPct:0,positionSizing:{fixedMargin:5,lastWinPct:5,leverage:10,baseNotional:50,avgMarginU:0,maxMarginU:0,avgNotionalU:0,maxNotionalU:0}};
  let equity=100,peak=100,maxDD=0,prevWin=false,marginSum=0,notionalSum=0,maxMarginU=0,maxNotionalU=0;
  for(const t of trades){
    const margin=prevWin?equity*.05:5;
    const notional=margin*10;
    const entry=Number(t.entry)||0,risk=Number(t.risk)||0,r=Number(t.r)||0;
    const stopPct=entry>0?risk/entry:0;
    const pnl=notional*stopPct*r;
    equity+=pnl;
    peak=Math.max(peak,equity);
    maxDD=Math.max(maxDD,peak>0?(peak-equity)/peak*100:0);
    marginSum+=margin;notionalSum+=notional;maxMarginU=Math.max(maxMarginU,margin);maxNotionalU=Math.max(maxNotionalU,notional);
    t.marginU=+margin.toFixed(4);t.notionalU=+notional.toFixed(4);t.pnlU=+pnl.toFixed(4);t.equityAfter=+equity.toFixed(4);
    prevWin=r>0.02;
  }
  return {...result,endingEquity:+equity.toFixed(2),maxDrawdownPct:+maxDD.toFixed(2),positionSizing:{fixedMargin:5,lastWinPct:5,leverage:10,baseNotional:50,avgMarginU:+(marginSum/trades.length).toFixed(2),maxMarginU:+maxMarginU.toFixed(2),avgNotionalU:+(notionalSum/trades.length).toFixed(2),maxNotionalU:+maxNotionalU.toFixed(2)},recentTrades:trades.slice(-10),__trades:trades};
}
function summarizeTradeSequence(trades,leverage=5){
  let equity=100,peak=100,maxDD=0,wins=0,losses=0,breakeven=0,gw=0,gl=0,maxLS=0,ls=0;
  let marginPctSum=0,maxMarginPct=0,marginSamples=0,maxNotionalPct=0,constrainedTrades=0;
  for(const t of trades){
    const r=Number(t.r)||0, entry=Number(t.entry), risk=Number(t.risk);
    if(entry>0&&risk>0){const stopPct=risk/entry;const targetRiskPct=0.005;const notionalPct=targetRiskPct/stopPct;const marginPct=notionalPct/leverage*100;marginPctSum+=marginPct;marginSamples++;maxMarginPct=Math.max(maxMarginPct,marginPct);maxNotionalPct=Math.max(maxNotionalPct,notionalPct*100);if(marginPct>100)constrainedTrades++;}
    equity*=1+0.005*r;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/peak*100);
    if(r>0.02){wins++;gw+=r;ls=0}else if(r<-0.02){losses++;gl+=-r;ls++;maxLS=Math.max(maxLS,ls)}else{breakeven++;ls=0}
  }
  const ss=side=>{const xs=trades.filter(t=>t.side===side),w=xs.filter(t=>t.r>0.02),l=xs.filter(t=>t.r<-0.02),a=w.reduce((q,t)=>q+t.r,0),b=l.reduce((q,t)=>q+(-t.r),0);return{trades:xs.length,wins:w.length,losses:l.length,winRate:xs.length?+(w.length/xs.length*100).toFixed(2):0,profitFactor:+(b>0?a/b:(a>0?999:0)).toFixed(2),netR:+xs.reduce((q,t)=>q+t.r,0).toFixed(2)}};
  return{trades:trades.length,wins,losses,breakeven,winRate:trades.length?+(wins/trades.length*100).toFixed(2):0,profitFactor:+(gl>0?gw/gl:(gw>0?999:0)).toFixed(2),netR:+trades.reduce((q,t)=>q+(Number(t.r)||0),0).toFixed(2),endingEquity:+equity.toFixed(2),maxDrawdownPct:+maxDD.toFixed(2),maxLossStreak:maxLS,long:ss("LONG"),short:ss("SHORT"),leverage:{selected:leverage,avgMarginPct:marginSamples?+(marginPctSum/marginSamples).toFixed(2):0,maxMarginPct:+maxMarginPct.toFixed(2),maxNotionalPct:+maxNotionalPct.toFixed(2),constrainedTrades,note:"固定每筆風險 0.5%；槓桿主要降低保證金需求，不直接把 Net R 乘上倍數。"}};
}
async function ensureHistoryBundles(startTs,endTs,requestUrl,symbol="SOLUSDT"){const ids=chunkIdsForRange(startTs,endTs),cache=caches.default,missing=[];let ready=0;for(const id of ids){const h=await cache.match(historyChunkKey(id,requestUrl,symbol));if(h)ready++;else missing.push(id)}const take=missing.slice(0,BT_MAX_CHUNKS_PER_INVOCATION);for(const id of take){const a=id*BT_CHUNK_MS,b=Math.min((id+1)*BT_CHUNK_MS-1,Date.now()),bundle=await fetchHistoryBundle(a,b,symbol);const ttl=b>=Date.now()-BT_CHUNK_MS?300:2592000;await cache.put(historyChunkKey(id,requestUrl,symbol),new Response(JSON.stringify(bundle),{headers:{"content-type":"application/json","cache-control":`public, max-age=${ttl}`}}));ready++}return{complete:missing.length===0,totalChunks:ids.length,readyChunks:ready,fetchedThisRun:take.length,remainingChunks:Math.max(0,ids.length-ready),chunkDays:15};}
function chunkIdsForRange(a,b){const x=Math.floor(a/BT_CHUNK_MS),y=Math.floor(b/BT_CHUNK_MS),o=[];for(let i=x;i<=y;i++)o.push(i);return o;}
function historyChunkKey(id,requestUrl,symbol="SOLUSDT"){return new Request(new URL(`/__bt_v72r2_hist/${symbol}/${id}`,requestUrl).toString(),{method:"GET"});}
async function fetchHistoryBundle(a,b,symbol="SOLUSDT"){return{symbol,startTs:a,endTs:b,m5:await fetchBybitRange("5",a,b,symbol),m15:await fetchBybitRange("15",a,b,symbol),h1:await fetchBybitRange("60",a,b,symbol),h4:await fetchBybitRange("240",a,b,symbol),createdAt:new Date().toISOString()};}
async function fetchBybitRange(interval,startTs,endTs,symbol="SOLUSDT"){let out=[],cursorEnd=endTs,pages=0;const ms=interval==="5"?5*60e3:interval==="15"?15*60e3:interval==="60"?60*60e3:4*60*60e3,maxPages=Math.ceil(((endTs-startTs)/ms+2)/1000)+2;while(cursorEnd>=startTs&&pages<maxPages){const url=`${BASE}?category=linear&symbol=${symbol}&interval=${interval}&start=${Math.floor(startTs)}&end=${Math.floor(cursorEnd)}&limit=1000`,r=await fetchWithRetry(url,{label:`Bybit range ${interval}m`,retries:2}),j=await r.json(),list=j?.result?.list;if(j?.retCode!==0||!Array.isArray(list))throw new Error(`Bybit range ${interval} invalid: ${JSON.stringify(j).slice(0,160)}`);if(!list.length)break;const batch=list.map(x=>({ts:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5])})).filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close)&&Number.isFinite(x.volume)&&x.ts>=startTs&&x.ts<=endTs);if(!batch.length)break;out.push(...batch);const oldest=Math.min(...batch.map(x=>x.ts));if(oldest<=startTs||oldest>=cursorEnd)break;cursorEnd=oldest-1;pages++;if(list.length<1000)break;await sleep(80)}return[...new Map(out.map(x=>[x.ts,x])).values()].sort((a,b)=>a.ts-b.ts);}
async function loadHistoryRange(a,b,requestUrl,symbol="SOLUSDT"){const cache=caches.default,ids=chunkIdsForRange(a,b),m5=[],m15=[],h1=[],h4=[];for(const id of ids){const h=await cache.match(historyChunkKey(id,requestUrl,symbol));if(!h)throw new Error(`歷史快取缺少 chunk ${id}，請重新整理。`);const x=await h.json();m5.push(...(x.m5||[]));m15.push(...(x.m15||[]));h1.push(...(x.h1||[]));h4.push(...(x.h4||[]))}const clean=xs=>[...new Map(xs.filter(x=>x.ts>=a&&x.ts<=b).map(x=>[x.ts,x])).values()].sort((p,q)=>p.ts-q.ts);return{m5:clean(m5),m15:clean(m15),h1:clean(h1),h4:clean(h4)};}

function backtestPage(r){
 const by=Object.fromEntries((r.results||[]).map(x=>[x.variant,x]));
 const keep=e=>{const q=new URLSearchParams({days:r.days,mode:r.tradeMode,strategy:"short",costbps:r.costBps,...e});return`/backtest?${q}`};
 const btn=(a,k,lab=x=>x)=>a.map(x=>`<a class="${String(r[k])===String(x)?'on':''}" href="${keep({[k==="tradeMode"?"mode":k==="costBps"?"costbps":k]:x})}">${lab(x)}</a>`).join('');
 const cards=["V8L","V8S","V8C"].map(id=>{
   const x=by[id]||{},f=x.signalFrequency||{},ps=x.positionSizing||{};
   return`<section class="card"><div class="top"><div><h2>${x.name||id}</h2><p>${x.description||""}</p></div><b class="${x.netR>=0?"p":"n"}">${x.netR>=0?"+":""}${Number(x.netR||0).toFixed(2)}R</b></div>
   <div class="kpi">
    <div><small>候選/日</small><strong>${Number(f.avgPerDay||0).toFixed(1)}</strong></div>
    <div><small>10+達標天</small><strong class="${f.daysBelow10===0?"p":""}">${f.days10Plus||0}/${f.days||0}</strong></div>
    <div><small>最低/日</small><strong>${f.minPerDay??0}</strong></div>
    <div><small>最高/日</small><strong>${f.maxPerDay??0}</strong></div>
    <div><small>成交</small><strong>${x.trades||0}</strong></div>
    <div><small>成交/日</small><strong>${Number((x.trades||0)/Math.max(1,f.days||1)).toFixed(1)}</strong></div>
    <div><small>品質通過</small><strong>${x.diagnostics?.qualityPassed||0}</strong></div>
    <div><small>勝率</small><strong>${Number(x.winRate||0).toFixed(1)}%</strong></div>
    <div><small>PF</small><strong>${Number(x.profitFactor||0).toFixed(2)}</strong></div>
    <div><small>回撤</small><strong>${Number(x.maxDrawdownPct||0).toFixed(2)}%</strong></div>
    <div><small>100U→</small><strong>${Number(x.endingEquity||100).toFixed(2)}U</strong></div>
    <div><small>平均保證金</small><strong>${Number(ps.avgMarginU||0).toFixed(2)}U</strong></div>
   </div></section>`
 }).join("");
 return`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <title>SOL V8.2 Regime Runner</title><style>
 *{box-sizing:border-box}body{margin:0;padding:7px;background:#0b0f17;color:#f5f7fb;font-family:system-ui}.wrap{max-width:760px;margin:auto}.hero,.card,.note{background:#111a27;border:1px solid #263348;border-radius:13px;padding:10px;margin-bottom:7px}.ey,small,p{color:#91a0b5}.ey{font-size:10px}h1{font-size:20px;margin:4px 0}h2{font-size:15px;margin:0}p{font-size:10px;margin:2px 0}.row{display:grid;grid-template-columns:42px 1fr;gap:5px;align-items:center;margin-top:5px}.row>span{font-size:10px}.btn{display:flex;gap:4px;flex-wrap:wrap}.btn a{font-size:11px;color:#fff;text-decoration:none;border:1px solid #34435c;border-radius:7px;padding:5px 8px}.btn a.on{background:#f4f6f8;color:#111}.top{display:flex;justify-content:space-between;gap:8px}.top>b{font-size:19px}.p{color:#58d99b!important}.n{color:#ff7e87!important}.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin-top:8px}.kpi div{background:#0b1420;border:1px solid #202d42;border-radius:8px;padding:6px}.kpi small{display:block;font-size:9px}.kpi strong{font-size:12px}@media(min-width:520px){.kpi{grid-template-columns:repeat(5,1fr)}}
 </style></head><body><main class="wrap"><section class="hero"><div class="ey">V8.2 SOL ONLY · REGIME + RUNNER · 10x</div><h1>⚡ SOL 多訊號短線引擎</h1><p>${r.days}天 · 100U · 基礎保證金5U · 成本${r.costBps}bps</p>
 <div class="row"><span>期間</span><div class="btn">${btn([7,14,30,90],"days",x=>x+"天")}</div></div>
 <div class="row"><span>方向</span><div class="btn">${btn(["both","long","short"],"tradeMode",x=>x==="both"?"多＋空":x==="long"?"只多":"只空")}</div></div>
 <div class="row"><span>成本</span><div class="btn">${btn([0,8,12,20],"costBps",x=>x+"bps")}</div></div></section>
 <section class="note"><b>V8.2：</b>保留 V8.1 Quality Gate，新增 4 Regime、Trigger 個別績效診斷；+0.7R 啟動保本，1R 出 40%，剩餘 60% 用 1.3 ATR Runner，持倉滿 30 分鐘啟動 Time Stop。</section>${cards}</main></body></html>`
}
function backtestProgressPage(r){const p=r.progress||{},pct=p.totalChunks?Math.min(100,Math.round(p.readyChunks/p.totalChunks*100)):0;return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1"><title>準備回測資料</title></head><body style="margin:0;background:#0b0f17;color:#fff;font-family:system-ui;padding:22px"><div style="max-width:620px;margin:auto;background:#111a27;border:1px solid #263348;border-radius:18px;padding:20px"><div style="color:#91a0b5">${r.symbol||'SOLUSDT'} V7.3.2 HA 歷史資料分批快取</div><h2>⏳ 準備 ${r.days} 天回測資料</h2><div style="font-size:32px;font-weight:800">${pct}%</div><div style="height:14px;background:#0b1420;border-radius:99px;overflow:hidden;margin:16px 0"><i style="display:block;height:100%;width:${pct}%;background:#dbe7f7"></i></div><p>${p.readyChunks||0} / ${p.totalChunks||0} 個 15 天區塊完成</p><p style="color:#91a0b5;line-height:1.6">本次新增 ${p.fetchedThisRun||0} 個，剩餘 ${p.remainingChunks||0} 個。頁面會自動繼續。</p></div></body></html>`;}

function backtestErrorPage(e){const m=String(e?.message||e||'Unknown error').replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));return `<!doctype html><html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#0b0f17;color:#fff;font-family:system-ui;padding:24px"><h2>⚠️ 回測失敗</h2><p>${m}</p><p><a style="color:#fff" href="/backtest?symbol=SOLUSDT&days=30&mode=both&leverage=10&strategy=short">重試 30 天</a></p></body></html>`}

function addHeikinAshi(rows){
  let prevOpen=null,prevClose=null;
  return rows.map((x,idx)=>{
    const haClose=(x.open+x.high+x.low+x.close)/4;
    const haOpen=idx===0?(x.open+x.close)/2:(prevOpen+prevClose)/2;
    const haHigh=Math.max(x.high,haOpen,haClose),haLow=Math.min(x.low,haOpen,haClose);
    prevOpen=haOpen;prevClose=haClose;
    return {...x,realOpen:x.open,realHigh:x.high,realLow:x.low,realClose:x.close,haOpen,haHigh,haLow,haClose};
  });
}

function simulateV8Sol(f,m,v,mode="both",o={}){
  let mi=0,pos=null,lastLongEntry=0,lastShortEntry=0;
  const trades=[],signals=[],costBps=Number(o.costBps??12);
  const diag={pullbackLong:0,pullbackShort:0,momentumLong:0,momentumShort:0,bosLong:0,bosShort:0,reclaimLong:0,rejectShort:0,sweepLong:0,sweepShort:0,longSignals:0,shortSignals:0,qualityPassed:0,qualityRejected:0,biasRejected:0,stopRejected:0,busySkipped:0,regimeTrendBull:0,regimeTrendBear:0,regimeRange:0,regimeTransition:0,breakevenArmed:0,timeStops:0};
  const pushCandidate=(side,b,score,triggers,bias,quality,regime)=>{signals.push({ts:b.ts,side,score,triggers:[...triggers],bias,quality,regime});if(side==="LONG")diag.longSignals++;else diag.shortSignals++;};
  const classifyRegime=(M,mi)=>{const prev=m[Math.max(0,mi-2)]||M,slope=M.ema20-prev.ema20,sep=Math.abs(M.ema20-M.ema50)/Math.max(M.atr||1e-9,1e-9);if(M.adx<16&&sep<.55)return"RANGE";if(M.ema20>M.ema50&&slope>0&&M.adx>=18)return"TREND_BULL";if(M.ema20<M.ema50&&slope<0&&M.adx>=18)return"TREND_BEAR";return"TRANSITION";};
  for(let i=60;i<f.length-1;i++){
    const b=f[i],p=f[i-1];while(mi+1<m.length&&m[mi+1].ts<=b.ts)mi++;const M=m[mi];
    if(!M||![b.atr,b.rsi,b.macdHist,b.ema20,b.ema50,b.adx,M.ema20,M.ema50,M.adx].every(Number.isFinite))continue;
    if(b.ts<o.tradeStartTs)continue;if(b.ts>o.tradeEndTs)break;
    const slope20=M.ema20-(m[Math.max(0,mi-2)]?.ema20??M.ema20),bullBias=M.ema20>M.ema50&&slope20>0,bearBias=M.ema20<M.ema50&&slope20<0,bias=bullBias?"BULL":bearBias?"BEAR":"NEUTRAL",regime=classifyRegime(M,mi);
    if(regime==="TREND_BULL")diag.regimeTrendBull++;else if(regime==="TREND_BEAR")diag.regimeTrendBear++;else if(regime==="RANGE")diag.regimeRange++;else diag.regimeTransition++;
    const prior=f.slice(Math.max(0,i-8),i);if(prior.length<6)continue;const hi=Math.max(...prior.map(x=>x.high)),lo=Math.min(...prior.map(x=>x.low)),atr=Math.max(b.atr,1e-9),longT=[],shortT=[];
    if(b.low<=b.ema20+.15*atr&&b.close>b.ema20&&b.close>b.open){longT.push("PULLBACK");diag.pullbackLong++}if(b.high>=b.ema20-.15*atr&&b.close<b.ema20&&b.close<b.open){shortT.push("PULLBACK");diag.pullbackShort++}
    if(b.macdHist>0&&b.macdHist>p.macdHist&&b.close>p.high){longT.push("MOMENTUM");diag.momentumLong++}if(b.macdHist<0&&b.macdHist<p.macdHist&&b.close<p.low){shortT.push("MOMENTUM");diag.momentumShort++}
    if(b.close>hi+.03*atr){longT.push("BOS");diag.bosLong++}if(b.close<lo-.03*atr){shortT.push("BOS");diag.bosShort++}
    if(p.close<=p.ema20&&b.close>b.ema20&&b.close>b.open){longT.push("EMA_RECLAIM");diag.reclaimLong++}if(p.close>=p.ema20&&b.close<b.ema20&&b.close<b.open){shortT.push("EMA_REJECT");diag.rejectShort++}
    if(b.low<lo&&b.close>lo&&b.close>b.open){longT.push("SWEEP");diag.sweepLong++}if(b.high>hi&&b.close<hi&&b.close<b.open){shortT.push("SWEEP");diag.sweepShort++}
    const lCandidate=mode!=="short"&&v.id!=="V8S"&&longT.length>=2,sCandidate=mode!=="long"&&v.id!=="V8L"&&shortT.length>=2;
    const longStrong=longT.some(x=>x==="BOS"||x==="SWEEP"||x==="MOMENTUM"),shortStrong=shortT.some(x=>x==="BOS"||x==="SWEEP"||x==="MOMENTUM"),longTrend=b.close>b.ema20&&b.ema20>b.ema50,shortTrend=b.close<b.ema20&&b.ema20<b.ema50,adxOK=b.adx>=18&&M.adx>=16,longRsi=b.rsi>=48&&b.rsi<=72,shortRsi=b.rsi>=28&&b.rsi<=52;
    const regimeL=regime==="TREND_BULL"?1:regime==="TREND_BEAR"?-2:0,regimeS=regime==="TREND_BEAR"?1:regime==="TREND_BULL"?-2:0;
    const lQ=longT.length+(bullBias?2:0)+(longTrend?1:0)+(adxOK?1:0)+(longRsi?1:0)+(longStrong?1:0)+regimeL-(bearBias?3:0),sQ=shortT.length+(bearBias?2:0)+(shortTrend?1:0)+(adxOK?1:0)+(shortRsi?1:0)+(shortStrong?1:0)+regimeS-(bullBias?3:0);
    if(lCandidate)pushCandidate("LONG",b,longT.length,longT,bias,lQ,regime);if(sCandidate)pushCandidate("SHORT",b,shortT.length,shortT,bias,sQ,regime);
    if(pos){const z=manageV82Position(pos,b);if(z.beArmed)diag.breakevenArmed++;if(z.timeStop)diag.timeStops++;if(z.done){const feeR=(costBps/10000)/(pos.risk/pos.entry);trades.push({...pos,exitTs:b.ts,exitPrice:z.p,r:+(z.r-feeR).toFixed(3),exitReason:z.reason});pos=null}else{diag.busySkipped++;continue}}
    let L=lCandidate&&bullBias&&longStrong&&lQ>=6&&regime!=="TREND_BEAR",S=sCandidate&&bearBias&&shortStrong&&sQ>=6&&regime!=="TREND_BULL";
    if(lCandidate&&!L){diag.qualityRejected++;if(!bullBias)diag.biasRejected++}if(sCandidate&&!S){diag.qualityRejected++;if(!bearBias)diag.biasRejected++}if(L&&S){if(lQ>sQ)S=false;else if(sQ>lQ)L=false;else{L=false;S=false}}
    if(L&&b.ts-lastLongEntry>=15*60e3){const entry=f[i+1].open,structure=Math.min(...f.slice(Math.max(0,i-5),i+1).map(x=>x.low)),stop=Math.min(entry-.70*atr,structure),risk=entry-stop,stopPct=risk/entry;if(risk>0&&stopPct>=.0035&&stopPct<=.025){diag.qualityPassed++;lastLongEntry=b.ts;pos=makeV82Position("LONG",entry,risk,stop,f[i+1].ts,{quality:lQ,triggers:longT,bias,regime,rsi:b.rsi,adx:b.adx,macdHist:b.macdHist})}else diag.stopRejected++}
    else if(S&&b.ts-lastShortEntry>=15*60e3){const entry=f[i+1].open,structure=Math.max(...f.slice(Math.max(0,i-5),i+1).map(x=>x.high)),stop=Math.max(entry+.70*atr,structure),risk=stop-entry,stopPct=risk/entry;if(risk>0&&stopPct>=.0035&&stopPct<=.025){diag.qualityPassed++;lastShortEntry=b.ts;pos=makeV82Position("SHORT",entry,risk,stop,f[i+1].ts,{quality:sQ,triggers:shortT,bias,regime,rsi:b.rsi,adx:b.adx,macdHist:b.macdHist})}else diag.stopRejected++}
  }
  if(pos&&f.length){const q=[...f].reverse().find(x=>x.ts<=o.tradeEndTs)||f.at(-1),d=pos.side==="LONG"?1:-1,rr=pos.real+pos.rem*((q.close-pos.entry)*d/pos.risk)-(costBps/10000)/(pos.risk/pos.entry);trades.push({...pos,exitTs:q.ts,exitPrice:q.close,r:+rr.toFixed(3),forcedClose:true,exitReason:"END"})}
  const freq=summarizeSignalFrequency(signals,o.tradeStartTs,o.tradeEndTs),triggerPerformance=summarizeTriggerPerformance(trades),regimePerformance=summarizeRegimePerformance(trades);
  return{variant:v.id,name:v.name,description:v.description,...summarizeTradeSequence(trades,10),diagnostics:diag,signalFrequency:freq,triggerPerformance,regimePerformance,recentTrades:trades.slice(-10),__trades:trades,__signals:signals};
}
function makeV82Position(side,entry,risk,stop,entryTs,entryDiag){const d=side==="LONG"?1:-1;return{side,entry,entryTs,risk,stop,initialStop:stop,beTrigger:entry+d*risk*.7,tp1:entry+d*risk,rem:1,real:0,tp1Hit:false,beArmed:false,trail:null,entryDiag};}
function manageV82Position(p,x){const L=p.side==="LONG";
  if(L?x.low<=p.stop:x.high>=p.stop){const rr=(p.stop-p.entry)*(L?1:-1)/p.risk;return{done:true,r:p.real+p.rem*rr,p:p.stop,reason:p.stop===p.entry?"BE":"SL"}}
  let beArmed=false;if(!p.beArmed&&(L?x.high>=p.beTrigger:x.low<=p.beTrigger)){p.beArmed=true;p.stop=p.entry;beArmed=true}
  if(!p.tp1Hit&&(L?x.high>=p.tp1:x.low<=p.tp1)){p.tp1Hit=true;p.real+=.40;p.rem-=.40;p.stop=p.entry;p.trail=L?x.close-1.3*x.atr:x.close+1.3*x.atr}
  if(p.tp1Hit){const n=L?x.close-1.3*x.atr:x.close+1.3*x.atr;p.trail=p.trail==null?n:(L?Math.max(p.trail,n):Math.min(p.trail,n));if(L?x.low<=p.trail:x.high>=p.trail){const rr=L?(p.trail-p.entry)/p.risk:(p.entry-p.trail)/p.risk;return{done:true,r:p.real+p.rem*rr,p:p.trail,reason:"TRAIL",beArmed}}}
  if(x.ts-p.entryTs>=30*60e3){const rr=(x.close-p.entry)*(L?1:-1)/p.risk;return{done:true,r:p.real+p.rem*rr,p:x.close,reason:"TIME",timeStop:true,beArmed}}
  return{done:false,beArmed};
}
function summarizeTriggerPerformance(trades){const names=["PULLBACK","MOMENTUM","BOS","EMA_RECLAIM","EMA_REJECT","SWEEP"],out={};for(const n of names){const xs=trades.filter(t=>(t.entryDiag?.triggers||[]).includes(n)),gw=xs.filter(t=>t.r>0).reduce((a,t)=>a+t.r,0),gl=xs.filter(t=>t.r<0).reduce((a,t)=>a-t.r,0);out[n]={trades:xs.length,winRate:xs.length?+(xs.filter(t=>t.r>.02).length/xs.length*100).toFixed(1):0,pf:+(gl?gw/gl:(gw?999:0)).toFixed(2),netR:+xs.reduce((a,t)=>a+t.r,0).toFixed(2)}}return out;}
function summarizeRegimePerformance(trades){const out={};for(const n of ["TREND_BULL","TREND_BEAR","RANGE","TRANSITION"]){const xs=trades.filter(t=>t.entryDiag?.regime===n),gw=xs.filter(t=>t.r>0).reduce((a,t)=>a+t.r,0),gl=xs.filter(t=>t.r<0).reduce((a,t)=>a-t.r,0);out[n]={trades:xs.length,winRate:xs.length?+(xs.filter(t=>t.r>.02).length/xs.length*100).toFixed(1):0,pf:+(gl?gw/gl:(gw?999:0)).toFixed(2),netR:+xs.reduce((a,t)=>a+t.r,0).toFixed(2)}}return out;}
function summarizeSignalFrequency(signals,start,end){const days={};for(let t=new Date(start);t.getTime()<=end;t=new Date(t.getTime()+86400e3))days[t.toISOString().slice(0,10)]=0;for(const x of signals){const k=new Date(x.ts).toISOString().slice(0,10);if(k in days)days[k]++}const vals=Object.values(days),sorted=[...vals].sort((a,b)=>a-b),n=vals.length||1;return{total:signals.length,days:vals.length,avgPerDay:+(signals.length/n).toFixed(2),medianPerDay:sorted.length?sorted[Math.floor(sorted.length/2)]:0,minPerDay:sorted.length?sorted[0]:0,maxPerDay:sorted.length?sorted.at(-1):0,days10Plus:vals.filter(x=>x>=10).length,daysBelow10:vals.filter(x=>x<10).length,hitRatePct:+(vals.filter(x=>x>=10).length/n*100).toFixed(1)}}

function simulateShortV73(f,m,h,v,mode="both",o={}){
  let mi=0,hi=0,pos=null,lastExit=0,streak=0,pause=0,day="",dayR=0,pendingL=null,pendingS=null;
  let activeRegime="TRANSITION",candidateRegime="",candidateCount=0,lastRegimeMi=-1;
  const ts=[],diag={
    bull:0,bear:0,transition:0,chop:0,regimeSwitches:0,
    sweepLong:0,sweepShort:0,bosLong:0,bosShort:0,retestLong:0,retestShort:0,
    longSignals:0,shortSignals:0,expiredSetup:0,blockedDaily:0,blockedCooldown:0,
    blockedMargin:0,invalidStop:0,blockedWrongRegime:0
  };
  const costBps=Number(o.costBps??12), stopMode="C", rsi=o.rsi||{longBos:{min:50,max:100},longRetest:{min:48,max:100},shortBos:{min:0,max:50},shortRetest:{min:0,max:52}};

  function classifyRegime(H,M,mi){
    if(!H||!M) return "TRANSITION";
    const hBody=Math.abs(H.haClose-H.haOpen), hRange=Math.max(H.haHigh-H.haLow,1e-9);
    const hBull=H.haClose>H.haOpen&&hBody/hRange>=0.35&&H.ema20>H.ema50&&H.adx>=16;
    const hBear=H.haClose<H.haOpen&&hBody/hRange>=0.35&&H.ema20<H.ema50&&H.adx>=16;

    // 15m structure uses only already-closed bars. Compare two rolling 4-bar blocks
    // to distinguish HH/HL from LH/LL instead of relying only on EMA direction.
    const recent=m.slice(Math.max(0,mi-3),mi+1);
    const prior=m.slice(Math.max(0,mi-7),Math.max(0,mi-3));
    if(recent.length<4||prior.length<4) return "TRANSITION";
    const rHi=Math.max(...recent.map(x=>x.high)), pHi=Math.max(...prior.map(x=>x.high));
    const rLo=Math.min(...recent.map(x=>x.low)),  pLo=Math.min(...prior.map(x=>x.low));

    const mBody=Math.abs(M.haClose-M.haOpen), mRange=Math.max(M.haHigh-M.haLow,1e-9);
    const mBull=M.haClose>M.haOpen&&mBody/mRange>=0.25&&M.ema20>M.ema50&&rHi>pHi&&rLo>pLo;
    const mBear=M.haClose<M.haOpen&&mBody/mRange>=0.25&&M.ema20<M.ema50&&rHi<pHi&&rLo<pLo;

    if(hBull&&mBull) return "BULL";
    if(hBear&&mBear) return "BEAR";

    // Low ADX on both layers is treated as chop. Direction disagreement is transition.
    if(H.adx<16&&M.adx<15) return "CHOP";
    return "TRANSITION";
  }

  for(let i=220;i<f.length-1;i++){
    const b=f[i];
    while(mi+1<m.length&&m[mi+1].ts<=b.ts)mi++;
    while(hi+1<h.length&&h[hi+1].ts<=b.ts)hi++;
    const M=m[mi],H=h[hi];
    if(!M||!H||![b.atr,b.rsi,b.macdHist,M.ema20,M.ema50,M.adx,H.ema20,H.ema50,H.ema200,H.adx].every(Number.isFinite))continue;
    if(b.ts<o.tradeStartTs)continue;if(b.ts>o.tradeEndTs)break;

    const dk=new Date(b.ts).toISOString().slice(0,10);if(dk!==day){day=dk;dayR=0;}

    if(pos){
      const z=manageShortV72R2(pos,b);
      if(z.done){
        let r=z.r-(costBps/10000)/(pos.risk/pos.entry);
        ts.push({...pos,exitTs:b.ts,exitPrice:z.p,r:+r.toFixed(3)});
        dayR+=r;
        if(r<-.02){streak++;if(streak>=3){pause=b.ts+6*3600e3;streak=0}}else if(r>.02)streak=0;
        lastExit=b.ts;pos=null;
      }
      continue;
    }

    if(dayR<=-3){diag.blockedDaily++;continue}
    if(b.ts<pause||b.ts<lastExit+30*60e3){diag.blockedCooldown++;continue}

    // Re-evaluate router only when a new 15m candle becomes current.
    if(mi!==lastRegimeMi){
      lastRegimeMi=mi;
      const raw=classifyRegime(H,M,mi);

      if(raw==="CHOP"){
        activeRegime="CHOP";candidateRegime="";candidateCount=0;
        pendingL=null;pendingS=null;
      }else if(raw==="TRANSITION"){
        activeRegime="TRANSITION";candidateRegime="";candidateCount=0;
        pendingL=null;pendingS=null;
      }else{
        if(raw===candidateRegime)candidateCount++;
        else{candidateRegime=raw;candidateCount=1;}

        // Require two consecutive 15m confirmations before enabling a direction.
        // During a Bull↔Bear change the router sits in TRANSITION first.
        if(candidateCount>=2&&activeRegime!==raw){
          activeRegime=raw;diag.regimeSwitches++;
          pendingL=null;pendingS=null;
        }else if(activeRegime!==raw){
          activeRegime="TRANSITION";
          pendingL=null;pendingS=null;
        }
      }
    }

    if(activeRegime==="BULL")diag.bull++;
    else if(activeRegime==="BEAR")diag.bear++;
    else if(activeRegime==="CHOP"){diag.chop++;continue}
    else{diag.transition++;continue}

    const bull=activeRegime==="BULL",bear=activeRegime==="BEAR";

    // 5m uses REAL candles. Sweep is optional; BOS can create a setup directly.
    const prior8=f.slice(Math.max(0,i-8),i);if(prior8.length<6)continue;
    const liqLow=Math.min(...prior8.map(x=>x.low)),liqHigh=Math.max(...prior8.map(x=>x.high));
    const sweepL=bull&&b.low<liqLow&&b.close>liqLow&&b.close>b.open;
    const sweepS=bear&&b.high>liqHigh&&b.close<liqHigh&&b.close<b.open;

    if(sweepL){
      pendingL={sweepTs:b.ts,sweepIndex:i,structureLow:b.low,bosLevel:liqHigh,bosTs:0,bosIndex:0,expires:i+12,hadSweep:true};
      pendingS=null;diag.sweepLong++;
    }
    if(sweepS){
      pendingS={sweepTs:b.ts,sweepIndex:i,structureHigh:b.high,bosLevel:liqLow,bosTs:0,bosIndex:0,expires:i+12,hadSweep:true};
      pendingL=null;diag.sweepShort++;
    }

    if(pendingL&&i>pendingL.expires){pendingL=null;diag.expiredSetup++}
    if(pendingS&&i>pendingS.expires){pendingS=null;diag.expiredSetup++}
    if(!bull&&pendingL){pendingL=null;diag.blockedWrongRegime++}
    if(!bear&&pendingS){pendingS=null;diag.blockedWrongRegime++}

    // Direct BOS path when no sweep setup exists. Structure C is the recent real-candle swing extreme.
    if(bull&&!pendingL&&b.close>liqHigh&&b.rsi>=rsi.longBos.min&&b.rsi<=rsi.longBos.max&&b.macdHist>0){
      pendingL={sweepTs:0,sweepIndex:i,structureLow:liqLow,bosLevel:liqHigh,bosTs:b.ts,bosIndex:i,retestUntil:i+6,expires:i+6,hadSweep:false};
      diag.bosLong++;
    }else if(pendingL&&!pendingL.bosTs&&i>pendingL.sweepIndex&&b.close>pendingL.bosLevel&&b.rsi>=rsi.longBos.min&&b.rsi<=rsi.longBos.max&&b.macdHist>0){
      pendingL.bosTs=b.ts;pendingL.bosIndex=i;pendingL.retestUntil=i+6;diag.bosLong++;
    }
    if(bear&&!pendingS&&b.close<liqLow&&b.rsi>=rsi.shortBos.min&&b.rsi<=rsi.shortBos.max&&b.macdHist<0){
      pendingS={sweepTs:0,sweepIndex:i,structureHigh:liqHigh,bosLevel:liqLow,bosTs:b.ts,bosIndex:i,retestUntil:i+6,expires:i+6,hadSweep:false};
      diag.bosShort++;
    }else if(pendingS&&!pendingS.bosTs&&i>pendingS.sweepIndex&&b.close<pendingS.bosLevel&&b.rsi>=rsi.shortBos.min&&b.rsi<=rsi.shortBos.max&&b.macdHist<0){
      pendingS.bosTs=b.ts;pendingS.bosIndex=i;pendingS.retestUntil=i+6;diag.bosShort++;
    }

    if(pendingL?.bosTs&&i>pendingL.retestUntil){pendingL=null;diag.expiredSetup++}
    if(pendingS?.bosTs&&i>pendingS.retestUntil){pendingS=null;diag.expiredSetup++}

    let L=!!(bull&&pendingL?.bosTs&&i>pendingL.bosIndex&&b.low<=pendingL.bosLevel+b.atr*.15&&b.close>pendingL.bosLevel&&b.close>b.open&&b.rsi>=rsi.longRetest.min&&b.rsi<=rsi.longRetest.max&&b.macdHist>=f[i-1].macdHist);
    let S=!!(bear&&pendingS?.bosTs&&i>pendingS.bosIndex&&b.high>=pendingS.bosLevel-b.atr*.15&&b.close<pendingS.bosLevel&&b.close<b.open&&b.rsi>=rsi.shortRetest.min&&b.rsi<=rsi.shortRetest.max&&b.macdHist<=f[i-1].macdHist);

    if(v.id==="SL3")S=false;if(v.id==="SS3")L=false;
    if(mode==="long")S=false;if(mode==="short")L=false;

    if(L)diag.retestLong++;if(S)diag.retestShort++;
    const side=L?"LONG":S?"SHORT":null;if(!side)continue;

    const entry=f[i+1].open;let stop;
    if(side==="LONG"){
      const structure=pendingL.structureLow;
      stop=structure;
    }else{
      const structure=pendingS.structureHigh;
      stop=structure;
    }

    if(!(entry>0&&Number.isFinite(stop))||(side==="LONG"&&stop>=entry)||(side==="SHORT"&&stop<=entry)){
      diag.invalidStop++;if(L)pendingL=null;if(S)pendingS=null;continue;
    }

    const risk=Math.abs(entry-stop),stopPct=risk/entry;
    if(!(risk>0&&stopPct<.10)){
      diag.invalidStop++;if(L)pendingL=null;if(S)pendingS=null;continue;
    }

    const margin=(.005/stopPct)/10*100;
    if(margin>100){
      diag.blockedMargin++;if(L)pendingL=null;if(S)pendingS=null;continue;
    }

    if(L)diag.longSignals++;if(S)diag.shortSignals++;
    const entryDiag={
      regime:activeRegime,
      ha1h:H.haClose>H.haOpen?"Bull":H.haClose<H.haOpen?"Bear":"Flat",
      ha15m:M.haClose>M.haOpen?"Bull":M.haClose<M.haOpen?"Bear":"Flat",
      ema20:Number(b.ema20),ema50:Number(b.ema50),adx:Number(b.adx),rsi:Number(b.rsi),macdHist:Number(b.macdHist),
      bosLevel:Number(side==="LONG"?pendingL?.bosLevel:pendingS?.bosLevel),
      retest:true,hadSweep:!!(side==="LONG"?pendingL?.hadSweep:pendingS?.hadSweep)
    };
    pos=makeShortV72R2(side,entry,risk,stop,f[i+1].ts,stopMode);
    pos.entryDiag=entryDiag;
    if(L)pendingL=null;if(S)pendingS=null;
  }

  if(pos&&f.length){
    const q=[...f].reverse().find(x=>x.ts<=o.tradeEndTs)||f.at(-1),dir=pos.side==="LONG"?1:-1;
    let r=pos.real+pos.rem*((q.close-pos.entry)*dir/pos.risk)-(costBps/10000)/(pos.risk/pos.entry);
    ts.push({...pos,exitTs:q.ts,exitPrice:q.close,r:+r.toFixed(3),forcedClose:true});
  }

  return{variant:v.id,name:v.name,description:v.description,...summarizeTradeSequence(ts,10),diagnostics:diag,recentTrades:ts.slice(-10),__trades:ts};
}
function makeShortV72R2(side,entry,risk,stop,entryTs,stopMode){const d=side==="LONG"?1:-1;return{side,entry,entryTs,risk,stop,initialStop:stop,stopMode,tp1:entry+d*risk,tp2:entry+d*risk*2,rem:1,real:0,tp1Hit:false,tp2Hit:false,trail:null};}
function manageShortV72R2(p,x){
  const L=p.side==="LONG";
  // Conservative ordering: if SL and TP are both touched in one candle, SL wins.
  if(L?x.low<=p.stop:x.high>=p.stop)return{done:true,r:p.real+p.rem*(p.stop===p.entry?0:-1),p:p.stop};
  if(!p.tp1Hit&&(L?x.high>=p.tp1:x.low<=p.tp1)){p.tp1Hit=true;p.real+=.40;p.rem-=.40;p.stop=p.entry;}
  if(!p.tp2Hit&&(L?x.high>=p.tp2:x.low<=p.tp2)){p.tp2Hit=true;p.real+=.60;p.rem-=.30;p.trail=L?x.close-1.5*x.atr:x.close+1.5*x.atr;}
  if(p.tp2Hit){const n=L?x.close-1.5*x.atr:x.close+1.5*x.atr;p.trail=p.trail==null?n:(L?Math.max(p.trail,n):Math.min(p.trail,n));if(L?x.low<=p.trail:x.high>=p.trail){const rr=L?(p.trail-p.entry)/p.risk:(p.entry-p.trail)/p.risk;return{done:true,r:p.real+p.rem*rr,p:p.trail};}}
  return{done:false};
}

function simulateVariantV6(tf15, tf1h, tf4h, variant, mode="both", {tradeStartTs=-Infinity,tradeEndTs=Infinity}={}) {
  const h1ByTs = tf1h.map(x => [x.ts, x]);
  const h4ByTs = tf4h.map(x => [x.ts, x]);
  let h1Idx = 0, h4Idx = 0;
  let equity = 100, peak = 100, maxDD = 0;
  let wins = 0, losses = 0, breakeven = 0;
  let grossWinR = 0, grossLossR = 0;
  let maxLossStreak = 0, lossStreak = 0;
  let cooldownUntil = 0, lossPauseUntil = 0;
  let pos = null;
  const trades = [];
  const diag = {
    barsScanned:0, ready15m:0, ready1h:0, ready4h:0,
    trendLong:0, trendShort:0, fourHBull:0, fourHBear:0,
    pullbackLong:0, pullbackShort:0, breakoutLong:0, breakoutShort:0,
    momentumLong:0, momentumShort:0, finalLongSignals:0, finalShortSignals:0,
    blockedByCooldown:0, blockedBy4H:0
  };

  for (let i = 220; i < tf15.length - 1; i++) {
    diag.barsScanned++;
    const b = tf15[i], prev = tf15[i-1];
    while (h1Idx + 1 < h1ByTs.length && h1ByTs[h1Idx+1][0] <= b.ts) h1Idx++;
    while (h4Idx + 1 < h4ByTs.length && h4ByTs[h4Idx+1][0] <= b.ts) h4Idx++;
    const h = h1ByTs[h1Idx]?.[1];
    const h4 = h4ByTs[h4Idx]?.[1];

    if (!Number.isFinite(b.atr) || !Number.isFinite(b.rsi) || !Number.isFinite(b.ema50) || !Number.isFinite(b.macdHist)) continue;
    diag.ready15m++;
    if (!h || !Number.isFinite(h.ema200) || !Number.isFinite(h.adx)) continue;
    diag.ready1h++;
    const needs4H = variant.id !== "C0";
    const h4Ready = !!h4 && Number.isFinite(h4.ema20) && Number.isFinite(h4.ema50) && Number.isFinite(h4.ema200);
    if (h4Ready) diag.ready4h++;
    if (needs4H && !h4Ready) { diag.blockedBy4H++; continue; }
    if (b.ts < tradeStartTs) continue;
    if (b.ts > tradeEndTs) break;

    const barMovePct = (b.high - b.low) / b.open * 100;
    if ((b.high - b.low) > b.atr * 3 || barMovePct > 4) {
      cooldownUntil = Math.max(cooldownUntil, b.ts + (barMovePct > 7 ? 4*3600e3 : 3600e3));
    }

    if (pos) {
      const outcome = managePosition(pos, b);
      if (outcome.done) {
        const r = outcome.totalR;
        equity *= (1 + 0.005 * r);
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, (peak - equity) / peak * 100);
        if (r > 0.02) { wins++; grossWinR += r; lossStreak = 0; }
        else if (r < -0.02) {
          losses++; grossLossR += -r; lossStreak++;
          maxLossStreak = Math.max(maxLossStreak, lossStreak);
          if (lossStreak >= 3) { lossPauseUntil = b.ts + 6*3600e3; lossStreak = 0; }
        } else { breakeven++; lossStreak = 0; }
        trades.push({...pos, exitTs:b.ts, exitPrice:outcome.exitPrice, r:+r.toFixed(3)});
        pos = null;
      }
      continue;
    }

    if (b.ts < cooldownUntil || b.ts < lossPauseUntil) { diag.blockedByCooldown++; continue; }

    const oneHBull = h.ema20 > h.ema50 && h.ema50 > h.ema200 && h.close > h.ema200;
    const oneHBear = h.ema20 < h.ema50 && h.ema50 < h.ema200 && h.close < h.ema200;
    if (oneHBull && h.adx >= 25) diag.trendLong++;
    if (oneHBear && h.adx >= 25) diag.trendShort++;

    const fourHBull = h4Ready && h4.ema20 > h4.ema50 && h4.close > h4.ema200;
    const fourHBear = h4Ready && h4.ema20 < h4.ema50 && h4.close < h4.ema200;
    if (fourHBull) diag.fourHBull++;
    if (fourHBear) diag.fourHBear++;

    const volOK = Number.isFinite(b.volMA20) && b.volume > b.volMA20 * 1.1;
    const macdLong = b.macdHist > 0 && b.macdHist > prev.macdHist;
    const macdShort = b.macdHist < 0 && b.macdHist < prev.macdHist;
    const breakLong = b.close > prev.high;
    const breakShort = b.close < prev.low;
    if (breakLong) diag.breakoutLong++;
    if (breakShort) diag.breakoutShort++;
    const recent = tf15.slice(Math.max(0,i-6), i+1);
    const recentLowToEma = recent.some(x=>Number.isFinite(x.ema20) && x.low <= x.ema20);
    const recentHighToEma = recent.some(x=>Number.isFinite(x.ema20) && x.high >= x.ema20);

    let longSignal = false, shortSignal = false;

    if (variant.id === "C0") {
      // Exact V5 C baseline. No 4H dependency.
      const pullbackLong = b.low <= b.ema20 && b.close >= b.ema50;
      const pullbackShort = b.high >= b.ema20 && b.close <= b.ema50;
      if (pullbackLong) diag.pullbackLong++;
      if (pullbackShort) diag.pullbackShort++;
      const momentumLong = b.rsi >= 50 && (macdLong || volOK);
      const momentumShort = b.rsi <= 50 && (macdShort || volOK);
      if (momentumLong) diag.momentumLong++;
      if (momentumShort) diag.momentumShort++;
      longSignal = oneHBull && h.adx >= 25 && pullbackLong && breakLong && momentumLong;
      shortSignal = oneHBear && h.adx >= 25 && pullbackShort && breakShort && momentumShort;
    } else if (variant.id === "CL2") {
      const rsiZone = b.rsi >= 52 && b.rsi <= 70;
      const structure = b.close > b.ema20 && b.ema20 > b.ema50;
      const momentum = macdLong || volOK;
      if (recentLowToEma) diag.pullbackLong++;
      if (momentum) diag.momentumLong++;
      longSignal = fourHBull && oneHBull && h.adx >= 22 && recentLowToEma && structure && breakLong && rsiZone && momentum;
    } else if (variant.id === "CS2") {
      const rsiZone = b.rsi <= 48 && b.rsi >= 30;
      const structure = b.close < b.ema20 && b.ema20 < b.ema50;
      const momentum = macdShort || volOK;
      if (recentHighToEma) diag.pullbackShort++;
      if (momentum) diag.momentumShort++;
      shortSignal = fourHBear && oneHBear && h.adx >= 25 && recentHighToEma && structure && breakShort && rsiZone && momentum;
    } else if (variant.id === "COMB") {
      const longRsi=b.rsi>=52&&b.rsi<=70,longStructure=b.close>b.ema20&&b.ema20>b.ema50,longMomentum=macdLong||volOK;
      const shortRsi=b.rsi<=48&&b.rsi>=30,shortStructure=b.close<b.ema20&&b.ema20<b.ema50,shortMomentum=macdShort||volOK;
      if(recentLowToEma)diag.pullbackLong++; if(recentHighToEma)diag.pullbackShort++; if(longMomentum)diag.momentumLong++; if(shortMomentum)diag.momentumShort++;
      longSignal=fourHBull&&oneHBull&&h.adx>=22&&recentLowToEma&&longStructure&&breakLong&&longRsi&&longMomentum;
      shortSignal=fourHBear&&oneHBear&&h.adx>=25&&recentHighToEma&&shortStructure&&breakShort&&shortRsi&&shortMomentum;
    }

    if (mode === "long") shortSignal = false;
    if (mode === "short") longSignal = false;
    if (longSignal) diag.finalLongSignals++;
    if (shortSignal) diag.finalShortSignals++;
    const side = longSignal ? "LONG" : shortSignal ? "SHORT" : null;
    if (!side) continue;

    const next = tf15[i+1];
    const entry = next.open;
    const risk = b.atr * 1.5;
    if (!(risk > 0)) continue;
    pos = makePosition(side, entry, risk, next.ts);
  }

  // Mark-to-market close any still-open position at the end so short windows don't silently drop it.
  if (pos && tf15.length) {
    let last = tf15[tf15.length-1];
    if (Number.isFinite(tradeEndTs)) for (let z=tf15.length-1;z>=0;z--) if (tf15[z].ts<=tradeEndTs){last=tf15[z];break;}
    const dir = pos.side === "LONG" ? 1 : -1;
    const unrealizedR = ((last.close - pos.entry) * dir) / pos.risk;
    const r = pos.realizedR + pos.remaining * unrealizedR;
    equity *= (1 + 0.005 * r);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak * 100);
    if (r > 0.02) { wins++; grossWinR += r; }
    else if (r < -0.02) { losses++; grossLossR += -r; }
    else breakeven++;
    trades.push({...pos, exitTs:last.ts, exitPrice:last.close, r:+r.toFixed(3), forcedClose:true});
  }

  const total = trades.length;
  const pf = grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? 999 : 0);
  const netR = trades.reduce((a,t)=>a+t.r,0);
  const sideStats = side => {
    const xs = trades.filter(t=>t.side===side);
    const w = xs.filter(t=>t.r>0.02), l = xs.filter(t=>t.r<-0.02);
    const gw = w.reduce((a,t)=>a+t.r,0), gl = l.reduce((a,t)=>a+(-t.r),0);
    return {trades:xs.length,wins:w.length,losses:l.length,winRate:xs.length?+(w.length/xs.length*100).toFixed(2):0,profitFactor:+(gl>0?gw/gl:(gw>0?999:0)).toFixed(2),netR:+xs.reduce((a,t)=>a+t.r,0).toFixed(2)};
  };
  return {
    variant:variant.id,name:variant.name,description:variant.description,
    trades:total,wins,losses,breakeven,
    winRate:total ? +(wins/total*100).toFixed(2) : 0,
    profitFactor:+pf.toFixed(2),netR:+netR.toFixed(2),endingEquity:+equity.toFixed(2),
    maxDrawdownPct:+maxDD.toFixed(2),maxLossStreak,
    long:sideStats("LONG"),short:sideStats("SHORT"),diagnostics:diag,
    recentTrades:trades.slice(-10).map(t=>({side:t.side,entryTs:t.entryTs,exitTs:t.exitTs,entry:+t.entry.toFixed(4),exit:+t.exitPrice.toFixed(4),r:t.r,forcedClose:!!t.forcedClose})),
    __trades:trades.map(t=>({side:t.side,entryTs:t.entryTs,exitTs:t.exitTs,entry:+t.entry.toFixed(4),exitPrice:+t.exitPrice.toFixed(4),risk:+t.risk.toFixed(6),r:t.r,forcedClose:!!t.forcedClose}))
  };
}
function makePosition(side, entry, risk, entryTs) {
  const dir = side === "LONG" ? 1 : -1;
  return {
    side, entry, entryTs, risk,
    stop: entry - dir*risk,
    tp1: entry + dir*risk,
    tp2: entry + dir*risk*2,
    remaining: 1,
    realizedR: 0,
    movedBE: false,
    tp1Hit: false,
    tp2Hit: false,
    trail: null
  };
}

function managePosition(p, b) {
  const long = p.side === "LONG";
  const hitStop = long ? b.low <= p.stop : b.high >= p.stop;
  if (hitStop) {
    const stopR = p.movedBE ? 0 : -1;
    return {done:true,totalR:p.realizedR + p.remaining*stopR,exitPrice:p.stop};
  }

  if (!p.tp1Hit) {
    const hit = long ? b.high >= p.tp1 : b.low <= p.tp1;
    if (hit) {
      p.tp1Hit = true; p.realizedR += 0.3; p.remaining -= 0.3; p.stop = p.entry; p.movedBE = true;
    }
  }
  if (!p.tp2Hit) {
    const hit = long ? b.high >= p.tp2 : b.low <= p.tp2;
    if (hit) {
      p.tp2Hit = true; p.realizedR += 0.6; p.remaining -= 0.3;
      p.trail = long ? b.close - 1.5*b.atr : b.close + 1.5*b.atr;
    }
  }

  if (p.tp2Hit) {
    const newTrail = long ? b.close - 1.5*b.atr : b.close + 1.5*b.atr;
    p.trail = p.trail == null ? newTrail : (long ? Math.max(p.trail,newTrail) : Math.min(p.trail,newTrail));
    const hitTrail = long ? b.low <= p.trail : b.high >= p.trail;
    if (hitTrail) {
      const runnerR = long ? (p.trail-p.entry)/p.risk : (p.entry-p.trail)/p.risk;
      return {done:true,totalR:p.realizedR + p.remaining*runnerR,exitPrice:p.trail};
    }
  }
  return {done:false};
}

async function fetchHistory(interval, days) {
  try {
    const rows = await fetchBybitHistory(interval, days);
    return {rows, source:"Bybit SOLUSDT linear"};
  } catch (bybitErr) {
    console.error("BACKTEST SOURCE: Bybit failed", interval, bybitErr?.message || String(bybitErr));
    const okxBar = interval === "15" ? "15m" : interval === "60" ? "1H" : interval === "240" ? "4H" : `${interval}m`;
    const rows = await fetchOkxHistoryThrottled(okxBar, days);
    return {rows, source:"OKX SOL-USDT-SWAP fallback"};
  }
}

async function fetchBybitHistory(interval, days) {
  const ms = interval === "15" ? 15*60e3 : interval === "60" ? 60*60e3 : interval === "240" ? 4*60*60e3 : Number(interval)*60e3;
  const target = Math.ceil(days*24*60*60e3/ms) + 260;
  let out = [];
  let end = Date.now();
  let pages = 0;
  const maxPages = Math.ceil(target / 1000) + 2;

  while (out.length < target && pages < maxPages) {
    const url = `${BASE}?category=linear&symbol=${symbol}&interval=${interval}&end=${end}&limit=1000`;
    const r = await fetchWithRetry(url, {label:`Bybit ${interval}m`, retries:4});
    const j = await r.json();
    const list = j?.result?.list;
    if (j?.retCode !== 0 || !Array.isArray(list) || !list.length) {
      throw new Error(`Bybit ${interval}m invalid response: ${JSON.stringify(j).slice(0,180)}`);
    }
    const batch = list.map(x => ({
      ts:Number(x[0]), open:Number(x[1]), high:Number(x[2]), low:Number(x[3]), close:Number(x[4]), volume:Number(x[5])
    })).filter(x => Object.values(x).every(Number.isFinite));
    if (!batch.length) break;
    out.push(...batch);
    const oldest = Math.min(...batch.map(x=>x.ts));
    if (!(oldest < end)) break;
    end = oldest - 1;
    pages++;
    if (batch.length < 1000) break;
    await sleep(150);
  }

  const uniq = new Map(out.map(x=>[x.ts,x]));
  const rows = [...uniq.values()].sort((a,b)=>a.ts-b.ts).slice(-target);
  if (rows.length < Math.min(target, 260)) throw new Error(`Bybit ${interval}m insufficient candles ${rows.length}`);
  return rows;
}

async function fetchOkxHistoryThrottled(bar, days) {
  const ms = bar === "15m" ? 15*60e3 : bar === "1H" ? 60*60e3 : bar === "4H" ? 4*60*60e3 : 60*60e3;
  const target = Math.ceil(days*24*60*60e3/ms) + 260;
  let out = [];
  let after = null;
  let pages = 0;

  const maxPages = Math.ceil(target / 100) + 2;
  while (out.length < target && pages < maxPages) {
    let url = `https://www.okx.com/api/v5/market/history-candles?instId=SOL-USDT-SWAP&bar=${encodeURIComponent(bar)}&limit=100`;
    if (after) url += `&after=${after}`;
    const r = await fetchWithRetry(url, {label:`OKX history ${bar}`, retries:5});
    const j = await r.json();
    if (j.code !== "0" || !Array.isArray(j.data) || !j.data.length) {
      throw new Error(`OKX history ${bar} invalid response: ${JSON.stringify(j).slice(0,180)}`);
    }
    const batch = j.data.map(x => ({
      ts:Number(x[0]), open:Number(x[1]), high:Number(x[2]), low:Number(x[3]), close:Number(x[4]), volume:Number(x[5])
    })).filter(x => Object.values(x).every(Number.isFinite));
    if (!batch.length) break;
    out.push(...batch);
    const oldest = Math.min(...batch.map(x=>x.ts));
    after = String(oldest);
    pages++;
    if (batch.length < 100) break;
    // OKX public limits are IP-based; Cloudflare egress IPs may be shared,
    // so stay deliberately below the documented ceiling.
    await sleep(750);
  }

  const uniq = new Map(out.map(x=>[x.ts,x]));
  const rows = [...uniq.values()].sort((a,b)=>a.ts-b.ts).slice(-target);
  if (rows.length < Math.min(target, 260)) throw new Error(`OKX ${bar} insufficient candles ${rows.length}`);
  return rows;
}

async function fetchWithRetry(url, {label="request", retries=4}={}) {
  let lastErr = null;
  for (let attempt=0; attempt<=retries; attempt++) {
    try {
      const r = await fetch(url, {headers:{"accept":"application/json","user-agent":"Mozilla/5.0 SOL-Backtest/2.0"}});
      if (r.ok) return r;
      const retryable = r.status === 429 || r.status >= 500;
      if (!retryable) throw new Error(`${label} HTTP ${r.status}`);
      lastErr = new Error(`${label} HTTP ${r.status}`);
      if (attempt >= retries) break;
      const retryAfter = Number(r.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * (2 ** attempt), 8000);
      console.log("BACKTEST RETRY", {label,status:r.status,attempt:attempt+1,waitMs});
      await sleep(waitMs);
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
      const waitMs = Math.min(1000 * (2 ** attempt), 8000);
      console.log("BACKTEST RETRY ERROR", {label,attempt:attempt+1,waitMs,message:e?.message||String(e)});
      await sleep(waitMs);
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function buildIndicators(rows) {
  const c = rows.map(x=>x.close), h = rows.map(x=>x.high), l = rows.map(x=>x.low), v = rows.map(x=>x.volume);
  const e20 = emaSeries(c,20), e50 = emaSeries(c,50), e200 = emaSeries(c,200);
  const r = rsiSeries(c,14), atr = atrSeries(h,l,c,14), adx = adxSeries(h,l,c,14);
  const fast=emaSeries(c,12), slow=emaSeries(c,26);
  const macd = c.map((_,i)=>Number.isFinite(fast[i])&&Number.isFinite(slow[i])?fast[i]-slow[i]:NaN);
  const signal=emaSeries(macd.map(x=>Number.isFinite(x)?x:0),9);
  const volMA=smaSeries(v,20);
  return rows.map((x,i)=>({...x,ema20:e20[i],ema50:e50[i],ema200:e200[i],rsi:r[i],atr:atr[i],adx:adx[i],macdHist:Number.isFinite(macd[i])&&Number.isFinite(signal[i])?macd[i]-signal[i]:NaN,volMA20:volMA[i]}));
}

function smaSeries(v,p){const o=Array(v.length).fill(NaN);let s=0;for(let i=0;i<v.length;i++){s+=v[i];if(i>=p)s-=v[i-p];if(i>=p-1)o[i]=s/p;}return o}
function emaSeries(v,p){const o=Array(v.length).fill(NaN);if(v.length<p)return o;let seed=0;for(let i=0;i<p;i++)seed+=v[i];let x=seed/p;o[p-1]=x;const k=2/(p+1);for(let i=p;i<v.length;i++){x=v[i]*k+x*(1-k);o[i]=x;}return o}
function rsiSeries(v,p=14){const o=Array(v.length).fill(NaN);if(v.length<=p)return o;let g=0,lo=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];g+=Math.max(d,0);lo+=Math.max(-d,0)}g/=p;lo/=p;o[p]=lo===0?100:100-100/(1+g/lo);for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];g=(g*(p-1)+Math.max(d,0))/p;lo=(lo*(p-1)+Math.max(-d,0))/p;o[i]=lo===0?100:100-100/(1+g/lo)}return o}
function atrSeries(h,l,c,p=14){const tr=Array(c.length).fill(NaN);for(let i=1;i<c.length;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const o=Array(c.length).fill(NaN);if(c.length<=p)return o;let a=0;for(let i=1;i<=p;i++)a+=tr[i];a/=p;o[p]=a;for(let i=p+1;i<c.length;i++){a=(a*(p-1)+tr[i])/p;o[i]=a}return o}
function adxSeries(h,l,c,p=14){const n=c.length,tr=Array(n).fill(0),pd=Array(n).fill(0),md=Array(n).fill(0);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const up=h[i]-h[i-1],dn=l[i-1]-l[i];pd[i]=up>dn&&up>0?up:0;md[i]=dn>up&&dn>0?dn:0}const o=Array(n).fill(NaN);if(n<2*p+2)return o;let trS=0,pS=0,mS=0;for(let i=1;i<=p;i++){trS+=tr[i];pS+=pd[i];mS+=md[i]}const dx=Array(n).fill(NaN);for(let i=p;i<n;i++){if(i>p){trS=trS-trS/p+tr[i];pS=pS-pS/p+pd[i];mS=mS-mS/p+md[i]}const pdi=trS?100*pS/trS:0,mdi=trS?100*mS/trS:0;dx[i]=(pdi+mdi)?100*Math.abs(pdi-mdi)/(pdi+mdi):0}let a=0;for(let i=p;i<2*p;i++)a+=dx[i];a/=p;o[2*p-1]=a;for(let i=2*p;i<n;i++){a=(a*(p-1)+dx[i])/p;o[i]=a}return o}


