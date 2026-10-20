import { useEffect, useState } from "react";
import { Check, Copy, FileText, Loader2 } from "lucide-react";
import { STATUS_LABEL, SandboxBadge, formatBRL, invokePagou, startPolling } from "./pagouClient";

// Tela de boleto. O registro é assíncrono: a linha digitável aparece quando a
// Pagou confirma o registro (webhook charge.created ou consulta).
export default function PagouBoletoPayment({ orderId, isAdmin = false, onPaid }) {
  const [charge, setCharge] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [simMsg, setSimMsg] = useState("");

  async function generate() {
    setLoading(true);
    setError("");
    const res = await invokePagou("pagouCreateBoleto", { order_id: orderId });
    setLoading(false);
    if (res.data.charge_id) setCharge(res.data);
    if (!res.ok) setError(res.data.message || "Não foi possível emitir o boleto.");
  }

  useEffect(() => {
    if (!charge?.charge_id || charge.status === "paid") return undefined;
    return startPolling(
      charge.charge_id,
      (c) => {
        setCharge(c);
        if (c.status === "paid") onPaid?.(c);
      },
      { intervalMs: 10_000, maxMs: 30 * 60_000 },
    );
  }, [charge?.charge_id]);

  async function copy(text, which) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Não foi possível copiar.");
    }
  }

  async function simulate() {
    setSimMsg("Enviando simulação...");
    const res = await invokePagou("pagouSimulate", { charge_id: charge.charge_id });
    setSimMsg(res.data.message || (res.ok ? "Simulação aceita." : "Simulação recusada."));
  }

  if (!charge) {
    return (
      <div className="mx-auto w-full max-w-md space-y-3 p-4">
        <button
          onClick={generate}
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-3 font-medium text-white disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Pagar com boleto
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  const registered = Boolean(charge.boleto_line);

  return (
    <div className="mx-auto w-full max-w-md space-y-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {formatBRL(charge.amount_cents)}
          {charge.due_date && ` · vence ${charge.due_date.split("-").reverse().join("/")}`}
        </p>
        <SandboxBadge environment={charge.environment} />
      </div>

      <p className="text-base font-semibold">{STATUS_LABEL[charge.status]}</p>

      {charge.status === "paid" && (
        <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-800">
          <Check className="h-5 w-5" /> Recebemos seu pagamento.
        </div>
      )}

      {["pending", "active"].includes(charge.status) && !registered && (
        <p className="flex items-center gap-2 text-sm text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin" /> Gerando seu boleto...
        </p>
      )}

      {charge.status === "active" && registered && (
        <div className="space-y-3">
          <p className="break-all rounded-lg bg-gray-50 p-3 font-mono text-xs">{charge.boleto_line}</p>
          <button
            onClick={() => copy(charge.boleto_line, "line")}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-3 font-medium text-white"
          >
            {copied === "line" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied === "line" ? "Linha copiada" : "Copiar linha digitável"}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <a href={charge.boleto_url} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-300 px-3 py-2 text-center text-sm">
              Abrir boleto
            </a>
            <a href={charge.boleto_pdf_url} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-300 px-3 py-2 text-center text-sm">
              Baixar PDF
            </a>
          </div>

          {charge.pix_copy_paste && (
            <div className="space-y-2 border-t border-gray-100 pt-3">
              <p className="text-sm font-medium">Prefere pagar com Pix?</p>
              {charge.pix_qr_base64 && (
                <img src={`data:image/png;base64,${charge.pix_qr_base64}`} alt="QR Code Pix" className="mx-auto h-48 w-48" />
              )}
              <button
                onClick={() => copy(charge.pix_copy_paste, "pix")}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm"
              >
                {copied === "pix" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied === "pix" ? "Código copiado" : "Copiar código Pix"}
              </button>
            </div>
          )}
        </div>
      )}

      {charge.status === "uncertain" && (
        <p className="text-sm text-gray-600">Aguarde alguns instantes. Não emita outro boleto para este pedido.</p>
      )}
      {charge.status === "failed" && <p className="text-sm text-red-600">{charge.failure_message || error}</p>}

      {isAdmin && charge.environment === "sandbox" && charge.status === "active" && charge.pix_copy_paste && (
        <div className="border-t border-dashed border-gray-200 pt-3">
          <button onClick={simulate} className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm">
            Simular pagamento pelo Pix (teste)
          </button>
          {simMsg && <p className="mt-2 text-xs text-gray-500">{simMsg}</p>}
        </div>
      )}
    </div>
  );
}
