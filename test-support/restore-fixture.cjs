'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

async function restoreFixture(plan, destination, { vaultRoot } = {}) {
  const target = path.resolve(destination);
  if (!path.isAbsolute(destination) || !vaultRoot) throw new Error('Fixture restore requires an absolute destination and explicit vault boundary');
  const vault = path.resolve(vaultRoot);
  const relative = path.relative(vault, target);
  if (!relative || ((relative !== '..' && !relative.startsWith(`..${path.sep}`)) && !path.isAbsolute(relative)))
    throw new Error('Fixture restore cannot write inside a vault');
  if (await fs.lstat(target).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)))
    throw new Error('Fixture restore destination must not already exist');
  await fs.mkdir(target, { recursive: false });
  try {
    await fs.writeFile(path.join(target, 'project.json'), JSON.stringify(plan.project), { flag: 'wx' });
    const sheetsDir = path.join(target, 'sheets');
    await fs.mkdir(sheetsDir, { recursive: false });
    for (const sheet of plan.sheets) {
      if (!/^[A-Za-z0-9_-]+$/.test(sheet.id)) throw new Error('Unsafe fixture sheet ID');
      const sheetDir = path.join(sheetsDir, sheet.id);
      await fs.mkdir(sheetDir, { recursive: false });
      await fs.writeFile(path.join(sheetDir, 'metadata.json'), JSON.stringify({
        manifest: sheet.manifest, metadata: sheet.metadata, fileMetadata: sheet.fileMetadata, metaCells: sheet.metaCells,
        occupiedSlots: sheet.occupiedSlots, teamPluginsRows: sheet.teamPluginsRows
      }), { flag: 'wx' });
      for (const slot of sheet.slots) {
        if (!['C', 'D'].includes(slot.kind) || !Number.isSafeInteger(slot.slot) || slot.slot < 0)
          throw new Error('Unsafe fixture slot identity');
        await fs.writeFile(path.join(sheetDir, `${slot.kind}-${slot.slot}.json`), JSON.stringify({ rows: slot.rows, sha256: slot.sha256 }), { flag: 'wx' });
      }
    }
    return target;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { restoreFixture };
