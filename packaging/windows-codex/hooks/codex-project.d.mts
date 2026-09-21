export interface CodexProjectRegistry {
  projects: Array<{ id: string; path: string; gitCommonDir: string }>;
  workspaceRoot: string;
  workspaceGitCommonDir: string;
  workspaceProject: string;
}
export function readProjectRegistry(registryPath: string, workspaceRoot: string): CodexProjectRegistry;
export function projectFor(cwd: string, registry: CodexProjectRegistry): string;
