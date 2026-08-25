const SYMBOL="SOLUSDT", BASE="https://api.bybit.com/v5/market/kline";
const BACKTEST_SYMBOLS=["SOLUSDT","BTCUSDT","ETHUSDT","BNBUSDT"];
const BACKTEST_LEVERAGES=[1,2,3,5,10,20,30,50];
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
        const strategyRaw = String(u.searchParams.get("strategy") || "swing").toLowerCase();
        const strategy = ["swing","short"].includes(strategyRaw) ? strategyRaw : "swing";
        const leverageRaw = Math.round(Number(u.searchParams.get("leverage") || 5));
        const leverage = Math.min(Math.max(Number.isFinite(leverageRaw) ? leverageRaw : 5, 1), 50);
        const defaultCostBps = strategy === "short" ? 12 : 8;
        const costRaw = Number(u.searchParams.get("costBps") ?? defaultCostBps);
        const costBps = Math.min(Math.max(Number.isFinite(costRaw) ? costRaw : defaultCostBps, 0), 50);
        const cache = caches.default;
        const cacheKey = new Request(new URL(`/__backtest_v7_result?symbol=${symbol}&strategy=${strategy}&days=${days}&mode=${mode}&leverage=${leverage}&costBps=${costBps}`, req.url).toString(), {method:"GET"});
        const cached = await cache.match(cacheKey);
        if (cached) {
          const result = await cached.json();
          const output = {...result, cache:"HIT"};
          if (u.pathname === "/backtest/api") return J(output);
          return new Response(backtestPageV7(output), {headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
        }
        const result = await runBacktestV7({days, mode, symbol, strategy, leverage, costBps, requestUrl:req.url});
        if (result.pending) {
          if (u.pathname === "/backtest/api") return J(result, 202);
          return new Response(backtestProgressPageV7(result), {status:202,headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
        }
        await cache.put(cacheKey, new Response(JSON.stringify(result), {headers:{"content-type":"application/json","cache-control":"public, max-age=900"}}));
        const output = {...result, cache:"MISS"};
        if (u.pathname === "/backtest/api") return J(output);
        return new Response(backtestPageV7(output), {headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
      } catch (e) {
        if (u.pathname === "/backtest/api") return J({error:true,message:e?.message||String(e),time:new Date().toISOString()},500);
        return new Response(backtestErrorPageV7(e), {status:500,headers:{"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}});
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
const BT_MAX_CHUNKS_PER_INVOCATION = 2;
const BT_SWING_WARMUP_MS = 50*24*60*60*1000;
const BT_SHORT_WARMUP_MS = 12*24*60*60*1000;
const BT_SHORT_LOOKAHEAD_MS = 24*60*60*1000;

const V7_PROFILES = {
  swing: {
    id:"swing", label:"🧭 波段", trigger:"15m", context:"4H + 1H → 15m",
    warmupMs:BT_SWING_WARMUP_MS, stopAtr:1.5, tp1R:1.0, tp1Pct:0.30, tp2R:2.0, tp2Pct:0.30, trailAtr:1.5,
    cooldownLossesHours:6,
    variants:[
      {id:"C0",name:"C Original",description:"原始 C 基準組：1H 結構 + ADX + 15m 對稱觸發。"},
      {id:"CL2",name:"C-Long V2",description:"4H 多頭 regime + 1H 結構 + 15m 回踩突破。"},
      {id:"CS2",name:"C-Short V2",description:"4H 空頭 regime + 1H 結構 + 15m 反彈跌破。"},
      {id:"COMB",name:"C Combined",description:"Long V2 + Short V2 共用單一持倉與資金曲線。"}
    ]
  },
  short: {
    id:"short", label:"⚡ 短線", trigger:"5m", context:"1H + 15m → 5m",
    warmupMs:BT_SHORT_WARMUP_MS, stopAtr:1.2, tp1R:0.8, tp1Pct:0.35, tp2R:1.5, tp2Pct:0.35, trailAtr:1.0,
    cooldownLossesHours:3,
    variants:[
      {id:"S0",name:"S Original",description:"短線基準組：15m 方向 + 5m 動能突破。"},
      {id:"SL1",name:"S-Long",description:"1H 多頭 + 15m setup + 5m 回踩後突破。"},
      {id:"SS1",name:"S-Short",description:"1H 空頭 + 15m setup + 5m 反彈後跌破。"},
      {id:"SCOMB",name:"S Combined",description:"S-Long + S-Short 共用單一持倉與資金曲線。"}
    ]
  }
};

async function runBacktestV7({days=30, mode="both", symbol="SOLUSDT", strategy="swing", leverage=5, costBps=8, requestUrl}={}) {
  const profile=V7_PROFILES[strategy]||V7_PROFILES.swing;
  const now=Date.now(), coreStart=now-days*86400e3, dataStart=coreStart-profile.warmupMs;
  const prep=await ensureHistoryBundlesV7(dataStart,now,requestUrl,symbol,strategy);
  if(!prep.complete) return {pending:true,version:"7.0",symbol,strategy,leverage,costBps,days,tradeMode:mode,progress:prep,message:"歷史 K 線正在分批下載並快取。頁面會自動繼續。"};

  const per=Object.fromEntries(profile.variants.map(v=>[v.id,[]]));
  const windowReports=[];
  if(strategy==="swing"){
    const raw=await loadHistoryRangeV7(dataStart,now,requestUrl,symbol,strategy);
    const data={m15:buildIndicators(raw.m15),h1:buildIndicators(raw.h1),h4:buildIndicators(raw.h4)};
    const pr={};
    for(const v of profile.variants){
      const r=simulateV7(data,v,profile,mode,{entryStartTs:coreStart,entryEndTs:now,manageEndTs:now,leverage,costBps});
      per[v.id].push(r); pr[v.id]=compactPeriodResultV7(r);
    }
    windowReports.push({index:1,start:new Date(coreStart).toISOString(),end:new Date(now).toISOString(),results:pr});
  } else {
    // 60-day windows keep 5m memory bounded. A 1-day look-ahead lets positions opened near a boundary exit naturally.
    const windowMs=60*86400e3;
    let wi=0;
    for(let start=coreStart;start<now;start+=windowMs){
      const end=Math.min(now,start+windowMs), manageEnd=Math.min(now,end+BT_SHORT_LOOKAHEAD_MS);
      const raw=await loadHistoryRangeV7(start-profile.warmupMs,manageEnd,requestUrl,symbol,strategy);
      const data={m5:buildIndicators(raw.m5),m15:buildIndicators(raw.m15),h1:buildIndicators(raw.h1)};
      const pr={};
      for(const v of profile.variants){
        const r=simulateV7(data,v,profile,mode,{entryStartTs:start,entryEndTs:end,manageEndTs:manageEnd,leverage,costBps});
        per[v.id].push(r); pr[v.id]=compactPeriodResultV7(r);
      }
      windowReports.push({index:++wi,start:new Date(start).toISOString(),end:new Date(end).toISOString(),results:pr});
    }
  }

  const results=profile.variants.map(v=>aggregateVariantRunsV7(v,per[v.id],leverage,costBps));
  const eligible=results.filter(x=>x.trades>=10);
  const bestNet=[...results].sort((a,b)=>b.netR-a.netR)[0]||null;
  const bestPF=[...eligible].sort((a,b)=>b.profitFactor-a.profitFactor)[0]||null;
  const bestDD=[...results].filter(x=>x.trades>0).sort((a,b)=>a.maxDrawdownPct-b.maxDrawdownPct)[0]||null;
  return {
    ok:true,version:"7.0",symbol,market:"USDT perpetual / linear",source:`Bybit ${symbol} linear · 15-day cached bundles`,
    strategy, strategyLabel:profile.label, context:profile.context, days, tradeMode:mode, leverage, costBps,
    windows:windowReports,
    sharedRules:{
      entry:"signal candle closes; enter next trigger candle open",
      stop:`${profile.stopAtr} ATR`,tp1:`${profile.tp1R}R / ${Math.round(profile.tp1Pct*100)}%`,tp2:`${profile.tp2R}R / ${Math.round(profile.tp2Pct*100)}%`,
      runner:`${Math.round((1-profile.tp1Pct-profile.tp2Pct)*100)}% with ${profile.trailAtr} ATR trailing`,riskPerTradePct:0.5,
      leverageModel:"fixed 0.5% account risk; insufficient-margin trades are skipped",
      costModel:`estimated round-trip trading cost ${costBps} bps deducted from each trade`,
      sameBarConflict:"stop first (conservative)",maxBacktestDays:365,
      shortWindowMethod:strategy==="short"?"60-day windows + warm-up + 1-day exit look-ahead":"single continuous window"
    },
    leaderboard:{bestByNetR:bestNet?.variant||null,bestByProfitFactor:bestPF?.variant||null,lowestDrawdown:bestDD?.variant||null},
    results
  };
}

function compactPeriodResultV7(r){return{trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,netR:r.netR,endingEquity:r.endingEquity,maxDrawdownPct:r.maxDrawdownPct,long:r.long,short:r.short};}
function aggregateVariantRunsV7(v,runs,leverage,costBps){
  const all=runs.flatMap(r=>r.__trades||[]).sort((a,b)=>a.entryTs-b.entryTs),diag={};
  for(const r of runs)for(const[k,val]of Object.entries(r.diagnostics||{}))diag[k]=(diag[k]||0)+(Number(val)||0);
  return{variant:v.id,name:v.name,description:v.description,...summarizeTradesV7(all,leverage,costBps),diagnostics:diag,recentTrades:all.slice(-10).map(t=>({side:t.side,entryTs:t.entryTs,exitTs:t.exitTs,entry:t.entry,exit:t.exitPrice,r:t.r,marginPct:t.marginPct,forcedClose:!!t.forcedClose}))};
}
function summarizeTradesV7(trades,leverage,costBps){
  let equity=100,peak=100,maxDD=0,wins=0,losses=0,breakeven=0,gw=0,gl=0,maxLS=0,ls=0,marginSum=0,maxMargin=0,maxNotional=0;
  const sideBuckets={LONG:[],SHORT:[]};
  for(const t of trades){
    const r=Number(t.r)||0; equity*=1+0.005*r; peak=Math.max(peak,equity); maxDD=Math.max(maxDD,(peak-equity)/peak*100);
    if(r>0.02){wins++;gw+=r;ls=0}else if(r<-0.02){losses++;gl+=-r;ls++;maxLS=Math.max(maxLS,ls)}else{breakeven++;ls=0}
    marginSum+=Number(t.marginPct)||0; maxMargin=Math.max(maxMargin,Number(t.marginPct)||0); maxNotional=Math.max(maxNotional,Number(t.notionalPct)||0);
    if(sideBuckets[t.side])sideBuckets[t.side].push(t);
  }
  const ss=xs=>{const w=xs.filter(t=>t.r>0.02),l=xs.filter(t=>t.r<-0.02),a=w.reduce((q,t)=>q+t.r,0),b=l.reduce((q,t)=>q+(-t.r),0);return{trades:xs.length,wins:w.length,losses:l.length,winRate:xs.length?+(w.length/xs.length*100).toFixed(2):0,profitFactor:+(b>0?a/b:(a>0?999:0)).toFixed(2),netR:+xs.reduce((q,t)=>q+t.r,0).toFixed(2)}};
  return{trades:trades.length,wins,losses,breakeven,winRate:trades.length?+(wins/trades.length*100).toFixed(2):0,profitFactor:+(gl>0?gw/gl:(gw>0?999:0)).toFixed(2),netR:+trades.reduce((q,t)=>q+(Number(t.r)||0),0).toFixed(2),endingEquity:+equity.toFixed(2),maxDrawdownPct:+maxDD.toFixed(2),maxLossStreak:maxLS,long:ss(sideBuckets.LONG),short:ss(sideBuckets.SHORT),leverage:{selected:leverage,avgMarginPct:trades.length?+(marginSum/trades.length).toFixed(2):0,maxMarginPct:+maxMargin.toFixed(2),maxNotionalPct:+maxNotional.toFixed(2),note:"固定每筆帳戶風險 0.5%；若所選槓桿需要超過 100% 保證金，該訊號不進場。未模擬交易所精確維持保證金/強平價與 funding。"},costs:{roundTripBps:costBps,note:"為手續費+滑價的估算值，可在網址 costBps 調整。"}};
}

async function ensureHistoryBundlesV7(startTs,endTs,requestUrl,symbol,strategy){
  const ids=chunkIdsForRangeV7(startTs,endTs),cache=caches.default,missing=[];let ready=0;
  for(const id of ids){const h=await cache.match(historyChunkKeyV7(id,requestUrl,symbol,strategy));if(h)ready++;else missing.push(id)}
  const take=missing.slice(0,BT_MAX_CHUNKS_PER_INVOCATION);
  for(const id of take){const a=id*BT_CHUNK_MS,b=Math.min((id+1)*BT_CHUNK_MS-1,Date.now()),bundle=await fetchHistoryBundleV7(a,b,symbol,strategy),ttl=b>=Date.now()-BT_CHUNK_MS?300:2592000;await cache.put(historyChunkKeyV7(id,requestUrl,symbol,strategy),new Response(JSON.stringify(bundle),{headers:{"content-type":"application/json","cache-control":`public, max-age=${ttl}`}}));ready++}
  return{complete:missing.length===0,totalChunks:ids.length,readyChunks:ready,fetchedThisRun:take.length,remainingChunks:Math.max(0,ids.length-ready),chunkDays:15};
}
function chunkIdsForRangeV7(a,b){const x=Math.floor(a/BT_CHUNK_MS),y=Math.floor(b/BT_CHUNK_MS),o=[];for(let i=x;i<=y;i++)o.push(i);return o;}
function historyChunkKeyV7(id,requestUrl,symbol,strategy){return new Request(new URL(`/__bt_v7_hist/${strategy}/${symbol}/${id}`,requestUrl).toString(),{method:"GET"});}
async function fetchHistoryBundleV7(a,b,symbol,strategy){
  if(strategy==="short") return{symbol,strategy,startTs:a,endTs:b,m5:await fetchBybitRangeV7("5",a,b,symbol),m15:await fetchBybitRangeV7("15",a,b,symbol),h1:await fetchBybitRangeV7("60",a,b,symbol),createdAt:new Date().toISOString()};
  return{symbol,strategy,startTs:a,endTs:b,m15:await fetchBybitRangeV7("15",a,b,symbol),h1:await fetchBybitRangeV7("60",a,b,symbol),h4:await fetchBybitRangeV7("240",a,b,symbol),createdAt:new Date().toISOString()};
}
async function fetchBybitRangeV7(interval,startTs,endTs,symbol){
  let out=[],cursorEnd=endTs,pages=0; const mins=Number(interval),ms=mins*60e3,maxPages=Math.ceil(((endTs-startTs)/ms+2)/1000)+2;
  while(cursorEnd>=startTs&&pages<maxPages){
    const url=`${BASE}?category=linear&symbol=${symbol}&interval=${interval}&start=${Math.floor(startTs)}&end=${Math.floor(cursorEnd)}&limit=1000`;
    const r=await fetchWithRetryV7(url,{label:`Bybit ${symbol} ${interval}m`,retries:2}),j=await r.json(),list=j?.result?.list;
    if(j?.retCode!==0||!Array.isArray(list))throw new Error(`Bybit ${symbol} ${interval} invalid: ${JSON.stringify(j).slice(0,160)}`);
    if(!list.length)break;
    const batch=list.map(x=>({ts:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5])})).filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close)&&Number.isFinite(x.volume)&&x.ts>=startTs&&x.ts<=endTs);
    if(!batch.length)break; out.push(...batch); const oldest=Math.min(...batch.map(x=>x.ts)); if(oldest<=startTs||oldest>=cursorEnd)break; cursorEnd=oldest-1; pages++; if(list.length<1000)break; await sleepV7(70);
  }
  return[...new Map(out.map(x=>[x.ts,x])).values()].sort((a,b)=>a.ts-b.ts);
}
async function loadHistoryRangeV7(a,b,requestUrl,symbol,strategy){
  const cache=caches.default,ids=chunkIdsForRangeV7(a,b),out={m5:[],m15:[],h1:[],h4:[]};
  for(const id of ids){const h=await cache.match(historyChunkKeyV7(id,requestUrl,symbol,strategy));if(!h)throw new Error(`歷史快取缺少 chunk ${id}，請重新整理。`);const x=await h.json();for(const k of Object.keys(out))out[k].push(...(x[k]||[]));}
  const clean=xs=>[...new Map(xs.filter(x=>x.ts>=a&&x.ts<=b).map(x=>[x.ts,x])).values()].sort((p,q)=>p.ts-q.ts);
  for(const k of Object.keys(out))out[k]=clean(out[k]); return out;
}

function simulateV7(data,variant,profile,mode,{entryStartTs=-Infinity,entryEndTs=Infinity,manageEndTs=Infinity,leverage=5,costBps=8}={}){
  const trigger=profile.id==="short"?data.m5:data.m15;
  const contextA=profile.id==="short"?data.m15:data.h1;
  const contextB=profile.id==="short"?data.h1:data.h4;
  let ai=0,bi=0,pos=null,cooldownUntil=0,lossPauseUntil=0,lossStreak=0,maxLossStreak=0; const trades=[];
  const diag={barsScanned:0,readyTrigger:0,readyContextA:0,readyContextB:0,finalLongSignals:0,finalShortSignals:0,blockedByCooldown:0,blockedByMargin:0};
  for(let i=220;i<trigger.length-1;i++){
    const b=trigger[i],prev=trigger[i-1]; if(b.ts>manageEndTs)break; diag.barsScanned++;
    while(ai+1<contextA.length&&contextA[ai+1].ts<=b.ts)ai++; while(bi+1<contextB.length&&contextB[bi+1].ts<=b.ts)bi++;
    const a=contextA[ai],c=contextB[bi];
    if(!Number.isFinite(b.atr)||!Number.isFinite(b.rsi)||!Number.isFinite(b.ema50)||!Number.isFinite(b.macdHist))continue; diag.readyTrigger++;
    if(!a||!Number.isFinite(a.ema200)||!Number.isFinite(a.adx))continue; diag.readyContextA++;
    if(!c||!Number.isFinite(c.ema200)||!Number.isFinite(c.adx))continue; diag.readyContextB++;

    if(pos){
      const outcome=managePositionV7(pos,b,profile);
      if(outcome.done){const rawR=outcome.totalR,netR=applyCostR(rawR,pos.entry,pos.risk,costBps); trades.push({...pos,exitTs:b.ts,exitPrice:outcome.exitPrice,r:+netR.toFixed(3),rawR:+rawR.toFixed(3)}); if(netR<-0.02){lossStreak++;maxLossStreak=Math.max(maxLossStreak,lossStreak);if(lossStreak>=3){lossPauseUntil=b.ts+profile.cooldownLossesHours*3600e3;lossStreak=0}}else lossStreak=0; pos=null;}
      continue;
    }
    if(b.ts<entryStartTs||b.ts>entryEndTs)continue;
    const movePct=(b.high-b.low)/b.open*100;
    if(profile.id==="short"){if((b.high-b.low)>b.atr*3||movePct>2.5)cooldownUntil=Math.max(cooldownUntil,b.ts+(movePct>5?2*3600e3:30*60e3));}
    else if((b.high-b.low)>b.atr*3||movePct>4)cooldownUntil=Math.max(cooldownUntil,b.ts+(movePct>7?4*3600e3:3600e3));
    if(b.ts<cooldownUntil||b.ts<lossPauseUntil){diag.blockedByCooldown++;continue;}

    const sig=profile.id==="short"?shortSignalsV7(trigger,i,a,c,variant.id):swingSignalsV7(trigger,i,a,c,variant.id);
    let longSignal=sig.long,shortSignal=sig.short; if(mode==="long")shortSignal=false;if(mode==="short")longSignal=false;
    if(longSignal)diag.finalLongSignals++;if(shortSignal)diag.finalShortSignals++;
    const side=longSignal?"LONG":shortSignal?"SHORT":null;if(!side)continue;
    const next=trigger[i+1],entry=next.open,risk=b.atr*profile.stopAtr;if(!(entry>0&&risk>0))continue;
    const stopPct=risk/entry,notionalPct=0.005/stopPct*100,marginPct=notionalPct/leverage;
    if(marginPct>100){diag.blockedByMargin++;continue;}
    pos=makePositionV7(side,entry,risk,next.ts,profile,marginPct,notionalPct);
  }
  if(pos&&trigger.length){let last=trigger[trigger.length-1];for(let z=trigger.length-1;z>=0;z--)if(trigger[z].ts<=manageEndTs){last=trigger[z];break;}const dir=pos.side==="LONG"?1:-1,rawR=pos.realizedR+pos.remaining*((last.close-pos.entry)*dir/pos.risk),netR=applyCostR(rawR,pos.entry,pos.risk,costBps);trades.push({...pos,exitTs:last.ts,exitPrice:last.close,r:+netR.toFixed(3),rawR:+rawR.toFixed(3),forcedClose:true});}
  const s=summarizeTradesV7(trades,leverage,costBps);return{variant:variant.id,name:variant.name,description:variant.description,...s,maxLossStreak:Math.max(s.maxLossStreak,maxLossStreak),diagnostics:diag,__trades:trades};
}

function swingSignalsV7(tf,i,h1,h4,id){
  const b=tf[i],prev=tf[i-1],recent=tf.slice(Math.max(0,i-6),i+1),volOK=Number.isFinite(b.volMA20)&&b.volume>b.volMA20*1.1,macdL=b.macdHist>0&&b.macdHist>prev.macdHist,macdS=b.macdHist<0&&b.macdHist<prev.macdHist,brL=b.close>prev.high,brS=b.close<prev.low;
  const oneBull=h1.ema20>h1.ema50&&h1.ema50>h1.ema200&&h1.close>h1.ema200,oneBear=h1.ema20<h1.ema50&&h1.ema50<h1.ema200&&h1.close<h1.ema200;
  const fourBull=h4.ema20>h4.ema50&&h4.close>h4.ema200,fourBear=h4.ema20<h4.ema50&&h4.close<h4.ema200;
  const lowEMA=recent.some(x=>Number.isFinite(x.ema20)&&x.low<=x.ema20),highEMA=recent.some(x=>Number.isFinite(x.ema20)&&x.high>=x.ema20);
  let long=false,short=false;
  if(id==="C0"){long=oneBull&&h1.adx>=25&&b.low<=b.ema20&&b.close>=b.ema50&&brL&&b.rsi>=50&&(macdL||volOK);short=oneBear&&h1.adx>=25&&b.high>=b.ema20&&b.close<=b.ema50&&brS&&b.rsi<=50&&(macdS||volOK);}
  if(id==="CL2"||id==="COMB")long=fourBull&&oneBull&&h1.adx>=22&&lowEMA&&b.close>b.ema20&&b.ema20>b.ema50&&brL&&b.rsi>=52&&b.rsi<=70&&(macdL||volOK);
  if(id==="CS2"||id==="COMB")short=fourBear&&oneBear&&h1.adx>=25&&highEMA&&b.close<b.ema20&&b.ema20<b.ema50&&brS&&b.rsi<=48&&b.rsi>=30&&(macdS||volOK);
  return{long,short};
}
function shortSignalsV7(tf,i,m15,h1,id){
  const b=tf[i],prev=tf[i-1],recent=tf.slice(Math.max(0,i-8),i+1),volOK=Number.isFinite(b.volMA20)&&b.volume>b.volMA20*1.15,macdL=b.macdHist>0&&b.macdHist>prev.macdHist,macdS=b.macdHist<0&&b.macdHist<prev.macdHist,brL=b.close>prev.high,brS=b.close<prev.low;
  const hBull=h1.ema20>h1.ema50&&h1.close>h1.ema200&&h1.adx>=18,hBear=h1.ema20<h1.ema50&&h1.close<h1.ema200&&h1.adx>=18;
  const setupBull=m15.ema20>m15.ema50&&m15.close>m15.ema20&&m15.rsi>=48&&m15.rsi<=70,setupBear=m15.ema20<m15.ema50&&m15.close<m15.ema20&&m15.rsi<=52&&m15.rsi>=30;
  const lowEMA=recent.some(x=>Number.isFinite(x.ema20)&&x.low<=x.ema20),highEMA=recent.some(x=>Number.isFinite(x.ema20)&&x.high>=x.ema20);
  const longCore=lowEMA&&b.close>b.ema20&&b.ema20>b.ema50&&brL&&b.rsi>=52&&b.rsi<=72&&(macdL||volOK);
  const shortCore=highEMA&&b.close<b.ema20&&b.ema20<b.ema50&&brS&&b.rsi<=48&&b.rsi>=28&&(macdS||volOK);
  let long=false,short=false;
  if(id==="S0"){long=setupBull&&brL&&b.rsi>=50&&(macdL||volOK);short=setupBear&&brS&&b.rsi<=50&&(macdS||volOK);}
  if(id==="SL1"||id==="SCOMB")long=hBull&&setupBull&&longCore;
  if(id==="SS1"||id==="SCOMB")short=hBear&&setupBear&&shortCore;
  return{long,short};
}
function makePositionV7(side,entry,risk,entryTs,p,marginPct,notionalPct){const dir=side==="LONG"?1:-1;return{side,entry,entryTs,risk,stop:entry-dir*risk,tp1:entry+dir*risk*p.tp1R,tp2:entry+dir*risk*p.tp2R,remaining:1,realizedR:0,movedBE:false,tp1Hit:false,tp2Hit:false,trail:null,marginPct:+marginPct.toFixed(2),notionalPct:+notionalPct.toFixed(2)}}
function managePositionV7(p,b,cfg){
  const long=p.side==="LONG",hitStop=long?b.low<=p.stop:b.high>=p.stop;if(hitStop){const stopR=p.movedBE?0:-1;return{done:true,totalR:p.realizedR+p.remaining*stopR,exitPrice:p.stop}}
  if(!p.tp1Hit&&(long?b.high>=p.tp1:b.low<=p.tp1)){p.tp1Hit=true;p.realizedR+=cfg.tp1Pct*cfg.tp1R;p.remaining-=cfg.tp1Pct;p.stop=p.entry;p.movedBE=true;}
  if(!p.tp2Hit&&(long?b.high>=p.tp2:b.low<=p.tp2)){p.tp2Hit=true;p.realizedR+=cfg.tp2Pct*cfg.tp2R;p.remaining-=cfg.tp2Pct;p.trail=long?b.close-cfg.trailAtr*b.atr:b.close+cfg.trailAtr*b.atr;}
  if(p.tp2Hit){const nt=long?b.close-cfg.trailAtr*b.atr:b.close+cfg.trailAtr*b.atr;p.trail=p.trail==null?nt:(long?Math.max(p.trail,nt):Math.min(p.trail,nt));if(long?b.low<=p.trail:b.high>=p.trail){const rr=long?(p.trail-p.entry)/p.risk:(p.entry-p.trail)/p.risk;return{done:true,totalR:p.realizedR+p.remaining*rr,exitPrice:p.trail}}}
  return{done:false};
}
function applyCostR(rawR,entry,risk,costBps){const stopPct=risk/entry;if(!(stopPct>0))return rawR;return rawR-(costBps/10000)/stopPct;}

function backtestPageV7(r){
  const esc=x=>String(x??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const by=Object.fromEntries((r.results||[]).map(x=>[x.variant,x])),profile=V7_PROFILES[r.strategy]||V7_PROFILES.swing,names=Object.fromEntries(profile.variants.map(v=>[v.id,v.name]));
  const keep=(extra={})=>{const q=new URLSearchParams({symbol:r.symbol||"SOLUSDT",strategy:r.strategy||"swing",days:String(r.days||30),mode:r.tradeMode||"both",leverage:String(r.leverage||5),costBps:String(r.costBps??8),...extra});return`/backtest?${q}`};
  const cards=profile.variants.map(v=>{const x=by[v.id]||{},lv=x.leverage||{};return`<article class="card"><div class="cardtop"><div><span class="tag">${v.id}</span><h2>${esc(v.name)}</h2></div><div class="net ${Number(x.netR)>=0?'pos':'neg'}">${Number(x.netR)>=0?'+':''}${Number(x.netR||0).toFixed(2)}R</div></div><div class="desc">${esc(v.description)}</div><div class="stats"><div><small>交易次數</small><b>${x.trades??0}</b></div><div><small>勝率</small><b>${Number(x.winRate||0).toFixed(1)}%</b></div><div><small>Profit Factor</small><b>${Number(x.profitFactor||0).toFixed(2)}</b></div><div><small>最大回撤</small><b>${Number(x.maxDrawdownPct||0).toFixed(2)}%</b></div><div><small>最大連敗</small><b>${x.maxLossStreak??0}</b></div><div><small>100U →</small><b>${Number(x.endingEquity||100).toFixed(2)}U</b></div><div><small>🟢 多單</small><b>${x.long?.trades??0}筆 · ${Number(x.long?.netR||0)>=0?'+':''}${Number(x.long?.netR||0).toFixed(2)}R</b></div><div><small>🔴 空單</small><b>${x.short?.trades??0}筆 · ${Number(x.short?.netR||0)>=0?'+':''}${Number(x.short?.netR||0).toFixed(2)}R</b></div><div><small>${r.leverage}x 平均保證金</small><b>${Number(lv.avgMarginPct||0).toFixed(1)}%</b></div><div><small>${r.leverage}x 最高保證金</small><b>${Number(lv.maxMarginPct||0).toFixed(1)}%</b></div></div><details><summary>最近交易</summary><div class="trades">${(x.recentTrades||[]).slice().reverse().map(t=>`<div><span>${t.side==='LONG'?'🟢 多':'🔴 空'}</span><span>${Number(t.r)>=0?'+':''}${Number(t.r).toFixed(2)}R · ${Number(t.marginPct||0).toFixed(0)}%保證金</span></div>`).join('')||'沒有交易'}</div></details></article>`}).join('');
  const lb=r.leaderboard||{},leader=id=>id?`${id} · ${names[id]||id}`:'樣本不足';
  const buttons=(arr,key,fmt=x=>x)=>arr.map(v=>`<a class="${String(r[key])===String(v)?'on':''}" href="${keep({[key]:String(v)})}">${fmt(v)}</a>`).join('');
  const coins=BACKTEST_SYMBOLS.map(s=>`<a class="${r.symbol===s?'on':''}" href="${keep({symbol:s})}">${s.replace('USDT','')}</a>`).join('');
  const strategyBtns=[["swing","🧭 波段"],["short","⚡ 短線"]].map(([s,l])=>`<a class="${r.strategy===s?'on':''}" href="${keep({strategy:s,costBps:s==='short'?'12':'8'})}">${l}</a>`).join('');
  const daysBtns=[7,14,30,90,180,365].map(d=>`<a class="${Number(r.days)===d?'on':''}" href="${keep({days:String(d)})}">${d===365?'1年':d+'天'}</a>`).join('');
  const modes=[["both","多＋空"],["long","只做多"],["short","只做空"]].map(([m,l])=>`<a class="${r.tradeMode===m?'on':''}" href="${keep({mode:m})}">${l}</a>`).join('');
  const levs=BACKTEST_LEVERAGES.map(v=>`<a class="${Number(r.leverage)===v?'on':''}" href="${keep({leverage:String(v)})}">${v}x</a>`).join('');
  const costs=[0,8,12,20].map(v=>`<a class="${Number(r.costBps)===v?'on':''}" href="${keep({costBps:String(v)})}">${v}bps</a>`).join('');
  return`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${r.symbol} V7</title><style>*{box-sizing:border-box}body{margin:0;background:#0b0f17;color:#f5f7fb;font-family:system-ui}.w{max-width:820px;margin:auto;padding:14px 10px 36px}.hero,.leader,.card,.note{background:#111a27;border:1px solid #263348;border-radius:18px;padding:16px;margin-top:10px}.ey,.desc,.foot,small,.label{color:#91a0b5}.hero h1{margin:7px 0}.label{font-size:12px;margin-top:12px}.btns{display:flex;gap:7px;flex-wrap:wrap;margin-top:7px}.btns a{color:#eaf0f8;text-decoration:none;border:1px solid #2b3950;border-radius:10px;padding:8px 11px}.btns a.on{background:#f5f7fb;color:#111827}.leader div{display:flex;justify-content:space-between;padding:5px 0}.cardtop{display:flex;justify-content:space-between;gap:10px}.tag{border:1px solid #34435c;border-radius:8px;padding:3px 7px}.card h2{font-size:17px;margin:8px 0}.net{font-size:25px;font-weight:800}.pos{color:#58d99b}.neg{color:#ff7e87}.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}.stats div,.trades{background:#0b1420;border:1px solid #223048;border-radius:12px;padding:10px}.stats small{display:block}.trades div{display:flex;justify-content:space-between;padding:5px}.card details{margin-top:10px}.note{font-size:13px;line-height:1.6}.foot{font-size:12px;line-height:1.6;margin:14px 4px}.foot a{color:#dbe7f7}@media(min-width:700px){.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card{margin-top:0}}</style></head><body><main class="w"><section class="hero"><div class="ey">${r.symbol} · V7 MULTI-STRATEGY ENGINE</div><h1>${profile.label} 回測</h1><div class="desc">${r.context} · ${r.days}天 · ${r.tradeMode} · ${r.leverage}x · 成本 ${r.costBps}bps</div><div class="label">策略模式</div><div class="btns">${strategyBtns}</div><div class="label">幣種</div><div class="btns">${coins}</div><div class="label">期間</div><div class="btns">${daysBtns}</div><div class="label">方向</div><div class="btns">${modes}</div><div class="label">槓桿</div><div class="btns">${levs}</div><div class="label">估算來回成本（手續費＋滑價）</div><div class="btns">${costs}</div></section><section class="note">⚙️ 固定每筆帳戶風險 <b>0.5%</b>。槓桿影響保證金需求，不直接把 R 倍數乘上槓桿；若某訊號在該槓桿下需要超過 100% 保證金，V7 會跳過該筆。成本以每筆完整來回 ${r.costBps} bps 扣除。未模擬 funding 與交易所精確強平公式。</section><section class="leader"><div><span>🏆 淨 R 最高</span><b>${leader(lb.bestByNetR)}</b></div><div><span>⚡ PF 最高</span><b>${leader(lb.bestByProfitFactor)}</b></div><div><span>🛡️ 回撤最低</span><b>${leader(lb.lowestDrawdown)}</b></div></section><section class="cards">${cards}</section><div class="foot"><b>${esc(r.sharedRules?.stop||'')}</b> · TP1 ${esc(r.sharedRules?.tp1||'')} · TP2 ${esc(r.sharedRules?.tp2||'')} · Runner ${esc(r.sharedRules?.runner||'')}<br><a href="/backtest/api?symbol=${r.symbol}&strategy=${r.strategy}&days=${r.days}&mode=${r.tradeMode}&leverage=${r.leverage}&costBps=${r.costBps}">JSON API</a> · <a href="/">SOL 即時 Dashboard</a></div></main></body></html>`;
}
function backtestProgressPageV7(r){const p=r.progress||{},pct=p.totalChunks?Math.min(100,Math.round(p.readyChunks/p.totalChunks*100)):0;return`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1"><title>準備 V7 回測資料</title></head><body style="margin:0;background:#0b0f17;color:#fff;font-family:system-ui;padding:22px"><div style="max-width:620px;margin:auto;background:#111a27;border:1px solid #263348;border-radius:18px;padding:20px"><div style="color:#91a0b5">${r.symbol} · V7 · ${r.strategy==='short'?'⚡短線':'🧭波段'}</div><h2>⏳ 準備 ${r.days} 天資料</h2><div style="font-size:32px;font-weight:800">${pct}%</div><div style="height:14px;background:#0b1420;border-radius:99px;overflow:hidden;margin:16px 0"><i style="display:block;height:100%;width:${pct}%;background:#dbe7f7"></i></div><p>${p.readyChunks||0} / ${p.totalChunks||0} 個 15 天區塊完成</p><p style="color:#91a0b5">每次只抓少量區塊，避免撞 Cloudflare subrequest 上限。頁面會自動繼續。</p></div></body></html>`;}
function backtestErrorPageV7(e){const m=String(e?.message||e||'Unknown error').replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));return`<!doctype html><html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#0b0f17;color:#fff;font-family:system-ui;padding:24px"><h2>⚠️ V7 回測失敗</h2><p>${m}</p><p><a style="color:#fff" href="/backtest?symbol=SOLUSDT&strategy=swing&days=30&mode=both&leverage=5">重試 30 天</a></p></body></html>`;}

async function fetchWithRetryV7(url,{label="request",retries=2}={}){let last=null;for(let a=0;a<=retries;a++){try{const r=await fetch(url,{headers:{"accept":"application/json","user-agent":"Mozilla/5.0 V7-Backtest/1.0"}});if(r.ok)return r;last=new Error(`${label} HTTP ${r.status}`);if(!(r.status===429||r.status>=500)||a>=retries)break;const ra=Number(r.headers.get("retry-after")),ms=Number.isFinite(ra)&&ra>0?ra*1000:Math.min(700*(2**a),3000);await sleepV7(ms)}catch(e){last=e;if(a>=retries)break;await sleepV7(Math.min(700*(2**a),3000))}}throw last||new Error(`${label} failed`)}
function sleepV7(ms){return new Promise(r=>setTimeout(r,ms));}

function buildIndicators(rows){const c=rows.map(x=>x.close),h=rows.map(x=>x.high),l=rows.map(x=>x.low),v=rows.map(x=>x.volume),e20=emaSeries(c,20),e50=emaSeries(c,50),e200=emaSeries(c,200),r=rsiSeries(c,14),atr=atrSeries(h,l,c,14),adx=adxSeries(h,l,c,14),fast=emaSeries(c,12),slow=emaSeries(c,26),macd=c.map((_,i)=>Number.isFinite(fast[i])&&Number.isFinite(slow[i])?fast[i]-slow[i]:NaN),signal=emaSeries(macd.map(x=>Number.isFinite(x)?x:0),9),volMA=smaSeries(v,20);return rows.map((x,i)=>({...x,ema20:e20[i],ema50:e50[i],ema200:e200[i],rsi:r[i],atr:atr[i],adx:adx[i],macdHist:Number.isFinite(macd[i])&&Number.isFinite(signal[i])?macd[i]-signal[i]:NaN,volMA20:volMA[i]}))}
function smaSeries(v,p){const o=Array(v.length).fill(NaN);let s=0;for(let i=0;i<v.length;i++){s+=v[i];if(i>=p)s-=v[i-p];if(i>=p-1)o[i]=s/p}return o}
function emaSeries(v,p){const o=Array(v.length).fill(NaN);if(v.length<p)return o;let seed=0;for(let i=0;i<p;i++)seed+=v[i];let x=seed/p;o[p-1]=x;const k=2/(p+1);for(let i=p;i<v.length;i++){x=v[i]*k+x*(1-k);o[i]=x}return o}
function rsiSeries(v,p=14){const o=Array(v.length).fill(NaN);if(v.length<=p)return o;let g=0,lo=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];g+=Math.max(d,0);lo+=Math.max(-d,0)}g/=p;lo/=p;o[p]=lo===0?100:100-100/(1+g/lo);for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];g=(g*(p-1)+Math.max(d,0))/p;lo=(lo*(p-1)+Math.max(-d,0))/p;o[i]=lo===0?100:100-100/(1+g/lo)}return o}
function atrSeries(h,l,c,p=14){const tr=Array(c.length).fill(NaN);for(let i=1;i<c.length;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const o=Array(c.length).fill(NaN);if(c.length<=p)return o;let a=0;for(let i=1;i<=p;i++)a+=tr[i];a/=p;o[p]=a;for(let i=p+1;i<c.length;i++){a=(a*(p-1)+tr[i])/p;o[i]=a}return o}
function adxSeries(h,l,c,p=14){const n=c.length,tr=Array(n).fill(0),pd=Array(n).fill(0),md=Array(n).fill(0);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const up=h[i]-h[i-1],dn=l[i-1]-l[i];pd[i]=up>dn&&up>0?up:0;md[i]=dn>up&&dn>0?dn:0}const o=Array(n).fill(NaN);if(n<2*p+2)return o;let trS=0,pS=0,mS=0;for(let i=1;i<=p;i++){trS+=tr[i];pS+=pd[i];mS+=md[i]}const dx=Array(n).fill(NaN);for(let i=p;i<n;i++){if(i>p){trS=trS-trS/p+tr[i];pS=pS-pS/p+pd[i];mS=mS-mS/p+md[i]}const pdi=trS?100*pS/trS:0,mdi=trS?100*mS/trS:0;dx[i]=(pdi+mdi)?100*Math.abs(pdi-mdi)/(pdi+mdi):0}let a=0;for(let i=p;i<2*p;i++)a+=dx[i];a/=p;o[2*p-1]=a;for(let i=2*p;i<n;i++){a=(a*(p-1)+dx[i])/p;o[i]=a}return o}

