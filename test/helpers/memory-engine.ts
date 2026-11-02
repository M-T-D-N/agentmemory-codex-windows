import { AsyncResource } from "node:async_hooks";

// Isolated engine boundary only: no real StateModule, network, model or records.
// Deliver registered handlers in a fresh async context, like SDK socket ingress.
export function memoryEngine(before?: (id: string, payload: any) => Promise<void>, flush?: () => unknown) {
  const ingress = new AsyncResource("fixture-engine-ingress");
  const functions = new Map<string, (...args: any[]) => any>();
  const rows = new Map<string, any>();
  const sdk = {
    functions, rows,
    registerFunction(id: string | { id: string }, handler: (...args: any[]) => any) {
      const key = typeof id === "string" ? id : id.id; functions.set(key, handler);
      return { unregister: () => functions.delete(key) };
    },
    async trigger({ function_id: id, payload: p, metadata }: any): Promise<any> {
      const handler = functions.get(id);
      if (handler) return ingress.runInAsyncScope(handler, undefined, p, metadata);
      await before?.(id, p);
      const address = JSON.stringify([p?.scope, p?.key]);
      const entries = () => [...rows].filter(([key]) => JSON.parse(key)[0] === p.scope);
      if (id === "state::list_groups") return { groups: [...new Set([...rows.keys()].map(key => JSON.parse(key)[0]))] };
      if (id === "state::get") return rows.get(address) ?? null;
      if (id === "state::set") { rows.set(address, structuredClone(p.value)); return p.value; }
      if (id === "state::delete") { rows.delete(address); return null; }
      if (id === "state::list") return entries().map(([, value]) => value);
      if (id === "state::list_page") { const all = entries(); return { entries: all.slice(p.offset, p.offset + p.limit).map(([key, value]) => ({ key: JSON.parse(key)[1], value })), total: all.length, next_offset: p.offset + p.limit < all.length ? p.offset + p.limit : null }; }
      if (id === "state::update") {
        const old_value = rows.get(address) ?? {}; const new_value = { ...old_value };
        for (const op of p.ops) {
          if (op.type !== "set" || op.path.includes(".")) throw Error("Unsupported fixture update");
          new_value[op.path] = op.value;
        }
        rows.set(address, new_value); return { old_value, new_value, errors: [] };
      }
      if (id === "state::flush") return await flush?.() ?? { durability: "file-flush-v1", flushedScopes: rows.size };
      if (id.startsWith("stream::")) return null;
      throw Error("Unexpected fixture RPC: " + id);
    },
  };
  return sdk;
}
