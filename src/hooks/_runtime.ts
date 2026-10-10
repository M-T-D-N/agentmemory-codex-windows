import { resolveClientSecret } from "../secret-store.js";
export { isSdkChildContext } from "./sdk-guard.js";

export const REST_URL =
  process.env["AGENTMEMORY_URL"] || "http://localhost:3111";


export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = resolveClientSecret(REST_URL);
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  return headers;
}
