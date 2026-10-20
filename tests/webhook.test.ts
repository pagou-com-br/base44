import { SANDBOX_ENV, call, createBase44, deps, fakeFetch, signedWebhook } from "./helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../functions/pagouWebhook.ts";

const KEY = SANDBOX_ENV.PAGOU_API_KEY;

async function setup(charge: Record<string, unknown> = {}) {
  const b = createBase44({ user: null });
  const order = await b.seed("Order", { user_email: "cliente@example.com", total_cents: 10050, payment_status: "pending" });
  const c = await b.seed("PagouCharge", {
    order_id: order.id,
    method: "pix",
    environment: "sandbox",
    amount_cents: 10050,
    status: "active",
    pagou_id: "pix-1",
    ...charge,
  });
  return { b, order, charge: c, d: deps(b, fakeFetch([]).fn) };
}

const completed = (overrides: Record<string, unknown> = {}) => ({
  name: "qrcode.completed",
  data: { id: "pix-1", transaction_id: "tx-1", e2e_id: "e2e", amount: 100.5, ...overrides },
});

test("Pix pago com assinatura válida marca a cobrança e o pedido", async () => {
  const { b, order, d } = await setup();
  const res = await call(handle, signedWebhook(completed(), KEY), d);
  assert.equal(res.status, 200);
  assert.equal(b.rows("PagouCharge")[0].status, "paid");
  assert.equal(b.rows("PagouCharge")[0].paid_amount_cents, 10050);
  assert.equal((await b.client.entities.Order.get(order.id)).payment_status, "paid");
  assert.equal(b.rows("PagouWebhookEvent")[0].processed, true);
});

test("assinatura inválida, corpo alterado ou timestamp velho: 401 sem efeito", async () => {
  const cases = [
    signedWebhook(completed(), "outra-chave"),
    signedWebhook(completed(), KEY, { tamper: true }),
    signedWebhook(completed(), KEY, { ts: Math.floor(Date.now() / 1000) - 301 }),
    new Request("https://x/", { method: "POST", body: JSON.stringify(completed()) }),
  ];
  for (const req of cases) {
    const { b, d } = await setup();
    const res = await call(handle, req, d);
    assert.equal(res.status, 401);
    assert.equal(b.rows("PagouCharge")[0].status, "active");
    assert.equal(b.rows("PagouWebhookEvent").length, 0);
  }
});

test("assinatura é calculada sobre os bytes originais, não sobre JSON remontado", async () => {
  const { b, d } = await setup();
  // Espaços e ordem de chaves incomuns: remontar o JSON quebraria a assinatura.
  const raw = '{ "data": {"amount":100.5,  "id":"pix-1","transaction_id":"tx-1"}, "name":"qrcode.completed" }';
  const res = await call(handle, signedWebhook(null, KEY, { raw }), d);
  assert.equal(res.status, 200);
  assert.equal(b.rows("PagouCharge")[0].status, "paid");
});

test("aceita a chave anterior durante a rotação", async () => {
  const { b } = await setup();
  const d = deps(b, fakeFetch([]).fn, { env: { PAGOU_API_KEY: "chave-nova", PAGOU_API_KEY_PREVIOUS: KEY } });
  const res = await call(handle, signedWebhook(completed(), KEY), d);
  assert.equal(res.status, 200);
});

test("reenvio do mesmo evento não aplica o efeito duas vezes", async () => {
  const { b, d } = await setup();
  await call(handle, signedWebhook(completed(), KEY), d);
  const again = await call(handle, signedWebhook(completed(), KEY), d);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(b.rows("PagouWebhookEvent").length, 1);
});

test("valor divergente não libera o pedido", async () => {
  const { b, order, d } = await setup();
  await call(handle, signedWebhook(completed({ amount: 1 }), KEY), d);
  const c = b.rows("PagouCharge")[0];
  assert.equal(c.status, "active");
  assert.equal(c.last_error_code, "amount_mismatch");
  assert.equal(c.needs_review, true);
  assert.equal((await b.client.entities.Order.get(order.id)).payment_status, "pending");
});

