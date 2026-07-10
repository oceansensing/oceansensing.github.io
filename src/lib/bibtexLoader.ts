import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, type Entry } from '@retorquere/bibtex-parser';
import type { Loader } from 'astro/loaders';

/**
 * Content-layer loader that turns a BibTeX file into a `publications`
 * collection. Adding a paper to the site = pasting its BibTeX entry into
 * the .bib file; the parser decodes LaTeX escapes and splits author names.
 */
export function bibtexLoader({ path }: { path: string }): Loader {
  return {
    name: 'bibtex-loader',
    load: async ({ store, parseData, generateDigest, watcher, config, logger }) => {
      const absPath = fileURLToPath(new URL(path, config.root));

      const sync = async () => {
        // sentenceCase: false — keep the capitalization exactly as written
        // in the .bib file (proper nouns like "Antarctic" stay capitalized)
        const bib = parse(await fs.readFile(absPath, 'utf-8'), { sentenceCase: false });
        for (const error of bib.errors) {
          logger.warn(`BibTeX parse issue in ${path}: ${error.error}`);
        }
        store.clear();
        for (const entry of bib.entries) {
          const data = await parseData({ id: entry.key, data: mapEntry(entry) });
          store.set({ id: entry.key, data, digest: generateDigest(data) });
        }
        logger.info(`Loaded ${bib.entries.length} publications from ${path}`);
      };

      await sync();

      watcher?.add(absPath);
      watcher?.on('change', async (changed) => {
        if (changed === absPath) await sync();
      });
    },
  };
}

function mapEntry(entry: Entry): Record<string, unknown> {
  const f = entry.fields;
  const authors = (f.author ?? []).map((a) => ({
    family: a.lastName ?? a.name ?? '',
    given: a.firstName,
  }));

  return {
    type: entry.type,
    title: f.title ?? '(untitled)',
    authors,
    venue: f.journal ?? f.booktitle ?? f.publisher,
    year: Number(f.year ?? 0),
    volume: f.volume,
    pages: f.pages,
    doi: f.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//, ''),
    url: f.url,
  };
}
