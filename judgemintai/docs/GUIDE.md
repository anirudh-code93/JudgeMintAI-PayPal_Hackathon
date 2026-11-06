# JudgeMintAI: Build, Test and Submit Guide

Nov 6, 2026

## Quick start

You can run JudgeMintAI on your laptop in about 10 minutes, with no keys and nothing to install except Node.js.

JudgeMintAI has two parts. **Judge mode** takes all the entries of a hackathon or any other competition, checks that each one is real, ranks them with a reason for every rank, and pays the prizes through PayPal. **Audit one entry** checks a single project and can issue a signed certificate. Steps 1 to 5 start the app and try the single audit, and "Try Judge mode" below tries the main feature.

1. In VS Code choose Terminal, then New Terminal, and run `node -v`. You need version 20 or higher. If it is older or missing, install the LTS version from nodejs.org and reopen VS Code.
2. Unzip `judgemintai.zip` from the chat. In VS Code choose File, then Open Folder, and pick the `judgemintai` folder (the one that contains `package.json`).
3. In the VS Code terminal run `npm start`. There is no `npm install` step because the project has zero dependencies. The terminal prints the address `http://localhost:3000`.
4. Open http://localhost:3000 in your browser, click **Try a public example**, then **Run audit**. The five agents usually finish in under half a minute and the report appears.
5. Scroll to the footer. It says "PayPal sandbox: not set up" until you add your keys in the Backend section below.

Without keys the app runs in rule-based mode: every check works, the AI-written head-judge notes are skipped, and buying a certificate waits for your PayPal keys. Press Ctrl+C in the terminal to stop the server, or run `npm run dev` to restart it automatically each time you save a file.

### Try Judge mode

Judge mode is the part for organisers and judges. It shows entry emails and can send prize money, so it asks for a key. The first time the server starts it makes one and prints it in the terminal on a line that begins `Organiser key:`.

1. Click **Judge mode** in the menu at the top of the page, or open http://localhost:3000/competitions. Copy the key from the terminal line that begins `Organiser key:` (only the key, not the arrow and the words after it), paste it into the form, type your name, and click **Open Judge mode**.
2. Click **New competition**. Type a name such as `Practice hackathon`, keep **Any hackathon or competition**, and leave the criteria and the prize row as they are.
3. Under "3. The entries" keep **Paste a list** and paste two or three lines, one per project. A line can be just a repository link, or `Name | repository link`, for example `Agent Toolkit | https://github.com/paypal/agent-toolkit`. The repositories must be public.
4. Click **Create competition**. The competition page opens and the leaderboard fills in as entries finish, two at a time. Three entries take a minute or two.
5. Click an entry's name to read why it has its rank, its scores and its checks. Without keys the scores are labelled estimates, because no AI model is scoring yet.

Finalising the judgement and paying a prize need your PayPal sandbox keys, so those steps are in the Testing section.

## Project map

The project is 62 files and about 10,000 lines of code, and every file is already in the zip. This map says what each one does and where it lives, in case you want to type or paste a file yourself.

**To type a file yourself:** in the VS Code Explorer panel, right-click, choose New Folder or New File, and type the path from the table (`src/agents/judge.js` means folder `src`, inside it folder `agents`, inside it the file `judge.js`). Paste the code from `ALL_CODE.md`, where every file is headed by its path, and save with Ctrl+S. Keep the names and folders exactly as written, because files import each other by path.

### Backend

The backend is Node.js with no npm packages of its own. It runs on your computer (or on Render) and does all the audit work, the competition ranking, the AI calls and the PayPal calls, including prize payouts. When your PayPal keys are set it also starts PayPal's AI Toolkit, a package that npx downloads the first time (see "The PayPal AI Toolkit inside the app" below).

| File | What it does |
| --- | --- |
| `server.js` | Starts the web server, defines the API routes, and serves the frontend files |
| `package.json` | Names the project and defines `npm start`, `npm run dev` and `npm test` |
| `.env.example` | Template for your settings and keys; you copy it to `.env` |
| `src/config.js` | Reads `.env` and holds every setting in one place |
| `src/http.js` | Small helpers for JSON replies, request size limits and errors |
| `src/netsafe.js` | Safety guard that refuses private network addresses when fetching a demo URL |
| `src/github.js` | Reads a repository through the GitHub API: file tree, commits, licence, and up to 60 key files |
| `src/auditor.js` | Runs one audit: collects evidence, runs the agents in parallel, calls the head judge, then Zapier and Elastic |
| `src/agents/technical.js` | Technical agent: does it exist, run, have tests, leak secrets |
| `src/agents/paypalAgent.js` | PayPal agent: is PayPal really in the code, in sandbox, with server-side capture |
| `src/agents/aiAgent.js` | AI agent: which model is called, where, and is it central |
| `src/agents/legalAgent.js` | Legal agent: public repo, open-source licence, video rules, prompt-injection attempts |
| `src/agents/submissionAgent.js` | Submission agent: description, tools list, links, documentation |
| `src/agents/sponsorsAgent.js` | Sponsor agent: which sponsor tools are really wired in |
| `src/agents/judge.js` | Head judge: weights the scores, decides the verdict, optional AI summary |
| `src/agents/util.js` | Shared scoring helpers and secret redaction |
| `src/llm.js` | Calls the AI model through any OpenAI-compatible API, keeps to the model's calls-per-minute limit, and never crashes an audit |
| `src/paypal.js` | PayPal checkout: creates and captures orders through the AI Toolkit or the Orders v2 API, and checks every payment again with PayPal |
| `src/paypalToolkit.js` | Starts PayPal's MCP server (the AI Toolkit), calls its create\_order and pay\_order tools, and falls back to the Orders API if it fails |
| `src/mcp.js` | A small MCP client that talks to a tool server through its standard input and output |
| `src/cert.js` | Signs and verifies certificates with HMAC-SHA256 |
| `src/store.js` | Saves audits to `data/audits.json` |
| `src/integrations.js` | Sends events to Zapier (finished audits, finalised competitions, paid prizes), and indexes audits and competition entries in Elastic |
| `scripts/get-sandbox-token.mjs` | Prints a PayPal sandbox access token for the AI Toolkit |
| `test/backend.test.js`, `test/fakes.js` | Automated tests for audits and certificates, with fake GitHub, PayPal (orders and payouts), YouTube and AI model servers |
| `test/toolkit.test.js`, `test-support/fake-mcp-server.mjs` | Tests for the toolkit route, using a fake toolkit server |
| `render.yaml` | Hosting blueprint for Render |
| `postman/JudgeMintAI.postman_collection.json` | Postman collection that exercises the API |
| `.vscode/mcp.json` | Connects the PayPal AI Toolkit (MCP server) to VS Code |

Judge mode adds these backend files. They sit in the same folders as the files above.

