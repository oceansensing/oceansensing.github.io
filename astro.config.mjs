// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://oceansensing.org',
  integrations: [
    /* The dev visualizer is unlisted: not in the nav, not here, and
       disallowed in robots.txt. It is still publicly reachable — Pages serves
       what is deployed — so this is about not advertising it, not about
       access control. */
    sitemap({ filter: (page) => !page.includes('/dev/') }),
  ],
  redirects: {
    '/cv': '/cv/donglai-gong',
  },
});
