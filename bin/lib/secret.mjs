// A secret stored with Windows DPAPI (ConvertFrom-SecureString), which only this Windows user on
// this machine can read back: the GitHub token (lib/github.mjs) and the Discord webhook URL
// (lib/notify.mjs).
import { execFileSync } from 'node:child_process'

export function readSecret(path) {
  const script =
    "$s = (Get-Content -Raw -LiteralPath $env:NIGHTSHIFT_SECRET_FILE).Trim() | ConvertTo-SecureString; [Net.NetworkCredential]::new('', $s).Password"
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, NIGHTSHIFT_SECRET_FILE: path },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!out) throw new Error(`${path} is empty`)
  return out
}
