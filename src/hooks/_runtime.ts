export { isSdkChildContext } from "./sdk-guard.js";

export const REST_URL =
  process.env["AGENTMEMORY_URL"] || "http://localhost:3111";

const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
  return headers;
}
