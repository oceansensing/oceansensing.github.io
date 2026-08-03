/**
 * Single source of truth for site-wide metadata.
 * Edit this file to change the site title, navigation, or contact info —
 * no layout code needs to change.
 */

export const SITE = {
  title: 'C4PO',
  fullName: 'Collaboratory for Physical Oceanography',
  description:
    'The Collaboratory for Physical Oceanography (C4PO) at the Virginia Institute of Marine Science studies polar and coastal ocean dynamics using autonomous ocean sensing platforms.',
  url: 'https://oceansensing.org',
} as const;

export const NAV = [
  { label: 'Research', href: '/research/' },
  { label: 'People', href: '/people/' },
  { label: 'Publications', href: '/publications/' },
  { label: 'Presentations', href: '/presentations/' },
  { label: 'Visualization', href: '/visualization/' },
  { label: 'Data & Tools', href: '/data/' },
] as const;

export const CONTACT = {
  pi: 'Dr. Donglai Gong',
  institution: 'Virginia Institute of Marine Science',
  school: "William & Mary's Batten School",
  address: '1370 Greate Road, Gloucester Point, VA 23062',
  email: 'info@c4po.science',
  github: 'https://github.com/oceansensing',
} as const;

/**
 * Surnames of lab members (current and former) to highlight in the
 * publications list.
 */
export const HIGHLIGHT_AUTHORS = [
  'Gong',
  'Ferris',
  'Slater',
  'Bourdon',
  'Wang',
] as const;

/**
 * Where the map fetches its data.
 *
 * Its own repository, on a separate account, and both halves of that matter.
 * The data is real-time and the site is not: a repository that commits what
 * it fetches keeps every superseded version forever, and this one had banked
 * 356 MB of them for 130 MB of live data. Over there each run replaces the
 * last and the history does not grow.
 *
 * The split is what bought the room: the site had reached ~900 MB of a 1 GB
 * cap and one more layer would not have fitted, and now it is a few megabytes
 * with the data on its own gigabyte. **The separate account had nothing to do
 * with it** — GitHub's three Pages limits (1 GB published, 100 GB/month, 10
 * builds/hour) are all per *site*, not per account, so a second repository
 * under either owner would have done the same. An earlier version of this
 * comment claimed otherwise.
 *
 * Under the lab's organisation rather than a personal account, so the site's
 * data does not depend on one person's handle surviving. That move changed
 * this URL and not by a little: `oceansensing.github.io` carries a CNAME, and
 * **project pages inherit their organisation's custom domain**, so the data
 * is served from oceansensing.org rather than from github.io. Same origin as
 * the site, which makes CORS moot — it still publishes
 * `access-control-allow-origin: *` — but it also means the data now *looks*
 * like part of the website. It is **not a public service**; robots.txt keeps
 * crawlers out of it and that repository's README says the rest.
 *
 * Anything of ours that reads it goes through here, so there is one string to
 * change — which is what made the move a one-line commit rather than a sweep.
 */
export const MAP_DATA = 'https://oceansensing.org/ocean-data-repo/map/';

/**
 * Where the harmful-algal-bloom photographs are.
 *
 * Their own repository, for the same reason the map's data has one: a website
 * should not carry 27 MB of binaries to show a page. The reasoning is weaker
 * here than it was there, and worth saying so — those grids were rewritten
 * hourly and banked every version forever, while these photographs were
 * committed once and never touched again. What this buys is weight and a
 * clean separation, not an escape from churn.
 *
 * It costs the build-time image pipeline. Astro resized these through
 * `astro:assets`; it cannot now, and should not — this site rebuilds hourly,
 * and re-encoding 95 photographs every hour to emit last hour's bytes is work
 * nobody sees. hab-data-repo makes the webp derivatives once, at the widths
 * `HAB_WIDTHS` names, and this site links them.
 *
 * Served from oceansensing.org because project pages inherit the
 * organisation's custom domain — so robots.txt disallows the path, and that
 * repository's README says the rest.
 */
export const HAB_DATA = 'https://oceansensing.org/hab-data-repo/photos/';

/**
 * The widths hab-data-repo publishes, and the ones the page may ask for.
 *
 * Both halves have to agree: this list builds the `srcset`, and that
 * repository's workflow builds the files. Add a width in one place only and
 * the page asks for a photograph that is not there — a broken image rather
 * than a smaller one, since there is no negotiation in a `srcset`.
 *
 * Grid tiers only, and it stops at 1400 deliberately. The largest thing on
 * offer is the source file, and that is **not one size**: the 2026 frames
 * were re-exported from camera originals at 2000 px, while the 2017 ones are
 * 1600 px web exports whose originals are lost. A fixed top tier would have
 * to either upscale the smaller ones or tell the browser a 1600 px file is
 * 2000 px wide. So the lightbox and the download link point at the file
 * itself, whatever size it happens to be.
 */
export const HAB_WIDTHS = [800, 1400] as const;

