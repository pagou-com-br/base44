import { CUSTOMER, call, createBase44, deps, fakeFetch, post, reply } from "./helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle as createBoleto } from "../functions/pagouCreateBoleto.ts";
import { handle as chargeStatus } from "../functions/pagouChargeStatus.ts";

async function setup(total = 10050) {
  const b = createBase44();
  const order = await b.seed("Order", { user_email: "cliente@example.com", total_cents: total, payment_status: "pending", ...CUSTOMER });
  return { b, order };
}

test("emite boleto com endereço em strings, vencimento UTC e links da fatura", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([{ method: "POST", path: /^\/v1\/charges$/, reply: () => reply(201, { id: "ch-1" }) }]);
  const res = await call(
    createBoleto,
    post({ order_id: order.id }),
    deps(b, f.fn, { now: new Date("2026-10-19T23:30:00Z"), env: { PAGOU_BOLETO_FINE_PERCENT: "2" } }),
  );
  assert.equal(res.status, 201);
  assert.equal(res.body.status, "pending");
  assert.equal(res.body.boleto_url, "https://fatura.pagou.com.br/boleto/ch-1");
  assert.equal(res.body.boleto_pdf_url, "https://fatura.pagou.com.br/boleto/pdf/ch-1");
  const sent = JSON.parse(f.calls[0].body);
  assert.equal(sent.due_date, "2026-10-22");
  assert.equal(sent.grace_period, 7);
  assert.equal(sent.payer.zip, "01310100");
  assert.equal(sent.payer.number, "100");
  assert.equal(sent.fine, 2);
  assert.equal("interest" in sent, false);
});

test("boleto abaixo de R$ 5,00 é recusado antes da API", async () => {
  const { b, order } = await setup(499);
  const f = fakeFetch([]);
  const res = await call(createBoleto, post({ order_id: order.id }), deps(b, f.fn));
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test("endereço incompleto é recusado com a lista do que falta", async () => {
  const b = createBase44();
  const order = await b.seed("Order", { user_email: "cliente@example.com", total_cents: 1000, payment_status: "pending", ...CUSTOMER, address_zip: "123", address_state: "Sao Paulo" });
  const res = await call(createBoleto, post({ order_id: order.id }), deps(b, fakeFetch([]).fn));
  assert.equal(res.status, 400);
  assert.match(res.body.message, /CEP.*UF/);
});

test("consulta: boleto cancelado mas Pix vinculado pago = pago", async () => {
  const { b, order } = await setup();
  const charge = await b.seed("PagouCharge", {
    order_id: order.id, user_email: "cliente@example.com", method: "boleto", environment: "sandbox",
    amount_cents: 10050, status: "active", pagou_id: "ch-1", boleto_line: "LINHA",
  });
  const f = fakeFetch([
    { method: "GET", path: /^\/v1\/charges\/ch-1$/, reply: () => reply(200, { id: "ch-1", status: 3, payload: { qrcode_id: "qr-9" } }) },
    { method: "GET", path: /^\/v1\/pix\/qr-9$/, reply: () => reply(200, { id: "qr-9", status: 4, amount: 100.5 }) },
  ]);
  const res = await call(chargeStatus, post({ charge_id: charge.id }), deps(b, f.fn));
  assert.equal(res.body.status, "paid");
  assert.equal((await b.client.entities.Order.get(order.id)).payment_status, "paid");
});

test("consulta: Pix pago com valor divergente não libera", async () => {
  const { b, order } = await setup();
  const charge = await b.seed("PagouCharge", {
    order_id: order.id, user_email: "cliente@example.com", method: "pix", environment: "sandbox",
    amount_cents: 10050, status: "active", pagou_id: "pix-1",
  });
  const f = fakeFetch([{ method: "GET", path: /^\/v1\/pix\/pix-1$/, reply: () => reply(200, { id: "pix-1", status: 4, amount: 1 }) }]);
  const res = await call(chargeStatus, post({ charge_id: charge.id }), deps(b, f.fn));
  assert.equal(res.body.status, "active");
  assert.equal(b.rows("PagouCharge")[0].needs_review, true);
});

test("consulta: cobrança final não chama a Pagou", async () => {
  const { b, order } = await setup();
  const charge = await b.seed("PagouCharge", {
    order_id: order.id, user_email: "cliente@example.com", method: "pix", environment: "sandbox",
    amount_cents: 10050, status: "paid", pagou_id: "pix-1",
  });
  const f = fakeFetch([]);
  const res = await call(chargeStatus, post({ charge_id: charge.id }), deps(b, f.fn));
  assert.equal(res.body.status, "paid");
  assert.equal(f.calls.length, 0);
});

test("consulta: falha de leitura não altera nada", async () => {
  const { b, order } = await setup();
  const charge = await b.seed("PagouCharge", {
    order_id: order.id, user_email: "cliente@example.com", method: "card", environment: "sandbox",
    amount_cents: 10050, status: "pending", pagou_id: "cc-1",
  });
  const f = fakeFetch([{ method: "GET", path: /creditcard/, reply: () => reply(503, {}) }]);
  const res = await call(chargeStatus, post({ charge_id: charge.id }), deps(b, f.fn));
  assert.equal(res.body.status, "pending");
});
