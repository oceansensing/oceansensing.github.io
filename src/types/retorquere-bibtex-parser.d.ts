/**
 * Minimal declarations for @retorquere/bibtex-parser v10, whose published
 * package omits its dist/types directory. Covers only the surface this site
 * uses (verified against the runtime output shape).
 */
declare module '@retorquere/bibtex-parser' {
  export interface Creator {
    lastName?: string;
    firstName?: string;
    name?: string;
  }

  export interface Entry {
    type: string;
    key: string;
    fields: {
      title?: string;
      author?: Creator[];
      journal?: string;
      booktitle?: string;
      publisher?: string;
      institution?: string;
      year?: string;
      volume?: string;
      pages?: string;
      doi?: string;
      url?: string;
      [field: string]: unknown;
    };
    input: string;
  }

  export interface ParseError {
    error: string;
    input?: string;
  }

  export interface Library {
    entries: Entry[];
    errors: ParseError[];
  }

  export interface ParseOptions {
    /** When false, titles keep the exact capitalization written in the .bib file */
    sentenceCase?: boolean;
  }

  export function parse(input: string, options?: ParseOptions): Library;
}
