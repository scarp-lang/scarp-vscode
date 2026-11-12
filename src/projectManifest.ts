import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const projectManifestGlob = '{scarp.project,Scarp.project}';

export function isProjectManifestName(name: string): boolean {
  return name === 'scarp.project' || name === 'Scarp.project';
}

/** Match the compiler's preferred spelling and preserve actual casing on disk. */
export async function findProjectManifest(root: string): Promise<string | undefined> {
  for (const name of ['scarp.project', 'Scarp.project']) {
    const candidate = path.join(root, name);
    const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') { return undefined; }
      throw error;
    });
    if (!stat) { continue; }
    if (!stat.isFile()) { throw new Error('Scarp project manifest must be an ordinary file.'); }
    return path.basename(await fs.realpath(candidate));
  }
  return undefined;
}
