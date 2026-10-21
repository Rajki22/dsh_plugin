import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function resolveCacheRoot() {
  const base = process.env.DSH_PROFILE_DIR
    || process.env.DSH_HOME
    || path.join(os.homedir(), '.dsh');
  return path.join(base, 'cache', 'dsh-whale-widget');
}

export async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

export async function readJsonFile(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return undefined;
  }
}

export async function readJsonFileWithStat(file) {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { value: JSON.parse(raw), stat };
  } catch (error) {
    return undefined;
  }
}

/**
 * Write through a sibling temp file and rename. A crash can leave the temp
 * file behind, but never a half-written cache at the target path.
 */
export async function writeJsonFile(file, value) {
  await ensureDirectory(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      await fs.rename(tempFile, file);
    } catch (error) {
      // Windows can refuse to replace an existing destination; remove it and
      // retry the same rename. The cache remains readable at worst.
      await fs.rm(file, { force: true });
      await fs.rename(tempFile, file);
    }
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}
