# SOLUSDC Indicator Worker

Cloudflare Worker for Binance USDⓈ-M Futures SOLUSDC.

Outputs:
- 4h / 1h / 30m / 15m
- EMA20 / EMA50 / EMA200
- Wilder RSI(14)
- trend label

## Cloudflare deployment from GitHub

1. Push this repository to GitHub.
2. In Cloudflare Workers & Pages, choose **Import a repository**.
3. Select this repository.
4. Build command: leave blank.
5. Deploy command: `npx wrangler deploy`.
6. Deploy.

The Worker root URL returns JSON.
