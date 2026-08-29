import type { ApiRequest } from "iii-sdk";
import { timingSafeCompare } from "./auth.js";

export interface HttpResponse {
  status_code: number;
  headers?: Record<string, string>;
  body: unknown;
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function checkBearerAuth(
  request: ApiRequest,
  secret: string | undefined,
): HttpResponse | null {
  if (!secret) return null;
  const authorization =
    request.headers?.["authorization"] || request.headers?.["Authorization"];
  if (
    typeof authorization !== "string" ||
    !timingSafeCompare(authorization, `Bearer ${secret}`)
  ) {
    return { status_code: 401, body: { error: "unauthorized" } };
  }
  return null;
}
