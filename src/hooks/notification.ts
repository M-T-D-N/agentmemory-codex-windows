#!/usr/bin/env node
import { isSdkChildContext } from "./_runtime.js";
import { resolveProject, hookCwd } from "./_project.js";
import { captureObservation, isDrainChild, runDrainChild, withEventId } from "./_capture.js";



const OBSERVE_TIMEOUT_MS = 2000;
const EXIT_CAP_MS = 2500;

async function main() {
  if (isSdkChildContext(undefined)) return;
  if (isDrainChild()) return runDrainChild();
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;
  const notificationType = data.notification_type ?? data.notificationType;
  if (notificationType !== "permission_prompt") return;

  const rawSessionId = [data.session_id, data.sessionId, data.conversation_id].find(
    (v) => typeof v === "string" && v.length > 0,
  );
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : "unknown";

  const cwd = hookCwd(data) || process.cwd();

  void captureObservation(
    withEventId(
      {
        hookType: "notification",
        sessionId,
        project: resolveProject(cwd),
        cwd,
        timestamp: new Date().toISOString(),
        data: {
          notification_type: notificationType,
          title: data.title,
          message: data.message,
        },
      },
      data,
    ),
    OBSERVE_TIMEOUT_MS,
  );
  setTimeout(() => process.exit(0), EXIT_CAP_MS).unref();
}

main().catch(() => process.exit(0));
