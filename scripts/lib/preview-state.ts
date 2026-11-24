// LOCAL RUN HARNESS ONLY (scripts/preview.mjs). Never deployed; nothing in src/
// imports it.
//
// Where a preview run keeps its local D1 and generated TOKEN_ENCRYPTION_KEY.
// `--live` holds real Google/Meta grants, so it has its own directory (and so
// its own database and key): a later default or `--fixtures` run, which is not
// behind the sign-in gate, never opens, reads or changes live accounts.
import { chmod, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PREVIEW_STATE = '.wrangler/preview/';
export const PREVIEW_LIVE_STATE = '.wrangler/preview-live/';

/** Absolute state directory (with a trailing separator) of a run, under the repository root. */
export function previewStateDir(root: URL, live: boolean): string {
  return fileURLToPath(new URL(live ? PREVIEW_LIVE_STATE : PREVIEW_STATE, root));
}

/** Creates the state directory; the live one is owner-only (0700), also when it already existed. */
export async function preparePreviewState(dir: string, live: boolean): Promise<void> {
  await mkdir(dir, { recursive: true, ...(live ? { mode: 0o700 } : {}) });
  if (live) await chmod(dir, 0o700);
}
