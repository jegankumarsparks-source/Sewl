@echo off
where node >nul 2>nul || (echo Install Node.js 22+ from nodejs.org & pause & exit /b 1)
if not exist node_modules (call npm install)
if not exist .env (copy .env.example .env & echo EDIT .env THEN RUN AGAIN & exit /b 0)
if not exist var\sewl.sqlite (set EXIT_POLICY_APPROVED=true && call npm run init)
call npm test
node src/main.js
