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
 * It publishes `access-control-allow-origin: *`, so this is a plain
 * cross-origin fetch with no proxy. It is **not a public service** — see that
 * repository's README. Anything of ours that reads it should go through here,
 * so there is one string to change.
 */
export const MAP_DATA = 'https://truedichotomy.github.io/ocean-data-repo/map/';