| File | What it does |
| --- | --- |
| `src/rules.js` | The rules of one event: the PayPal hackathon preset and the "any competition" preset, with each rule you can switch on or off |
| `src/agents/requiredTechAgent.js` | Checks that an entry really uses the technology the event requires: calls in code rather than a README mention, test or sandbox mode, keys read from the environment |
| `src/intake.js` | Turns a pasted list, a CSV, JSON, or a GitHub organisation or topic into a clean list of entries |
| `src/similarity.js` | Finds copies across entries: the same repository, forks, identical files, similar code (renamed variables do not hide it), the same video or demo, similar descriptions |
| `src/scoring.js` | Scores each entry from 0 to 10 on your criteria, with one AI call per entry, or with labelled estimates when there is no key |
| `src/ranking.js` | Combines the scores and the audit into the final order, writes each entry's "why this rank" text, and applies the judges' adjustments |
| `src/competition.js` | Creates a competition, runs the evaluation queue two entries at a time, records the judges' decisions, finalises the judgement and writes the CSV |
| `src/competitionStore.js` | Saves competitions to `data/competitions.json` |
| `src/competitionRoutes.js` | The Judge mode API routes, all behind the organiser key |
| `src/auth.js` | Checks the organiser key, and stops answering anyone who guesses wrong keys too often |
| `src/payouts.js` | Pays prizes through PayPal's Payouts API, with the safety checks that run before any money moves |
| `test/competition.test.js` | Automated tests for all of Judge mode, using fake GitHub, PayPal and AI servers |

### Frontend

The frontend is plain HTML, CSS and JavaScript that runs in the browser. There is no build step: the server hands these files to the browser as they are.

| File | What it does |
| --- | --- |
| `public/index.html` | The page itself: audit form, progress, report, verify and Judge mode views |
| `public/styles.css` | The whole design: colours, type, layout, mobile view, certificate print style |
| `public/js/app.js` | The screens and the router for single audits: form, live progress, report, recent audits, verify page, plus the hand-over to Judge mode |
| `public/js/util.js` | Helpers to build page elements safely, call the API, and format labels |
| `public/js/grid.js` | The checks table, using AG Grid, with a plain table as a fallback |
| `public/js/pay.js` | PayPal buttons and the certificate card |
| `public/js/seal.js` | The drawn hallmark seal and the certificate's background pattern |

Judge mode adds these frontend files, all in `public/js`.

| File | What it does |
| --- | --- |
| `public/js/judge.js` | The Judge mode entry point: the list of competitions, the New competition form, and the routes to its other pages |
| `public/js/judgeDash.js` | The competition page: progress, leaderboard, prizes with their Pay buttons, entries, rules and the decision log |
| `public/js/judgeEntry.js` | One entry: why it has its rank, each score with its source, the evidence, the copies found, and the judges' controls |
| `public/js/board.js` | The leaderboard, using AG Grid, with a plain table as a fallback |
| `public/js/judgeForms.js` | The form parts: rules, criteria, entry import, prizes and the confirmation dialog |
| `public/js/judgeUi.js` | The organiser sign-in, messages and small helpers shared by the Judge mode screens |
| `public/js/judgeApi.js` | Talks to the server with the organiser key, and downloads the CSV |

The root also holds `README.md`, `LICENSE` (MIT) and `.gitignore`. The `docs` folder holds this guide and the PRD as Markdown files (`docs/GUIDE.md` and `docs/PRD.md`).

## Backend: keys and the PayPal sandbox

Backend setup means filling in one file, `.env`. Only the two PayPal keys are needed for the certificate checkout and for paying prizes; every other key is optional.

### Create your .env file

In the VS Code terminal run `copy .env.example .env` (works in PowerShell and CMD; on Mac or Linux use `cp`). Open `.env` and paste values after each equals sign with no quotes and no spaces. Never upload this file: it is already listed in `.gitignore`.

### PayPal sandbox keys (needed for checkout)

The sandbox is PayPal's free practice world. Test accounts pay test money, so nothing real moves.

1. Go to developer.paypal.com and log in with any PayPal account (create a free one if you have none).
2. Open **Apps & Credentials** and switch the toggle to **Sandbox**.
3. Click **Create App**, name it JudgeMintAI, keep the type Merchant, and create it.
4. Copy the **Client ID** and the **Secret** (click Show) into `.env` as `PAYPAL_CLIENT_ID=` and `PAYPAL_CLIENT_SECRET=`.
5. Open **Testing Tools, then Sandbox Accounts**. PayPal has already made a Personal (buyer) and a Business (seller) test account. On the Personal one open the menu, choose View/edit account, and copy its email and password. You will log in with these in the payment popup, never with your real PayPal login.
6. Stop the server with Ctrl+C and run `npm start` again. The terminal now says "PayPal: sandbox credentials loaded" and the page footer says "PayPal sandbox: connected". It also starts PayPal's AI Toolkit in the background, which the section "The PayPal AI Toolkit inside the app" below explains.

PayPal moves menu items around now and then. If a label differs, look for "Apps & Credentials" and "Sandbox Accounts" under the developer dashboard.

### How one payment flows through the backend

1. The browser asks `POST /api/audits/:id/pay/create`. The server asks PayPal to create the order, first through the AI Toolkit's create\_order tool and otherwise with `POST /v2/checkout/orders`, with intent CAPTURE and the price from `CERT_PRICE_USD`, so the page can never change the amount.
2. PayPal's button opens its popup. The buyer logs in with the sandbox Personal account and approves.
3. The browser sends the order id to `POST /api/audits/:id/pay/capture`. The server captures the order with the toolkit's pay\_order tool, or with PayPal's capture endpoint if the toolkit is not running. After a toolkit capture it reads the order back from PayPal itself. It accepts the order only if the status is COMPLETED, the amount and currency match, and the order belongs to this audit.
4. The server signs a certificate with HMAC-SHA256 and returns it. Anyone can check it at `/verify/<serial>`.

The code for this is `src/paypal.js`, the two routes in `server.js`, and `public/js/pay.js` for the buttons. After a test payment, log in at sandbox.paypal.com with the Business account to see the money arrive.

### The PayPal AI Toolkit inside the app

JudgeMintAI uses the PayPal AI Toolkit while it runs, not only while you code. When your PayPal keys are set, `npm start` launches PayPal's own MCP server (`npx -y @paypal/mcp`) in the background. The server then asks it to run two tools for every payment: `create_order` when the buyer clicks the PayPal button, and `pay_order` after the buyer approves.

What you will see:

- The very first start downloads the package from npm, which can take a minute or two. The page works meanwhile, and a buyer never waits more than a few seconds for the toolkit.
- The terminal says `PayPal AI Toolkit ready: create_order, pay_order` when it is running, or `PayPal AI Toolkit could not start` with the reason.
- The page footer shows `PayPal AI Toolkit: ready, 2 calls so far` (the count grows with each payment), and a paid certificate has a "Paid through" line that names the route.
- If the toolkit is unavailable or fails, the server uses PayPal's Orders API for that step, so a demo does not break. After a toolkit capture the server always reads the order back from PayPal itself before it signs a certificate, so the certificate never rests on the toolkit's word alone.
- The toolkit is started with only the two order permissions it needs, and with a sandbox access token made from your keys. Your client secret and your other keys are not passed to it.

`PAYPAL_VIA` in `.env` chooses the route:

| Value | What happens | Use it |
| --- | --- | --- |
| `auto` | Toolkit first, PayPal's Orders API as the safety net | Normal use, and the default |
| `toolkit` | Toolkit only, so a toolkit problem shows up as a payment error | While recording the demo, to prove the toolkit does the work |
| `rest` | PayPal's Orders API only, with nothing to download | If the toolkit will not start, or the PayPal popup shows an error for its orders |

