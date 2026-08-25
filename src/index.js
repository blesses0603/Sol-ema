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

    if (u.pathname === "/backtest" || u.pathname === "/backtest/api") {
      try {
        const days = Math.min(Math.max(Number(u.searchParams.get("days") || 30), 7), 365);
        const cache = caches.default;
        const cacheKey = new Request(new URL(`/__backtest_cache?days=${days}`, req.url).toString(), {method:"GET"});
        const cached = await cache.match(cacheKey);
        let result, cacheState;
        if (cached) {
          result = await cached.json();
          cacheState = "HIT";
        } else {
          result = await runBacktest({days});
          cacheState = "MISS";
          await cache.put(cacheKey, new Response(JSON.stringify(result), {
            headers:{"content-type":"application/json","cache-control":"public, max-age=900"}
          }));
        }
        const output = {...result, cache:cacheState};
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

async function runBacktest({days=30}={}) {
  // Use Bybit linear SOLUSDT first: up to 1000 candles per request, which
  // dramatically reduces request count. OKX is a throttled fallback only.
  const m15Data = await fetchHistory("15", days);
  const h1Data = await fetchHistory("60", days);
  const m15 = m15Data.rows;
  const h1 = h1Data.rows;

  const tf1h = buildIndicators(h1);
  const tf15 = buildIndicators(m15);

  const variants = [
    {
      id:"A",
      name:"Strict",
      description:"1H EMA20/50/200 + ADX; 15m pullback + RSI + MACD + volume + breakout"
    },
    {
      id:"B",
      name:"Balanced",
      description:"Same 1H trend; 15m pullback + RSI + breakout, with MACD OR volume confirmation"
    },
    {
      id:"C",
      name:"Trend",
      description:"Stronger 1H trend filter; looser 15m trigger using pullback + breakout + momentum confirmation"
    }
  ];

  const results = variants.map(v => simulateVariant(tf15, tf1h, v));
  const eligiblePF = results.filter(x=>x.trades>=5);
  const byNetR = [...results].sort((a,b)=>b.netR-a.netR)[0]?.variant || null;
  const byPF = [...eligiblePF].sort((a,b)=>b.profitFactor-a.profitFactor)[0]?.variant || null;
  const byDD = [...results].sort((a,b)=>a.maxDrawdownPct-b.maxDrawdownPct)[0]?.variant || null;

  return {
    ok:true,
    symbol:"SOLUSDT",
    market:"USDT perpetual / linear",
    source:{m15:m15Data.source,h1:h1Data.source},
    mode:"ABC synchronized comparison V2",
    days,
    candles:{m15:m15.length,h1:h1.length},
    sharedRules:{
      entry:"signal candle closes; enter next candle open",
      stop:"1.5 ATR",
      tp1:"1R / 30%",
      tp2:"2R / 30%",
      runner:"40% with 1.5 ATR trailing",
      riskPerTradePct:0.5,
      volatilityCooldown:"1h if >3 ATR or >4%; 4h if >7%",
      threeLossCooldown:"6 hours",
      sameBarConflict:"stop first (conservative)"
    },
    leaderboard:{bestByNetR:byNetR,bestByProfitFactor:byPF,lowestDrawdown:byDD},
    results
  };
}


function backtestPage(r){
  const esc=x=>String(x??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const names={A:"A 嚴格版",B:"B 平衡版",C:"C 趨勢版"};
  const resultById=Object.fromEntries((r.results||[]).map(x=>[x.variant,x]));
  const cards=["A","B","C"].map(id=>{const x=resultById[id]||{};return `<article class="card"><div class="cardtop"><div><span class="tag">${esc(id)}</span><h2>${names[id]}</h2></div><div class="net ${Number(x.netR)>=0?'pos':'neg'}">${Number(x.netR)>=0?'+':''}${Number(x.netR||0).toFixed(2)}R</div></div><div class="stats"><div><small>交易次數</small><b>${x.trades??0}</b></div><div><small>勝率</small><b>${Number(x.winRate||0).toFixed(1)}%</b></div><div><small>Profit Factor</small><b>${Number(x.profitFactor||0).toFixed(2)}</b></div><div><small>最大回撤</small><b>${Number(x.maxDrawdownPct||0).toFixed(2)}%</b></div><div><small>最大連敗</small><b>${x.maxLossStreak??0}</b></div><div><small>100U →</small><b>${Number(x.endingEquity||100).toFixed(2)}U</b></div></div><details><summary>最近交易</summary><div class="trades">${(x.recentTrades||[]).slice().reverse().map(t=>`<div><span>${t.side==='LONG'?'🟢 多':'🔴 空'}</span><span>${Number(t.r)>=0?'+':''}${Number(t.r).toFixed(2)}R</span></div>`).join('')||'沒有交易'}</div></details></article>`}).join('');
  const lb=r.leaderboard||{};
  const leader=(id)=>id?`${id} · ${names[id]||id}`:'樣本不足';
  const buttons=[30,90,180,365].map(d=>`<a class="${Number(r.days)===d?'on':''}" href="/backtest?days=${d}">${d===365?'1年':d+'天'}</a>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b0f17"><title>SOL ABC 回測</title><style>*{box-sizing:border-box}body{margin:0;background:#0b0f17;color:#f5f7fb;font-family:system-ui,-apple-system,sans-serif}.w{max-width:900px;margin:auto;padding:16px 12px 40px}.hero,.card,.leader{background:#121925;border:1px solid #263246;border-radius:20px}.hero{padding:18px}.ey,small,.muted{color:#8995a8}.ey{font-size:12px;letter-spacing:.08em}.hero h1{margin:6px 0 4px;font-size:25px}.period{display:flex;gap:8px;overflow:auto;margin-top:15px}.period a{color:#dce4f1;text-decoration:none;padding:9px 13px;border:1px solid #2a374c;border-radius:12px;white-space:nowrap}.period a.on{background:#f5f7fb;color:#0b0f17;font-weight:800}.leader{padding:15px;margin-top:12px;display:grid;gap:9px}.leader div{display:flex;justify-content:space-between;gap:12px}.leader b{text-align:right}.cards{display:grid;gap:12px;margin-top:12px}.card{padding:16px}.cardtop{display:flex;justify-content:space-between;align-items:start;gap:10px}.card h2{font-size:18px;margin:5px 0}.tag{display:inline-block;background:#0d1420;border:1px solid #2a374c;border-radius:8px;padding:3px 8px;font-weight:800}.net{font-size:25px;font-weight:900}.pos{color:#69e6a6}.neg{color:#ff8585}.stats{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:13px}.stats div{background:#0d1420;border:1px solid #202c3f;border-radius:13px;padding:11px}.stats small{display:block;font-size:11px;margin-bottom:4px}.stats b{font-size:17px}details{margin-top:12px}summary{cursor:pointer;color:#cbd5e1}.trades{margin-top:8px;background:#0d1420;border-radius:12px;padding:8px 11px}.trades div{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #202c3f}.trades div:last-child{border:0}.foot{font-size:12px;line-height:1.65;color:#8995a8;margin:14px 3px}.foot a{color:#cbd5e1}@media(min-width:760px){.cards{grid-template-columns:repeat(3,1fr)}.stats{grid-template-columns:1fr 1fr}}</style></head><body><main class="w"><section class="hero"><div class="ey">SOLUSDT · ABC BACKTEST</div><h1>📊 策略回測儀表板</h1><div class="muted">${r.days} 天 · 15m + 1h · ${esc(r.source?.m15||'')}</div><nav class="period">${buttons}</nav></section><section class="leader"><div><span>🏆 淨 R 最高</span><b>${leader(lb.bestByNetR)}</b></div><div><span>⚡ PF 最高</span><b>${leader(lb.bestByProfitFactor)}</b></div><div><span>🛡️ 回撤最低</span><b>${leader(lb.lowestDrawdown)}</b></div></section><section class="cards">${cards}</section><div class="foot">風控：每筆 0.5% · SL 1.5 ATR · TP1 1R/30% · TP2 2R/30% · Runner 40%。同根碰 SL/TP 採止損優先。資料快取：${esc(r.cache)}。<br><a href="/backtest/api?days=${r.days}">查看原始 JSON API</a> · <a href="/">返回 SOL Dashboard</a></div></main></body></html>`;
}

function backtestErrorPage(e){const m=String(e?.message||e||'Unknown error').replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));return `<!doctype html><html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#0b0f17;color:#fff;font-family:system-ui;padding:24px"><h2>⚠️ 回測失敗</h2><p>${m}</p><p><a style="color:#fff" href="/backtest?days=30">重試 30 天</a></p></body></html>`}

function simulateVariant(tf15, tf1h, variant) {
  const h1ByTs = tf1h.map(x => [x.ts, x]);
  let hIdx = 0;
  let equity = 100, peak = 100, maxDD = 0;
  let wins = 0, losses = 0, breakeven = 0;
  let grossWinR = 0, grossLossR = 0;
  let maxLossStreak = 0, lossStreak = 0;
  let cooldownUntil = 0;
  let lossPauseUntil = 0;
  let pos = null;
  const trades = [];

  for (let i = 220; i < tf15.length - 1; i++) {
    const b = tf15[i], prev = tf15[i-1];
    while (hIdx + 1 < h1ByTs.length && h1ByTs[hIdx+1][0] <= b.ts) hIdx++;
    const h = h1ByTs[hIdx]?.[1];
    if (!h || !Number.isFinite(h.ema200) || !Number.isFinite(h.adx) || !Number.isFinite(b.atr) || !Number.isFinite(b.rsi)) continue;

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
        if (r > 0.02) {
          wins++; grossWinR += r; lossStreak = 0;
        } else if (r < -0.02) {
          losses++; grossLossR += -r; lossStreak++;
          maxLossStreak = Math.max(maxLossStreak, lossStreak);
          if (lossStreak >= 3) {
            lossPauseUntil = b.ts + 6*3600e3;
            lossStreak = 0;
          }
        } else {
          breakeven++; lossStreak = 0;
        }
        trades.push({...pos, exitTs:b.ts, exitPrice:outcome.exitPrice, r:+r.toFixed(3)});
        pos = null;
      }
      continue;
    }

    if (b.ts < cooldownUntil || b.ts < lossPauseUntil) continue;

    const longBase = h.ema20 > h.ema50 && h.ema50 > h.ema200 && h.close > h.ema200;
    const shortBase = h.ema20 < h.ema50 && h.ema50 < h.ema200 && h.close < h.ema200;
    const longTrend = longBase && h.adx >= (variant.id === "C" ? 25 : 20);
    const shortTrend = shortBase && h.adx >= (variant.id === "C" ? 25 : 20);

    const volOK = Number.isFinite(b.volMA20) && b.volume > b.volMA20 * 1.1;
    const pullbackLong = b.low <= b.ema20 && b.close >= b.ema50;
    const pullbackShort = b.high >= b.ema20 && b.close <= b.ema50;
    const recent = tf15.slice(Math.max(0,i-6),i+1);
    const recentRSI = recent.map(x=>x.rsi).filter(Number.isFinite);
    const rsiLong = prev.rsi < 52 && b.rsi >= 52 && recentRSI.length && Math.min(...recentRSI) < 50;
    const rsiShort = prev.rsi > 48 && b.rsi <= 48 && recentRSI.length && Math.max(...recentRSI) > 50;
    const macdLong = b.macdHist > 0 && b.macdHist > prev.macdHist;
    const macdShort = b.macdHist < 0 && b.macdHist < prev.macdHist;
    const breakLong = b.close > prev.high;
    const breakShort = b.close < prev.low;

    let longSignal = false, shortSignal = false;
    if (variant.id === "A") {
      longSignal = longTrend && pullbackLong && rsiLong && macdLong && volOK && breakLong;
      shortSignal = shortTrend && pullbackShort && rsiShort && macdShort && volOK && breakShort;
    } else if (variant.id === "B") {
      longSignal = longTrend && pullbackLong && rsiLong && breakLong && (macdLong || volOK);
      shortSignal = shortTrend && pullbackShort && rsiShort && breakShort && (macdShort || volOK);
    } else {
      const momentumLong = b.rsi >= 50 && (macdLong || volOK);
      const momentumShort = b.rsi <= 50 && (macdShort || volOK);
      longSignal = longTrend && pullbackLong && breakLong && momentumLong;
      shortSignal = shortTrend && pullbackShort && breakShort && momentumShort;
    }

    const side = longSignal ? "LONG" : shortSignal ? "SHORT" : null;
    if (!side) continue;

    const next = tf15[i+1];
    const entry = next.open;
    const risk = b.atr * 1.5;
    if (!(risk > 0)) continue;
    pos = makePosition(side, entry, risk, next.ts);
  }

  const total = trades.length;
  const pf = grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? 999 : 0);
  const netR = trades.reduce((a,t)=>a+t.r,0);
  return {
    variant:variant.id,
    name:variant.name,
    description:variant.description,
    trades:total,
    wins,losses,breakeven,
    winRate:total ? +(wins/total*100).toFixed(2) : 0,
    profitFactor:+pf.toFixed(2),
    netR:+netR.toFixed(2),
    endingEquity:+equity.toFixed(2),
    maxDrawdownPct:+maxDD.toFixed(2),
    maxLossStreak,
    recentTrades:trades.slice(-10).map(t=>({side:t.side,entryTs:t.entryTs,exitTs:t.exitTs,entry:+t.entry.toFixed(4),exit:+t.exitPrice.toFixed(4),r:t.r}))
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
    const okxBar = interval === "15" ? "15m" : "1H";
    const rows = await fetchOkxHistoryThrottled(okxBar, days);
    return {rows, source:"OKX SOL-USDT-SWAP fallback"};
  }
}

async function fetchBybitHistory(interval, days) {
  const ms = interval === "15" ? 15*60e3 : 60*60e3;
  const target = Math.ceil(days*24*60*60e3/ms) + 260;
  let out = [];
  let end = Date.now();
  let pages = 0;

  while (out.length < target && pages < 12) {
    const url = `${BASE}?category=linear&symbol=${SYMBOL}&interval=${interval}&end=${end}&limit=1000`;
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
  const ms = bar === "15m" ? 15*60e3 : 60*60e3;
  const target = Math.ceil(days*24*60*60e3/ms) + 260;
  let out = [];
  let after = null;
  let pages = 0;

  while (out.length < target && pages < 80) {
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
