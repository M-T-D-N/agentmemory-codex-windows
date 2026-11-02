import assert from 'node:assert/strict';

export const fixedCopyFailure = Object.freeze({kind:'fixed-io-error',checkpoint:'pre-start-copy'});
export const fixedCopyFailureBlock = String.raw`
    $qualificationCopyPath = Join-Path $backupRoot ('qualification-pre-start-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $qualificationCopyLock = [IO.FileStream]::new($qualificationCopyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
    try {
        Copy-Item -LiteralPath (Join-Path $payload 'config\hook-spec.json') -Destination $qualificationCopyPath -Force
    }
    finally { $qualificationCopyLock.Dispose() }
    throw 'Qualification copy unexpectedly succeeded; this is not the required sharing violation.'
`;

export function createPreStartCopyFailureInstaller(bytes) {
  const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  assert(Buffer.from(source).equals(bytes),'Candidate must round-trip without encoding changes');
  const anchor="    $cutoverPhase = 'copy-adapter'";
  const bootstrap="Join-Path $PSScriptRoot 'payload\\scripts\\agentmemory-evidence.ps1'";
  assert(source.split(anchor).length===2&&source.split(bootstrap).length===2,'Candidate does not have the unique reviewed copy/identity boundaries');
  assert(!source.includes('qualificationCopyLock'),'Candidate already contains a failure fixture');
  // Only the private fixture changes: the original candidate remains immutable.
  return Buffer.from(source.replace(bootstrap,"Join-Path $ReleaseRoot 'payload\\scripts\\agentmemory-evidence.ps1'").replace(anchor,anchor+fixedCopyFailureBlock));
}

export function verifyFixedCopyFailureOutcome(details) {
  assert(details?.phase==='copy-adapter' &&
    details.original_error_id==='System.IO.IOException,Microsoft.PowerShell.Commands.CopyItemCommand' &&
    details.original_error_hresult===-2147024864,
    'Expected the observed pre-start Copy-Item sharing violation');
}