I could not run the real `@paypal/mcp` package in my workspace, because it cannot download from npm. I tested this route against a stand-in toolkit server that uses the real tool names and arguments, including a toolkit that crashes, hangs or reports success for an unpaid order. You are the first to run the real package, so look for `PayPal AI Toolkit ready` in the terminal. If it does not appear, or the PayPal popup shows an error page, set `PAYPAL_VIA=rest` and restart. Everything else keeps working.

### AI model key (recommended)

Put a key in `LLM_API_KEY` to switch on the AI head judge. A free key from aistudio.google.com/apikey works with the defaults in `.env.example`. If Google has renamed that model, copy the current model name from AI Studio into `LLM_MODEL`. Any OpenAI-compatible service also works if you change `LLM_BASE_URL` and `LLM_MODEL`. The terminal then shows "AI mode: LLM". The AI code is in `src/llm.js` and `src/agents/judge.js`.

In Judge mode the same key scores every entry from 0 to 10 on each criterion and writes a reason for each score (`src/scoring.js`). Without a key those scores are estimates from the audit facts, and they are labelled as estimates.

### Optional keys

| Setting | What it gives you | Where to get it |
| --- | --- | --- |
| `GITHUB_TOKEN` | 5,000 GitHub reads per hour instead of 60 | github.com, Settings, Developer settings, Personal access tokens, create one with no scopes ticked |
| `YOUTUBE_API_KEY` | Verifies the video is public and under 3 minutes | Google Cloud Console, enable YouTube Data API v3, create an API key |
| `CERT_SECRET` | Fixed signing key for certificates | Type any long random text; if empty, one is generated into `data/.cert_secret` |
| `CERT_PRICE_USD` | Certificate price in the sandbox (default 2.00) | You choose |
| `ZAPIER_WEBHOOK_URL` | Sends every finished audit, every finalised competition and every paid prize to your Zap | Zapier, new Zap, trigger Webhooks by Zapier, event Catch Hook, copy the URL |
| `ELASTIC_URL`, `ELASTIC_API_KEY` | Indexes audits, and the entries of finalised competitions, so they can be searched | Elastic Cloud trial, create a project, copy its endpoint and an API key |
| `AUDIT_RATE_LIMIT_PER_HOUR` | Audits one visitor may start per hour (default 20) | You choose |
| `PAYPAL_VIA` | Chooses how checkout talks to PayPal: auto (toolkit first, Orders API as the safety net), toolkit (toolkit only) or rest (Orders API only) | You choose; leave it at auto unless the toolkit section says otherwise |
| `PUBLIC_URL` | The public address PayPal sends buyers back to | Leave it empty on your computer; Render fills it in for you |

After changing `.env`, restart the server. The first lines it prints tell you which integrations are on.

### Judge mode settings

Judge mode needs no new keys, and every setting below is optional. The defaults suit a first test.

| Setting | What it does | Default |
| --- | --- | --- |
| `ORGANIZER_KEY` | The password for Judge mode. If it is empty, the server makes a key, prints it as `Organiser key:` in the terminal and saves it in `data/.organizer_key` | Made for you |
| `MAX_PROJECTS_DEFAULT` | How many entries are evaluated when you do not choose a number | 10 |
| `MAX_PROJECTS_HARD` | The most entries one competition can hold on this server. Raise it on a bigger server | 50 |
| `EVAL_CONCURRENCY` | How many entries are evaluated at the same time, from 1 to 4 | 2 |
| `LLM_RPM` | AI model calls per minute. Gemini's free tier allows about 10, and `0` means no limit | 10 with Gemini, otherwise no limit |
| `LLM_RETRY_MS` | How long to wait before retrying when the model says "too many requests" | 6000 |
| `MAX_PAYOUT_PER_PRIZE` | The largest single prize the server will send | 5000 |
| `ALLOW_LIVE_PAYOUTS` | Leave it unset. Only `true` lets Judge mode pay real money, and only together with live PayPal keys | Off |

`GITHUB_TOKEN` matters more in Judge mode, because every entry is read from GitHub. Without a token GitHub allows 60 reads an hour, which is enough for about 10 entries. Add the free token from the table above before you run a bigger competition.

### PayPal Payouts for prizes

Prizes are paid with PayPal's Payouts API, which sends money from your PayPal business account to a winner's PayPal email. PayPal's AI Toolkit has no payout tool, so `src/payouts.js` calls the Payouts API directly, with the same two sandbox keys. Certificate checkout still goes through the toolkit.

1. Open **Testing Tools, then Sandbox Accounts** and check that the **Business** account that owns your app has a balance. Prize money leaves that account.
2. For a winner's PayPal email, use the email of a sandbox **Personal** account, because a real email has no sandbox account. Afterwards, log in at sandbox.paypal.com with that Personal account to see the money arrive.
3. Restart `npm start`. The terminal says `Prize payouts: PayPal sandbox (no real money)`.

Before any money moves, the server checks that the judgement is finalised, that the winning entry is ranked and has a valid PayPal email, and that your confirmation repeats the right amount, email and entry. Each attempt uses a fixed PayPal reference, so a double click cannot pay twice. A prize card shows one of these states:

| The card says | What it means |
| --- | --- |
| Not paid yet | Nothing has been sent |
| Sending | The server is waiting for PayPal's answer |
| Sent, waiting for PayPal to confirm | PayPal accepted the payment and has not finished it. Press **Check with PayPal** after a minute |
| Paid | PayPal reports the money as delivered |
| Sent, not claimed yet | The email has no PayPal account yet. PayPal holds the money until the winner signs up with that email, and returns it after 30 days |
| PayPal refused it | PayPal said no, and the card shows its words. Fix the cause and press **Pay** again |
| Not sure it went through | PayPal did not answer in time, or the server restarted while sending. Pressing **Pay** again is safe, because PayPal ignores a repeated request with the same reference |

If PayPal answers NOT\_AUTHORIZED, open your app under Apps & Credentials and look for Payouts under Features, because Payouts access can be limited per app or account.

I could not test against real PayPal from my workspace. The payout code was tested against a stand-in server that follows PayPal's documented Payouts API, so your first sandbox prize is the real test.

## Frontend: screens, AG Grid and PayPal buttons

The frontend needs no setup: the server hands the `public` folder to the browser, so you save a file, refresh the page and see the change. If a style change does not show, press Ctrl+F5.

### The screens

The router in `public/js/app.js` reads the address and swaps the screen without reloading the page.

| Address | What you see |
| --- | --- |
| `/` | The audit form (Repository URL, Project name, Hosted demo URL, Demo video on YouTube, What it does, Tools and models used, Hackathon start date) and the list of recent audits |
| `/a/<id>` | Live progress while the agents work, then the report: seal, score by agent, prioritised fixes, checks table, certificate purchase |
| `/verify` and `/verify/JM-...` | The certificate checker |

Judge mode adds four more addresses. `public/js/app.js` hands them to `public/js/judge.js`, and the first time you open one it asks for the organiser key.

| Address | What you see |
| --- | --- |
| `/competitions` | The sign-in with the organiser key, then the list of competitions with their status |
| `/competitions/new` | The New competition form: the event and its rules, the criteria and their weights, the entries, and the prizes |
| `/c/<id>` | One competition: progress, the leaderboard, the prizes with their Pay buttons, the entries, the rules and the decision log |
| `/c/<id>/p/<entry>` | One entry: why it has its rank, each score and its source, the rule checks, the copies found, the evidence, and the judges' decision |

