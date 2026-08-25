const SYMBOL="SOLUSDT", BASE="https://api.bybit.com/v5/market/kline";
const BACKTEST_SYMBOLS=["SOLUSDT","BTCUSDT","ETHUSDT","BNBUSDT"];
const BACKTEST_LEVERAGES=[10];
const SHEET_WEBAPP="https://script.google.com/macros/s/AKfycbyM5J9mLarf3KUKR9kPCsgFUJL4sLxo3kHttRKIBT_QywpSp6_lQOw8rVHRmG1VUHtWFw/exec";
const TFS=[["4h","4H","240"],["1h","1H","60"],["30m","30m","30"],["15m","15m","15"]];

export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health") {
      return J({
        ok: true,
        service: "SOL Technical Dashboard",
        sheetSync: "enabled",
        cron: "every minute",
        time: new Date().toISOString()
      });
    }

    if (u.pathname === "/backtest" || u.pathname === "/backtest/api") {
      try {
        const days = Math.min(Math.max(Number(u.searchParams.get("days") || 30), 7), 365);
        const modeRaw = String(u.searchParams.get("mode") || "both").toLowerCase();
        const mode = ["both","long","short"].includes(modeRaw) ? modeRaw : "both";
        const symbolRaw = String(u.searchParams.get("symbol") || "SOLUSDT").toUpperCase();
        const symbol = BACKTEST_SYMBOLS.includes(symbolRaw) ? symbolRaw : "SOLUSDT";
        const leverage = 10;
        const strategyRaw=String(u.searchParams.get("strategy")||"swing").toLowerCase();
        const strategy=["swing","short"].includes(strategyRaw)?strategyRaw:"swing";
        const costRaw=Number(u.searchParams.get("costbps"));
        const costBps=[0,8,12,20].includes(costRaw)?costRaw:(strategy==="short"?12:8);
        const cache = caches.default;
        const cacheKey = new Request(new URL(`/__backtest_v71_result?symbol=${symbol}&days=${days}&mode=${mode}&leverage=10&strategy=${strategy}&costbps=${costBps}`, req.url).toString(), {method:"GET"});
        const cached = await cache.match(cacheKey);
        if (cached) {
          const result = await cached.json();
          const output = {...result, cache:"HIT"};
          if (u.pathname === "/backtest/api") return J(output);
          return new Response(backtestPage(output), {headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
        }
        const result = await runBacktestStaged({days, mode, symbol, leverage, strategy, costBps, requestUrl:req.url});
        if (result.pending) {
          if (u.pathname === "/backtest/api") return J(result, 202);
          return new Response(backtestProgressPage(result), {status:202,headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
        }
        await cache.put(cacheKey, new Response(JSON.stringify(result), {headers:{"content-type":"application/json","cache-control":"public, max-age=900"}}));
        const output = {...result, cache:"MISS"};
        if (u.pathname === "/backtest/api") return J(output);
        return new Response(backtestPage(output), {headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
      } catch (e) {
        if (u.pathname === "/backtest/api") return J({error:true,message:e?.message||String(e),time:new Date().toISOString()},500);
        return new Response(backtestErrorPage(e), {status:500,headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
      }
    }

    try {
      const cache = caches.default;
      const cacheKey = new Request(new URL("/__report_cache", req.url).toString(), {method:"GET"});
      let cached = await cache.match(cacheKey);
      let report;

      if (cached) {
        report = await cached.json();
      } else {
        report = await buildReport();
        await cache.put(cacheKey, new Response(JSON.stringify(report), {
          headers: {"content-type":"application/json","cache-control":"public, max-age=5"}
        }));
      }

      // HTTP access may also sync, but no more than once per minute.
      await syncSheetOncePerMinute(report, req.url);

      if (u.pathname === "/api") return J(report);
      if (u.pathname !== "/") return J({error:true,message:"Not found"},404);

      return new Response(page(report), {
        headers: {
          "content-type":"text/html; charset=UTF-8",
          "cache-control":"no-store"
        }
      });
    } catch (e) {
      return J({error:true,message:e?.message||String(e),time:new Date().toISOString()},500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      console.log("CRON DEBUG: started", {
        cron: controller?.cron,
        scheduledTime: controller?.scheduledTime,
        now: new Date().toISOString()
      });

      try {
        const data = {};

        for (const [key, label, interval] of TFS) {
          console.log(`CRON DEBUG: ${key} fetch start`, {label, interval});
          try {
            data[key] = await calc(label, interval);
            console.log(`CRON DEBUG: ${key} OK`, {
              close: data[key].close,
              ema20: data[key].ema20,
              ema50: data[key].ema50,
              ema200: data[key].ema200,
              rsi14: data[key].rsi14
            });
          } catch (err) {
            console.error(`CRON DEBUG: ${key} FAILED`, err?.stack || err?.message || String(err));
            return;
          }
        }

        const score = Object.values(data).reduce((a,x)=>a+x.score,0);
        const overall = score>=6?"🟢 強多":score>=2?"🟢 偏多":score<=-6?"🔴 強空":score<=-2?"🔴 偏空":"🟡 震盪";
        const report = {
          symbol: SYMBOL,
          source: "OKX primary / Kraken fallback",
          updatedAt: new Date().toISOString(),
          price: data["15m"].close,
          overall,
          data
        };

        console.log("CRON DEBUG: report built", {
          price: report.price,
          overall: report.overall,
          updatedAt: report.updatedAt
        });

        try {
          console.log("CRON DEBUG: Google POST start");
          const res = await fetch(SHEET_WEBAPP, {
            method: "POST",
            headers: {"content-type":"application/json"},
            body: JSON.stringify(report),
            redirect: "follow"
          });
          const text = await res.text();
          console.log("CRON DEBUG: Google POST response", {
            status: res.status,
            ok: res.ok,
            body: text.slice(0,500)
          });
          if (!res.ok) {
            console.error("CRON DEBUG: Google POST non-2xx");
            return;
          }
        } catch (err) {
          console.error("CRON DEBUG: Google POST FAILED", err?.stack || err?.message || String(err));
          return;
        }

        console.log("CRON DEBUG: COMPLETE SUCCESS", report.updatedAt);
      } catch (err) {
        // Do not rethrow during diagnosis, so logs preserve the real failure point.
        console.error("CRON DEBUG: unexpected failure", err?.stack || err?.message || String(err));
      }
    })());
  }
};

async function buildReport() {
  const data = {};
  for (const [key,label,interval] of TFS) data[key] = await calc(label,interval);
  const score = Object.values(data).reduce((a,x)=>a+x.score,0);
  const overall = score>=6?"🟢 強多":score>=2?"🟢 偏多":score<=-6?"🔴 強空":score<=-2?"🔴 偏空":"🟡 震盪";
  return {
    symbol: SYMBOL,
    source: "OKX primary / Kraken fallback",
    updatedAt: new Date().toISOString(),
    price: data["15m"].close,
    overall,
    data
  };
}

async function syncSheetOncePerMinute(report, requestUrl) {
  const cache = caches.default;
  const syncKey = new Request(new URL("/__sheet_sync_marker", requestUrl).toString(), {method:"GET"});
  const marker = await cache.match(syncKey);
  if (marker) return;

  try {
    const res = await fetch(SHEET_WEBAPP, {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify(report)
    });
    if (!res.ok) throw new Error(`Google Sheet HTTP ${res.status}`);
    await cache.put(syncKey, new Response("ok", {
      headers: {"cache-control":"public, max-age=60"}
    }));
  } catch (e) {
    console.log("HTTP sheet sync failed:", e?.message || String(e));
  }
}

async function calc(label, interval) {
  const limit = 260;
  let closes = null;
  let source = null;

  // Primary: OKX SOL-USDT-SWAP
  try {
    const okxBar = {
      "240":"4H",
      "60":"1H",
      "30":"30m",
      "15":"15m"
    }[String(interval)];

    if (!okxBar) throw new Error(`Unsupported OKX interval ${interval}`);

    const url = `https://www.okx.com/api/v5/market/candles?instId=SOL-USDT-SWAP&bar=${encodeURIComponent(okxBar)}&limit=${limit}`;
    const r = await fetch(url, {
      headers: {
        "accept":"application/json",
        "user-agent":"Mozilla/5.0 SOL-EMA-Monitor/1.0"
      }
    });
    if (!r.ok) throw new Error(`OKX ${label} HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== "0" || !Array.isArray(j.data)) {
      throw new Error(`OKX ${label} invalid response: ${JSON.stringify(j).slice(0,180)}`);
    }

    // OKX is newest-first; close is index 4.
    closes = j.data.map(x => Number(x[4])).filter(Number.isFinite).reverse();
    if (closes.length < 210) throw new Error(`OKX ${label} insufficient candles ${closes.length}`);
    source = "OKX SOL-USDT-SWAP";
  } catch (okxErr) {
    console.error(`SOURCE DEBUG: OKX ${label} failed`, okxErr?.message || String(okxErr));

    // Fallback: Kraken spot SOL/USD OHLC. This is only a resilience fallback,
    // so the Sheet explicitly records the actual source.
    const krakenInterval = Number(interval);
    const url = `https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=${krakenInterval}`;
    const r = await fetch(url, {
      headers: {
        "accept":"application/json",
        "user-agent":"Mozilla/5.0 SOL-EMA-Monitor/1.0"
      }
    });
    if (!r.ok) throw new Error(`Kraken ${label} HTTP ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j.error) && j.error.length) {
      throw new Error(`Kraken ${label}: ${j.error.join(", ")}`);
    }
    const key = Object.keys(j.result || {}).find(k => k !== "last");
    const rows = key ? j.result[key] : null;
    if (!Array.isArray(rows)) throw new Error(`Kraken ${label} invalid OHLC response`);
    closes = rows.map(x => Number(x[4])).filter(Number.isFinite);
    if (closes.length < 210) throw new Error(`Kraken ${label} insufficient candles ${closes.length}`);
    source = "Kraken SOL/USD Spot fallback";
  }

  const e20 = ema(closes,20);
  const e50 = ema(closes,50);
  const e200 = ema(closes,200);
  const r14 = rsiW(closes,14);
  const close = closes[closes.length-1];

  let score = 0;
  if (close > e20) score++;
  if (e20 > e50) score++;
  if (e50 > e200) score++;
  if (r14 >= 55) score++;
  if (close < e20) score--;
  if (e20 < e50) score--;
  if (e50 < e200) score--;
  if (r14 <= 45) score--;

  const trend = score>=3?"🟢 強多":score>=1?"🟢 偏多":score<=-3?"🔴 強空":score<=-1?"🔴 偏空":"🟡 震盪";
  const rsiState = r14>=70?"過熱":r14>=55?"偏強":r14<=30?"超賣":r14<=45?"偏弱":"中性";

  return {
    label,
    close:+close.toFixed(4),
    ema20:+e20.toFixed(4),
    ema50:+e50.toFixed(4),
    ema200:+e200.toFixed(4),
    rsi14:+r14.toFixed(2),
    rsiState,
    trend,
    score,
    source
  };
}

function ema(v,p){let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p,k=2/(p+1);for(let i=p;i<v.length;i++)x=v[i]*k+x*(1-k);return x}
function rsiW(v,p=14){let g=0,l=0;for(let i=1;i<=p;i++){let d=v[i]-v[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}g/=p;l/=p;for(let i=p+1;i<v.length;i++){let d=v[i]-v[i-1];g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p}if(l===0)return 100;let rs=g/l;return 100-100/(1+rs)}
function R(v,d){let p=10**d;return Math.round(v*p)/p}
function J(x,s=200){return new Response(JSON.stringify(x,null,2),{status:s,headers:{"content-type":"application/json; charset=UTF-8","access-control-allow-origin":"*","cache-control":"no-store"}})}
function page(r){
 const cards=TFS.map(([k,l])=>{let x=r.data[k];return `<article class="tfcard"><div class="tfhead"><strong>${l}</strong><span class="trend">${x.trend}</span></div><div class="grid"><div><small>Close</small><b>${x.close.toFixed(2)}</b></div><div><small>RSI14</small><b>${x.rsi14.toFixed(1)}</b><em>${x.rsiState}</em></div><div><small>EMA20</small><b>${x.ema20.toFixed(2)}</b></div><div><small>EMA50</small><b>${x.ema50.toFixed(2)}</b></div><div><small>EMA200</small><b>${x.ema200.toFixed(2)}</b></div></div></article>`}).join("");
 return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b0f17"><title>SOL Dashboard</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b0f17;color:#f5f7fb;font-family:system-ui,-apple-system,sans-serif}.w{max-width:760px;margin:auto;padding:16px 12px 34px}.hero,.tfcard{background:#121925;border:1px solid #263246;border-radius:20px}.hero{padding:20px;background:linear-gradient(145deg,#182131,#121925)}.ey{color:#8995a8;font-size:12px;letter-spacing:.08em}.top{display:flex;justify-content:space-between;align-items:end;gap:12px}h1{font-size:23px;margin:7px 0}.price{font-size:36px;font-weight:800}.badge,.trend{background:#0d1420;border:1px solid #263246;border-radius:999px;padding:7px 10px;white-space:nowrap}.meta{color:#8995a8;font-size:12px;margin-top:8px}.section{font-size:18px;margin:22px 4px 10px}.tfcard{padding:16px;margin-top:10px}.tfhead{display:flex;align-items:center;justify-content:space-between;font-size:20px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:14px}.grid div{background:#0d1420;border:1px solid #202c3f;border-radius:14px;padding:12px}.grid div:last-child{grid-column:1/-1}.grid small{display:block;color:#8995a8;font-size:11px;margin-bottom:4px}.grid b{font-size:18px;font-variant-numeric:tabular-nums}.grid em{display:block;color:#8995a8;font-size:11px;font-style:normal;margin-top:2px}.links{display:flex;gap:8px;margin-top:14px}.links a{color:#f5f7fb;text-decoration:none;background:#121925;border:1px solid #263246;padding:9px 12px;border-radius:12px}.foot{color:#8995a8;font-size:12px;line-height:1.6;margin-top:14px}@media(min-width:640px){.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px}.tfcard{margin-top:0}.grid div:last-child{grid-column:auto}}
</style></head><body><main class="w"><section class="hero"><div class="ey">SOL TECHNICAL DASHBOARD</div><div class="top"><div><h1>SOLUSDT Perpetual</h1><div class="price">$${r.price.toFixed(2)}</div></div><div class="badge">${r.overall}</div></div><div class="meta">Bybit SOLUSDT Perpetual · 更新 <span id="t"></span></div></section><h2 class="section">多週期 EMA / RSI</h2><section class="cards">${cards}</section><div class="links"><a href="/api">API JSON</a><a href="/health">Health</a></div><div class="foot">EMA 使用 SMA seed 後標準 EMA 遞迴；RSI 使用 Wilder 平滑。技術指標來源為 Bybit SOLUSDT 永續，與 Binance SOLUSDC 實際成交價可能略有差異。</div></main><script>document.getElementById("t").textContent=new Date(${JSON.stringify(r.updatedAt)}).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",hour12:false});let n=5;const m=document.querySelector(".meta");const c=document.createElement("span");c.id="count";c.textContent=" · 🔄 "+n+" 秒後更新";m.appendChild(c);const timer=setInterval(()=>{n--;c.textContent=" · 🔄 "+n+" 秒後更新";if(n<=0){clearInterval(timer);location.reload()}},1000)</script></body></html>`;
}

const BT_CHUNK_MS = 15*24*60*60*1000;
const BT_WARMUP_MS = 50*24*60*60*1000;
const BT_MAX_CHUNKS_PER_INVOCATION = 2;

async function runBacktestStaged({days=30,mode="both",symbol="SOLUSDT",leverage=10,strategy="swing",costBps=8,requestUrl}={}){
 const now=Date.now(),coreStart=now-days*86400e3,dataStart=coreStart-BT_WARMUP_MS,prep=await ensureHistoryBundles(dataStart,now,requestUrl,symbol);
 if(!prep.complete)return{pending:true,version:"7.1",symbol,leverage:10,strategy,costBps,days,tradeMode:mode,progress:prep};
 const raw=await loadHistoryRange(dataStart,now,requestUrl,symbol);let results,variants;
 if(strategy==="short"){const f=buildIndicators(raw.m5),m=buildIndicators(raw.m15),h=buildIndicators(raw.h1);variants=[{id:"SL1",name:"S-Long V2",description:"1H Bull + 15m trend + 5m pullback/reclaim"},{id:"SS1",name:"S-Short V2",description:"1H Bear + 15m trend + 5m rally/breakdown"},{id:"SCOMB",name:"S Combined V2",description:"Regime-aware 多空共用單一持倉"}];results=variants.map(v=>simulateShortV71(f,m,h,v,mode,{tradeStartTs:coreStart,tradeEndTs:now,costBps,leverage:10}));}
 else{variants=[{id:"C0",name:"C Original",description:"既有波段基準"},{id:"CL2",name:"C-Long V2",description:"既有 4H/1H/15m 多頭"},{id:"CS2",name:"C-Short V2",description:"既有 4H/1H/15m 空頭"},{id:"COMB",name:"C Combined",description:"既有波段多空組合"}];const a=buildIndicators(raw.m15),b=buildIndicators(raw.h1),c=buildIndicators(raw.h4);results=variants.map(v=>aggregateVariantRuns(v,[simulateVariantV6(a,b,c,v,mode,{tradeStartTs:coreStart,tradeEndTs:now})],10));}
 const eligible=results.filter(x=>x.trades>=5);return{ok:true,symbol,version:"7.1",strategy,costBps,days,tradeMode:mode,leverage:10,sharedRules:strategy==="short"?{regime:"1H Bull/Bear/Chop; Chop=no trade",entry:"15m trend + 5m pullback/reclaim",stop:"1.35 ATR",tp1:"1R/35%",tp2:"1.8R/35%",runner:"30%/1.2 ATR",cooldown:"30m",dailyLossLimit:"-3R",threeLossPause:"6h",riskPerTradePct:.5}:{entry:"frozen swing engine",riskPerTradePct:.5},leaderboard:{bestByNetR:[...results].sort((a,b)=>b.netR-a.netR)[0]?.variant||null,bestByProfitFactor:[...eligible].sort((a,b)=>b.profitFactor-a.profitFactor)[0]?.variant||null,lowestDrawdown:[...results].filter(x=>x.trades>0).sort((a,b)=>a.maxDrawdownPct-b.maxDrawdownPct)[0]?.variant||null},results};
}
function compactPeriodResult(r){return {trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,netR:r.netR,endingEquity:r.endingEquity,maxDrawdownPct:r.maxDrawdownPct,long:r.long,short:r.short};}
function aggregateVariantRuns(v,runs,leverage=5){const all=runs.flatMap(r=>r.__trades||[]).sort((a,b)=>a.entryTs-b.entryTs),diag={};for(const r of runs)for(const[k,val]of Object.entries(r.diagnostics||{}))diag[k]=(diag[k]||0)+(Number(val)||0);return {variant:v.id,name:v.name,description:v.description,...summarizeTradeSequence(all,leverage),diagnostics:diag,periods:runs.map((r,i)=>({index:i+1,trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,netR:r.netR,maxDrawdownPct:r.maxDrawdownPct,long:r.long,short:r.short})),recentTrades:all.slice(-10).map(t=>({side:t.side,entryTs:t.entryTs,exitTs:t.exitTs,entry:t.entry,exit:t.exitPrice,r:t.r,risk:t.risk,forcedClose:!!t.forcedClose}))};}
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
async function ensureHistoryBundles(startTs,endTs,requestUrl,symbol="SOLUSDT"){const ids=chunkIdsForRange(startTs,endTs),cache=caches.default,missing=[];let ready=0;for(const id of ids){const h=await cache.match(historyChunkKey(id,requestUrl,symbol));if(h)ready++;else missing.push(id)}const take=missing.slice(0,BT_MAX_CHUNKS_PER_INVOCATION);for(const id of take){const a=id*BT_CHUNK_MS,b=Math.min((id+1)*BT_CHUNK_MS-1,Date.now()),bundle=await fetchHistoryBundle(a,b,symbol);const ttl=b>=Date.now()-BT_CHUNK_MS?300:2592000;await cache.put(historyChunkKey(id,requestUrl,symbol),new Response(JSON.stringify(bundle),{headers:{"content-type":"application/json","cache-control":`public, max-age=${ttl}`}}));ready++}return{complete:missing.length===0,totalChunks:ids.length,readyChunks:ready,fetchedThisRun:take.length,remainingChunks:Math.max(0,ids.length-ready),chunkDays:30};}
function chunkIdsForRange(a,b){const x=Math.floor(a/BT_CHUNK_MS),y=Math.floor(b/BT_CHUNK_MS),o=[];for(let i=x;i<=y;i++)o.push(i);return o;}
function historyChunkKey(id,requestUrl,symbol="SOLUSDT"){return new Request(new URL(`/__bt_v71_hist/${symbol}/${id}`,requestUrl).toString(),{method:"GET"});}
async function fetchHistoryBundle(a,b,symbol="SOLUSDT"){return{symbol,startTs:a,endTs:b,m5:await fetchBybitRange("5",a,b,symbol),m15:await fetchBybitRange("15",a,b,symbol),h1:await fetchBybitRange("60",a,b,symbol),h4:await fetchBybitRange("240",a,b,symbol),createdAt:new Date().toISOString()};}
async function fetchBybitRange(interval,startTs,endTs,symbol="SOLUSDT"){let out=[],cursorEnd=endTs,pages=0;const ms=interval==="5"?5*60e3:interval==="15"?15*60e3:interval==="60"?60*60e3:4*60*60e3,maxPages=Math.ceil(((endTs-startTs)/ms+2)/1000)+2;while(cursorEnd>=startTs&&pages<maxPages){const url=`${BASE}?category=linear&symbol=${symbol}&interval=${interval}&start=${Math.floor(startTs)}&end=${Math.floor(cursorEnd)}&limit=1000`,r=await fetchWithRetry(url,{label:`Bybit range ${interval}m`,retries:2}),j=await r.json(),list=j?.result?.list;if(j?.retCode!==0||!Array.isArray(list))throw new Error(`Bybit range ${interval} invalid: ${JSON.stringify(j).slice(0,160)}`);if(!list.length)break;const batch=list.map(x=>({ts:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5])})).filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close)&&Number.isFinite(x.volume)&&x.ts>=startTs&&x.ts<=endTs);if(!batch.length)break;out.push(...batch);const oldest=Math.min(...batch.map(x=>x.ts));if(oldest<=startTs||oldest>=cursorEnd)break;cursorEnd=oldest-1;pages++;if(list.length<1000)break;await sleep(80)}return[...new Map(out.map(x=>[x.ts,x])).values()].sort((a,b)=>a.ts-b.ts);}
async function loadHistoryRange(a,b,requestUrl,symbol="SOLUSDT"){const cache=caches.default,ids=chunkIdsForRange(a,b),m5=[],m15=[],h1=[],h4=[];for(const id of ids){const h=await cache.match(historyChunkKey(id,requestUrl,symbol));if(!h)throw new Error(`歷史快取缺少 chunk ${id}，請重新整理。`);const x=await h.json();m5.push(...(x.m5||[]));m15.push(...(x.m15||[]));h1.push(...(x.h1||[]));h4.push(...(x.h4||[]))}const clean=xs=>[...new Map(xs.filter(x=>x.ts>=a&&x.ts<=b).map(x=>[x.ts,x])).values()].sort((p,q)=>p.ts-q.ts);return{m5:clean(m5),m15:clean(m15),h1:clean(h1),h4:clean(h4)};}

function backtestPage(r){const by=Object.fromEntries((r.results||[]).map(x=>[x.variant,x])),ids=r.strategy==="short"?["SL1","SS1","SCOMB"]:["C0","CL2","CS2","COMB"];const keep=e=>{const q=new URLSearchParams({symbol:r.symbol,days:r.days,mode:r.tradeMode,strategy:r.strategy,costbps:r.costBps,...e});return`/backtest?${q}`};const btn=(a,k,lab=x=>x)=>a.map(x=>`<a class="${String(r[k])===String(x)?'on':''}" href="${keep({[k==='tradeMode'?'mode':k]:x})}">${lab(x)}</a>`).join('');const cards=ids.map(id=>{const x=by[id]||{},l=x.leverage||{};return`<section class="card"><h2>${x.name||id} <b class="${x.netR>=0?'p':'n'}">${x.netR>=0?'+':''}${Number(x.netR||0).toFixed(2)}R</b></h2><p>${x.description||''}</p><div class="g"><div>交易<b>${x.trades||0}</b></div><div>勝率<b>${Number(x.winRate||0).toFixed(1)}%</b></div><div>PF<b>${Number(x.profitFactor||0).toFixed(2)}</b></div><div>最大回撤<b>${Number(x.maxDrawdownPct||0).toFixed(2)}%</b></div><div>多單<b>${x.long?.trades||0} / ${Number(x.long?.netR||0).toFixed(2)}R</b></div><div>空單<b>${x.short?.trades||0} / ${Number(x.short?.netR||0).toFixed(2)}R</b></div><div>10x平均保證金<b>${Number(l.avgMarginPct||0).toFixed(1)}%</b></div><div>10x最高保證金<b>${Number(l.maxMarginPct||0).toFixed(1)}%</b></div></div></section>`}).join('');return`<!doctype html><html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0b0f17;color:#f5f7fb;font-family:system-ui;margin:auto;max-width:780px;padding:12px}.hero,.card,.note{background:#111a27;border:1px solid #263348;border-radius:18px;padding:15px;margin:10px 0}.btn{display:flex;gap:7px;flex-wrap:wrap}.btn a{color:#eee;text-decoration:none;border:1px solid #34435c;border-radius:9px;padding:7px}.btn a.on{background:#eee;color:#111}.g{display:grid;grid-template-columns:1fr 1fr;gap:7px}.g div{background:#0b1420;padding:9px;border-radius:10px;color:#91a0b5}.g b{display:block;color:#fff}.p{color:#58d99b;float:right}.n{color:#ff7e87;float:right}p{color:#91a0b5}</style><div class="hero"><small>V7.1 · ${r.symbol} · 固定 10x</small><h1>${r.strategy==='short'?'⚡ 短線 Regime + Reclaim':'🧭 波段（凍結）'}</h1><p>${r.days}天 · 成本 ${r.costBps}bps</p><b>模式</b><div class="btn">${btn(['swing','short'],'strategy',x=>x==='swing'?'🧭波段':'⚡短線')}</div><b>幣種</b><div class="btn">${btn(BACKTEST_SYMBOLS,'symbol',x=>x.replace('USDT',''))}</div><b>期間</b><div class="btn">${btn([7,14,30,90,180,365],'days',x=>x===365?'1年':x+'天')}</div><b>方向</b><div class="btn">${btn(['both','long','short'],'tradeMode',x=>x==='both'?'多＋空':x==='long'?'只多':'只空')}</div><b>成本</b><div class="btn">${btn([0,8,12,20],'costBps',x=>x+'bps')}</div></div><div class="note">${r.strategy==='short'?'1H Bull/Bear/Chop，Chop 不交易；15m 趨勢；5m 回踩後 reclaim。30m 冷卻、連敗3次暫停6h、單日 -3R 停止新單。':'波段策略保持原本 C 系列邏輯。'}</div>${cards}</html>`}
function backtestProgressPage(r){const p=r.progress||{},pct=p.totalChunks?Math.min(100,Math.round(p.readyChunks/p.totalChunks*100)):0;return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1"><title>準備回測資料</title></head><body style="margin:0;background:#0b0f17;color:#fff;font-family:system-ui;padding:22px"><div style="max-width:620px;margin:auto;background:#111a27;border:1px solid #263348;border-radius:18px;padding:20px"><div style="color:#91a0b5">${r.symbol||'SOLUSDT'} V7.1 歷史資料分批快取</div><h2>⏳ 準備 ${r.days} 天回測資料</h2><div style="font-size:32px;font-weight:800">${pct}%</div><div style="height:14px;background:#0b1420;border-radius:99px;overflow:hidden;margin:16px 0"><i style="display:block;height:100%;width:${pct}%;background:#dbe7f7"></i></div><p>${p.readyChunks||0} / ${p.totalChunks||0} 個 15 天區塊完成</p><p style="color:#91a0b5;line-height:1.6">本次新增 ${p.fetchedThisRun||0} 個，剩餘 ${p.remainingChunks||0} 個。頁面會自動繼續。</p></div></body></html>`;}

function backtestErrorPage(e){const m=String(e?.message||e||'Unknown error').replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));return `<!doctype html><html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#0b0f17;color:#fff;font-family:system-ui;padding:24px"><h2>⚠️ 回測失敗</h2><p>${m}</p><p><a style="color:#fff" href="/backtest?symbol=SOLUSDT&days=30&mode=both&leverage=10&strategy=short">重試 30 天</a></p></body></html>`}

