/**
 * Which deployment each file belongs to.
 *
 * A reader drops whatever is in front of them — a directory off the
 * dockserver, a recovery folder, two vehicles at once — and the decoder has
 * no business writing all of that into one file. Two gliders are obviously
 * two records; so is one glider's spring deployment and its summer one, even
 * though every filename and every sensor matches.
 *
 * **A deployment is one glider, over one continuous stretch of time.** The
 * split is therefore two rules:
 *
 * - a different **glider** is a different deployment, always;
 * - a **gap** in one glider's record of at least three days is a different
 *   deployment.
 *
 * # Why the gap is measured between segments, not between samples
 *
 * A glider logs different sensors on wildly different schedules — a position
 * fix only on surfacing, an Iridium counter once a segment. Measuring gaps
 * per sample would split a deployment every time some slow channel went quiet
 * over a weekend. What actually spans a deployment is the *segment*: the
 * glider is flying continuously within one and files them back to back, so
 * the gap that matters is between the end of one segment and the start of the
 * next.
 *
 * # Why three days
 *
 * It is the caller's number, not a law of nature, and it is exposed as one.
 * What it has to clear is the longest a glider can plausibly go dark inside a
 * single deployment — a missed satellite pass, ice, a comms fault — while
 * still being shorter than the shortest turnaround between deployments.
 * Slocum segments are hours apart, so anything from about a day upwards
 * separates the two cases cleanly; three leaves room on both sides.
 */

import type { Series } from './types.ts';
import { gliderOf } from './types.ts';

/** Three days, in seconds. */
export const DEFAULT_GAP_SECONDS = 3 * 24 * 60 * 60;

/** One file's contribution: which glider, and the span it covers. */
export interface Segment {
  /** The file it came from, for naming the output. */
  file: string;
  glider: string;
  /** Epoch seconds of the first and last sample in it. */
  start: number;
  end: number;
  series: Series[];
}

export interface Deployment {
  glider: string;
  start: number;
  end: number;
  /** In time order. */
  segments: Segment[];
  /** Every series across those segments, for `buildTable`. */
  series: Series[];
}

export interface SplitOptions {
  /** A quiet stretch at least this long starts a new deployment. */
  gapSeconds?: number;
}

/**
 * The span a decoded file covers.
 *
 * Taken across every sensor rather than from the clock alone, because a
 * sensor can legitimately be written on a cycle where the clock was not.
 * Non-finite stamps are ignored — they are cycles whose clock was NOTSET, and
 * they carry no position in time to place a deployment boundary against.
 */
export function spanOf(series: readonly Series[]): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const s of series) {
    for (const t of s.time) {
      if (!Number.isFinite(t)) continue;
      if (t < start) start = t;
      if (t > end) end = t;
    }
  }
  return start === Infinity ? null : { start, end };
}

/**
 * Group decoded files into deployments.
 *
 * Files with no usable time at all are dropped rather than guessed at: a
 * segment with no clock cannot be placed against a gap, and putting it in the
 * first deployment would be inventing a fact. They are returned separately so
 * the caller can say so.
 */
export function splitDeployments(
  files: readonly { file: string; series: Series[] }[],
  options: SplitOptions = {},
): { deployments: Deployment[]; undated: string[] } {
  const gap = options.gapSeconds ?? DEFAULT_GAP_SECONDS;

  const segments: Segment[] = [];
  const undated: string[] = [];
  for (const entry of files) {
    const span = spanOf(entry.series);
    if (!span) {
      undated.push(entry.file);
      continue;
    }
    segments.push({
      file: entry.file,
      // Every series from one file carries the same glider; the filename is
      // the fallback for a series built by hand.
      glider: entry.series.find((s) => s.glider)?.glider ?? gliderOf(entry.file),
      start: span.start,
      end: span.end,
      series: entry.series,
    });
  }

  const byGlider = new Map<string, Segment[]>();
  for (const segment of segments) {
    const bucket = byGlider.get(segment.glider);
    if (bucket) bucket.push(segment);
    else byGlider.set(segment.glider, [segment]);
  }

  const deployments: Deployment[] = [];
  for (const [glider, bucket] of byGlider) {
    bucket.sort((a, b) => a.start - b.start || a.end - b.end);

    let current: Segment[] = [];
    let reach = -Infinity; // the furthest into time this deployment yet runs
    for (const segment of bucket) {
      // Against the deployment's furthest reach rather than the previous
      // segment's end, so one long segment overlapping a short one does not
      // look like a gap.
      if (current.length > 0 && segment.start - reach >= gap) {
        deployments.push(gather(glider, current));
        current = [];
        reach = -Infinity;
      }
      current.push(segment);
      reach = Math.max(reach, segment.end);
    }
    if (current.length > 0) deployments.push(gather(glider, current));
  }

  deployments.sort((a, b) => a.start - b.start || (a.glider < b.glider ? -1 : 1));
  return { deployments, undated };
}

function gather(glider: string, segments: Segment[]): Deployment {
  return {
    glider,
    start: Math.min(...segments.map((s) => s.start)),
    end: Math.max(...segments.map((s) => s.end)),
    segments,
    series: segments.flatMap((s) => s.series),
  };
}

/**
 * What to call a deployment on screen and in a file name.
 *
 * The glider and the day it started, which is how an operator refers to one —
 * `electa 2025-05-07`. Distinct by construction: two deployments of one
 * glider are three days apart at minimum, so their start days differ.
 */
export function deploymentLabel(deployment: Deployment): string {
  const day = Number.isFinite(deployment.start)
    ? new Date(deployment.start * 1000).toISOString().slice(0, 10)
    : 'undated';
  return `${deployment.glider} ${day}`;
}

/** The same, as a filename stem: `electa-20250507`. */
export function deploymentStem(deployment: Deployment): string {
  const day = Number.isFinite(deployment.start)
    ? new Date(deployment.start * 1000).toISOString().slice(0, 10).replace(/-/g, '')
    : 'undated';
  return `${deployment.glider}-${day}`;
}
