import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob, file } from 'astro/loaders';
import { parse as parseYaml } from 'yaml';
import { bibtexLoader } from './lib/bibtexLoader';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      summary: z.string(),
      status: z.enum(['active', 'completed']).default('active'),
      cover: image().optional(),
      coverAlt: z.string().default(''),
      gallery: z
        .array(z.object({ src: image(), alt: z.string() }))
        .default([]),
      sponsors: z.array(z.string()).default([]),
      links: z.array(z.object({ label: z.string(), url: z.url() })).default([]),
      featured: z.boolean().default(false),
      order: z.number().default(99),
    }),
});

const people = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/people' }),
  schema: ({ image }) =>
    z.object({
      name: z.string(),
      role: z.string(),
      status: z.enum(['current', 'alumni']),
      photo: image().optional(),
      email: z.email().optional(),
      links: z
        .object({
          website: z.url().optional(),
          orcid: z.string().optional(),
          scholar: z.url().optional(),
          github: z.string().optional(),
          linkedin: z.url().optional(),
        })
        .default({}),
      years: z.string().optional(),
      currentPosition: z.string().optional(),
      order: z.number().default(99),
    }),
});

const news = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/news' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      date: z.coerce.date(),
      description: z.string(),
      cover: image().optional(),
      draft: z.boolean().default(false),
    }),
});

const publications = defineCollection({
  loader: bibtexLoader({ path: 'src/data/publications.bib' }),
  schema: z.object({
    type: z.string(),
    title: z.string(),
    authors: z.array(z.object({ family: z.string(), given: z.string().optional() })),
    venue: z.string().optional(),
    year: z.number(),
    volume: z.string().optional(),
    pages: z.string().optional(),
    doi: z.string().optional(),
    url: z.string().optional(),
  }),
});

const datasets = defineCollection({
  loader: file('src/data/datasets.yaml', { parser: (text) => parseYaml(text) }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    url: z.url(),
    archive: z.string().optional(),
    doi: z.string().optional(),
  }),
});

const interns = defineCollection({
  loader: file('src/data/interns.yaml', { parser: (text) => parseYaml(text) }),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    year: z.string(),
    project: z.string(),
    now: z.string().optional(),
    linkedin: z.url().optional(),
  }),
});

const software = defineCollection({
  loader: file('src/data/software.yaml', { parser: (text) => parseYaml(text) }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    repo: z.url(),
    language: z.string().optional(),
  }),
});

export const collections = { projects, people, news, publications, datasets, software, interns };
