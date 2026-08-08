# @c4po/slocum

A decoder for the Slocum glider file family — `sbd`, `tbd`, `mbd`, `nbd`,
`dbd`, `ebd` and their LZ4-compressed twins — with CSV and netCDF-3 writers.

Every reader of the format is a reimplementation of the vendor's `dbd2asc`.
This one is a port of
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

**Columns are ordered, not left as they fell.** The quantities a reader opens
a glider file for lead — position, depth, the CTD, and what is derived from it
— and the rest follow by how populated they are, so the nearly-empty channels
end up last. Untouched, the order is the cache file's alphabetical namespace,
which buried water temperature in the sixty-second column. `orderColumns` is
exported because derived columns are appended after the table is built.

Columns are keyed on **(sensor, glider, computer)**. The glider is the vehicle;
flight and science are the two computers inside it, and the sensor prefix says
which owns what — `sci_` is the science computer's, `m_` measured and `c_`
commanded on the flight computer, `u_` parameters the user sets and `f_`
factory values, with `x_` and a few others derived. Measured on the test glider, the science namespace is 100%
`sci_` and the flight namespace holds 1,022 `sci_` sensors it knows only
because science values are relayed to it.

So two gliders' `m_depth` stay two columns, and within one glider a sensor
written by both computers stays two — `sci_water_pressure` is measured by the
science computer at full rate and relayed to the flight computer at a much
slower one, 853 samples against 4 in the fixture.

Within one computer the opposite holds. The same sensor across segments is one
column, concatenated; and `sbd`/`mbd`/`dbd` are three decimations of one flight
record, as `tbd`/`nbd`/`ebd` are of one science record, so dropping any
combination gives one column per sensor, **deduplicated by timestamp**.

Merged per sensor rather than per file: the lists are chosen independently with
`sbdlist.dat` and `mbdlist.dat`, so they are not nested — on one test segment
the sbd holds 64 sensors and the mbd 134, sharing 58. The result is the union.

## More than one deployment in a pile of files

`splitDeployments(files, { gapSeconds })` groups decoded files before anything
is written:

```ts
import { splitDeployments, deploymentStem } from '@c4po/slocum';

const { deployments, undated } = splitDeployments(
  files.map((f) => ({ file: f.name, series: readSeries(openDbd(f.bytes, f)) })),
);
for (const d of deployments) write(`${deploymentStem(d)}.csv`, toCsv(buildTable(d.series)));
```

**A deployment is one glider over one continuous stretch of time.** A
different glider always splits; a gap of three days or more splits one
glider's record. Two gliders in one table is obvious once seen, but one
glider's spring and summer work is not — the filenames match and the sensor
names match, and once they are combined there is nothing to separate them by.

The gap is measured **between segments**, not between samples. A glider logs
different sensors on wildly different schedules — a position fix only on
surfacing, an Iridium counter once a segment — so a per-sample gap would split
a deployment whenever a slow channel went quiet for a weekend.

`gapSeconds` defaults to three days. It has to clear the longest a glider can
plausibly go dark inside one deployment while staying shorter than the
shortest turnaround between two; Slocum segments are hours apart, so three
days leaves room on both sides.

Files with no usable clock come back in `undated` rather than being placed.
A segment with no time cannot be tested against a gap, and putting it in the
first deployment would be inventing a fact.

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

## Deployments

`deployment.ts` groups decoded files before anything is written, so each
deployment becomes its own output file. A deployment is **one glider over one
continuous stretch of time**: a different vehicle always starts a new one, and
so does a gap of three days or more, measured between segments rather than
between samples.

```ts
const { deployments, undated } = splitDeployments(
  files.map((f) => ({ file: f.name, series: f.series })),
);
```

`undated` holds files with no usable clock — they cannot be placed against a
gap, and putting them in the first deployment would be inventing a fact.

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
| `deployment.ts` | which files belong to which deployment |
| `og1.ts`, `cdl.ts` | the OceanGliders OG1.0 mapping, and its text form |
| `types.ts`, `index.ts` | shapes, and the public surface |

## What it does not do

It reads files; it does not process them. No thermal-lag correction, no
despiking, no quality control, no gridding, and it does not write the IOOS
Glider DAC's trajectory format. The netCDF it writes is **netCDF-3 classic**
and deliberately does not claim CF conventions: the variable names and units
are the glider's own strings, carried verbatim.
