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
  { label: 'Data & Tools', href: '/data/' },
  { label: 'News', href: '/news/' },
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
