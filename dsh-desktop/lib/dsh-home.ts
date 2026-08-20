import * as os from 'node:os';
import * as path from 'node:path';

/** Resolve the one effective DSH home used by every desktop subsystem. */
export function dshHomePath(): string {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.dsh');
}
