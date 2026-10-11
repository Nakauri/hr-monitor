// The gitignored ux-audit folder lives in the main checkout only. The parent of git's common dir is
// that checkout from the main tree and from any worktree, so scripts find the kit without a user path.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function uxDir(fromDir, override) {
  if (override) return path.resolve(override);
  let common;
  try {
    common = execFileSync('git', ['-C', fromDir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    throw new Error('ux-audit folder not found (not a git checkout, or git missing); pass --ux <dir>');
  }
  return path.join(path.dirname(path.resolve(fromDir, common)), 'ux-audit');
}
