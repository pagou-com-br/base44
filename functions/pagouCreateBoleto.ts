// pagouCreateBoleto: emite um boleto para um pedido do usuário logado.
// Entrada: POST { order_id }. O registro é assíncrono: a linha digitável chega
// pelo webhook charge.created (ou pela consulta), não na resposta da criação.
// Contrato: https://docs.pagou.com.br/integracao-com-a-api/meio-de-pagamento-boleto/criando-um-boleto.md

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

const BOLETO_MIN_CENTS = 500;
const DEFAULT_DUE_DAYS = 3;
const DEFAULT_GRACE_DAYS = 7;

function percentFromEnv(deps: Deps, name: string): number | null {
  const raw = (deps.env(name) || "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100 || (n > 0 && n < 0.1)) {
    throw new HttpError(500, "pagou_invalid_setting", `${name} deve ser 0 ou entre 0.1 e 100.`);
  }
  return n;
}

function intFromEnv(deps: Deps, name: string, fallback: number, min: number, max: number): number {
  const raw = (deps.env(name) || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(500, "pagou_invalid_setting", `${name} deve ser inteiro entre ${min} e ${max}.`);
  }
  return n;
}

async function handle(req: Request, deps: Deps): Promise<Response> {
  const input = await readJsonBody(req);
  const cfg = getConfig(deps.env);
  const user = await requireUser(deps.base44);
  const order = await loadOrderForUser(deps.base44, input.order_id, user);
  const entities = deps.base44.asServiceRole.entities;

  const open = await findOpenCharge(deps.base44, order.id, "boleto");
  if (open) return json(200, publicCharge(open));

  if (order.total_cents < BOLETO_MIN_CENTS) {
    throw new HttpError(400, "boleto_min_amount", "O boleto exige valor mínimo de R$ 5,00.");
  }

  const payer = {
    name: String(order.customer_name || "").trim(),
    document: onlyDigits(order.customer_document),
    zip: onlyDigits(order.address_zip),
    street: String(order.address_street || "").trim(),
    city: String(order.address_city || "").trim(),
    state: String(order.address_state || "").trim().toUpperCase(),
    number: String(order.address_number || "").trim(),
    neighborhood: String(order.address_neighborhood || "").trim(),
  };
  const problems: string[] = [];
  if (!payer.name) problems.push("nome");
  if (payer.document.length !== 11 && payer.document.length !== 14) problems.push("CPF/CNPJ");
  if (payer.zip.length !== 8) problems.push("CEP");
  if (!/^[A-Z]{2}$/.test(payer.state)) problems.push("UF");
  if (!payer.street || !payer.city || !payer.number || !payer.neighborhood) problems.push("endereço");
  if (problems.length) {
    throw new HttpError(400, "invalid_payer", `Confira os dados do pagador: ${problems.join(", ")}.`);
  }

  const now = deps.now();
  const dueDays = intFromEnv(deps, "PAGOU_BOLETO_DUE_DAYS", DEFAULT_DUE_DAYS, 0, 60);
  const dueDate = utcDate(new Date(now.getTime() + dueDays * 86_400_000));

  const body: Record<string, unknown> = {
    amount: centsToReais(order.total_cents),
    description: `Pedido ${order.id}`,
    due_date: dueDate,
    grace_period: intFromEnv(deps, "PAGOU_BOLETO_GRACE_DAYS", DEFAULT_GRACE_DAYS, 1, 30),
    payer,
    customer_code: order.id,
    metadata: [{ key: "order_id", value: order.id }],
  };
  const fine = percentFromEnv(deps, "PAGOU_BOLETO_FINE_PERCENT");
  const interest = percentFromEnv(deps, "PAGOU_BOLETO_INTEREST_MONTHLY_PERCENT");
  if (fine !== null) body.fine = fine;
  if (interest !== null) body.interest = interest;
  if (cfg.webhookUrl) body.notification_url = cfg.webhookUrl;

  const charge = await entities.PagouCharge.create({
    order_id: order.id,
    user_email: order.user_email,
    method: "boleto",
    environment: cfg.environment,
    amount_cents: order.total_cents,
    status: "creating",
    due_date: dueDate,
    created_window_start: now.toISOString(),
  });

  const res = await pagouFetch(cfg, deps.fetch, "POST", "/v1/charges", body);

  if (res.ok && typeof res.body?.id === "string") {
    const id = encodeURIComponent(res.body.id);
    const update = {
      pagou_id: res.body.id,
      status: "pending",
      boleto_url: `https://fatura.pagou.com.br/boleto/${id}`,
      boleto_pdf_url: `https://fatura.pagou.com.br/boleto/pdf/${id}`,
    };
    await entities.PagouCharge.update(charge.id, update);
    return json(201, publicCharge({ ...charge, ...update }));
  }

  if (res.uncertain || res.ok) {
    const update = { status: "uncertain", last_error_code: res.errorCode || `http_${res.status}` };
    await entities.PagouCharge.update(charge.id, update);
    console.warn("pagou: criação de boleto com resultado incerto", { charge_id: charge.id, status: res.status });
    return json(202, publicCharge({ ...charge, ...update }));
  }

  const message = res.status === 401
    ? "Pagamento indisponível no momento."
    : res.errorMessage || "Não foi possível emitir o boleto. Confira seus dados.";
  const update = { status: "failed", last_error_code: res.errorCode || `http_${res.status}`, last_error_message: message };
  await entities.PagouCharge.update(charge.id, update);
  if (res.status === 401) console.error("pagou: credencial recusada (401). Confira PAGOU_API_KEY e PAGOU_ENV.");
  return json(422, { error: "pagou_rejected", message, ...publicCharge({ ...charge, ...update }) });
}

export { handle };
serve(handle);
