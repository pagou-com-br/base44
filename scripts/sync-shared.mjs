// Copia o bloco <pagou-shared> de shared/pagou.ts para cada arquivo de functions/.
// O Base44 publica cada função isolada, sem importar arquivos locais, então o
// código comum precisa estar dentro de cada uma. Uso: npm run sync [-- --check]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const START = "// <pagou-shared>";
const END = "// </pagou-shared>";

function extract(text, file) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error(`Marcadores <pagou-shared> ausentes em ${file}`);
  return { before: text.slice(0, a), block: text.slice(a, b + END.length), after: text.slice(b + END.length) };
}

const shared = extract(readFileSync(join(root, "shared", "pagou.ts"), "utf8"), "shared/pagou.ts").block;
const check = process.argv.includes("--check");
const dir = join(root, "functions");
const stale = [];

for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
  const path = join(dir, name);
  const text = readFileSync(path, "utf8");
  const parts = extract(text, name);
  if (parts.block === shared) continue;
  stale.push(name);
  if (!check) writeFileSync(path, parts.before + shared + parts.after);
}

if (check && stale.length) {
  console.error(`Bloco compartilhado desatualizado em: ${stale.join(", ")}. Rode npm run sync.`);
  process.exit(1);
}
console.log(check ? "Bloco compartilhado em dia." : `Sincronizado: ${stale.length ? stale.join(", ") : "nada a fazer"}`);
