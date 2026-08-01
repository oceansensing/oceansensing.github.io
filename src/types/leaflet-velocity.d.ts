/**
 * leaflet-velocity v2 ships no types. It is imported purely for its side
 * effect — it attaches velocityLayer to the Leaflet namespace — so this is
 * the shorthand ambient declaration that lets the bare import compile.
 *
 * The signature it registers is declared separately in leaflet-augment.d.ts.
 * The two cannot share a file: a shorthand ambient declaration is only legal
 * in a global (import-free) file, while augmenting Leaflet requires a module.
 */
declare module 'leaflet-velocity';
