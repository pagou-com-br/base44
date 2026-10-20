import { CUSTOMER, call, createBase44, deps, fakeFetch, networkError, post, reply } from "./helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../functions/pagouCreateCardCharge.ts";

const TOKEN = "A".repeat(80) + "==";
const CARD = { card_token: TOKEN, holder: "PAGADOR TESTE", expires_at: "2030-12" };
const KEY = "tentativa-0001-abcdef";
const XFF = { "X-Forwarded-For": "203.0.113.10, 10.0.0.1" };

async function setup() {
  const b = createBase44();
  const order = await b.seed("Order", { user_email: "cliente@example.com", total_cents: 5000, payment_status: "pending", ...CUSTOMER });
  return { b, order };
}

const input = (orderId: string, extra: Record<string, unknown> = {}) => ({
  order_id: orderId,
  idempotency_key: KEY,
  installments: 1,
  card: CARD,
  ...extra,
});

test("cobra em centavos, com Idempotency-Key e IP real do comprador", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([
    {
      method: "POST",
      path: /^\/v1\/creditcard\/charges$/,
      reply: () => reply(201, { id: "cc-1", customer_id: "cu-1", card_id: "ca-1", value: 5000, status: "captured" }),
    },
  ]);
  const res = await call(handle, post(input(order.id), XFF), deps(b, f.fn, { now: new Date("2026-10-19T15:00:00Z") }));

  assert.equal(res.status, 201);
  assert.equal(res.body.status, "paid");
  const sent = JSON.parse(f.calls[0].body);
  assert.equal(sent.value, 5000);
  assert.equal(sent.payday, "2026-10-19");
  assert.deepEqual(sent.antifraud, { ip: "203.0.113.10" });
  assert.equal(sent.customer.document_type, "cpf");
  assert.equal(sent.customer.phone, "11999999999");
  assert.equal(f.calls[0].headers["idempotency-key"], KEY);
  assert.equal((await b.client.entities.Order.get(order.id)).payment_status, "paid");
});

test("o token do cartão nunca é gravado", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([{ method: "POST", path: /creditcard/, reply: () => reply(201, { id: "cc-1", status: "captured", value: 5000 }) }]);
  await call(handle, post(input(order.id), XFF), deps(b, f.fn));
  const stored = JSON.stringify(b.rows("PagouCharge"));
  assert.equal(stored.includes(TOKEN), false);
});

test("recusa mostra o motivo e libera nova tentativa com outra chave", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([
    { method: "POST", path: /creditcard/, reply: () => reply(201, { id: "cc-1", status: "failed", failure_reason: "Saldo insuficiente", value: 5000 }) },
  ]);
  const res = await call(handle, post(input(order.id), XFF), deps(b, f.fn));
  assert.equal(res.body.status, "failed");
  assert.equal(res.body.failure_message, "Saldo insuficiente");

  const f2 = fakeFetch([{ method: "POST", path: /creditcard/, reply: () => reply(201, { id: "cc-2", status: "captured", value: 5000 }) }]);
  const retry = await call(handle, post(input(order.id, { idempotency_key: "tentativa-0002-abcdef" }), XFF), deps(b, f2.fn));
  assert.equal(retry.body.status, "paid");
});

test("resultado incerto: repetição usa a MESMA chave e os MESMOS bytes", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([{ method: "POST", path: /creditcard/, reply: networkError }]);
  const first = await call(handle, post(input(order.id), XFF), deps(b, f.fn));
  assert.equal(first.status, 202);
  assert.equal(first.body.status, "uncertain");

  const f2 = fakeFetch([{ method: "POST", path: /creditcard/, reply: () => reply(201, { id: "cc-1", status: "captured", value: 5000 }) }]);
  // IP diferente na repetição: o corpo deve continuar idêntico ao original.
  const second = await call(handle, post(input(order.id), { "X-Forwarded-For": "198.51.100.7" }), deps(b, f2.fn));
  assert.equal(second.body.status, "paid");
  assert.equal(f2.calls[0].headers["idempotency-key"], KEY);
  assert.equal(f2.calls[0].body, f.calls[0].body);
});

test("repetição com outro cartão é recusada antes de chamar a Pagou", async () => {
  const { b, order } = await setup();
  await call(handle, post(input(order.id), XFF), deps(b, fakeFetch([{ method: "POST", path: /creditcard/, reply: networkError }]).fn));
  const f2 = fakeFetch([]);
  const res = await call(handle, post(input(order.id, { card: { ...CARD, card_token: "B".repeat(80) } }), XFF), deps(b, f2.fn));
  assert.equal(res.status, 422);
  assert.equal(f2.calls.length, 0);
});

test("nova chave com tentativa anterior incerta é bloqueada", async () => {
  const { b, order } = await setup();
  await call(handle, post(input(order.id), XFF), deps(b, fakeFetch([{ method: "POST", path: /creditcard/, reply: networkError }]).fn));
  const f2 = fakeFetch([]);
  const res = await call(handle, post(input(order.id, { idempotency_key: "tentativa-9999-abcdef" }), XFF), deps(b, f2.fn));
  assert.equal(res.status, 409);
  assert.equal(f2.calls.length, 0);
});

test("409 de idempotência fica incerto, sem trocar a chave", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([{ method: "POST", path: /creditcard/, reply: () => reply(409, { error: "x", code: "idempotency_outcome_unknown" }) }]);
  const res = await call(handle, post(input(order.id), XFF), deps(b, f.fn));
  assert.equal(res.body.status, "uncertain");
});

test("merchant_not_accredited vira mensagem amigável", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([{ method: "POST", path: /creditcard/, reply: () => reply(422, { error: "lojista não possui credenciamento", code: "merchant_not_accredited" }) }]);
  const res = await call(handle, post(input(order.id), XFF), deps(b, f.fn));
  assert.equal(res.status, 422);
  assert.match(res.body.message, /indisponível/);
});

test("valida token, parcelas e IP", async () => {
  const { b, order } = await setup();
  const f = fakeFetch([]);
  const d = deps(b, f.fn);
  assert.equal((await call(handle, post(input(order.id, { card: { ...CARD, card_token: "curto" } }), XFF), d)).status, 400);
  assert.equal((await call(handle, post(input(order.id, { installments: 13 }), XFF), d)).status, 400);
  assert.equal((await call(handle, post(input(order.id)), d)).status, 400); // sem IP
  assert.equal((await call(handle, post(input(order.id, { idempotency_key: "x" }), XFF), d)).status, 400);
  assert.equal(f.calls.length, 0);
});
