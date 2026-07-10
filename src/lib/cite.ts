import { HIGHLIGHT_AUTHORS } from '../config';

export interface Author {
  family: string;
  given?: string | undefined;
}

/** "Donglai" -> "D." ; "Anna B." -> "A. B." */
function initials(given?: string): string {
  if (!given) return '';
  return given
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((part) => `${part[0]}.`)
    .join(' ');
}

export function isLabMember(author: Author): boolean {
  return (HIGHLIGHT_AUTHORS as readonly string[]).includes(author.family);
}

/** Format one author as "Gong, D." */
export function formatAuthor(author: Author): string {
  const init = initials(author.given);
  return init ? `${author.family}, ${init}` : author.family;
}

/** Join author names with commas and an "&" before the last one. */
export function joinAuthors(names: string[]): string[] {
  return names.flatMap((name, i) => {
    if (i === 0) return [name];
    const sep = i === names.length - 1 ? ' & ' : ', ';
    return [sep, name];
  });
}
