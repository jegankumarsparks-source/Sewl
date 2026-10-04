# RUNBOOK
1) npm install  2) cp .env.example .env (fill 4 values)  3) npm run init
4) npm test (all pass)  5) npm start (always-on) OR GitHub Actions cron
(.github/workflows/cron.yml, secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
HELIUS_API_KEY, EXIT_POLICY_APPROVED=true).
Rules: PAPER ONLY; $800 = latch not promise; missing data = NULL + reason;
never commit .env/var; weekly report Sundays.
