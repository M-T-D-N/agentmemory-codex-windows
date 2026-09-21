import type { ISdk } from "iii-sdk";
import { execFile } from "node:child_process";
import { constants as bufferConstants } from "node:buffer";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SnapshotMeta,
  ExportData,
} from "../types.js";
import { generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { captureExportData, importExportData } from "./export-import.js";
import { logger } from "../logger.js";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const MAX_SNAPSHOT_BYTES = bufferConstants.MAX_STRING_LENGTH;

const execFileAsync = promisify(execFile);

async function gitExec(dir: string, args: string[], maxBuffer?: number): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir, ...(maxBuffer === undefined ? {} : { maxBuffer }) });
  return stdout.trim();
}

async function ensureGitRepo(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(join(dir, ".git"))) {
    await gitExec(dir, ["init"]);
    await gitExec(dir, ["config", "user.email", "agentmemory@local"]);
    await gitExec(dir, ["config", "user.name", "agentmemory"]);
  }
}

export function registerSnapshotFunction(
  sdk: ISdk,
  kv: StateKV,
  snapshotDir: string,
  onObservationsImported?: () => void,
): void {
  // Serialize snapshots: the periodic timer, REST (api::snapshot-create), and
  // MCP can all trigger this concurrently. Two runs writing state.json and
  // committing in the same git repo at once race on the index lock. An
  // overlapping call is a no-op success; the winner captures current state.
  let snapshotInFlight = false;

  sdk.registerFunction("mem::snapshot-create",
    async (data?: { message?: string }) => {
      if (snapshotInFlight) {
        return { success: true, message: "Snapshot already in progress" };
      }
      snapshotInFlight = true;

      try {
        await ensureGitRepo(snapshotDir);
        const ts = new Date().toISOString();

        const state = { ...await captureExportData(kv), timestamp: ts };
        const serialized = JSON.stringify(state, null, 2);
        if (Buffer.byteLength(serialized, "utf-8") > MAX_SNAPSHOT_BYTES) throw Error("Snapshot exceeds the supported JSON byte limit");

        writeFileSync(
          join(snapshotDir, "state.json"),
          serialized,
          "utf-8",
        );

        await gitExec(snapshotDir, ["add", "."]);

        const message = data?.message || `Snapshot ${ts}`;
        try {
          await gitExec(snapshotDir, ["commit", "-m", message]);
        } catch (commitErr) {
          const errMsg =
            commitErr instanceof Error ? commitErr.message : String(commitErr);
          if (errMsg.includes("nothing to commit")) {
            return { success: true, message: "No changes to snapshot" };
          }
          throw commitErr;
        }

        const commitHash = await gitExec(snapshotDir, ["rev-parse", "HEAD"]);

        const meta: SnapshotMeta = {
          id: generateId("snap"),
          commitHash,
          createdAt: ts,
          message,
          stats: {
            sessions: state.sessions.length,
            observations: Object.values(state.observations).reduce(
              (sum, arr) => sum + arr.length,
              0,
            ),
            memories: state.memories.length,
            graphNodes: state.graphNodes?.length ?? 0,
          },
        };

        await recordAudit(kv, "export", "mem::snapshot-create", [meta.id], {
          commitHash,
          stats: meta.stats,
        });

        logger.info("Snapshot created", { commitHash });
        return { success: true, snapshot: meta };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot failed", { error: msg });
        return { success: false, error: msg };
      } finally {
        snapshotInFlight = false;
      }
    },
  );

  sdk.registerFunction("mem::snapshot-list",  async () => {
    try {
      if (!existsSync(join(snapshotDir, ".git"))) {
        return { snapshots: [] };
      }
      const log = await gitExec(snapshotDir, [
        "log",
        "--format=%H|%aI|%s",
        "-20",
      ]);
      const snapshots = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          const [hash, date] = parts;
          const msg = parts.slice(2).join("|");
          return { commitHash: hash, createdAt: date, message: msg };
        });
      return { snapshots };
    } catch {
      return { snapshots: [] };
    }
  });

  sdk.registerFunction("mem::snapshot-restore",
    async (data: { commitHash: string } | undefined) => {
      if (!data || typeof data.commitHash !== "string" || !data.commitHash.trim()) {
        return { success: false, error: "commitHash is required" };
      }
      if (!COMMIT_HASH_RE.test(data.commitHash)) {
        return { success: false, error: "Invalid commitHash format" };
      }

      try {
        const object = `${data.commitHash}:state.json`;
        const sizeText = await gitExec(snapshotDir, ["cat-file", "-s", object]);
        const size = Number(sizeText);
        if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || size < 1 || size > MAX_SNAPSHOT_BYTES) {
          throw Error("Snapshot size is invalid or exceeds the supported JSON byte limit");
        }
        const content = await gitExec(snapshotDir, ["show", object], size + 1);
        const state = JSON.parse(content) as Partial<ExportData>;
        const result = await importExportData(kv, { strategy: "merge", exportData: {
          sessions: [], memories: [], summaries: [], observations: {}, ...state,
        } as ExportData }, onObservationsImported);
        if (!result.success) return result;

        await recordAudit(kv, "import", "mem::snapshot-restore", [], {
          commitHash: data.commitHash,
          sessions: state.sessions?.length || 0,
          memories: state.memories?.length || 0,
          graphNodes: state.graphNodes?.length || 0,
        });

        logger.info("Snapshot restored", {
          commitHash: data.commitHash,
        });
        return { success: true, commitHash: data.commitHash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot restore failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );
}
