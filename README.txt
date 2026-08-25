# SOL EMA Cron version

- Dashboard refresh: every 5 seconds in the browser
- Cloudflare Cron: every 1 minute
- Cron flow: Bybit -> EMA/RSI -> Apps Script -> Google Sheet
- Sheet sync no longer depends on anyone opening the dashboard.

After uploading both `src/index.js` and `wrangler.jsonc` to the repository, let Cloudflare deploy the new commit.
Then check the Google Sheet `更新時間` column after 1-2 minutes.
