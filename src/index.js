const SYMBOL="SOLUSDT", BASE="https://api.bybit.com/v5/market/kline";
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
          source: "Bybit SOLUSDT Perpetual",
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
    source: "Bybit SOLUSDT Perpetual",
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

async function calc(label,interval){
  const r=await fetch(`${BASE}?category=linear&symbol=${SYMBOL}&interval=${interval}&limit=500`,{headers:{Accept:"application/json"}});
  if(!r.ok) throw Error(`Bybit ${label} HTTP ${r.status}`);
  const b=await r.json(); if(b.retCode!==0||!b.result?.list?.length) throw Error(`Bybit ${label}: ${b.retMsg||"No data"}`);
  const c=[...b.result.list].reverse().map(x=>Number(x[4]));
  const close=c.at(-1),e20=ema(c,20),e50=ema(c,50),e200=ema(c,200),rsi=rsiW(c,14);
  let score=0;if(e20>e50&&e50>e200)score+=2;else if(e20<e50&&e50<e200)score-=2;if(close>e20)score++;else score--;if(rsi>=55&&rsi<70)score++;else if(rsi>30&&rsi<=45)score--;
  const trend=score>=3?"🟢 強多":score>=1?"🟢 偏多":score<=-3?"🔴 強空":score<=-1?"🔴 偏空":"🟡 震盪";
  const rs=rsi>=70?"過熱":rsi<=30?"超賣":rsi>=55?"偏強":rsi<=45?"偏弱":"中性";
  return {timeframe:label,close:R(close,4),ema20:R(e20,4),ema50:R(e50,4),ema200:R(e200,4),rsi14:R(rsi,2),rsiState:rs,trend,score};
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