function simulateShortV71(f,m,h,v,mode="both",o={}){let mi=0,hi=0,pos=null,lastExit=0,streak=0,pause=0,day="",dayR=0;const ts=[],diag={bull:0,bear:0,chop:0,longSignals:0,shortSignals:0};for(let i=220;i<f.length-1;i++){const b=f[i],p=f[i-1],p2=f[i-2];while(mi+1<m.length&&m[mi+1].ts<=b.ts)mi++;while(hi+1<h.length&&h[hi+1].ts<=b.ts)hi++;const M=m[mi],H=h[hi];if(!M||!H||![b.atr,b.rsi,b.ema20,b.ema50,M.ema20,M.ema50,M.adx,H.ema20,H.ema50,H.ema200,H.adx].every(Number.isFinite))continue;if(b.ts<o.tradeStartTs)continue;if(b.ts>o.tradeEndTs)break;const d=new Date(b.ts).toISOString().slice(0,10);if(d!==day){day=d;dayR=0}if(pos){const z=manageShortV71(pos,b);if(z.done){let r=z.r-((o.costBps||12)/10000)/(pos.risk/pos.entry);ts.push({...pos,exitTs:b.ts,exitPrice:z.p,r:+r.toFixed(3)});dayR+=r;if(r<-.02){streak++;if(streak>=3){pause=b.ts+6*3600e3;streak=0}}else if(r>.02)streak=0;lastExit=b.ts;pos=null}continue}if(dayR<=-3||b.ts<pause||b.ts<lastExit+30*60e3)continue;const bull=H.ema20>H.ema50&&H.ema50>H.ema200&&H.close>H.ema20&&H.adx>=20,bear=H.ema20<H.ema50&&H.ema50<H.ema200&&H.close<H.ema20&&H.adx>=20;if(bull)diag.bull++;else if(bear)diag.bear++;else{diag.chop++;continue}const tl=M.ema20>M.ema50&&M.close>M.ema20&&M.adx>=18,ss=M.ema20<M.ema50&&M.close<M.ema20&&M.adx>=18;const touchL=[p2,p,b].some(x=>x.low<=x.ema20||x.low<=x.ema50),touchS=[p2,p,b].some(x=>x.high>=x.ema20||x.high>=x.ema50);let L=bull&&tl&&touchL&&p.close<=p.ema20&&b.close>b.ema20&&b.close>p.high&&b.rsi>=50&&b.rsi<=68&&b.macdHist>p.macdHist,S=bear&&ss&&touchS&&p.close>=p.ema20&&b.close<p.ema20&&b.close<p.low&&b.rsi<=50&&b.rsi>=32&&b.macdHist<p.macdHist;if(v.id==="SL1")S=false;if(v.id==="SS1")L=false;if(mode==="long")S=false;if(mode==="short")L=false;if(L)diag.longSignals++;if(S)diag.shortSignals++;const side=L?"LONG":S?"SHORT":null;if(!side)continue;const entry=f[i+1].open,risk=b.atr*1.35;if(!(entry>0&&risk>0))continue;const margin=(.005/(risk/entry))/10*100;if(margin>100)continue;pos=makeShortV71(side,entry,risk,f[i+1].ts)}if(pos&&f.length){const q=f.at(-1),dir=pos.side==="LONG"?1:-1;let r=pos.real+pos.rem*((q.close-pos.entry)*dir/pos.risk)-((o.costBps||12)/10000)/(pos.risk/pos.entry);ts.push({...pos,exitTs:q.ts,exitPrice:q.close,r:+r.toFixed(3)})}return{variant:v.id,name:v.name,description:v.description,...summarizeTradeSequence(ts,10),diagnostics:diag,recentTrades:ts.slice(-10),__trades:ts}}
function makeShortV71(side,entry,risk,entryTs){const d=side==="LONG"?1:-1;return{side,entry,entryTs,risk,stop:entry-d*risk,tp1:entry+d*risk,tp2:entry+d*risk*1.8,rem:1,real:0,a:false,b:false,trail:null}}
function manageShortV71(p,x){const L=p.side==="LONG";if(L?x.low<=p.stop:x.high>=p.stop)return{done:true,r:p.real+p.rem*(p.stop===p.entry?0:-1),p:p.stop};if(!p.a&&(L?x.high>=p.tp1:x.low<=p.tp1)){p.a=true;p.real+=.35;p.rem-=.35;p.stop=p.entry}if(!p.b&&(L?x.high>=p.tp2:x.low<=p.tp2)){p.b=true;p.real+=.63;p.rem-=.35;p.trail=L?x.close-1.2*x.atr:x.close+1.2*x.atr}if(p.b){const n=L?x.close-1.2*x.atr:x.close+1.2*x.atr;p.trail=L?Math.max(p.trail,n):Math.min(p.trail,n);if(L?x.low<=p.trail:x.high>=p.trail){const rr=L?(p.trail-p.entry)/p.risk:(p.entry-p.trail)/p.risk;return{done:true,r:p.real+p.rem*rr,p:p.trail}}}return{done:false}}

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
