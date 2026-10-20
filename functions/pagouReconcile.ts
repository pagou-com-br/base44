// pagouReconcile: resolve cobranças incertas e cobre webhooks perdidos.
// Só admin (botão no painel) ou automação agendada com o segredo PAGOU_CRON_SECRET
// no header X-Cron-Secret. Nunca cria cobrança: só lista, consulta e atualiza.
// Entrada: POST {}.

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

const MAX_PER_RUN = 50;
const UNCERTAIN_MIN_AGE_MS = 2 * 60_000;
const UNCERTAIN_GIVE_UP_MS = 60 * 60_000;
const STALE_OPEN_MS = 30 * 60_000;

async function authorize(req: Request, deps: Deps): Promise<void> {
  const secret = (deps.env("PAGOU_CRON_SECRET") || "").trim();
  const sent = req.headers.get("x-cron-secret") || "";
  if (secret.length >= 32 && sent.length === secret.length) {
    const a = new TextEncoder().encode(sent);
    const b = new TextEncoder().encode(secret);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (diff === 0) return;
  }
  const user = await requireUser(deps.base44);
  if (!isAdmin(user)) throw new HttpError(403, "forbidden", "Apenas administradores.");
}

function windowParams(charge: any): string {
  const start = new Date(charge.created_window_start || charge.created_date);
  const from = utcSeconds(new Date(start.getTime() - 2 * 60_000));
  const to = utcSeconds(new Date(start.getTime() + 10 * 60_000));
  return `created_at_from=${encodeURIComponent(from)}&created_at_to=${encodeURIComponent(to)}`;
}

// Procura na Pagou a cobrança criada durante a janela da tentativa incerta.
async function locate(deps: Deps, cfg: PagouConfig, charge: any): Promise<{ found: any | null; rateLimited: boolean; failed: boolean }> {
  const win = windowParams(charge);
  if (charge.method === "card") {
    const res = await pagouFetch(cfg, deps.fetch, "GET", `/v1/creditcard/charges?${win}&limit=100&offset=0`);
    if (!res.ok) return { found: null, rateLimited: res.status === 429, failed: true };
    const items = Array.isArray(res.body?.items) ? res.body.items : [];
    const matches = items.filter((it: any) => Number(it.value) === charge.amount_cents && it.description === `Pedido ${charge.order_id}`);
    return { found: matches.length === 1 ? matches[0] : null, rateLimited: false, failed: matches.length > 1 };
  }
  const path = charge.method === "pix" ? "/v1/pix" : "/v1/charges";
  const res = await pagouFetch(cfg, deps.fetch, "GET", `${path}?${win}&limit=100&offset=0`);
  if (!res.ok) return { found: null, rateLimited: res.status === 429, failed: true };
  const items = Array.isArray(res.body) ? res.body : []; // lista vazia pode vir como null
  const matches = items.filter((it: any) => it.customer_code === charge.order_id && reaisToCents(it.amount) === charge.amount_cents);
  return { found: matches.length === 1 ? matches[0] : null, rateLimited: false, failed: matches.length > 1 };
}

async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  await authorize(req, deps);
  const cfg = getConfig(deps.env);
  const entities = deps.base44.asServiceRole.entities;
  const now = deps.now().getTime();
  const summary = { resolved: 0, still_uncertain: 0, gave_up: 0, needs_review: 0, refreshed: 0, orphan_events: 0, rate_limited: false };

  const uncertain = await entities.PagouCharge.filter(
    { status: ["uncertain", "creating"], environment: cfg.environment },
    "created_date",
    MAX_PER_RUN,
  );
  for (const charge of Array.isArray(uncertain) ? uncertain : []) {
    const age = now - new Date(charge.created_window_start || charge.created_date).getTime();
    if (age < UNCERTAIN_MIN_AGE_MS) continue;

    if (charge.pagou_id) {
      await refreshCharge(deps, cfg, charge);
      summary.refreshed++;
      continue;
    }
    const { found, rateLimited, failed } = await locate(deps, cfg, charge);
    if (rateLimited) {
      summary.rate_limited = true;
      break;
    }
    if (found && typeof found.id === "string") {
      const extra: Record<string, unknown> = { pagou_id: found.id };
      if (charge.method === "boleto") {
        extra.boleto_url = `https://fatura.pagou.com.br/boleto/${encodeURIComponent(found.id)}`;
        extra.boleto_pdf_url = `https://fatura.pagou.com.br/boleto/pdf/${encodeURIComponent(found.id)}`;
      }
      await entities.PagouCharge.update(charge.id, extra);
      await refreshCharge(deps, cfg, { ...charge, ...extra });
      summary.resolved++;
      continue;
    }
    if (failed && charge.method !== "card") {
      summary.still_uncertain++;
      continue;
    }
    if (age > UNCERTAIN_GIVE_UP_MS) {
      if (charge.method === "card") {
        // Cartão pode ter sido cobrado sem que a gente saiba: decisão humana.
        await entities.PagouCharge.update(charge.id, { needs_review: true });
        summary.needs_review++;
      } else {
        await entities.PagouCharge.update(charge.id, {
          status: "failed",
          last_error_code: "not_found_after_uncertain",
          last_error_message: "A cobrança não foi encontrada na Pagou. Gere uma nova.",
        });
        summary.gave_up++;
      }
    } else {
      summary.still_uncertain++;
    }
  }

  if (!summary.rate_limited) {
    const open = await entities.PagouCharge.filter(
      { status: ["pending", "active"], environment: cfg.environment },
      "updated_date",
      MAX_PER_RUN,
    );
    for (const charge of Array.isArray(open) ? open : []) {
      const updatedAt = new Date(charge.updated_date || charge.created_date).getTime();
      if (now - updatedAt < STALE_OPEN_MS) continue;
      await refreshCharge(deps, cfg, charge);
      summary.refreshed++;
    }
  }

  const orphans = await entities.PagouWebhookEvent.filter({ processed: false }, "-created_date", MAX_PER_RUN);
  summary.orphan_events = Array.isArray(orphans) ? orphans.length : 0;

  return json(200, summary);
}

export { handle };
serve(handle);
