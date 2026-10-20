import { CUSTOMER, call, createBase44, deps, fakeFetch, networkError, post, reply } from "./helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../functions/pagouCreatePix.ts";

async function setup(total = 10050) {
  const b = createBase44();
  const order = await b.seed("Order", { user_email: "cliente@example.com", total_cents: total, payment_status: "pending", ...CUSTOMER });
  return { b, order };
}

test("cria o Pix com o valor do pedido e grava QR Code", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([
    {
      method: "POST",
      path: /^\/v1\/pix$/,
      reply: () => reply(201, { id: "pix-1", payload: { payload_id: 1, data: "COPIA_E_COLA", image: "BASE64" } }),
    },
  ]);
  // O valor enviado pelo navegador é ignorado.
  const res = await call(handle, post({ order_id: order.id, amount: 0.01 }), deps(b, f.fn));

  assert.equal(res.status, 201);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.pix_copy_paste, "COPIA_E_COLA");
  const sent = JSON.parse(f.calls[0].body);
  assert.equal(sent.amount, 100.5);
  assert.equal(sent.payer.document, "52998224725");
  assert.equal(sent.notification_url, "https://app.exemplo.com/functions/pagouWebhook");
  assert.equal(sent.customer_code, order.id);
  assert.equal(f.calls[0].headers["x-api-key"], "chave-de-teste-nao-real");
  assert.equal(f.calls[0].url, "https://api.pagou.cloud/v1/pix");
  assert.equal(b.rows("PagouCharge")[0].pagou_id, "pix-1");
});

test("omite notification_url quando não configurada (nunca manda null)", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([{ method: "POST", path: /^\/v1\/pix$/, reply: () => reply(201, { id: "pix-1", payload: {} }) }]);
  await call(handle, post({ order_id: order.id }), deps(b, f.fn, { env: { PAGOU_WEBHOOK_URL: "" } }));
  assert.equal("notification_url" in JSON.parse(f.calls[0].body), false);
});

test("timeout ou 5xx deixa incerto e NÃO repete a criação", async () => {
  for (const failure of [networkError, () => reply(502, { error: "bad gateway" })]) {
    const { b, order } = await setup();
    const f = fakeFetch([{ method: "POST", path: /^\/v1\/pix$/, reply: failure }]);
    const res = await call(handle, post({ order_id: order.id }), deps(b, f.fn));
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "uncertain");
    assert.equal(f.calls.length, 1);

    // Novo clique: devolve a cobrança incerta, sem chamar a Pagou de novo.
    const again = await call(handle, post({ order_id: order.id }), deps(b, f.fn));
    assert.equal(again.body.status, "uncertain");
    assert.equal(f.calls.length, 1);
    assert.equal(b.rows("PagouCharge").length, 1);
  }
});

test("erro 400 vira falha com a mensagem da Pagou", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([{ method: "POST", path: /^\/v1\/pix$/, reply: () => reply(400, { error: "document is not valid" }) }]);
  const res = await call(handle, post({ order_id: order.id }), deps(b, f.fn));
  assert.equal(res.status, 422);
  assert.equal(res.body.status, "failed");
  assert.match(res.body.message, /document is not valid/);
});

test("devolve o Pix ativo existente em vez de criar outro", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([{ method: "POST", path: /^\/v1\/pix$/, reply: () => reply(201, { id: "pix-1", payload: { data: "X" } }) }]);
  await call(handle, post({ order_id: order.id }), deps(b, f.fn));
  const second = await call(handle, post({ order_id: order.id }), deps(b, f.fn));
  assert.equal(second.status, 200);
  assert.equal(f.calls.length, 1);
});

test("pedido de outro usuário não é encontrado", async () => {
  const b = createBase44();
  const order = await b.seed("Order", { user_email: "outra@example.com", total_cents: 1000, payment_status: "pending", ...CUSTOMER });
  const f = fakeFetch([]);
  const res = await call(handle, post({ order_id: order.id }), deps(b, f.fn));
  assert.equal(res.status, 404);
  assert.equal(f.calls.length, 0);
});

test("sem login responde 401", async () => {
  const b = createBase44({ user: null });
  const res = await call(handle, post({ order_id: "x" }), deps(b, fakeFetch([]).fn));
  assert.equal(res.status, 401);
});
