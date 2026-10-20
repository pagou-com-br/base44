// pagouCreateCardCharge: cobra um cartão tokenizado no navegador.
// Entrada: POST { order_id, idempotency_key, installments, card: { card_token, holder, expires_at } }.
// O navegador gera idempotency_key uma vez por tentativa de compra e reenvia a
// MESMA chave com o MESMO cartão se a resposta vier incerta. O token nunca é
// gravado: guardamos só os demais dados da requisição e um hash do corpo, o
// que permite remontar exatamente os mesmos bytes na repetição.
// Contrato: https://docs.pagou.com.br/integracao-com-a-api/meio-de-pagamento-cartao-de-credito/criando-uma-cobranca.md

// <pagou-shared>
// Bloco compartilhado da integração Pagou. Fonte: shared/pagou.ts.
// Não edite dentro de functions/: rode `npm run sync` para propagar.

type Env = (name: string) => string | undefined;

type Deps = {
  env: Env;
  fetch: typeof fetch;
  base44: any;
  now: () => Date;
  uuid: () => string;
};

type PagouConfig = {
  baseUrl: string;
  apiKey: string;
  previousApiKey: string;
  environment: "sandbox" | "production";
  webhookUrl: string;
};

type PagouResult = {
  ok: boolean;
  status: number;
  body: any;
  uncertain: boolean;
  errorCode: string;
  errorMessage: string;
};

const PAGOU_URLS = {
  sandbox: "https://api.pagou.cloud",
  production: "https://api.pagou.com.br",
} as const;

const USER_AGENT = "Base44-Pagou/2.0";
const PAGOU_TIMEOUT_MS = 30_000;
const ORDER_ENTITY = "Order";

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json(err.status, { error: err.code, message: err.message });
  }
  console.error("pagou: erro interno", err instanceof Error ? err.message : "desconhecido");
  return json(500, { error: "internal_error", message: "Erro interno. Tente novamente em instantes." });
}

function getConfig(env: Env): PagouConfig {
  const environment = env("PAGOU_ENV") === "production" ? "production" : "sandbox";
  const baseUrl = (env("PAGOU_BASE_URL") || "").replace(/\/+$/, "");
  const apiKey = (env("PAGOU_API_KEY") || "").trim();
  if (!apiKey) throw new HttpError(500, "pagou_not_configured", "PAGOU_API_KEY não configurada.");
  if (baseUrl !== PAGOU_URLS[environment]) {
    throw new HttpError(
      500,
      "pagou_env_mismatch",
      `PAGOU_BASE_URL não corresponde a PAGOU_ENV=${environment}.`,
    );
  }
  return {
    baseUrl,
    apiKey,
    previousApiKey: (env("PAGOU_API_KEY_PREVIOUS") || "").trim(),
    environment,
    webhookUrl: (env("PAGOU_WEBHOOK_URL") || "").trim(),
  };
}

function parsePagouError(body: any): { code: string; message: string } {
  if (!body || typeof body !== "object") return { code: "", message: "" };
  const code = typeof body.code === "string" ? body.code : "";
  let message = "";
  if (typeof body.message === "string") message = body.message;
  else if (typeof body.error === "string") message = body.error;
  if (Array.isArray(body.errors)) {
    const extra = body.errors.filter((e: unknown) => typeof e === "string").join("; ");
    if (extra) message = message ? `${message}: ${extra}` : extra;
  }
  return { code, message };
}

