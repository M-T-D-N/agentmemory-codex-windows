import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const installer = fileURLToPath(new URL("../Install-WindowsCodex.ps1", import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
for (const mode of ["internal", "source-root", "case-insensitive", "external"]) test(`PS5.1 installer junction ${mode}`, { skip: process.platform !== "win32" }, async () => {
 const base=path.resolve(".tmp/ps51-junction"); await mkdir(base,{recursive:true}); const root=await mkdtemp(path.join(base,"fixture-"));
 try {
  const env={}; for(const [key,value]of Object.entries(process.env)){const name=key.toUpperCase();if(name in env&&env[name]!==value)throw Error("Environment casing collision");env[name]=value;}
  env.TEMP=root;env.TMP=root;env.TMPDIR=root;env.PSMODULEPATH=path.join(env.SYSTEMROOT,"System32/WindowsPowerShell/v1.0/Modules");
  const script="$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest; if($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop'){throw 'Actual PS5.1 required'}; "+
   "$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile("+quote(installer)+",[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Move-PackageJunctionTargets'},$true);Invoke-Expression $fn.Extent.Text; "+
   "$root="+quote(root)+";$src=Join-Path $root '원본 package';$dst=Join-Path $root '설치 package';foreach($dir in @($src,$dst,(Join-Path $src '.pnpm/dep'),(Join-Path $dst '.pnpm/dep'))){[void](New-Item -ItemType Directory -Path $dir -Force)};"+
   "$target="+(mode==="source-root"?"$src":mode==="external"?"($src+'-outside')":"(Join-Path $src '.pnpm/dep')")+";"+
   (mode==="external"?"[void](New-Item -ItemType Directory -Path $target);":"")+
   (mode==="case-insensitive"?"$target=$target.ToUpperInvariant();":"")+
   "$link=Join-Path $dst 'dependency';[void](New-Item -ItemType Junction -Path $link -Target $target);"+
   (mode==="external"?"$rejected=$false;try{Move-PackageJunctionTargets -SourceRoot $src -DestinationRoot $dst}catch{if($_.Exception.Message -notlike '*escapes the release package*'){throw};$rejected=$true};if(-not $rejected){throw 'External target accepted'};if((Get-Item -LiteralPath $link).Target -ne $target){throw 'Rejected request changed junction'};":"Move-PackageJunctionTargets -SourceRoot $src -DestinationRoot $dst;$expected="+(mode==="source-root"?"$dst":"(Join-Path $dst '.pnpm/dep')")+";if((Get-Item -LiteralPath $link).Target -ne $expected){throw 'Wrong relocated target'};");
  const result=spawnSync(path.join(env.SYSTEMROOT,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",script],{env,encoding:"utf8",timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr || result.error?.message);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("PS5.1 actual robocopy relocates nested pnpm junctions and validates package reuse", { skip: process.platform !== "win32" }, async () => {
  const base = path.resolve(".tmp/ps51-junction");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "copy-fixture-"));
  try {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      const name = key.toUpperCase();
      if (name in env && env[name] !== value) throw Error("Environment casing collision");
      env[name] = value;
    }
    env.TEMP = root; env.TMP = root; env.TMPDIR = root;
    env.PSMODULEPATH = path.join(env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/Modules");
    const script = "$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;" +
      "if($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop'){throw 'Actual PS5.1 required'};" +
      "$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(" + quote(installer) + ",[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};" +
      "foreach($name in @('Move-PackageJunctionTargets','Test-ExistingPackageMatchesRelease','ConvertTo-WindowsManifestPath')){$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);if(!$fn){throw ('Missing '+$name)};Invoke-Expression $fn.Extent.Text};" +
      "$root=" + quote(root) + ";$src=Join-Path $root '원본 package';$dst=Join-Path $root '갱신 package';$dep=Join-Path $src 'node_modules/.pnpm/dependency';$nested=Join-Path $src 'node_modules/.pnpm/parent/node_modules';foreach($dir in @($dep,$nested)){[void](New-Item -ItemType Directory -Path $dir -Force)};" +
      "$marker=Join-Path $dep 'fixture.txt';[IO.File]::WriteAllText($marker,'isolated dependency fixture');$hash=(Get-FileHash -LiteralPath $marker).Hash;" +
      "[void](New-Item -ItemType Junction -Path (Join-Path $src 'node_modules/dependency') -Target $dep);[void](New-Item -ItemType Junction -Path (Join-Path $nested 'dependency') -Target $dep);" +
      "& (Join-Path $env:SystemRoot 'System32/robocopy.exe') $src $dst /E /SL /SJ /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP;if($LASTEXITCODE -ge 8){throw 'Actual package copy failed'};" +
      "Move-PackageJunctionTargets -SourceRoot $src -DestinationRoot $dst;$expected=Join-Path $dst 'node_modules/.pnpm/dependency';foreach($relative in @('node_modules/dependency','node_modules/.pnpm/parent/node_modules/dependency')){$link=Join-Path $dst $relative;if((Get-Item -LiteralPath $link).Target -ne $expected){throw ('Wrong nested target '+$relative)};if((Get-FileHash -LiteralPath (Join-Path $link 'fixture.txt')).Hash -ne $hash){throw 'Dependency content changed'}};" +
      "$manifest=[pscustomobject]@{package_relative_path='runtime/r-fixture/agentmemory';immutable_files=@([pscustomobject]@{path='runtime/r-fixture/agentmemory/node_modules/.pnpm/dependency/fixture.txt';sha256=$hash})};" +
      "if(!(Test-ExistingPackageMatchesRelease -PackageRoot $dst -Manifest $manifest)){throw 'Correct installed package cannot be reused'};" +
      "[IO.File]::WriteAllText((Join-Path $expected 'fixture.txt'),'changed installed fixture');if(Test-ExistingPackageMatchesRelease -PackageRoot $dst -Manifest $manifest){throw 'Changed package was accepted for reuse'};" +
      "if((Get-FileHash -LiteralPath $marker).Hash -ne $hash){throw 'Source package was mutated'};";
    const result = spawnSync(path.join(env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PS5.1 reads UTF8 installation layout paths without replacing Korean characters", { skip: process.platform !== "win32" }, async () => {
  const base = path.resolve(".tmp/ps51-junction"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "utf8-fixture-"));
  try {
    await mkdir(path.join(root, "config"));
    const relative = "runtime/한글 package/agentmemory";
    await writeFile(path.join(root, "config/install-manifest.json"), JSON.stringify({ node_path: process.execPath, package_relative_path: relative, install_root: root }), "utf8");
    const env = {}; for (const [key, value] of Object.entries(process.env)) env[key.toUpperCase()] = value;
    for (const name of ["AGENTMEMORY_PACKAGE_DIR", "AGENTMEMORY_NODE_PATH", "AGENTMEMORY_RUNTIME_VERSION"]) delete env[name];
    env.TEMP = root; env.TMP = root; env.TMPDIR = root;
    env.PSMODULEPATH = path.join(env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/Modules");
    const layout = fileURLToPath(new URL("../powershell/agentmemory-layout.ps1", import.meta.url));
    const script = "$ErrorActionPreference='Stop'; if($PSVersionTable.PSVersion.Major -ne 5){throw 'PS5.1 required'}; . " + quote(layout) + ";$root=" + quote(root) + ";$layout=Resolve-AgentMemoryLayout -Root $root; $expected=[IO.Path]::GetFullPath((Join-Path $root " + quote(relative) + ")); if($layout.PackageRoot -cne $expected){throw 'UTF8 package path changed'};";
    const result = spawnSync(path.join(env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally { await rm(root, { recursive: true, force: true }); }
});
