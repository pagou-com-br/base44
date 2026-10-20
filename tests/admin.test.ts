import { call, createBase44, deps, fakeFetch, post, reply } from "./helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle as simulate } from "../functions/pagouSimulate.ts";
import { handle as reconcile } from "../functions/pagouReconcile.ts";
import { handle as config } from "../functions/pagouConfig.ts";

const ADMIN = { email: "admin@example.com", role: "admin" };
const NOW = new Date("2026-10-19T15:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

async function charge(b: any, data: Record<string, unknown>) {
  const order = await b.seed("Order", { user_email: "cliente@example.com", total_cents: 10050, payment_status: "pending" });
  return b.seed("PagouCharge", { order_id: order.id, user_email: "cliente@example.com", environment: "sandbox", amount_cents: 10050, ...data });
}

test("simulação: só admin e só Sandbox", async () => {
  const user = createBase44();
  assert.equal((await call(simulate, post({ charge_id: "x" }), deps(user, fakeFetch([]).fn))).status, 403);

  const admin = createBase44({ user: ADMIN });
  const prod = { PAGOU_ENV: "production", PAGOU_BASE_URL: "https://api.pagou.com.br" };
  assert.equal((await call(simulate, post({ charge_id: "x" }), deps(admin, fakeFetch([]).fn, { env: prod }))).status, 403);
});

test("simulação de Pix: sem corpo, chave fixa por cobrança, 202 não paga", async () => {
  const b = createBase44({ user: ADMIN });
  const c = await charge(b, { method: "pix", status: "active", pagou_id: "pix-1" });
  const f = fakeFetch([
    { method: "POST", path: /^\/v1\/payment-simulations\/pix\/pix-1$/, reply: () => reply(202, { id: "sim_1", status: "processing" }) },
  ]);
  const d = deps(b, f.fn);
  const res = await call(simulate, post({ charge_id: c.id }), d);
  await call(simulate, post({ charge_id: c.id }), d);
  assert.equal(res.status, 202);
  assert.equal(f.calls[0].body, "");
  assert.equal(f.calls[0].headers["idempotency-key"], `sim-${c.id}`);
  assert.equal(f.calls[1].headers["idempotency-key"], `sim-${c.id}`);
  assert.equal(b.rows("PagouCharge")[0].status, "active");
});

test("simulação de boleto envia exatamente {\"payment_method\":\"pix\"}", async () => {
  const b = createBase44({ user: ADMIN });
  const c = await charge(b, { method: "boleto", status: "active", pagou_id: "ch-1" });
  const f = fakeFetch([{ method: "POST", path: /charges\/ch-1$/, reply: () => reply(202, { id: "sim_2", status: "processing" }) }]);
  await call(simulate, post({ charge_id: c.id }), deps(b, f.fn));
  assert.equal(f.calls[0].body, '{"payment_method":"pix"}');
});

test("reconciliação acha o Pix incerto pela janela e customer_code", async () => {
  const b = createBase44({ user: ADMIN });
  const c = await charge(b, { method: "pix", status: "uncertain", created_window_start: minutesAgo(5) });
  const f = fakeFetch([
    {
      method: "GET",
      path: /^\/v1\/pix\?created_at_from=/,
      reply: () => reply(200, [
        { id: "outro", customer_code: "pedido-x", amount: 100.5 },
        { id: "pix-77", customer_code: c.order_id, amount: 100.5 },
      ]),
    },
    { method: "GET", path: /^\/v1\/pix\/pix-77$/, reply: () => reply(200, { id: "pix-77", status: 4, amount: 100.5 }) },
  ]);
  const res = await call(reconcile, post({}), deps(b, f.fn, { now: NOW }));
  assert.equal(res.body.resolved, 1);
  const row = b.rows("PagouCharge")[0];
  assert.equal(row.pagou_id, "pix-77");
  assert.equal(row.status, "paid");
  assert.match(f.calls[0].path, /created_at_from=2026-10-19T14%3A53%3A00Z&created_at_to=2026-10-19T15%3A05%3A00Z&limit=100&offset=0/);
});

test("reconciliação: lista vazia (null) e tempo esgotado viram falha; cartão vai para revisão", async () => {
  const b = createBase44({ user: ADMIN });
  await charge(b, { method: "pix", status: "uncertain", created_window_start: minutesAgo(90) });
  await charge(b, { method: "card", status: "uncertain", created_window_start: minutesAgo(90) });
  const f = fakeFetch([
    { method: "GET", path: /^\/v1\/pix\?/, reply: () => reply(200, null) },
    { method: "GET", path: /^\/v1\/creditcard\/charges\?/, reply: () => reply(200, { items: [], total: 0 }) },
  ]);
  const res = await call(reconcile, post({}), deps(b, f.fn, { now: NOW }));
  assert.equal(res.body.gave_up, 1);
  assert.equal(res.body.needs_review, 1);
  const [pix, card] = b.rows("PagouCharge");
  assert.equal(pix.status, "failed");
  assert.equal(card.status, "uncertain");
  assert.equal(card.needs_review, true);
});

test("reconciliação nunca cria cobrança", async () => {
  const b = createBase44({ user: ADMIN });
  await charge(b, { method: "pix", status: "uncertain", created_window_start: minutesAgo(5) });
  const f = fakeFetch([{ method: "GET", path: /^\/v1\/pix\?/, reply: () => reply(200, []) }]);
  await call(reconcile, post({}), deps(b, f.fn, { now: NOW }));
  assert.equal(f.calls.every((c) => c.method === "GET"), true);
});

test("reconciliação exige admin ou segredo de agendamento", async () => {
  const user = createBase44();
  assert.equal((await call(reconcile, post({}), deps(user, fakeFetch([]).fn))).status, 403);
  const anon = createBase44({ user: null });
  const secret = "s".repeat(40);
  const ok = await call(reconcile, post({}, { "X-Cron-Secret": secret }), deps(anon, fakeFetch([]).fn, { env: { PAGOU_CRON_SECRET: secret } }));
  assert.equal(ok.status, 200);
  const bad = await call(reconcile, post({}, { "X-Cron-Secret": "t".repeat(40) }), deps(anon, fakeFetch([]).fn, { env: { PAGOU_CRON_SECRET: secret } }));
  assert.equal(bad.status, 401);
});

test("config pública não expõe a chave", async () => {
  const b = createBase44();
  const res = await call(config, new Request("https://x/", { method: "POST" }), deps(b, fakeFetch([]).fn));
  assert.deepEqual(res.body, { environment: "sandbox", production: false });
});
