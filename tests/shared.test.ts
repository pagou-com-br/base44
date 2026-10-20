import "./helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  centsToReais,
  getConfig,
  mapBoletoStatus,
  mapCardStatus,
  mapPixStatus,
  parsePagouError,
  reaisToCents,
  utcSeconds,
} from "../shared/pagou.ts";

const env = (vars: Record<string, string>) => (k: string) => vars[k];

test("converte reais e centavos sem erro de ponto flutuante", () => {
  assert.equal(reaisToCents(100.5), 10050);
  assert.equal(reaisToCents(0.29), 29);
  assert.equal(reaisToCents(1.15), 115); // 1.15 * 100 = 114.99999999999999
  assert.equal(reaisToCents(0.07), 7); // 0.07 * 100 = 7.000000000000001
  assert.equal(reaisToCents("19.99"), 1999);
  assert.ok(Number.isNaN(reaisToCents(undefined)));
  assert.equal(centsToReais(10050), 100.5);
  assert.equal(centsToReais(1), 0.01);
});

test("getConfig exige chave e casa ambiente com URL", () => {
  assert.throws(() => getConfig(env({ PAGOU_BASE_URL: "https://api.pagou.cloud" })), /PAGOU_API_KEY/);
  assert.throws(
    () => getConfig(env({ PAGOU_API_KEY: "x", PAGOU_ENV: "production", PAGOU_BASE_URL: "https://api.pagou.cloud" })),
    /não corresponde/,
  );
  assert.throws(
    () => getConfig(env({ PAGOU_API_KEY: "x", PAGOU_BASE_URL: "https://sandbox.api.pagou.com.br" })),
    /não corresponde/,
  );
  const cfg = getConfig(env({ PAGOU_API_KEY: "x", PAGOU_ENV: "production", PAGOU_BASE_URL: "https://api.pagou.com.br/" }));
  assert.equal(cfg.environment, "production");
  assert.equal(cfg.baseUrl, "https://api.pagou.com.br");
});

test("lê os vários formatos de erro da Pagou", () => {
  assert.deepEqual(parsePagouError({ error: "validation error", errors: ["Value is invalid"] }), {
    code: "",
    message: "validation error: Value is invalid",
  });
  assert.deepEqual(parsePagouError({ error: "lojista sem credenciamento", code: "merchant_not_accredited" }), {
    code: "merchant_not_accredited",
    message: "lojista sem credenciamento",
  });
  assert.deepEqual(parsePagouError({ error: { nested: true } }), { code: "", message: "" });
  assert.deepEqual(parsePagouError("texto"), { code: "", message: "" });
});

test("status nunca regride", () => {
  assert.equal(canTransition("active", "paid"), true);
  assert.equal(canTransition("paid", "active"), false);
  assert.equal(canTransition("paid", "canceled"), false);
  assert.equal(canTransition("canceled", "paid"), true); // boleto cancelado pago pelo Pix vinculado
  assert.equal(canTransition("paid", "partially_refunded"), true);
  assert.equal(canTransition("refunded", "partially_refunded"), false);
  assert.equal(canTransition("uncertain", "pending"), true);
});

test("mapas de status seguem a documentação", () => {
  assert.equal(mapPixStatus(4), "paid");
  assert.equal(mapPixStatus(6), null);
  assert.equal(mapBoletoStatus(9), "paid");
  assert.equal(mapBoletoStatus(6), "failed");
  assert.equal(mapBoletoStatus(7), null);
  assert.equal(mapCardStatus("authorized"), "pending");
  assert.equal(mapCardStatus("settled"), "paid");
  assert.equal(mapCardStatus("charged_back"), null);
});

test("datas de filtro em UTC sem milissegundos", () => {
  assert.equal(utcSeconds(new Date("2026-10-19T12:34:56.789Z")), "2026-10-19T12:34:56Z");
});
