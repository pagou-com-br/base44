import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { STATUS_LABEL, formatBRL, invokePagou } from "./pagouClient";

// Painel "Pagamentos Pagou". Só para admin (as entidades só liberam leitura a admin).
export default function PagouAdminPanel() {
  const [charges, setCharges] = useState([]);
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState({ status: "", method: "" });
  const [busy, setBusy] = useState("");
  const [summary, setSummary] = useState(null);

  async function load() {
    const [c, e] = await Promise.all([
      base44.entities.PagouCharge.list("-created_date", 200),
      base44.entities.PagouWebhookEvent.list("-created_date", 100),
    ]);
    setCharges(c || []);
    setEvents(e || []);
  }

  useEffect(() => {
    load();
  }, []);

  async function reconcile() {
    setBusy("reconcile");
    const res = await invokePagou("pagouReconcile");
    setSummary(res.ok ? res.data : { error: res.data.message || "Falha na reconciliação" });
    await load();
    setBusy("");
  }

  async function check(id) {
    setBusy(id);
    await invokePagou("pagouChargeStatus", { charge_id: id });
    await load();
    setBusy("");
  }

  const rows = useMemo(
    () => charges.filter((c) => (!filter.status || c.status === filter.status) && (!filter.method || c.method === filter.method)),
    [charges, filter],
  );
  const env = charges[0]?.environment;

  return (
    <div className="space-y-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Pagamentos Pagou</h1>
          {env && (
            <span className={`rounded-full px-3 py-1 text-xs font-bold ${env === "production" ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900"}`}>
              {env === "production" ? "PRODUÇÃO" : "SANDBOX"}
            </span>
          )}
        </div>
        <button onClick={reconcile} disabled={busy === "reconcile"} className="flex items-center gap-2 rounded-lg bg-black px-4 py-2 text-sm text-white">
          {busy === "reconcile" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Reconciliar agora
        </button>
      </div>

      {summary && (
        <p className="rounded-lg bg-gray-50 p-3 text-sm">
          {summary.error ||
            `Resolvidas: ${summary.resolved} · Atualizadas: ${summary.refreshed} · Ainda incertas: ${summary.still_uncertain} · Revisão manual: ${summary.needs_review} · Eventos sem cobrança: ${summary.orphan_events}${summary.rate_limited ? " · Limite de requisições atingido" : ""}`}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))} className="rounded-lg border px-3 py-2 text-sm">
          <option value="">Todos os status</option>
          {Object.keys(STATUS_LABEL).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filter.method} onChange={(e) => setFilter((f) => ({ ...f, method: e.target.value }))} className="rounded-lg border px-3 py-2 text-sm">
          <option value="">Todos os meios</option>
          <option value="pix">Pix</option>
          <option value="boleto">Boleto</option>
          <option value="card">Cartão</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Criada</th><th className="p-3">Pedido</th><th className="p-3">Meio</th>
              <th className="p-3">Valor</th><th className="p-3">Status</th><th className="p-3">Alerta</th><th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const alert = c.status === "uncertain" || c.needs_review;
              return (
                <tr key={c.id} className={`border-t ${alert ? "bg-red-50" : ""}`}>
                  <td className="p-3 whitespace-nowrap">{new Date(c.created_date).toLocaleString("pt-BR")}</td>
                  <td className="p-3 font-mono text-xs">{c.order_id}</td>
                  <td className="p-3">{c.method}</td>
                  <td className="p-3">{formatBRL(c.amount_cents)}</td>
                  <td className="p-3">{c.status}</td>
                  <td className="p-3 text-xs text-red-700">{c.needs_review ? c.last_error_code || "revisar" : c.status === "uncertain" ? "incerta" : ""}</td>
                  <td className="p-3">
                    {c.pagou_id && (
                      <button onClick={() => check(c.id)} disabled={busy === c.id} className="rounded border px-2 py-1 text-xs">
                        {busy === c.id ? "..." : "Consultar na Pagou"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="mb-2 font-semibold">Últimas notificações</h2>
        <ul className="divide-y rounded-xl border border-gray-200 text-sm">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-3 p-3">
              <span className="font-mono text-xs">{e.name}</span>
              <span className="font-mono text-xs text-gray-500">{e.pagou_id}</span>
              <span className={e.processed ? "text-green-700" : "text-red-700"}>{e.processed ? "processado" : "pendente"}</span>
              {e.error && <span className="text-xs text-red-700">{e.error}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
