import type { HttpRequest as ApiRequest } from "@iii-dev/helpers/http";
import { checkRequestGuard, configuredAllowedOrigins, timingSafeCompare } from "./auth.js";

let resolveHttpOriginPorts: () => Array<number | null | undefined> = () => [3111, 3113];

export function setHttpOriginPorts(resolve: () => Array<number | null | undefined>): void {
  resolveHttpOriginPorts = resolve;
}

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
  const rejected = checkRequestGuard({
    method: request.method,
    headers: request.headers,
    allowedOrigins: configuredAllowedOrigins(resolveHttpOriginPorts()),
  });
  if (rejected) return rejected;
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
