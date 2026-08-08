# @c4po/slocum

A decoder for the Slocum glider file family — `sbd`, `tbd`, `mbd`, `nbd`,
`dbd`, `ebd` and their LZ4-compressed twins — with CSV and netCDF-3 writers.

Teledyne Webb publishes no specification for the format, so every reader of it
is a reimplementation of the vendor's `dbd2asc`. This one is a port of
[`SlocumIO.jl`](https://github.com/oceansensing/SlocumIO.jl), which was itself
validated against [`dbdreader`](https://github.com/smerckel/dbdreader) byte for
byte, and `npm run test:slocum` holds the port to the same fixture.

It powers [oceansensing.org/data/slocum/](https://oceansensing.org/data/slocum/),
where the whole decode happens in the reader's browser and no file is uploaded.

## No DOM, no dependencies

Every module takes bytes and returns numbers. There is no Leaflet, no DOM and
no npm dependency — the LZ4 and netCDF implementations are here rather than
imported, on the same argument the map's `kmz.ts` makes about ZIP libraries:
both formats are published and small, and this code is served to a browser.

`@c4po/teos10` is used by `derive.ts` alone, which is the optional seawater
half; the decoder proper does not touch it.

That is what lets `test:slocum` run the TypeScript directly through Node's type
stripping — no build, no jsdom — and it is what a native port would keep.

## Using it

```ts
import { openDbd, readSeries, buildTable, toCsv } from '@c4po/slocum';

// A file off a glider is *factored*: it names an 8-character CRC and carries
// no sensor list, so the matching <crc>.cac is required, not optional.
const file = openDbd(bytes, { name: 'unit_507-2025-120-1-169.sbd', cache: cacText });

const series = readSeries(file);          // per sensor, each on its own times
const table = buildTable(series);         // rectangular, lossless
const csv = toCsv(table);
```

`describe(bytes, name)` reads the header alone, so a caller can find out
*which* cache a file wants before it has one — which is the difference between
a usable error and "missing cache".

## The step that is a decision, not a formatting choice

A Slocum file has **no single time base**. Every sensor is written on its own
subset of cycles, so turning a file into a table means choosing one:

| `join` | rows | what is in them |
| --- | --- | --- |
| `'union'` (default) | every time any sensor reported | only recorded values; blank elsewhere |
| `'interpolate'` | one sensor's times | every other column interpolated, and so not recorded |

The default is the lossless one. The other is offered and is never applied
without being asked, which is the same bargain the rest of this site strikes
with its readers.

Two sensors of the same name from the two computers stay two columns, suffixed
with their file family: `sci_water_pressure` is measured by the science
computer at full rate and *relayed* to the flight computer at a much slower
one — 853 samples against 4 in the test fixture. The same sensor across
segments is one column, concatenated.

## OceanGliders OG1.0

`og1.ts` maps a decoded table onto
[OG1.0](https://oceangliderscommunity.github.io/OG-format-user-manual/OG_Format.html),
the community trajectory format. It needs deployment metadata a Slocum file
does not carry — `OG1_FIELDS` declares the thirty-eight fields and
`missingFields` says which mandatory ones are still empty:

```ts
import { buildOg1, missingFields, toCdl, writeNetcdf } from '@c4po/slocum';

if (missingFields(metadata).length === 0) {
  const { document, id } = buildOg1(table, metadata);
  const nc = writeNetcdf(document);        // OG1 structure, netCDF-3 encoding
  const cdl = toCdl(document, { name: id }); // `ncgen -4` makes netCDF-4 of this
}
```

**OG1.0 structure, netCDF-3 encoding** — not "OG1.0 compliant". OG1 declares
its metadata variables as `NC_STRING`, which classic does not have, so they
are fixed-width `char` arrays here; the CDL declares them as `string`, which
is the exact route to a conformant netCDF-4 file — checked with `ncgen`,
which compiles it cleanly and preserves every value. What has *not* been done
is an OG1 validator run; the community's own checkers are experimental.

Four things OG1 wants at every measurement are computed rather than recorded —
position between fixes, `DEPTH` from pressure and latitude via TEOS-10, `PSAL`
via PSS-78, and `PHASE` with its segment and profile numbering. Each says so
in its own attributes.

## Files

| file | what it is |
| --- | --- |
| `dbd.ts` | the binary decoder — preamble, state bytes, cycles |
| `header.ts` | the ASCII header and the sensor-list cache |
| `lz4.ts` | LZ4 blocks, for the compressed forms |
| `nmea.ts` | `DDDMM.MMMM` positions, and whether one is real |
| `table.ts` | series → a rectangular table |
| `derive.ts` | seawater properties, via `@c4po/teos10` |
| `csv.ts`, `netcdf.ts` | CSV, and a netCDF-3 classic document writer |
| `og1.ts`, `cdl.ts` | the OceanGliders OG1.0 mapping, and its text form |
| `types.ts`, `index.ts` | shapes, and the public surface |

## What it does not do

It reads files; it does not process them. No thermal-lag correction, no
despiking, no quality control, no gridding, and it does not write the IOOS
Glider DAC's trajectory format. The netCDF it writes is **netCDF-3 classic**
and deliberately does not claim CF conventions: the variable names and units
are the glider's own strings, carried verbatim.