test("devolução parcial e depois total", async () => {
  const { b, d } = await setup({ status: "paid", paid_amount_cents: 10050 });
  await call(handle, signedWebhook({ name: "qrcode.refunded", data: { id: "pix-1", transaction_id: "r-1", amount: 50 } }, KEY), d);
  assert.equal(b.rows("PagouCharge")[0].status, "partially_refunded");
  await call(handle, signedWebhook({ name: "qrcode.refunded", data: { id: "pix-1", transaction_id: "r-2", amount: 50.5 } }, KEY), d);
  assert.equal(b.rows("PagouCharge")[0].status, "refunded");
  assert.equal(b.rows("PagouCharge")[0].refunded_amount_cents, 10050);
});

test("evento atrasado não faz o pedido regredir", async () => {
  const { b, d } = await setup({ method: "boleto", pagou_id: "ch-1", status: "paid" });
  const created = { name: "charge.created", data: { id: "ch-1", transaction_id: "t", payload: { line: "LINHA", bar_code: "BARRA" } } };
  await call(handle, signedWebhook(created, KEY), d);
  const c = b.rows("PagouCharge")[0];
  assert.equal(c.status, "paid");
  assert.equal(c.boleto_line, "LINHA");
});

test("boleto: registro, Pix vinculado e pagamento", async () => {
  const { b, order, d } = await setup({ method: "boleto", pagou_id: "ch-1", status: "pending" });
  const created = {
    name: "charge.created",
    data: { id: "ch-1", transaction_id: "t-1", payload: { line: "LINHA", bar_code: "BARRA", qrcode_id: "qr-9", data: "PIX", image: "IMG" } },
  };
  await call(handle, signedWebhook(created, KEY), d);
  let c = b.rows("PagouCharge")[0];
  assert.equal(c.status, "active");
  assert.equal(c.linked_qrcode_id, "qr-9");
  assert.equal(c.pix_copy_paste, "PIX");

  const paid = { name: "charge.paid", data: { id: "ch-1", transaction_id: "t-2", amount: { paid: 102.3, original: 100.5 }, paid_in: "boleto" } };
  await call(handle, signedWebhook(paid, KEY), d);
  c = b.rows("PagouCharge")[0];
  assert.equal(c.status, "paid");
  assert.equal(c.paid_amount_cents, 10230);
  assert.equal((await b.client.entities.Order.get(order.id)).payment_status, "paid");
});

test("boleto pago pelo Pix vinculado (evento traz o ID do QR Code)", async () => {
  const { b, d } = await setup({ method: "boleto", pagou_id: "ch-1", linked_qrcode_id: "qr-9", status: "active" });
  await call(handle, signedWebhook(completed({ id: "qr-9" }), KEY), d);
  assert.equal(b.rows("PagouCharge")[0].status, "paid");
});

test("usa o campo name: event_name não é reconhecido", async () => {
  const { b, d } = await setup();
  const res = await call(handle, signedWebhook({ event_name: "qrcode.completed", data: { id: "pix-1", amount: 100.5 } }, KEY), d);
  assert.equal(res.status, 400);
  assert.equal(b.rows("PagouCharge")[0].status, "active");
});

test("cobrança desconhecida: guarda o evento e responde 200", async () => {
  const { b, d } = await setup();
  const res = await call(handle, signedWebhook(completed({ id: "nao-existe" }), KEY), d);
  assert.equal(res.status, 200);
  const ev = b.rows("PagouWebhookEvent")[0];
  assert.equal(ev.processed, false);
  assert.equal(ev.error, "charge_not_found");
});

test("falha ao gravar o evento devolve 500 para a Pagou reenviar", async () => {
  const { b, d } = await setup();
  const broken = { ...d, base44: { ...b.client, asServiceRole: { entities: new Proxy({}, { get: () => ({ filter: async () => { throw new Error("db"); } }) }) } } };
  const res = await call(handle, signedWebhook(completed(), KEY), broken);
  assert.equal(res.status, 500);
});