async function pagouFetch(
  cfg: PagouConfig,
  fetchFn: typeof fetch,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<PagouResult> {
  const headers: Record<string, string> = {
    "X-API-KEY": cfg.apiKey,
    "User-Agent": USER_AGENT,
    ...extraHeaders,
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetchFn(cfg.baseUrl + path, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(PAGOU_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, body: null, uncertain: true, errorCode: "network_or_timeout", errorMessage: "Sem resposta da Pagou." };
  }
  const text = await res.text().catch(() => "");
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const { code, message } = res.ok ? { code: "", message: "" } : parsePagouError(parsed);
  return {
    ok: res.ok,
    status: res.status,
    body: parsed,
    uncertain: res.status >= 500,
    errorCode: code,
    errorMessage: message,
  };
}

function reaisToCents(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (typeof n !== "number" || !Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function centsToReais(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function onlyDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Ordem de "avanço" do status local. Um evento atrasado nunca faz o status regredir.
const STATUS_RANK: Record<string, number> = {
  creating: 0,
  uncertain: 0,
  pending: 1,
  active: 2,
  failed: 3,
  canceled: 3,
  expired: 3,
  paid: 4,
  partially_refunded: 5,
  refunded: 6,
};

function canTransition(current: string, next: string): boolean {
  if (current === next) return false;
  return (STATUS_RANK[next] ?? -1) > (STATUS_RANK[current] ?? -1);
}

const OPEN_STATUSES = ["creating", "uncertain", "pending", "active"];

function mapPixStatus(code: unknown): string | null {
  return ({ 1: "pending", 2: "active", 3: "canceled", 4: "paid", 5: "refunded" } as Record<number, string>)[Number(code)] ?? null;
}

function mapBoletoStatus(code: unknown): string | null {
  return ({ 1: "pending", 2: "active", 3: "canceled", 4: "paid", 5: "refunded", 6: "failed", 8: "paid", 9: "paid" } as Record<number, string>)[Number(code)] ?? null;
}

function mapCardStatus(status: unknown): string | null {
  return ({
    pending: "pending",
    authorized: "pending",
    captured: "paid",
    settled: "paid",
    canceled: "canceled",
    failed: "failed",
    reversed: "refunded",
  } as Record<string, string>)[String(status)] ?? null;
}

async function requireUser(base44: any): Promise<any> {
  try {
    const user = await base44.auth.me();
    if (user && user.email) return user;
  } catch {
    // cai no 401
  }
  throw new HttpError(401, "unauthorized", "Faça login para continuar.");
}

function isAdmin(user: any): boolean {
  return user?.role === "admin";
}

// ---- Adaptador do pedido -------------------------------------------------
// Única parte que depende do modelo de dados do seu app. Ajuste aqui se a
// sua entidade de pedido tiver outro nome ou outros campos.

type OrderData = {
  id: string;
  user_email: string;
  total_cents: number;
  payment_status: string;
  customer_name: string;
  customer_document: string;
  customer_email: string;
  customer_phone: string;
  address_zip: string;
  address_street: string;
  address_number: string;
  address_neighborhood: string;
  address_city: string;
  address_state: string;
};

async function loadOrderForUser(base44: any, orderId: unknown, user: any): Promise<OrderData> {
  if (typeof orderId !== "string" || !orderId) {
    throw new HttpError(400, "invalid_order", "Pedido inválido.");
  }
  let order: any;
  try {
    order = await base44.asServiceRole.entities[ORDER_ENTITY].get(orderId);
  } catch {
    order = null;
  }
  if (!order) throw new HttpError(404, "order_not_found", "Pedido não encontrado.");
  if (order.user_email !== user.email && !isAdmin(user)) {
    throw new HttpError(404, "order_not_found", "Pedido não encontrado.");
  }
  if (order.payment_status === "paid") {
    throw new HttpError(409, "order_already_paid", "Este pedido já está pago.");
  }
  const total = Number(order.total_cents);
  if (!Number.isInteger(total) || total <= 0) {
    throw new HttpError(400, "invalid_order_total", "Total do pedido inválido.");
  }
  return { ...order, total_cents: total };
}

async function markOrderPaid(base44: any, orderId: string, chargeId: string): Promise<void> {
  await base44.asServiceRole.entities[ORDER_ENTITY].update(orderId, {
    payment_status: "paid",
    pagou_charge_id: chargeId,
  });
}

async function markOrderRefunded(base44: any, orderId: string, partial: boolean): Promise<void> {
  await base44.asServiceRole.entities[ORDER_ENTITY].update(orderId, {
    payment_status: partial ? "partially_refunded" : "refunded",
  });
}
// --------------------------------------------------------------------------

// Aplica um novo status à PagouCharge respeitando a ordem e refletindo no pedido.
async function applyChargeStatus(
  base44: any,
  charge: any,
  next: string,
  extra: Record<string, unknown> = {},
): Promise<any> {
  const entities = base44.asServiceRole.entities;
  if (!canTransition(charge.status, next)) {
    if (Object.keys(extra).length) await entities.PagouCharge.update(charge.id, extra);
    return { ...charge, ...extra };
  }
  const updated = { ...extra, status: next };
  await entities.PagouCharge.update(charge.id, updated);
  if (next === "paid") await markOrderPaid(base44, charge.order_id, charge.id);
  if (next === "refunded" || next === "partially_refunded") {
    await markOrderRefunded(base44, charge.order_id, next === "partially_refunded");
  }
  return { ...charge, ...updated };
}

async function findOpenCharge(base44: any, orderId: string, method: string): Promise<any | null> {
  const found = await base44.asServiceRole.entities.PagouCharge.filter(
    { order_id: orderId, method, status: OPEN_STATUSES },
    "-created_date",
    1,
  );
  return Array.isArray(found) && found.length ? found[0] : null;
}

function publicCharge(c: any): Record<string, unknown> {
  return {
    charge_id: c.id,
    order_id: c.order_id,
    method: c.method,
    environment: c.environment,
    status: c.status,
    amount_cents: c.amount_cents,
    pix_copy_paste: c.pix_copy_paste || "",
    pix_qr_base64: c.pix_qr_base64 || "",
    pix_expires_at: c.pix_expires_at || "",
    boleto_line: c.boleto_line || "",
    boleto_barcode: c.boleto_barcode || "",
    boleto_url: c.boleto_url || "",
    boleto_pdf_url: c.boleto_pdf_url || "",
    due_date: c.due_date || "",
    failure_message: c.status === "failed" ? c.last_error_message || "" : "",
  };
}

const FINAL_STATUSES = ["paid", "partially_refunded", "refunded", "canceled", "failed"];

// Consulta a cobrança na Pagou e aplica o resultado. Leitura com falha não muda nada.
async function refreshCharge(deps: Deps, cfg: PagouConfig, charge: any): Promise<any> {
  if (!charge.pagou_id) return charge;
  const id = encodeURIComponent(charge.pagou_id);
  const base44 = deps.base44;

  if (charge.method === "pix") {
    const res = await pagouFetch(cfg, deps.fetch, "GET", `/v1/pix/${id}`);
    if (!res.ok || !res.body) return charge;
    const raw = String(res.body.status ?? "");
    const next = mapPixStatus(res.body.status);
    const extra: Record<string, unknown> = { pagou_status_raw: raw };
    if (next === "paid" && reaisToCents(res.body.amount) !== charge.amount_cents) {
      return applyChargeStatus(base44, charge, charge.status, { ...extra, last_error_code: "amount_mismatch", needs_review: true });
    }
    if (next === "paid") extra.paid_amount_cents = charge.amount_cents;
    if (next === null) extra.needs_review = true;
    return applyChargeStatus(base44, charge, next ?? charge.status, extra);
  }

  if (charge.method === "boleto") {
    const res = await pagouFetch(cfg, deps.fetch, "GET", `/v1/charges/${id}`);
    if (!res.ok || !res.body) return charge;
    const b = res.body;
    const p = b.payload && typeof b.payload === "object" ? b.payload : {};
    const extra: Record<string, unknown> = { pagou_status_raw: String(b.status ?? "") };
    if (typeof p.line === "string" && p.line) extra.boleto_line = p.line;
    if (typeof p.bar_code === "string" && p.bar_code) extra.boleto_barcode = p.bar_code;
    if (typeof p.qrcode_id === "string" && p.qrcode_id) extra.linked_qrcode_id = p.qrcode_id;
    if (typeof p.data === "string" && p.data) extra.pix_copy_paste = p.data;
    if (typeof p.image === "string" && p.image) extra.pix_qr_base64 = p.image;
    let next = mapBoletoStatus(b.status);
    if (next === null) extra.needs_review = true;
    // Boleto cancelado pode ter sido pago pelo Pix vinculado: confira o QR Code.
    const qrId = (extra.linked_qrcode_id as string) || charge.linked_qrcode_id;
    if (next === "canceled" && qrId) {
      const pix = await pagouFetch(cfg, deps.fetch, "GET", `/v1/pix/${encodeURIComponent(qrId)}`);
      if (!pix.ok) return applyChargeStatus(base44, charge, charge.status, extra);
      if (Number(pix.body?.status) === 4) {
        next = "paid";
        extra.paid_amount_cents = reaisToCents(pix.body.amount);
      }
    }
    if (next === "active" && !extra.boleto_line && !charge.boleto_line) next = "pending";
    return applyChargeStatus(base44, charge, next ?? charge.status, extra);
  }

  if (charge.method === "card") {
    const res = await pagouFetch(cfg, deps.fetch, "GET", `/v1/creditcard/charges/${id}`);
    if (!res.ok || !res.body) return charge;
    const raw = String(res.body.status ?? "");
    const extra: Record<string, unknown> = { pagou_status_raw: raw };
    if (raw === "charged_back" || raw === "unknown") extra.needs_review = true;
    if (typeof res.body.failure_reason === "string") extra.last_error_message = res.body.failure_reason;
    const next = mapCardStatus(raw);
    if (next === "paid") extra.paid_amount_cents = Number(res.body.value) || charge.amount_cents;
    return applyChargeStatus(base44, charge, next ?? charge.status, extra);
  }
  return charge;
}

declare const Deno: any;

async function realDeps(req: Request): Promise<Deps> {
  const { createClientFromRequest } = await import("npm:@base44/sdk@0.8.52");
  return {
    env: (name: string) => Deno.env.get(name),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    base44: createClientFromRequest(req),
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
  };
}

function serve(handle: (req: Request, deps: Deps) => Promise<Response>): void {
  if ((globalThis as any).__PAGOU_TEST__) return;
  Deno.serve(async (req: Request) => {
    try {
      return await handle(req, await realDeps(req));
    } catch (err) {
      return errorResponse(err);
    }
  });
}

async function readJsonBody(req: Request): Promise<any> {
  if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new HttpError(400, "invalid_json", "Corpo da requisição inválido.");
  }
}
// </pagou-shared>

const MAX_INSTALLMENTS = 12;
const TOKEN_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "").trim();
}

function validateCard(card: any): { card_token: string; holder: string; expires_at: string } {
  const token = typeof card?.card_token === "string" ? card.card_token : "";
  const holder = typeof card?.holder === "string" ? card.holder.trim() : "";
  const expiresAt = typeof card?.expires_at === "string" ? card.expires_at : "";
  if (token.length < 64 || token.length > 16384 || !TOKEN_PATTERN.test(token)) {
    throw new HttpError(400, "invalid_card_token", "Não foi possível validar o cartão. Confira os dados e tente novamente.");
  }
  if (holder.length < 2) throw new HttpError(400, "invalid_holder", "Informe o nome impresso no cartão.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(expiresAt)) {
    throw new HttpError(400, "invalid_expiration", "Validade do cartão inválida.");
  }
  return { card_token: token, holder, expires_at: expiresAt };
}

// Ordem fixa das chaves: a repetição precisa gerar os mesmos bytes.
function buildBody(snapshot: any, card: Record<string, string>): string {
  return JSON.stringify({
    customer: snapshot.customer,
    card: { card_token: card.card_token, holder: card.holder, expires_at: card.expires_at },
    value: snapshot.value,
    installments: snapshot.installments,
    payday: snapshot.payday,
    description: snapshot.description,
    antifraud: snapshot.antifraud,
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function send(deps: Deps, cfg: PagouConfig, charge: any, bodyText: string): Promise<Response> {
  const entities = deps.base44.asServiceRole.entities;
  const res = await pagouFetch(cfg, deps.fetch, "POST", "/v1/creditcard/charges", bodyText, {
    "Idempotency-Key": charge.idempotency_key,
  });

  if (res.ok && typeof res.body?.id === "string" && typeof res.body?.status === "string") {
    const raw = res.body.status;
    const next = mapCardStatus(raw) ?? "pending";
    const extra: Record<string, unknown> = {
      pagou_id: res.body.id,
      pagou_status_raw: raw,
      card_customer_id: typeof res.body.customer_id === "string" ? res.body.customer_id : "",
      card_id: typeof res.body.card_id === "string" ? res.body.card_id : "",
    };
    if (next === "failed") {
      extra.last_error_code = "card_failed";
      extra.last_error_message = typeof res.body.failure_reason === "string" && res.body.failure_reason
        ? res.body.failure_reason
        : "Pagamento recusado. Tente outro cartão.";
    }
    if (next === "paid") extra.paid_amount_cents = Number(res.body.value) || charge.amount_cents;
    if (raw === "unknown") extra.needs_review = true;
    const updated = await applyChargeStatus(deps.base44, charge, next, extra);
    return json(201, publicCharge(updated));
  }

  const conflictCodes = ["idempotency_in_progress", "idempotency_outcome_unknown", "idempotency_key_conflict"];
  if (res.uncertain || res.ok || conflictCodes.includes(res.errorCode)) {
    const update: Record<string, unknown> = { status: "uncertain", last_error_code: res.errorCode || `http_${res.status}` };
    if (res.errorCode === "idempotency_key_conflict") update.needs_review = true;
    await entities.PagouCharge.update(charge.id, update);
    console.warn("pagou: cobrança de cartão com resultado incerto", { charge_id: charge.id, status: res.status, code: res.errorCode });
    return json(202, publicCharge({ ...charge, ...update }));
  }

  const friendly: Record<string, string> = {
    merchant_not_accredited: "Pagamento com cartão indisponível no momento.",
    card_expired: "Cartão vencido. Use outro cartão.",
    document_type_mismatch: "CPF/CNPJ do pagador inválido.",
    installments_exceed_max: "Número de parcelas acima do permitido para este cartão.",
  };
  const message = res.status === 401
    ? "Pagamento indisponível no momento."
    : friendly[res.errorCode] || res.errorMessage || "Não foi possível processar o cartão.";
  const update = { status: "failed", last_error_code: res.errorCode || `http_${res.status}`, last_error_message: message };
  await entities.PagouCharge.update(charge.id, update);
  if (res.status === 401) console.error("pagou: credencial recusada (401). Confira PAGOU_API_KEY e PAGOU_ENV.");
  return json(422, { error: "pagou_rejected", message, ...publicCharge({ ...charge, ...update }) });
}

async function handle(req: Request, deps: Deps): Promise<Response> {
  const input = await readJsonBody(req);
  const cfg = getConfig(deps.env);
  const user = await requireUser(deps.base44);
  const entities = deps.base44.asServiceRole.entities;

  const key = typeof input.idempotency_key === "string" ? input.idempotency_key : "";
  if (!IDEMPOTENCY_PATTERN.test(key)) {
    throw new HttpError(400, "invalid_idempotency_key", "Identificador da tentativa inválido. Recarregue a página.");
  }
  const card = validateCard(input.card);

  // Mesma chave já usada: é a repetição da mesma compra.
  const existing = await entities.PagouCharge.filter({ idempotency_key: key }, "-created_date", 1);
  if (Array.isArray(existing) && existing.length) {
    const charge = existing[0];
    if (charge.user_email !== user.email && !isAdmin(user)) {
      throw new HttpError(404, "charge_not_found", "Pagamento não encontrado.");
    }
    if (charge.status !== "uncertain" && charge.status !== "creating") return json(200, publicCharge(charge));
    const snapshot = JSON.parse(charge.request_snapshot || "{}");
    const bodyText = buildBody(snapshot, card);
    if ((await sha256Hex(bodyText)) !== charge.request_fingerprint) {
      throw new HttpError(422, "retry_body_mismatch", "Use o mesmo cartão da tentativa anterior para confirmar o pagamento.");
    }
    return send(deps, cfg, charge, bodyText);
  }

  const order = await loadOrderForUser(deps.base44, input.order_id, user);
  const open = await findOpenCharge(deps.base44, order.id, "card");
  if (open) {
    if (open.status === "uncertain" || open.status === "creating") {
      throw new HttpError(409, "previous_attempt_uncertain", "Ainda estamos confirmando o pagamento anterior deste pedido. Aguarde alguns minutos.");
    }
    return json(200, publicCharge(open));
  }

  const installments = Number(input.installments ?? 1);
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) {
    throw new HttpError(400, "invalid_installments", "Número de parcelas inválido.");
  }
  const ip = clientIp(req);
  if (!ip) throw new HttpError(400, "missing_ip", "Não foi possível identificar sua conexão. Tente novamente.");

  const document = onlyDigits(order.customer_document);
  const phone = onlyDigits(order.customer_phone);
  const customer = {
    document,
    document_type: document.length === 14 ? "cnpj" : "cpf",
    name: String(order.customer_name || "").trim(),
    email: String(order.customer_email || order.user_email || "").trim(),
    phone,
    address: {
      zip_code: onlyDigits(order.address_zip),
      street: String(order.address_street || "").trim(),
      number: String(order.address_number || "").trim(),
      neighborhood: String(order.address_neighborhood || "").trim(),
      city: String(order.address_city || "").trim(),
      state: String(order.address_state || "").trim().toUpperCase(),
    },
  };
  const problems: string[] = [];
  if (document.length !== 11 && document.length !== 14) problems.push("CPF/CNPJ");
  if (customer.name.length < 3) problems.push("nome");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) problems.push("e-mail");
  if (phone.length < 10 || phone.length > 14) problems.push("telefone");
  if (customer.address.zip_code.length !== 8) problems.push("CEP");
  if (!/^[A-Z]{2}$/.test(customer.address.state)) problems.push("UF");
  if (!customer.address.street || !customer.address.number || !customer.address.neighborhood || !customer.address.city) {
    problems.push("endereço");
  }
  if (problems.length) throw new HttpError(400, "invalid_payer", `Confira os dados do pagador: ${problems.join(", ")}.`);

  const now = deps.now();
  const snapshot = {
    customer,
    value: order.total_cents,
    installments,
    payday: utcDate(now),
    description: `Pedido ${order.id}`,
    antifraud: { ip },
  };
  const bodyText = buildBody(snapshot, card);

  // A chave e o snapshot são gravados ANTES do envio.
  const charge = await entities.PagouCharge.create({
    order_id: order.id,
    user_email: order.user_email,
    method: "card",
    environment: cfg.environment,
    amount_cents: order.total_cents,
    status: "creating",
    idempotency_key: key,
    request_snapshot: JSON.stringify(snapshot),
    request_fingerprint: await sha256Hex(bodyText),
    created_window_start: now.toISOString(),
  });
  return send(deps, cfg, charge, bodyText);
}

export { handle };
serve(handle);
