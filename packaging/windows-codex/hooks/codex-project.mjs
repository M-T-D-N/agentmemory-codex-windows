import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

function canonicalPath(value) {
  return resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function pathContains(parent, child) {
  const canonicalParent = canonicalPath(parent);
  const canonicalChild = canonicalPath(child);
  return canonicalChild === canonicalParent || canonicalChild.startsWith(`${canonicalParent}${sep}`);
}

function physicalGitIdentity(path) {
  let component = join(path, ".git");
  for (;;) {
    const info = lstatSync(component, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw new Error("Relocation crosses a reparse point");
    const parent = dirname(component);
    if (parent === component) break;
    component = parent;
  }
  const directory = lstatSync(path, { throwIfNoEntry: false });
  if (!directory) return false;
  if (!directory.isDirectory() || !lstatSync(join(path, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Relocation target is not a canonical Git checkout");
  }
  const identity = gitValue(path, ["-c", "safe.directory=" + path, "rev-parse",
    "--path-format=absolute", "--show-toplevel", "--git-common-dir"]).split(/\r?\n/);
  if (identity.length !== 2 || canonicalPath(identity[0]) !== canonicalPath(path)
    || canonicalPath(identity[1]) !== canonicalPath(join(path, ".git"))) {
    throw new Error("Relocation Git identity does not match its canonical path");
  }
  return true;
}

function retainedSourceVerified(reference, batch) {
  const v = batch.verification, rollback = batch.rollback;
  const copied = v?.copy_result, cutover = v?.primary_root_cutover, project = cutover?.project;
  if (!v || !rollback || !copied || !cutover || !project) return false;
  for (const [expected, actual] of [[v.source_file_count, copied.verified_file_count], [v.source_bytes, copied.verified_bytes]]) {
    if (!Number.isSafeInteger(expected) || expected <= 0 || expected !== actual) return false;
  }
  if (![v.codex_project_id, copied.verified_at_utc, cutover.verified_at_utc, cutover.source_retention_reason]
    .every(value => typeof value === "string" && value.trim())) return false;
  return batch.transport === "COPY_VERIFY_CUTOVER" && !!reference.subpath
    && project.project_id === v.codex_project_id && /^[0-9a-f]{64}$/.test(v.source_tree_sha256)
    && copied.source_and_destination_tree_sha256 === v.source_tree_sha256
    && copied.destination_reparse_or_special_count === 0 && copied.source_deleted === false
    && cutover.source_deleted === false && rollback.source_remains_canonical_until_verified_cutover === false
    && rollback.source_is_never_deleted_by_copy === true && rollback.source_retained_as_rollback_during_soak === true
    && [project.primary_root, cutover.canonical_ref, rollback.canonical_authority_after_cutover]
      .every(root => typeof root === "string" && isAbsolute(root) && canonicalPath(root) === canonicalPath(batch.destination));
}

function referencedProjectPath(entry, relocation, relativePath) {
  const ref = entry.relocation_ref;
  if (!relocation || !ref || typeof ref !== "object" || Array.isArray(ref)
    || Object.keys(ref).some(key => !["batch_id", "subpath"].includes(key))
    || typeof ref.batch_id !== "string" || !ref.batch_id.trim()
    || (Object.hasOwn(ref, "subpath") && !relativePath(ref.subpath))
    || relocation.cutover_state.registered_projects?.[entry.id] !== "target") {
    throw new Error("Invalid relocation_ref or project cutover state: " + entry.id);
  }
  const batches = relocation.batch_ledger?.filter(batch => batch?.batch_id === ref.batch_id);
  if (!Array.isArray(batches) || batches.length !== 1) throw new Error("Relocation batch must exist exactly once");
  const batch = batches[0];
  if (!["COMPLETE", "SOAKING"].includes(batch.status)
    || ![batch.source, batch.destination].every(value => typeof value === "string" && isAbsolute(value)
      && !value.split(/[\\/]/).includes(".."))) throw new Error("Invalid relocation batch endpoints or status");
  const projectsRoot = dirname(resolve(relocation.target_root, relocation.namespaces.projects.replaceAll("{project}", "probe")));
  if (!pathContains(projectsRoot, batch.destination) || canonicalPath(projectsRoot) === canonicalPath(batch.destination)) {
    throw new Error("Relocation destination is outside projects");
  }
  if (batch.verification?.nested_git_repository !== ref.subpath) throw new Error("Relocation subpath must match declared nested repository");
  const source = resolve(batch.source, ref.subpath || "");
  const destination = resolve(batch.destination, ref.subpath || "");
  if (canonicalPath(source) === canonicalPath(destination)) throw new Error("Relocation source and target are identical");
  if (!physicalGitIdentity(destination)) throw new Error("Relocation target is missing; no source fallback");
  const sourcePresent = physicalGitIdentity(source);
  if (batch.status === "SOAKING") {
    if (!sourcePresent || !retainedSourceVerified(ref, batch)) throw new Error("Retained source cutover evidence is incomplete");
  } else if (sourcePresent) throw new Error("Duplicate relocation Git identities");
  return destination;
}

function readProjectRegistry(registryPath, workspaceRoot) {
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!Array.isArray(parsed?.projects) || (parsed.schema_version !== undefined && ![1, 2, 3, 4].includes(parsed.schema_version))) throw new Error(`Invalid project registry: ${registryPath}`);
  let relocation;
  try {
    relocation = JSON.parse(readFileSync(join(dirname(registryPath), "workspace-relocation.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const relativePath = (value) => typeof value === "string" && value.trim()
    && !isAbsolute(value) && !value.split(/[\\/]/).some((part) => !part || part === ".." || part === "." || /[. ]$|[<>:"|?*\x00-\x1f]/.test(part));
  if (relocation && (relocation.schema_version !== 1
    || typeof relocation.target_root !== "string" || !isAbsolute(relocation.target_root)
    || typeof relocation.cutover_state?.legacy_control_root !== "string"
    || !isAbsolute(relocation.cutover_state.legacy_control_root)
    || !relativePath(relocation.namespaces?.control)
    || !["source", "target"].includes(relocation.cutover_state.control)
    || !relativePath(relocation.namespaces?.projects)
    || !relocation.namespaces.projects.includes("{project}")
    || /[{}]/.test(relocation.namespaces.projects.replaceAll("{project}", "project")))) {
    throw new Error("Invalid workspace relocation routing");
  }
  const seenIds = new Set(), seenPaths = new Set();
  for (const entry of parsed.projects) {
    const hasPath = Object.hasOwn(entry || {}, "path"), hasRef = Object.hasOwn(entry || {}, "relocation_ref"), hasNested = Object.hasOwn(entry || {}, "nested_ref");
    if (typeof entry?.id !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(entry.id)
      || (parsed.schema_version >= 3 && !/^[a-z0-9][a-z0-9-]*$/.test(entry.id))
      || seenIds.has(entry.id) || Number(hasPath) + Number(hasRef) + Number(hasNested) !== 1 || (hasPath && !relativePath(entry.path))
      || (hasRef && ![3, 4].includes(parsed.schema_version))
      || (hasNested && parsed.schema_version !== 4)) throw new Error("Invalid project registry entry: " + registryPath);
    seenIds.add(entry.id);
  }
  const baseProjectPath = (entry) => {
    const hasRef = Object.hasOwn(entry, "relocation_ref");
    let projectPath = hasRef ? referencedProjectPath(entry, relocation, relativePath) : resolve(workspaceRoot, entry.path);
    if (relocation && !hasRef) {
      const location = relocation.cutover_state.registered_projects?.[entry.id];
      if (location !== "source" && location !== "target") {
        throw new Error(`Missing or invalid project cutover state: ${entry.id}`);
      }
      projectPath = location === "target"
        ? resolve(relocation.target_root, relocation.namespaces.projects.replaceAll("{project}", entry.id))
        : resolve(relocation.cutover_state.legacy_control_root, entry.path);
    }
    return projectPath;
  };
  const paths = new Map(parsed.projects.filter(entry => !Object.hasOwn(entry, "nested_ref"))
    .map(entry => [entry.id, baseProjectPath(entry)]));
  const projects = parsed.projects.map((entry) => {
    let projectPath = paths.get(entry.id);
    if (Object.hasOwn(entry, "nested_ref")) {
      const ref = entry.nested_ref;
      if (!ref || typeof ref !== "object" || Array.isArray(ref)
        || Object.keys(ref).some(key => !["project_id", "subpath"].includes(key))
        || !paths.has(ref.project_id) || !relativePath(ref.subpath)) throw new Error("Invalid nested_ref: " + entry.id);
      const parent = paths.get(ref.project_id);
      if (relocation && relocation.cutover_state.registered_projects?.[entry.id]
        !== relocation.cutover_state.registered_projects?.[ref.project_id]) throw new Error("Nested project cutover state must match its parent");
      projectPath = resolve(parent, ref.subpath);
      if (!pathContains(parent, projectPath) || canonicalPath(parent) === canonicalPath(projectPath)
        || !physicalGitIdentity(parent) || !physicalGitIdentity(projectPath)) throw new Error("Nested project requires canonical parent and child repositories");
    }
    if (seenPaths.has(canonicalPath(projectPath))) throw new Error("Duplicate project registry path");
    seenPaths.add(canonicalPath(projectPath));
    return { id: entry.id, path: projectPath, gitCommonDir: resolve(projectPath, ".git") };
  }).sort((a, b) => b.path.length - a.path.length);
  const controlRoot = relocation
    ? relocation.cutover_state.control === "target"
      ? resolve(relocation.target_root, relocation.namespaces.control)
      : resolve(relocation.cutover_state.legacy_control_root)
    : workspaceRoot;
  return {
    projects,
    workspaceRoot: controlRoot,
    workspaceGitCommonDir: resolve(controlRoot, ".git"),
    workspaceProject: basename(relocation?.cutover_state.legacy_control_root || workspaceRoot),
  };
}

function gitValue(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 700,
    }).trim();
  } catch {
    return "";
  }
}

function projectFor(cwd, registry) {
  const dir = resolve(typeof cwd === "string" && cwd.trim() ? cwd : process.cwd());
  const direct = registry.projects.find((entry) => pathContains(entry.path, dir));
  if (direct) return direct.id;

  const commonDir = gitValue(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir) {
    const linked = registry.projects.find(
      (entry) => canonicalPath(entry.gitCommonDir) === canonicalPath(commonDir),
    );
    if (linked) return linked.id;
    if (canonicalPath(commonDir) === canonicalPath(registry.workspaceGitCommonDir)) return registry.workspaceProject;
  }

  if (pathContains(registry.workspaceRoot, dir)) return registry.workspaceProject;
  const gitRoot = gitValue(dir, ["rev-parse", "--show-toplevel"]);
  return basename(gitRoot || dir);
}

export { projectFor, readProjectRegistry };
