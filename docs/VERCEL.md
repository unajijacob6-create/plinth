# Running Plinth's server routes on Vercel (free Hobby plan)

The Plinth site is a static page. It works on GitHub Pages with nothing behind it: the browser reads
the chain itself. Vercel adds a few optional server routes on top of the same site: share links with
a preview picture, a quote proxy, one-request fund listings, and an AI operator demo.

Nothing on Vercel can move a fund's money. There is no NEAR key there, and none must ever be added.

Facts about Vercel in this page were checked against vercel.com/docs in November 2026. The whole
configuration was also built locally with `vercel build` (CLI 65.14.0). It has not been deployed by
the author of this page; the first real deployment is the one you make below.

## What is deployed

| What | Where in the repository | Becomes |
|---|---|---|
| The site | `web/` built by `npm run web:build` into `web/dist` | static files at `/` |
| One Vercel Function | `api/index.ts` (code in `api/_lib/`) | every `/api/...` route and `/f/<fund>` |
| Settings | `vercel.json` | build command, output folder, the two rewrites, 60 s limit for the function |

`vercel.json` builds the site with `PLINTH_BASE=/` (Vercel serves it at the root, GitHub Pages at
`/plinth/`) and `VITE_PLINTH_API=` (empty: "the API is on this same address"). The GitHub Pages
workflow sets neither, so that build is unchanged and uses no API.

## Set it up, click by click

1. Open https://vercel.com/signup, choose **Hobby** (the free plan, for personal non-commercial
   use), and **Continue with GitHub**. Sign in with the GitHub account that owns the repository.
2. On the dashboard choose **Add New… → Project**. Under **Import Git Repository** find `plinth`
   and press **Import**. If it is not listed, press **Adjust GitHub App Permissions** (or
   **Configure GitHub App**) and give the Vercel GitHub App access to this one repository.
3. On the configuration screen:
   - **Framework Preset**: Vite (`vercel.json` also says so).
   - **Root Directory**: leave as it is (the repository root).
   - **Build and Output Settings**: leave everything off. `vercel.json` supplies the build
     command and the output folder, and overrides whatever is typed here.
   - **Environment Variables**: none are needed for the first deployment. See the next section.
4. Press **Deploy**. After about a minute you get an address like `https://plinth-xxxx.vercel.app`.
5. Open `https://<your address>/api/health`. You should see something like:

   ```json
   {"ok":true,"env":{"NEAR_AI_API_KEY":false,"ONE_CLICK_JWT":false},"factories":{"testnet":false,"mainnet":false},"commit":"<git sha>","node":"v26.x.x","time":"..."}
   ```

   `env` shows only whether each variable is set, never its value. `commit` is the commit that was
   built. `factories` says whether `data/releases.json` names a fund factory for each network.
6. Open `https://<your address>/f/open2.plinthfund.testnet`. The browser should land on the site
   with that fund selected. Open `https://<your address>/api/og?fund=open2.plinthfund.testnet`: you
   should see the preview picture.

From now on every push to the `main` branch is deployed to that address, and every other branch
or pull request gets its own preview address. GitHub Pages keeps deploying as before; the two do
not affect each other.

## Environment variables

Both are optional. Without them every route still answers; two of them answer less.

| Name | What it is | Where it comes from | Without it |
|---|---|---|---|
| `NEAR_AI_API_KEY` | API key for NEAR AI Cloud (`https://cloud-api.near.ai/v1`) | Your NEAR AI Cloud account, API keys page | `POST /api/agent` answers 503 `agent_not_configured`. Everything else works. |
| `ONE_CLICK_JWT` | Partner token (a JWT) for NEAR Intents 1Click, sent as `Authorization: Bearer` | The 1Click Partner Dashboard, https://partners.near-intents.org | `POST /api/quote` still works, but 1Click adds its platform fee for requests without a token (0.25% per its documentation, November 2026). The response header `x-plinth-jwt` says `no`. |

To add one: open the project on vercel.com, **Settings → Environment Variables**, set **Type** to
**Secret** (write-only after saving), enter the name and the value, tick **Production** (and
**Preview** only if you want preview deployments to use it too), **Save**. Then open
**Deployments**, the **…** menu of the latest one, **Redeploy**: a variable only reaches
deployments made after it was saved. Check `/api/health` again; the variable should now say `true`.

Things to know before adding them:

- `NEAR_AI_API_KEY`: every successful `POST /api/agent` spends this key's credits, and anyone on
  the internet can call the route. Each call is one completion of at most 1200 output tokens. The
  route allows 3 calls in a row per address and then one a minute, and 20 in a row overall and
  then one every 30 s. Those limits live in the memory of one running copy of the function, so
  they slow abuse down but do not cap spending. Use a key with a small balance or a spending
  limit set on the NEAR AI side, and remove the variable when the demo is over.
- `ONE_CLICK_JWT`: anyone can request quotes through `/api/quote` with your token attached (the
  token itself never leaves the server). The proxy forwards only plain quote fields and drops fee
  and partner fields (`appFees`, `rebates`, `insured`, `confidentiality`).
- Never add any other secret. In particular no NEAR account key, no operator key, no seed phrase.

Optional, not secret (Type **Config**):

| Name | Use |
|---|---|
| `PLINTH_FACTORY_TESTNET`, `PLINTH_FACTORY_MAINNET` | Factory account to list funds from, if you want to override `data/releases.json`. |
| `PLINTH_AGENT_MODEL` | Model for `/api/agent` (default: the one in `tools/lib/nearai.ts`). |
| `PLINTH_SITE_URL` | `https://your-domain` to use in share links instead of the address the request came to. |

