// Base44 falso em memória e fetch falso da Pagou. Nenhum teste toca a rede.
import { createHmac } from "node:crypto";

(globalThis as any).__PAGOU_TEST__ = true;

export const SANDBOX_ENV: Record<string, string> = {
  PAGOU_API_KEY: "chave-de-teste-nao-real",
  PAGOU_BASE_URL: "https://api.pagou.cloud",
  PAGOU_ENV: "sandbox",
  PAGOU_WEBHOOK_URL: "https://app.exemplo.com/functions/pagouWebhook",
};

export const CUSTOMER = {
  customer_name: "Pagador de Teste",
  customer_document: "529.982.247-25",
  customer_email: "pagador@example.com",
  customer_phone: "(11) 99999-9999",
  address_zip: "01310-100",
  address_street: "Avenida de Teste",
  address_number: "100",
  address_neighborhood: "Centro",
  address_city: "São Paulo",
  address_state: "SP",
};

type Rec = Record<string, any>;

export function createBase44(opts: { user?: Rec | null; now?: () => Date } = {}) {
  const tables = new Map<string, Map<string, Rec>>();
  let seq = 0;
  const clock = opts.now ?? (() => new Date());
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const matches = (rec: Rec, query: Rec) =>
    Object.entries(query).every(([k, v]) => (Array.isArray(v) ? v.includes(rec[k]) : rec[k] === v));

  const handler = (name: string) => ({
    async get(id: string) {
      const rec = table(name).get(id);
      if (!rec) throw new Error("not found");
      return { ...rec };
    },
    async filter(query: Rec = {}, sort = "-created_date", limit = 5000) {
      const field = sort.replace(/^-/, "");
      const dir = sort.startsWith("-") ? -1 : 1;
      return [...table(name).values()]
        .filter((r) => matches(r, query))
        .sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : (a._seq - b._seq) * dir))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async create(data: Rec) {
      const ts = clock().toISOString();
      const rec = { ...data, id: `${name.toLowerCase()}_${++seq}`, _seq: seq, created_date: ts, updated_date: ts };
      table(name).set(rec.id, rec);
      return { ...rec };
    },
    async update(id: string, data: Rec) {
      const rec = table(name).get(id);
      if (!rec) throw new Error("not found");
      Object.assign(rec, data, { updated_date: clock().toISOString() });
      return { ...rec };
    },
  });

  const entities = new Proxy({}, { get: (_t, name: string) => handler(name) });
  const user = opts.user === undefined ? { email: "cliente@example.com", role: "user" } : opts.user;
  return {
    tables,
    rows: (name: string) => [...table(name).values()],
    seed: (name: string, data: Rec) => handler(name).create(data),
    client: {
      auth: {
        async me() {
          if (!user) throw new Error("unauthenticated");
          return user;
        },
      },
      entities,
      asServiceRole: { entities },
    },
  };
}

type Route = {
  method: string;
  path: RegExp;
  reply: (call: Call) => Response | Promise<Response>;
};

export type Call = { method: string; url: string; path: string; headers: Record<string, string>; body: string };

export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fn = async (input: any, init: any = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    const call: Call = { method: init.method || "GET", url, path: new URL(url).pathname + new URL(url).search, headers, body: init.body ?? "" };
    calls.push(call);
    const route = routes.find((r) => r.method === call.method && r.path.test(call.path));
    if (!route) throw new Error(`rota não simulada: ${call.method} ${call.path}`);
    return route.reply(call);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

export const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const networkError = () => {
  throw new TypeError("fetch failed");
};

export function deps(b: ReturnType<typeof createBase44>, fetchFn: typeof fetch, opts: { env?: Record<string, string>; now?: Date } = {}) {
  const env = { ...SANDBOX_ENV, ...(opts.env || {}) };
  return {
    env: (k: string) => env[k],
    fetch: fetchFn,
    base44: b.client,
    now: () => opts.now ?? new Date(),
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
}

export function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.exemplo.com/fn", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export async function call(handle: Function, req: Request, d: any) {
  try {
    const res: Response = await handle(req, d);
    return { status: res.status, body: await res.json() };
  } catch (err: any) {
    // Mesmo tratamento do serve(): HttpError vira resposta.
    if (typeof err?.status === "number") return { status: err.status, body: { error: err.code, message: err.message } };
    throw err;
  }
}

export function signedWebhook(event: unknown, key: string, opts: { ts?: number; raw?: string; tamper?: boolean } = {}) {
  const raw = opts.raw ?? JSON.stringify(event);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(ts + raw).digest("hex");
  return new Request("https://app.exemplo.com/functions/pagouWebhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pagou-Timestamp": ts, "X-Pagou-Signature": signature },
    body: opts.tamper ? raw.replace(/\d/, "9") : raw,
  });
}
