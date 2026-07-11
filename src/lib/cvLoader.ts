import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Loader } from 'astro/loaders';

/**
 * Loads one CV section (e.g. education) for every lab member.
 *
 * Each member owns a directory under src/data/cv/ named after their
 * People-page id (src/data/cv/<person>/education.yaml, …). A member's CV
 * page appears automatically once their directory has data; missing
 * section files are simply skipped. Entry ids are "<person>/<item-id>"
 * and every entry carries a `person` field for filtering.
 */
export function cvSectionLoader(section: string): Loader {
  return {
    name: `cv-${section}-loader`,
    load: async ({ store, parseData, generateDigest, watcher, config, logger }) => {
      const base = fileURLToPath(new URL('src/data/cv/', config.root));

      const sync = async () => {
        store.clear();
        let count = 0;
        const entries = await fs.readdir(base, { withFileTypes: true });
        for (const dirent of entries.filter((d) => d.isDirectory())) {
          const person = dirent.name;
          let text: string;
          try {
            text = await fs.readFile(path.join(base, person, `${section}.yaml`), 'utf-8');
          } catch {
            continue; // this member doesn't have this section
          }
          const items: Array<Record<string, unknown>> = parseYaml(text) ?? [];
          for (const item of items) {
            const id = `${person}/${item.id}`;
            const data = await parseData({ id, data: { ...item, person } });
            store.set({ id, data, digest: generateDigest(data) });
            count++;
          }
        }
        logger.info(`Loaded ${count} cv/${section} entries`);
      };

      await sync();

      watcher?.add(base);
      watcher?.on('change', async (changed) => {
        if (changed.endsWith(`${path.sep}${section}.yaml`) && changed.includes(`${path.sep}cv${path.sep}`)) {
          await sync();
        }
      });
    },
  };
}