## What each route does

All `/api` routes send `access-control-allow-origin: *`, so the GitHub Pages copy of the site (or
anyone else) may call them. Errors are JSON: `{"error": "<code>", "message": "<sentence>"}`.

| Route | What it does | Cached by Vercel's CDN |
|---|---|---|
| `GET /api/health` | Which variables are set (true/false), the commit, the Node version. | no |
| `POST /api/quote` | Sends an allow-listed copy of the JSON body to 1Click `POST /v0/quote`, adding the partner token if set. Returns 1Click's status and body unchanged, byte for byte (the fund contract checks 1Click's signature over it). Body at most 8 KB, JSON object only, 10 s limit, 20 in a row per address then one a second. | never |
| `GET /api/tokens` | 1Click `GET /v0/tokens`, unchanged. | 60 s |
| `POST /api/agent` | Body `{"fund": "<account>", "network": "testnet"\|"mainnet", "note": "<up to 1000 characters>"}`. Reads the fund from the chain itself, asks the model on NEAR AI Cloud for one decision, and returns the decision, the model's signed receipt with the exact bytes, and whether the receipt verifies. **It proposes nothing on chain.** | never |
| `GET /api/funds?network=testnet` | Funds created by the factory (newest first), each with a short summary from `get_fund`, then the three funds that predate the factory, marked `legacy` and `known_issue`. If no factory is configured, or it cannot be read, only the legacy funds. | 20 s |
| `GET /api/fund?id=<account>&network=testnet` | One fund: account, number of access keys, which code it runs and whether that is a Plinth release, `get_fund`, the last 10 trades and refusals. | 20 s |
| `GET /api/og?fund=<account>&network=testnet` | A 1200×630 PNG drawn from the chain at that moment: account, access keys (red if not 0), release (or "known issue", or "unknown code"), holdings, trades, refusals. | 60 s |
| `GET /f/<account>` | A tiny page with the preview tags for chats and social sites, which sends a browser on to `/?fund=<account>`. Add `?network=mainnet` for a mainnet fund. | no |

`/api/funds`, `/api/fund` and `/api/og` are a convenience, not a verification. They look a code
hash up in `data/releases.json`; they do not download or inspect the code. The site's Verify box
and `npm run verify` do that, from the chain, without trusting this server.

## Staying on the free plan

- Stay on **Hobby** and do not add a payment method. Hobby has no bills: when a monthly allowance
  runs out, that feature pauses (in most cases until 30 days have passed) instead of costing money.
- Allowances that matter here (per month): 1,000,000 function invocations, 4 hours of active CPU,
  360 GB-hours of memory, 100 GB of data transfer. A function may run up to 300 s on Hobby; this
  project sets its own limit of 60 s.
- Hobby is for personal, non-commercial use. A hackathon demo fits. A fund run as a business does
  not; that needs the Pro plan.
- The CDN caching above means repeated views of the same fund or picture mostly do not start the
  function at all.
- No cron job is configured. (Hobby allows cron jobs at most once a day; nothing here needs one.)
- Do not enable paid add-ons (Web Analytics beyond the free tier, Speed Insights, extra team seats).
- To stop everything: **Settings → General → Delete Project**. The GitHub Pages site is untouched.

## What is deliberately not on Vercel

- **Any key with power over a fund.** A Plinth fund has no access keys at all. The only account
  that can do anything is the operator, and all it can do is propose a trade that the contract
  then checks. The operator's key stays on the operator's own machine (`npm run operate`). If it
  sat in a Vercel variable, anyone who got into the Vercel or GitHub account could propose trades.
  So `/api/agent` stops at "this is what the model decided".
- **Deploying funds or factories** (`npm run deploy`, `tools/factory.ts`). Those sign transactions
  with keys from `~/.near-credentials` and stay on a personal machine.
- **Verification.** Whether a fund is keyless and runs known code is checked in the visitor's
  browser, straight from the chain. Moving it to a server would ask people to trust the server.
- **Wallet actions** (join, exit, claim). They go from the visitor's wallet to the chain.
- **A database, accounts, logs of who asked what.** The function keeps nothing between requests
  except small in-memory rate-limit counters and token names.
- **Scheduled trading.** No cron job proposes trades; see the first point.

## If something is wrong

| You see | Likely cause |
|---|---|
| `/api/health` gives 404 | The project's **Root Directory** is not the repository root, or `api/index.ts` / `vercel.json` are not on the deployed branch. |
| Build fails at `npm run web:build` | Open the deployment's **Build Logs**. It is the same command CI runs. |
| A variable still shows `false` | It was saved after the last deployment (redeploy), or it is not ticked for **Production**. |
| `/api/agent` gives 502 `model_error` | NEAR AI Cloud refused the call: wrong key, no credits, or the model name is not available. |
| `/api/agent` or `/api/quote` gives 429 | The rate limit. The `retry-after` header says how many seconds to wait. |
| `/api/fund` gives 503 `rpc_unavailable` | The public NEAR RPC (fastnear) is rate limiting or down. It is retried once; try again shortly. |
| A chat shows no preview for an `/f/...` link | With Vercel's Standard Protection, every address except the production one asks for a Vercel login; share links from the production address. Most chats also remember a link's preview for hours. |
| New files under `api/` show up as extra routes | Every `.ts` file under `api/` whose path has no `_` prefix becomes its own function. Keep helpers in `api/_lib/` and tests in `api/_test/`. |

## Checking it without deploying

```
npm run test:api     # no network: quote proxy, share page, fund listing, picture, agent
npm run typecheck
```