### AG Grid checks table (sponsor tool)

The report's table of checks uses AG Grid Community, loaded by a script tag in `public/index.html`. `public/js/grid.js` builds it with sortable columns, a filter box, a **Problems only** and **All checks** switch, and a click on any row opens its detail panel. If the AG Grid script cannot load (offline, blocked Wi-Fi), `grid.js` shows a plain table with the same data, so the report never breaks.

Judge mode uses AG Grid for the leaderboard as well. `public/js/board.js` builds it with the columns Rank, Entry, Score, Merit, Audit, Flags and Why this rank, a filter box, and an Order column with up and down arrows that appears when the judges may move entries. If the AG Grid script cannot load, `board.js` shows a plain table with the same rows and the same arrows.

### PayPal buttons

`public/js/pay.js` loads PayPal's own button script using only your sandbox Client ID, which the page gets from `/api/config`. The secret never leaves the server. The buttons call the server's create and capture routes described in the Backend section, then the certificate card appears with **Print certificate** (the browser's print dialog can save it as a PDF) and a link to copy. Buttons show only when PayPal keys are set and the verdict is not Fail. The popup is PayPal's own, but behind it the server creates and captures the order with the PayPal AI Toolkit. The page footer says whether the toolkit is ready, and the certificate card has a "Paid through" line that names the route that moved the money.

### Changing the look

- Colours and fonts: the variables at the top of `public/styles.css`, such as `--paper`, `--ink`, `--mint`, `--pass`, `--fail`, `--f-body` and `--f-display`.
- Wording: `public/index.html` for the home page and `public/js/app.js` for the report.
- Fonts come from Google Fonts. If they are blocked, the page falls back to system fonts and stays readable.

### Check these four things once on your computer

I tested every screen in a headless browser against local fake servers, but my workspace could not reach AG Grid's script host, Google Fonts, PayPal's real button script or the npm download of PayPal's toolkit package. So confirm yourself that the checks table and the Judge mode leaderboard have sort arrows in their headers (that is AG Grid), that the PayPal button appears after you add keys, that the headline font is condensed, and that the terminal says "PayPal AI Toolkit ready" a minute or two after you start the server with your keys. Troubleshooting below covers each one.

## Testing

Test in three layers: automated tests that need nothing, two manual runs with your PayPal sandbox keys, one for each part of the app, and Postman for the API.

### Automated tests (Backend)

Run `npm test` in the VS Code terminal. It takes about 15 seconds and must end with `# tests 38`, `# pass 38` and `# fail 0`. The tests start local stand-ins for GitHub, PayPal's sandbox (orders and payouts), YouTube, the AI model and the PayPal AI Toolkit, so they need no internet and no keys.

| What is tested | Why it matters |
| --- | --- |
| JudgeMintAI audits its own code and must pass | The rules and the real code agree |
| A fake PayPal repo (README-only claims, mocked payments, a leaked key, no licence) must fail | The agents catch cheating |
| Sponsor names in a README earn nothing, real wiring does | Sponsor scores cannot be gamed |
| Text aimed at the AI judge, such as asking for a perfect score, is flagged | Prompt-injection defence |
| Create order, approve, capture, certificate, then a tampered certificate is rejected | The whole payment flow |
| The PayPal AI Toolkit route: create the order and capture it through a stand-in toolkit, with your secret keys kept out of its environment | The in-app toolkit use works end to end |
| A toolkit that cannot start, hangs, crashes after capturing, claims success for an unapproved order or charges the wrong amount | Payments stay safe and fall back to the Orders API |
| A wrong amount, a declined card or a failed audit gets no certificate | Payment safeguards |
| The public config never shows the PayPal secret, and folder-escape URLs are blocked | Security |

The fake PayPal in these tests follows PayPal's documented Orders v2 and Payouts behaviour but is not PayPal, and the fake toolkit is a stand-in for PayPal's real package. The manual run below is the real test.

Judge mode has its own 14 tests in `test/competition.test.js`, which are part of the 38. They run whole competitions against the same kind of stand-ins.

| What is tested | Why it matters |
| --- | --- |
| The rules of an event: the PayPal preset, the "any competition" preset, and a required technology that the organiser names | The same engine judges any hackathon |
| A required technology that is really called in code passes, and one that is only named in the README does not | Name-dropping earns nothing |
| Importing entries from pasted lines, a CSV, JSON and a GitHub organisation, with the entry limit and bad rows | A small server is never overloaded, and bad input is refused politely |
| Copy detection: the same code with renamed variables is found, different code is not, and the earlier entry is named the original | Copies are caught fairly |
| Ranking: weighted scores, the audit's share, ties, entries kept off the ranking, and the reason for every rank | A rank never changes between page loads, and every rank is explained |
| Judging: score adjustments, disqualify and reinstate, moving entries, the decision log, finalise and reopen | Judges have the final say, and every decision is recorded |
| An entry that tries to instruct the AI judge gets no AI scores and a visible flag, AI answers are validated, and rate limits are retried | The AI cannot be talked into a rank |
| Prize payments through a stand-in Payouts API: only after finalising, only with a valid email and a matching confirmation, never twice, plus refusals, timeouts and a crash in the middle of a payment | Money moves only on purpose |
| The organiser key on every Judge mode route, wrong keys, and limits on names, prizes, ids and request size | Only the organiser can see rankings and emails, or pay |

### Manual run in the browser (Frontend and Backend together)

1. Put your sandbox keys in `.env`, restart the server, and check that the footer says "PayPal sandbox: connected". After a minute or two the terminal also says "PayPal AI Toolkit ready: create\_order, pay\_order", because the first start downloads PayPal's package.
2. Audit a repo whose verdict is not Fail. Your own repo works once it is on GitHub (next section). The **Try a public example** button audits PayPal's `paypal/agent-toolkit` repo: you get a full report, but it is not a hackathon entry and may be Fail, and Fail blocks checkout by design.
3. In the report, scroll to the certificate section and click the PayPal button.
4. In the popup log in with the sandbox Personal (buyer) email and password, then approve.
5. Expect the certificate card with a serial like `JM-63997E9A8617` and a working **Print certificate** button. Its "Paid through" line should say "PayPal AI Toolkit (MCP server)".
6. Open `/verify/<your serial>`. Expect "Valid. The signature matches, so the record has not been altered."
7. Open `/verify/JM-000000000000`. Expect "No certificate with that serial exists."
8. Log in at sandbox.paypal.com with the Business test account and find the 2.00 USD payment.

This is the first time the real PayPal sandbox and PayPal's real toolkit package meet the code, since my workspace could reach neither. If step 3 or 4 fails, Troubleshooting below lists the likely causes.

### Manual run of Judge mode

This run needs your sandbox keys in `.env` and one sandbox Personal account to act as the winner. It takes about 10 minutes.

1. Start the server and open Judge mode as in the Quick start. In **New competition**, fill the prize row: type `5` in the amount box and keep the place at 1.
2. Paste two or three public repositories under "3. The entries", click **Create competition**, and wait until each entry says Evaluated. Read the leaderboard, then open one entry and read its "Why this rank" text.
3. Try a judge's power. Adjust one score, or use the arrows in the Order column to move an entry, and look at the decision log on the competition page.
4. Click **Finalise the judgement**, then **Finalise** in the box. The first prize now shows which entry holds first place.
5. On the first-prize card, type the sandbox Personal account's email, click **Save email**, then click **Pay 5.00 USD with PayPal**. Check the amount, the winner and the email in the box, and click **Send 5.00 USD**.
6. The card says "Sent, waiting for PayPal to confirm" or "Paid". Click **Check with PayPal** until it says Paid.
7. Log in at sandbox.paypal.com with the Personal account and find the 5.00 USD. Back in JudgeMintAI click **Export CSV** and open the file.

This is the first time real PayPal sandbox payouts meet the code. If step 5 or 6 fails, the card shows PayPal's own words, and Troubleshooting below lists the likely causes.

### Postman (sponsor tool)

In Postman choose Import and select `postman/JudgeMintAI.postman_collection.json`. Its variables are already set to `http://localhost:3000` and the public example repo. Send the requests in order: Health, Public config, Start an audit, Get the audit (re-send until the status is complete), Recent audits, Create PayPal sandbox order, Capture an approved order (approve it in the PayPal popup first), Verify a certificate. Scripts in the collection save `auditId`, `orderId` and `serial` for you and check each reply.

The collection also has a folder named **Judge mode (needs the organiser key)** with ten requests. Before you run it, set the collection variable `organizerKey` to the key from your terminal. To pay a test prize, also set `winnerEmail` to the email of a sandbox Personal account. Send the requests from top to bottom: check the key (and see that a wrong key is refused), create a competition and start evaluating, get the competition until its status is ready, adjust a score, finalise the judgement, pay the first prize, check the payment, export the CSV, and list all competitions. The folder uses two public repositories, set in the variables `repoUrl` and `repoUrl2`. If finalising answers 409 "No entry can be ranked yet", both entries failed their audit, so use other repositories or change the rules.

## Going online: GitHub, Render, Zapier and Elastic

The hackathon needs a public repository with a visible open-source licence and a working demo, so this section puts the project on GitHub and Render and connects the two sponsor services.

### 1. Public GitHub repository with the MIT licence

1. Create a free account at github.com if you do not have one.
2. In VS Code open the Source Control panel (Ctrl+Shift+G). Click **Initialize Repository**. Check that `.env` is **not** in the list of changes (it is ignored on purpose). If it appears, do not commit: check that the `.gitignore` file exists in the project folder.
3. Type a message such as `First working version` and click **Commit**.
4. Click **Publish to GitHub**, sign in when the browser asks, name it `judgemintai`, and choose the **public** repository option.
5. Open the repository page. The **About** panel on the right must show **MIT license**. GitHub reads it from the `LICENSE` file and can take a minute. Use the gear next to About to add a description and, later, your Render link as the website.

Terminal alternative: run `git init`, `git add .`, `git commit -m "First working version"`, then create an empty public repository on github.com and paste the three commands GitHub shows (`git remote add origin ...`, `git branch -M main`, `git push -u origin main`). If Git says it does not know who you are, run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.

Make real commits as you go, for example after adding keys, after the first live payment and after recording the video. JudgeMintAI's own Technical agent warns about a repository with a single code-dump commit.

### 2. Render hosting (sponsor tool)

1. Sign up at render.com with your GitHub account.
2. Choose **New**, then **Blueprint**, pick the `judgemintai` repository, and apply. Render reads `render.yaml` and creates a free Node web service.
3. Render asks for the values marked secret: `LLM_API_KEY`, `GITHUB_TOKEN`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ZAPIER_WEBHOOK_URL`, `ELASTIC_URL` and `ELASTIC_API_KEY`. Paste the same sandbox values as in your `.env`; leave out any you do not use. `CERT_SECRET` and `ORGANIZER_KEY` are generated for you.
4. When the status is Live, open `https://<your-name>.onrender.com/api/health`. It must show `"ok":true`. The home page footer should say "PayPal sandbox: connected".
5. That address is your hosted demo link for the submission.

Render's free plan sleeps after about 15 minutes idle, so the first load takes up to a minute, and its disk is wiped on every deploy or restart. Open the app a minute before you record, and record the whole demo in one sitting, because audits, certificates and competitions made earlier disappear after a restart.

On the live site Judge mode asks for the organiser key, so visitors can use the audit page but cannot see rankings or pay anyone. `render.yaml` makes the key for you: open the service's **Environment** tab on Render, read the `ORGANIZER_KEY` row, and sign in to Judge mode with it before you record. Because the free plan is small, `render.yaml` limits a competition to 30 entries (`MAX_PROJECTS_HARD`) and evaluates 10 unless you choose another number (`MAX_PROJECTS_DEFAULT`).

`render.yaml` sets `PAYPAL_VIA` to `auto`, so Render uses the PayPal AI Toolkit when it is ready and PayPal's Orders API otherwise. The toolkit package downloads again after every Render restart, so check that the page footer says "PayPal AI Toolkit: ready" before you record the payment.

### 3. Zapier (sponsor tool)

1. At zapier.com choose **Create Zap**, pick the trigger app **Webhooks by Zapier**, and the event **Catch Hook**. Copy the custom webhook URL it shows.
2. Paste it as `ZAPIER_WEBHOOK_URL` in `.env` and in Render, then restart.
3. Run an audit, then press **Test trigger** in Zapier. You should see an `audit.completed` event with `project`, `repo`, `score`, `verdict` and `topFix`. A paid certificate sends `certificate.issued`. Judge mode sends `competition.finalised`, with the ranking, when the judges finalise a competition, and `prize.paid` when a prize turns to Paid. Finalise a practice competition if you want to see those too.
4. Add an action so the demo shows something useful, such as a Google Sheets row or an email for every audit.

### 4. Elastic (sponsor tool)

1. At cloud.elastic.co start the free trial and create an Elasticsearch deployment or serverless project.
2. Copy its Elasticsearch endpoint, the https address on the deployment page, with no slash at the end, into `ELASTIC_URL`.
3. Create an API key in Kibana's API keys page and paste the encoded value into `ELASTIC_API_KEY`.
4. Run an audit, open Kibana's Dev Tools console, and run `GET judgemint-audits/_search`. You should see the audit you just ran. That index name comes from `ELASTIC_INDEX`.

Judge mode adds a second index. When the judges finalise a competition, every entry is indexed in one request, with its rank, scores, flags and the reason for the rank, and never an email address. Run `GET judgemint-entries/_search` in Kibana's Dev Tools to see them, for example to search for every entry that was flagged as a copy. That index name comes from `ELASTIC_ENTRIES_INDEX`.

## PayPal AI Toolkit while you code, without a Claude subscription

You can use the PayPal AI Toolkit for free, because its MCP server works with any assistant that supports MCP and is not tied to Claude.

JudgeMintAI also uses the toolkit inside the running app, for every payment (see "The PayPal AI Toolkit inside the app" in the Backend section). The two routes below are the second use: building the project with the toolkit in your editor.

The `/plugin install paypal@claude-plugins-official` command in the hackathon brief runs inside Claude Code. [Claude's docs](https://code.claude.com/docs/en/overview) say most Claude Code surfaces need a Claude subscription or an Anthropic Console account, and you have neither, so skip it. The plugin wraps the same PayPal MCP server that `.vscode/mcp.json` in this project already sets up. The server's tools cover orders and refunds (`create_order`, `get_order`, `pay_order`), invoices, products, subscriptions, disputes, shipment tracking and transactions, listed in [PayPal's tools catalog](https://developer.paypal.com/ai-tools/agent-tools/).

I could not run either route below from my workspace, because it cannot reach npm or PayPal. The configuration matches [VS Code's MCP reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) and [PayPal's setup page](https://developer.paypal.com/tools/mcp-server/), but you are the first to run it.

### Route A: VS Code with GitHub Copilot Free

GitHub's [plan page](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-licenses) says the Free plan has "limited chat and agent usage". Allowances change, so check what your account shows.

1. Open the `judgemintai` folder in VS Code and sign in to GitHub from the account icon at the bottom left, so that Copilot Chat works.
2. Make sure `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are in `.env`, then run `node scripts/get-sandbox-token.mjs` in the terminal. It prints a long sandbox access token. It expires after a few hours, so run it again when the server says the token is invalid.
3. Press Ctrl+Shift+P, run **MCP: List Servers**, choose **paypal**, and start it. VS Code asks for the token once: paste it.
4. Open Copilot Chat, switch it to **Agent** mode, and open the tools list to confirm PayPal's tools appear.
5. Ask: "Using the PayPal tools, create a sandbox order for 2.00 USD called JudgeMintAI certificate, then fetch that order." Approve each tool call when VS Code asks. You should see an order id and its status.
6. Record this moment for your demo video. It is your proof that the toolkit was used.

PayPal also hosts a remote sandbox server at `https://mcp.sandbox.paypal.com` that signs you in through PayPal's own login page, which avoids the token step. [PayPal's setup page](https://developer.paypal.com/tools/mcp-server/) has the details.

### Route B: no AI at all, with the MCP Inspector

If your free Copilot allowance runs out, the Inspector lets you call the same tools by hand. In the VS Code terminal (PowerShell) run:

```
$env:PAYPAL_ACCESS_TOKEN = (node scripts/get-sandbox-token.mjs)
$env:PAYPAL_ENVIRONMENT = "SANDBOX"
npx @modelcontextprotocol/inspector npx -y @paypal/mcp --tools=all
```

On Mac or Linux use `export PAYPAL_ACCESS_TOKEN=$(node scripts/get-sandbox-token.mjs)` and `export PAYPAL_ENVIRONMENT=SANDBOX`. The Inspector opens in your browser. Click Connect, then Tools, then List Tools, pick `create_order`, fill in the form it shows, and run it.

### Say it truthfully in your submission

Claim only what you actually did. If the terminal said `PayPal AI Toolkit ready` and the certificate from a test payment says "Paid through PayPal AI Toolkit (MCP server)", you can write: "JudgeMintAI's server creates and captures its PayPal sandbox orders through the PayPal AI Toolkit's MCP server (`@paypal/mcp`, tools `create_order` and `pay_order`), with PayPal's Orders API as a safety net." If the toolkit never started on your computer, leave that sentence out and say that the server uses PayPal's Orders API. After step 6 of Route A, or after Route B, you can also write: "We used the PayPal AI Toolkit's MCP server (`@paypal/mcp`, configured in `.vscode/mcp.json`) inside VS Code to create and inspect sandbox orders while building the checkout." If you skip both routes, leave that sentence out. JudgeMintAI itself flags claims that have nothing behind them, and judges can do the same.

The same rule applies to the Judge mode parts. Write that prizes are paid through PayPal's Payouts API in the sandbox only if you finished the manual run of Judge mode and the prize card said Paid. If the payment did not work, write that the Pay button is built and tested against a stand-in for PayPal, and do not say that it paid anyone. Do the same for Zapier and Elastic: claim a feed only after you have seen its event in Zapier or its documents in Kibana.

## Demo video script (under 3 minutes)

Aim for 2 minutes 30 seconds. The rule is under 3 minutes, and a judge who is cut off at 3:00 never sees your ending.

| Time | On screen | Say |
| --- | --- | --- |
| 0:00 | Judge mode: the leaderboard of a finished practice competition | Judges open hundreds of entries. Some only mention the required technology, some are copies, and ranking them fairly takes days. JudgeMintAI does the first pass for the judges and leaves the final say to them. |
| 0:15 | New competition form: name, rules, entry limit, pasted list | An organiser sets the rules of any hackathon, chooses how many entries to evaluate, and pastes the entries, or imports a CSV or a GitHub organisation. |
| 0:35 | The competition page filling in as entries finish | Agents audit every entry: is the code real, is the required technology really called, is the AI real, are the licence and the video right. Entries are also compared with each other. |
| 0:55 | A flagged copy and a failed audit on the leaderboard | A copy is named with its original, and an entry that only name-drops the technology fails its audit. Both stay on the board with the reason until a judge decides. |
| 1:15 | One entry: Why this rank, the scores and their source, the evidence | Every rank has a reason in plain words, every score says whether the AI or an estimate gave it, and the evidence is one click away. |
| 1:35 | Adjust a score, move an entry with the arrows, then the decision log | Judges have the final say. They adjust scores, reinstate or disqualify, and reorder the list, and every decision is logged with the judge's name. |
| 1:55 | Finalise the judgement, then the Pay confirmation box | When the order is final, each prize gets a Pay button. It shows the amount, the winner and the email, and PayPal's Payouts API sends the money from the sandbox. |
| 2:15 | The prize card saying Paid, then sandbox.paypal.com with the payment | PayPal confirms it, and the winner's sandbox account has the money. A prize can never be paid twice, and nothing moves before the judges finalise. |
| 2:30 | The audit report and certificate with its Paid through line, then the home page | The same engine audits a single entry before the deadline, and its certificate checkout runs through the PayPal AI Toolkit. JudgeMintAI: every entry gets a hallmark, and the judges keep the final say. |

Show only what you really set up. If you skipped Elastic, Zapier or the toolkit, cut that row and say less.

### Before you record

1. Prepare a practice competition on the same server you will record on: two or three entries, one prize with a small amount, and the email of a sandbox Personal account saved for the winner. Let it finish evaluating before you record, and try the whole run once.
2. Audit your own repository first and pick a run that is not a Fail, so the certificate step works.
3. Sign in to Judge mode before you press record, and keep the terminal off screen, because it prints the organiser key.
4. Open the Render app a minute early so it is awake, and record in one sitting, because Render's free plan forgets audits and competitions when it restarts.
5. Close other tabs and notifications. Zoom the browser to about 110 percent so text is readable.
6. Do not use music. Show your own screens, and show no logos except PayPal's checkout, because the rules ban third-party trademarks and copyrighted music in the video.
7. Start the server with your PayPal keys a few minutes early and wait for "PayPal AI Toolkit ready" in the terminal. To prove in the video that the toolkit does the work, set `PAYPAL_VIA=toolkit` in `.env` and restart, and set it back to `auto` after recording.

### Record and upload

1. On Windows press Win+G for the Game Bar and record the browser window, or use the free OBS Studio. Speak yourself, or add captions.
2. Upload to YouTube, set **Visibility** to **Public**, and answer that the video is not made for kids.
3. Check that the duration under the video is below 3:00, then paste the link into the submission and into JudgeMintAI's form. With a `YOUTUBE_API_KEY` the Legal agent verifies public and under 3 minutes for you.

## Submission checklist

Every hackathon requirement maps to a place in this project, and the right-hand column is what is left for you to do.

| Requirement from the brief | Where it is covered | Your action |
| --- | --- | --- |
| Watch the four YouTube videos in the brief | Not possible for me | Watch them yourself and note any extra rules or deadlines |
| Use the PayPal AI Toolkit | `src/paypalToolkit.js`, `src/mcp.js`, `.vscode/mcp.json`, `scripts/get-sandbox-token.mjs` | Check that the terminal says "PayPal AI Toolkit ready", record a payment, and optionally do Route A or B in the toolkit section |
| Meaningful PayPal integration (sandbox) | Prize payments through the Payouts API in `src/payouts.js`, and certificate checkout through the toolkit and Orders v2 in `src/paypal.js` | Run both manual sandbox runs from the Testing section: a certificate payment and a test prize |
| Meaningful AI integration | AI scoring and head judge in `src/llm.js`, `src/scoring.js` and `src/agents/` | Add `LLM_API_KEY` and see "AI mode: LLM" at startup |
| Working prototype | The whole project, 38 automated tests | `npm test`, then try it in the browser |
| Functional demo | Hosted on Render, plus run steps in `README.md` | Deploy, then open `/api/health` on the Render address |
| Documentation | `README.md`, the PRD and this guide | Both are already in the zip. If you edit the documents here, export them again as Markdown and replace `docs/PRD.md` and `docs/GUIDE.md` |
| Text description | The section below | Paste it into the form |
| Tools list and how each is used | The section below and the README table | Paste it into the form |
| Public repository with a visible open-source licence | MIT `LICENSE` file | Publish publicly and check that About shows MIT |
| Demo video under 3 minutes, public on YouTube, no third-party trademarks or copyrighted music | The video script section | Record, upload, and check the duration |
| Sponsor tools for extra prize money | AG Grid, Render, Zapier, Elastic, Postman | Finish each setup in the going-online section |
| List every AI tool you used | The PRD's tools section | Include Claude as your coding assistant in the form |

### Final pre-flight

1. Run `npm test` and confirm 38 of 38 pass.
2. Clone your public repository into a new empty folder, copy your `.env` in, run `npm start`, and check that it works. This proves the repository has every file.
3. Audit your own repository in JudgeMintAI with your Render address, your video link and your hackathon start date. Fix the top items and run it again.
4. On the Render address, run a small competition with two or three entries, finalise it, and pay one sandbox test prize. This proves that Judge mode and PayPal Payouts work on the live site, not only on your computer.
5. Check the exact deadline and its time zone on the hackathon page, convert it to Indian time, and submit at least a few hours early.

## Submission text to copy and paste

This is the text for the submission form. Edit any sentence that is not true for what you finally built.

### Tagline

JudgeMintAI audits every hackathon entry, flags fakes and copies, ranks the rest with a reason for each rank, and pays the prizes through PayPal once the judges sign off.

### Project description

**JudgeMintAI: every hackathon submission gets a hallmark.**

Hackathon judges open hundreds of entries by hand. Many entries mention the required technology in the README but never call it, some are copies of each other, some leak keys, and some miss the licence, video or paperwork rules. Ranking the rest fairly takes days, and paying the winners is a separate chore.

An organiser creates a competition for any hackathon or contest, sets its rules (the technology entries must use, AI, licence, video, dates, and rules of their own in plain words), chooses how many entries to evaluate, and brings them in from a pasted list, a CSV, JSON or a GitHub organisation. Specialist agents audit every entry: Technical Validity, Required Technology, AI Usage, Legal and Compliance, Submission Completeness and Sponsor Tools. Entries are also compared with each other, so the same repository entered twice, forks, identical files, similar code (renamed variables do not hide it) and repeated videos or descriptions are flagged, and the original is named. Each entry is scored from 0 to 10 on criteria the organiser chooses (problem solving, impact on society, helpfulness, technical complexity, creativity, feasibility, viability and efficiency by default) and ranked, with a written reason for every rank. A single-entry mode lets a team audit its own project before the deadline.

The judges keep the final say. They can open any entry to read the evidence, adjust a score by up to five points, reinstate or disqualify an entry, and move entries up or down, and every decision is recorded with the judge's name. When the order is final, each prize gets a Pay button that shows the amount, the winner and the email before it sends the money through PayPal's Payouts API.

PayPal is central in three ways. First, prizes are paid through PayPal's Payouts API from the leaderboard: only after the judges finalise, only to a ranked entry with a valid PayPal email, only after a confirmation that repeats the amount and the email, and with a fixed reference for each attempt so that a double click or a retry cannot pay twice. Second, a PayPal agent checks that an entry's own integration is real: calls to the Orders API, sandbox use, credentials kept in environment variables, server-side capture and no mocked responses. Third, a team can buy a signed verification certificate in the PayPal sandbox. The server creates and captures that order through the PayPal AI Toolkit's MCP server, reads the order back from PayPal to check the amount and currency, and signs the certificate with HMAC-SHA256, with PayPal's Orders API as the safety net if the toolkit is down. Everything runs in the PayPal sandbox, so no real money moves.

AI is central too. A language model (Gemini 2.5 Flash by default, or any OpenAI-compatible model) scores every entry from 0 to 10 on each criterion with a short reason, checks the organiser's rules that need judgement. In the single-entry audit it also reviews the PayPal integration code and writes the head judge's notes. It sees an entry's pitch, its declared tools, an excerpt of its README and the audit's measured facts, never its source code, and text aimed at manipulating the AI judge is detected: that entry gets no AI scores and a visible flag. Rules produce the checks and the ranking maths, so every rank can be reproduced, and the model adds judgement and wording on top. Without a key, scores are labelled estimates.

It runs on Node.js with no npm dependencies, shows the leaderboard and the checks in AG Grid tables, deploys to Render, sends events to Zapier, indexes results in Elastic, and ships with a Postman collection. The code is MIT licensed, and payments run only in the PayPal sandbox unless an organiser switches live payouts on, so by default no real money moves.

### Tools used and how

| Tool | How it is used |
| --- | --- |
| PayPal Payouts API (sandbox) | Pays the prizes from the Judge mode leaderboard after the judges finalise, with a confirmation, a fixed reference for each attempt and a status check (`src/payouts.js`) |
| PayPal AI Toolkit (`@paypal/mcp`) | PayPal's MCP server, started by our server, creates and captures every certificate order through its `create_order` and `pay_order` tools. It is also used in VS Code while building the checkout, configured in `.vscode/mcp.json` |
| PayPal Orders v2 API and JavaScript SDK (sandbox) | The buyer approves a certificate payment with PayPal's buttons, the server checks every captured payment with PayPal before it signs, and it creates and captures orders directly when the toolkit is down |
| Gemini 2.5 Flash through an OpenAI-compatible API | Scores every entry on the criteria with a reason and checks the organiser's custom rules. In the single-entry audit it also reviews the PayPal code and writes the head judge's notes |
| AG Grid | The sortable, filterable leaderboard, and the table of every check in a report |
| Render | Hosts the app |
| Zapier | Receives a webhook for each finished audit and certificate, each finalised competition and each paid prize |
| Elastic | Indexes every finished single audit and, when the judges finalise a competition, every entry with its rank, scores and flags, so organisers can search across entries |
| Postman | Collection that tests the whole API, including a Judge mode run from import to prize payment |
| Node.js 20 | Backend with no npm dependencies, using the built-in `http`, `fetch`, `crypto` and `node:test` |
| Claude (Anthropic) | AI coding assistant that wrote the code, checked by the automated tests |
| VS Code, GitHub, Playwright | Editor, public repository, and browser testing during development |

Delete any row for a tool you did not actually set up.

### Built with (tags)

node.js, javascript, paypal, paypal-payouts, paypal-ai-toolkit, mcp, gemini, ag-grid, render, zapier, elasticsearch, postman, html, css

## Troubleshooting

Start with two places: the VS Code terminal that runs `npm start` prints server errors, and in the browser the F12 key opens the Console and Network tabs.

| What you see | Likely cause | Fix |
| --- | --- | --- |
| `node` or `npm` is not recognized | Node.js is missing, or VS Code was open during the install | Install the LTS version from nodejs.org and reopen VS Code |
| `EADDRINUSE` or address already in use | Another copy of the server is running | Press Ctrl+C in the other terminal, or set `PORT=3001` in `.env` |
| Footer says "PayPal sandbox: not set up" | Keys missing, `.env` misnamed (Windows may hide a `.txt` ending) or the server was not restarted | Check the file is exactly `.env`, save it, and restart `npm start` |
| `get-sandbox-token.mjs` prints HTTP 401 | Live keys, or a typo in the keys | Copy the Client ID and Secret again from the Sandbox tab |
| PayPal button never appears, or "checkout script did not load" | Ad blocker, no internet, or a wrong Client ID | Turn the blocker off for localhost, and use the Sandbox Client ID |
| PayPal popup rejects the login | You used your real PayPal login | Use the sandbox Personal account's email and password |
| Payment fails after approval | The buyer closed the popup or the sandbox card was declined | Try again, or use another sandbox Personal account |
| The terminal says "PayPal AI Toolkit could not start", or the footer says "PayPal AI Toolkit: unavailable" | npm could not download or start PayPal's package: no internet, a firewall, or `npx` is missing | Check that `npx -v` prints a version and that you are online, then restart. Payments keep working through the Orders API. To skip the toolkit, set `PAYPAL_VIA=rest` in `.env` |
| The footer says "PayPal AI Toolkit: starting up" for a long time | The very first start downloads the package from npm | Wait a minute or two for "PayPal AI Toolkit ready" in the terminal. Until then payments use the Orders API |
| The PayPal popup shows an error page for the order the toolkit created | The popup refused that order (I could not test this against the real toolkit) | Set `PAYPAL_VIA=rest` in `.env`, restart and try again, then paste the exact message into a chat with Claude |
| No pay button, a message instead | The verdict is Fail, or PayPal keys are missing | Fix the failing checks and audit again, or add the keys |
| "GitHub API rate limit reached" | 60 reads an hour without a token | Add a free `GITHUB_TOKEN` and restart |
| "Repository was not found or is private" | Private repository or a typo | Make it public and use the form `https://github.com/owner/repo` |
| Startup says AI mode is heuristic | `LLM_API_KEY` empty or invalid, or the model name changed | Check the key, and copy the current model name into `LLM_MODEL`. Audits still work |
| The checks table has no sort arrows | AG Grid's script was blocked, so the plain table is showing | Reload with internet on, and turn off blockers for the page |
| Headlines look plain | Google Fonts is blocked | Nothing to fix, the page falls back to system fonts |
| Certificate or audit gone on Render | Free plan wiped its disk on restart | Run a new audit, and record the video in one sitting |
| `git push` is rejected | Not signed in to GitHub | Use VS Code's **Publish to GitHub**, or sign in when it asks |

### Judge mode problems

The message on the page always quotes what the server or PayPal answered, in their own words. These are the problems you are most likely to meet.

| What you see | Likely cause | Fix |
| --- | --- | --- |
| "That organiser key is not correct." | The key was copied with extra words, or the server made a new one | Copy only the key from the terminal line that begins `Organiser key:`. It is also saved in `data/.organizer_key`. To choose your own, set `ORGANIZER_KEY` in `.env` and restart. On Render, read it in the Environment tab |
| "Too many wrong organiser keys. Wait ten minutes and try again." | Ten wrong keys from one address within ten minutes | Wait ten minutes, then paste the right key |
| Entries say "Could not be evaluated" with "GitHub API rate limit reached" | Without a token GitHub allows 60 reads an hour, which is about 10 entries | Add a free `GITHUB_TOKEN` to `.env`, restart, and click the button that says Evaluate and a number to do the rest |
| A warning says "No AI key is set", and scores are labelled estimates | `LLM_API_KEY` is empty | Add the key, restart, and click **Evaluate everything again**. Judge mode works without it, with estimates for the judges to review |
| Entries take a long time to turn to Evaluated | The free Gemini tier allows about 10 AI calls a minute, and the server keeps to `LLM_RPM` | Wait. Fifty entries take several minutes. A model key with a higher limit lets you raise `LLM_RPM` |
| Some entries you pasted are missing | The entry limit. The page says how many were left out | Raise "How many entries to evaluate at most" (up to `MAX_PROJECTS_HARD`) and add them again |
| An entry says "Not ranked" | Its audit failed, it was disqualified, it looks copied from another entry, or it could not be evaluated | Open the entry and read the reason. If you disagree, click **Rank it anyway (reinstate)** |
| Finalising says "No entry can be ranked yet" | Every entry failed its audit or has not been evaluated | Evaluate the entries, read why they are not ranked, and check the rules, for example a required technology that nobody uses |
| No **Pay** button on a prize | The judgement is not final, no entry holds that place, or the winner's PayPal email is missing | Click **Finalise the judgement**, then type the winner's sandbox email on the prize card and click **Save email**. The card says what is missing |
| "PayPal refused it" with NOT\_AUTHORIZED or insufficient funds | The sandbox Business account has too little money, or Payouts is not available to the app | Check the Business account's balance under Sandbox Accounts, and Payouts under your app's Features, then press **Pay** again |
| "Sent, waiting for PayPal to confirm" | PayPal accepted the payment and is still processing it | Wait a minute and click **Check with PayPal** |
| "Sent, not claimed yet" | The email has no PayPal account | Use the email of a sandbox Personal account. PayPal holds unclaimed money and returns it after 30 days |
| "Not sure it went through" | PayPal did not answer in time, or the server restarted while sending | Click **Check with PayPal** if the button is there, otherwise press **Pay** again. PayPal ignores a repeated request with the same reference |
| No **Reopen the judgement** button | A prize payment has started, so the judgement is locked | Nothing to fix, this is on purpose. Click **Export CSV** for your records |
| A competition is gone on Render | The free plan wiped its disk when the service restarted | Create it again, and click **Export CSV** before you stop |

If something else breaks, copy the exact error text from the terminal or the browser console and paste it into a chat with Claude along with the file name. That is the fastest way to get a fix.
