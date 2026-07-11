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
          cv: z.string().optional(),
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
    preprint: z.boolean().default(false),
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

const presentations = defineCollection({
  loader: file('src/data/presentations.yaml', { parser: (text) => parseYaml(text) }),
  schema: z.object({
    title: z.string(),
    speakers: z.string(),
    event: z.string(),
    location: z.string().optional(),
    date: z.coerce.date(),
    type: z.enum(['invited', 'conference', 'workshop', 'outreach']).default('conference'),
    format: z.enum(['talk', 'poster']).optional(),
    link: z.url().optional(),
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

// CV sections (src/data/cv/*.yaml) — small structured lists rendered by
// the /cv/ page. Publications and presentations are NOT duplicated here;
// the CV pulls those from the collections above.
const cvFile = (name: string, schema: Parameters<typeof defineCollection>[0]['schema']) =>
  defineCollection({
    loader: file(`src/data/cv/${name}.yaml`, { parser: (text) => parseYaml(text) }),
    schema,
  });

const cvEducation = cvFile(
  'education',
  z.object({ year: z.string(), degree: z.string(), institution: z.string() })
);
const cvAppointments = cvFile(
  'appointments',
  z.object({ years: z.string(), title: z.string(), institution: z.string() })
);
const cvGrants = cvFile(
  'grants',
  z.object({ years: z.string(), title: z.string(), sponsor: z.string(), role: z.string() })
);
const cvAdvising = cvFile(
  'advising',
  z.object({ name: z.string(), degree: z.string(), years: z.string(), topic: z.string() })
);
const cvService = cvFile(
  'service',
  z.object({
    group: z.enum(['editorial', 'review', 'university']),
    years: z.string(),
    text: z.string(),
  })
);
const cvFieldwork = cvFile('fieldwork', z.object({ years: z.string(), text: z.string() }));
const cvTeaching = cvFile('teaching', z.object({ years: z.string(), text: z.string() }));
const cvAwards = cvFile('awards', z.object({ year: z.string(), text: z.string() }));

export const collections = {
  projects,
  people,
  news,
  publications,
  presentations,
  datasets,
  software,
  interns,
  cvEducation,
  cvAppointments,
  cvGrants,
  cvAdvising,
  cvService,
  cvFieldwork,
  cvTeaching,
  cvAwards,
};
