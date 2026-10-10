import type { IIIClient } from "iii-sdk";
import { STREAM } from "./schema.js";
import { generatedIdTime } from "./kv.js";
import { getViewerStreamMax } from "../config.js";
import { logger } from "../logger.js";

const PRUNE_BATCH_INTERVAL = 50;
const DELETE_BATCH_SIZE = 100;
const UNSHIFT_CHUNK_SIZE = 1000;
const SEED_TIMEOUT_MS = 5000;

const trackedItemIds: string[] = [];
const trackedItemIdSet = new Set<string>();
let writesSincePrune = 0;
let pruning = false;
let pruneAgain = false;
let seeding = false;

export function trackViewerStreamItem(itemId: string): void {
  if (trackedItemIdSet.has(itemId)) return;
  trackedItemIdSet.add(itemId);
  trackedItemIds.push(itemId);
  writesSincePrune += 1;
}

function unshiftMany(target: string[], items: string[]): void {
  for (let end = items.length; end > 0; end -= UNSHIFT_CHUNK_SIZE) {
    const start = Math.max(0, end - UNSHIFT_CHUNK_SIZE);
    target.splice(0, 0, ...items.slice(start, end));
  }
}

async function deleteItems(sdk: IIIClient, itemIds: string[]): Promise<string[]> {
  const failedItemIds: string[] = [];
  for (let start = 0; start < itemIds.length; start += DELETE_BATCH_SIZE) {
    const batch = itemIds.slice(start, start + DELETE_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((itemId) =>
        sdk.trigger({
          function_id: "stream::delete",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            item_id: itemId,
          },
        }),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        logger.warn("Failed to prune viewer stream item", {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
        failedItemIds.push(batch[i]);
      }
    }
  }
  return failedItemIds;
}

async function pruneOverflow(sdk: IIIClient): Promise<void> {
  if (seeding) { pruneAgain = true; return; }
  if (pruning) {
    pruneAgain = true;
    return;
  }
  pruning = true;
  try {
    do {
      pruneAgain = false;
      const overflow = trackedItemIds.length - getViewerStreamMax();
      if (overflow <= 0) break;
      const candidates = trackedItemIds.splice(0, overflow);
      for (const itemId of candidates) trackedItemIdSet.delete(itemId);
      candidates.reverse();
      const failedItemIds = await deleteItems(sdk, candidates);
      if (failedItemIds.length > 0) {
        for (const itemId of failedItemIds) trackedItemIdSet.add(itemId);
        unshiftMany(trackedItemIds, failedItemIds);
      }
    } while (pruneAgain);
  } finally {
    pruning = false;
  }
}

export async function pruneViewerStreamIfDue(sdk: IIIClient): Promise<void> {
  if (writesSincePrune < PRUNE_BATCH_INTERVAL) return;
  writesSincePrune = 0;
  await pruneOverflow(sdk);
}

type StoredViewerItem = {
  observation?: { id?: unknown; timestamp?: unknown };
};

function itemTime(item: StoredViewerItem): number {
  const fromId = generatedIdTime(item?.observation?.id);
  if (fromId !== null) return fromId;
  const raw = item?.observation?.timestamp;
  const parsed = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function oldestFirst(items: StoredViewerItem[]): StoredViewerItem[] {
  return items
    .map((item, index) => ({ item, index, at: itemTime(item) }))
    .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.index - b.index))
    .map((entry) => entry.item);
}

export interface SeedViewerStreamOptions {
  unorderedListing?: boolean;
  managedState?: boolean;
}

async function seedManagedViewerStream(sdk: IIIClient): Promise<number> {
  seeding = true;
  const stored: string[] = [];
  try {
    let offset = 0;
    let initialTotal: number | undefined;
    for (;;) {
      const page = await sdk.trigger<unknown, { entries: Array<{ key: string; value: null }>; total: number; next_offset: number | null }>({
        function_id: "stream::list_keys_page", payload: { stream_name: STREAM.name, group_id: STREAM.viewerGroup, offset, limit: 128 }, timeoutMs: SEED_TIMEOUT_MS,
      });
      if (!page || !Array.isArray(page.entries) || page.entries.length > 128 || !Number.isSafeInteger(page.total) || page.total < offset + page.entries.length
        || page.entries.some(e => !e || typeof e.key !== "string" || e.value !== null)
        || (page.next_offset !== null && (page.entries.length === 0 || page.next_offset !== offset + page.entries.length || page.next_offset >= page.total))) {
        throw new Error("Invalid viewer stream key page");
      }
      initialTotal ??= page.total;
      if (page.total < initialTotal) throw new Error("Viewer stream changed during key pagination");
      for (const { key } of page.entries.slice(0, initialTotal - offset)) {
        if (!trackedItemIdSet.has(key)) stored.push(key);
      }
      if (page.next_offset === null || page.next_offset >= initialTotal) break;
      offset = page.next_offset;
    }
    const untracked = stored.filter(id => !trackedItemIdSet.has(id));
    for (const id of untracked) trackedItemIdSet.add(id);
    unshiftMany(trackedItemIds, untracked);
    stored.length = untracked.length;
  } catch (error) {
    logger.warn("Could not read bounded viewer stream keys", { error: error instanceof Error ? error.message : String(error) });
    return 0;
  } finally { seeding = false; }
  await pruneOverflow(sdk);
  return stored.length;
}

export async function seedViewerStreamTracker(
  sdk: IIIClient,
  options: SeedViewerStreamOptions = {},
): Promise<number> {
  if (options.managedState) return seedManagedViewerStream(sdk);
  let items: StoredViewerItem[];
  try {
    items = await sdk.trigger<unknown, StoredViewerItem[]>({
      function_id: "stream::list",
      payload: { stream_name: STREAM.name, group_id: STREAM.viewerGroup },
      timeoutMs: SEED_TIMEOUT_MS,
    });
  } catch (err) {
    logger.warn("Could not read the viewer stream backlog", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  if (!Array.isArray(items)) return 0;
  const stored: string[] = [];
  for (const item of options.unorderedListing ? oldestFirst(items) : items) {
    const id = item?.observation?.id;
    if (typeof id !== "string" || trackedItemIdSet.has(id)) continue;
    trackedItemIdSet.add(id);
    stored.push(id);
  }
  unshiftMany(trackedItemIds, stored);
  await pruneOverflow(sdk);
  return stored.length;
}

export function resetViewerStreamTracker(): void {
  trackedItemIds.length = 0;
  trackedItemIdSet.clear();
  writesSincePrune = 0;
  pruning = false;
  pruneAgain = false;
  seeding = false;
}
