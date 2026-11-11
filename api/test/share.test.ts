import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, routeOf } from "../index.ts";
import { escapeHtml, scriptJson } from "../_lib/http.ts";
import { isAccountId } from "../_lib/near.ts";
import { sharePage } from "../_lib/share.ts";
import { isAccountId as toolsIsAccountId } from "../../tools/lib/config.ts";
import { fakeDeps, get } from "./helpers.ts";

const noNetwork = () => fakeDeps(() => assert.fail("/f must not use the network"));

const GOOD = ["open2.plinthfund.testnet", "fund-mwa9jwo8.plinthfund.testnet", "a.near", "ab", "a_b-c.d0.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "x".repeat(64)];
const BAD = ["", "a", "A.near", "a..near", ".near", "near.", "a--b.near", "a_.near", "-a.near", "a b.near", "a/b.near", "a.near/", "<script>", "a.near\n", "a.near?x=1", "a.near#x", "a%2enear", "é.near", "x".repeat(65), '"onload="x', "a.near'", null, undefined, 5, {}, ["a.near"]];

test("account id validation is strict and agrees with the tools", () => {
  for (const id of GOOD) assert.equal(isAccountId(id), true, String(id));
  for (const id of BAD) assert.equal(isAccountId(id), false, JSON.stringify(id));
  for (const id of [...GOOD, ...BAD]) assert.equal(isAccountId(id), toolsIsAccountId(id), JSON.stringify(id));
});

test("escapeHtml and scriptJson leave nothing that can open a tag, close an attribute or end a script", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&\`</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;");
  const s = scriptJson("</script><script>alert(1)//&\u2028");
  assert.ok(!/[<>&\u2028]/.test(s));
  assert.equal(JSON.parse(s), "</script><script>alert(1)//&\u2028");
});

test("/f/:id carries the Open Graph tags and sends browsers to the site", async () => {
  const res = await handle(get("/f/open2.plinthfund.testnet"), noNetwork());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  const html = await res.text();
  const meta = (attr: string, name: string) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`))?.[1];
  assert.equal(meta("property", "og:title"), "open2.plinthfund.testnet · Plinth fund");
  assert.ok((meta("property", "og:description") ?? "").length > 40);
  assert.equal(meta("property", "og:image"), "https://plinth.example/api/og?fund=open2.plinthfund.testnet&amp;network=testnet");
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
  assert.equal(meta("name", "twitter:image"), meta("property", "og:image"));
  assert.match(html, /<link rel="canonical" href="https:\/\/plinth\.example\/f\/open2\.plinthfund\.testnet">/);
  assert.match(html, /<meta http-equiv="refresh" content="0; url=https:\/\/plinth\.example\/\?fund=open2\.plinthfund\.testnet">/);
  assert.match(html, /location\.replace\("https:\/\/plinth\.example\/\?fund=open2\.plinthfund\.testnet"\)/);
});

test("/f/:id on mainnet keeps the network in every link", async () => {
  const html = await (await handle(get("/f/fund.plinth.near?network=mainnet"), noNetwork())).text();
  assert.match(html, /api\/og\?fund=fund\.plinth\.near&amp;network=mainnet"/);
  assert.match(html, /url=https:\/\/plinth\.example\/\?fund=fund\.plinth\.near&amp;network=mainnet"/);
  assert.match(html, /rel="canonical" href="https:\/\/plinth\.example\/f\/fund\.plinth\.near\?network=mainnet"/);
});

test("/f/:id refuses anything that is not an account id and never echoes it", async () => {
  const evil = ['"><script>alert(1)</script>', "a.near\"onload=\"x", "A.NEAR", "a..near", "x".repeat(65), "javascript:alert(1)", "a.near%0d%0aSet-Cookie:x"];
  for (const id of evil) {
    for (const path of [`/f/${encodeURIComponent(id)}`, `/api?route=f&id=${encodeURIComponent(id)}`]) {
      const res = await handle(get(path), noNetwork());
      assert.equal(res.status, 400, path);
      const html = await res.text();
      assert.ok(!html.includes("alert(1)") && !html.includes("onload") && !html.includes("A.NEAR") && !html.includes("Set-Cookie"), path);
      assert.equal(res.headers.get("set-cookie"), null);
    }
  }
  assert.equal((await handle(get("/f/a.near?network=<b>"), noNetwork())).status, 400);
  assert.equal((await handle(get("/f/%E0%A4%A"), noNetwork())).status, 400);
});

test("/f/:id works through the vercel.json rewrite form too", async () => {
  const res = await handle(get("/api?route=f&id=open2.plinthfund.testnet"), noNetwork());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /og:title" content="open2\.plinthfund\.testnet · Plinth fund"/);
});

test("the absolute URLs come from the forwarded host, and a hostile Host header is not reflected", async () => {
  const ok = await (await handle(get("/f/a.near", { "x-forwarded-host": "plinth.vercel.app", "x-forwarded-proto": "https" }), noNetwork())).text();
  assert.match(ok, /og:image" content="https:\/\/plinth\.vercel\.app\/api\/og/);
  const bad = await (await handle(get("/f/a.near", { "x-forwarded-host": 'evil.example"><script>x</script>' }), noNetwork())).text();
  assert.ok(!bad.includes("evil.example"));
  assert.match(bad, /og:image" content="https:\/\/plinth\.example\/api\/og/);
  const fixed = await (await handle(get("/f/a.near", { "x-forwarded-host": "other.example" }), fakeDeps(() => assert.fail("no network"), { PLINTH_SITE_URL: "https://plinth.fund/" }))).text();
  assert.match(fixed, /og:image" content="https:\/\/plinth\.fund\/api\/og/);
});

test("sharePage escapes whatever it is given", () => {
  // The handler never passes such values; the template must still be safe on its own.
  const html = sharePage('https://x.example"><img src=x onerror=1>', "a.near", "testnet");
  assert.ok(!html.includes('"><img'));
  assert.ok(!/<img/.test(html));
});

test("routing: path form, rewrite form, and unknown routes", async () => {
  const r = (u: string) => routeOf(new URL("https://x.example" + u));
  assert.deepEqual(r("/api/quote"), ["quote", null]);
  assert.deepEqual(r("/api?route=quote"), ["quote", null]);
  assert.deepEqual(r("/api/fund?id=a.near&route=agent"), ["fund", null]); // the path wins over a query
  assert.deepEqual(r("/f/a.near"), ["f", "a.near"]);
  assert.deepEqual(r("/api?route=f&id=a.near"), ["f", "a.near"]);
  assert.deepEqual(r("/api/nope"), ["", null]);
  assert.deepEqual(r("/api/constructor"), ["", null]);
  const res = await handle(get("/api/nope"), noNetwork());
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not_found");
});

test("health reports which variables are set as booleans only, never a value", async () => {
  const res = await handle(get("/api/health"), fakeDeps(() => assert.fail("no network"), { NEAR_AI_API_KEY: "sk-test-value", ONE_CLICK_JWT: "", VERCEL_GIT_COMMIT_SHA: "abc123" }));
  const text = await res.text();
  const j = JSON.parse(text);
  assert.deepEqual(j.env, { NEAR_AI_API_KEY: true, ONE_CLICK_JWT: false });
  assert.equal(j.commit, "abc123");
  assert.equal(typeof j.factories.testnet, "boolean");
  assert.ok(!text.includes("sk-test-value"));
});
