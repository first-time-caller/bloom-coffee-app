/**
 * Shared contract between the .slog parser, the Bloom web app, the native
 * machine link and the backend. Units are always real-world units:
 * °C, bar, ml/s, grams, milliseconds. Never the firmware's fixed-point ints.
 *
 * Rules for changing this file: add optional fields freely; renaming or
 * removing a field needs every consumer updated in the same change.
 */

/** One sample from a GaggiMate .slog file. Fields absent from the file's fieldsMask are omitted. */
export interface ShotSample {
  /** ms since shot start */
  t: number;
  /** target / current boiler temperature, °C */
  tt?: number;
  ct?: number;
  /** target / current pressure, bar */
  tp?: number;
  cp?: number;
  /** pump flow, target flow, puck flow, weight-derived flow, ml/s */
  fl?: number;
  tf?: number;
  pf?: number;
  vf?: number;
  /** scale weight and estimated weight, g */
  v?: number;
  ev?: number;
  /** puck resistance (unitless, firmware scale /100) */
  pr?: number;
  /** system-state bit flags, raw */
  si?: number;
  /** water pumped, g */
  wp?: number;
}

export interface ShotPhase {
  sampleIndex: number;
  /** ms since shot start, derived from the sample at sampleIndex */
  tMs: number;
  phaseNumber: number;
  phaseName: string;
  /** raw firmware transition reason code */
  reason: number;
}

/** A fully parsed shot from /api/history/<id>.slog */
export interface Shot {
  /** machine-local shot id (the integer in the file name) */
  id: number;
  /** .slog format version from the header */
  version: number;
  /** ISO 8601, from header startEpoch */
  startedAt: string;
  durationMs: number;
  sampleIntervalMs: number;
  profileId: string;
  profileName: string;
  brewDelayMs: number;
  /** final scale weight in g, null when no scale was connected */
  finalWeightG: number | null;
  finalExitReason: number;
  phases: ShotPhase[];
  samples: ShotSample[];
}

/** One row of /api/history/index.bin or recent.bin */
export interface ShotIndexEntry {
  id: number;
  startedAt: string;
  durationMs: number;
  profileName: string;
  finalWeightG: number | null;
  /** 0 = unrated, 1..5 */
  rating: number;
  /** yield recorded in notes (doseOut), g, null if unknown */
  volumeG: number | null;
  deleted: boolean;
}

/** Notes stored on the machine per shot (req:history:notes:get / save). */
export interface MachineShotNotes {
  rating?: number;
  doseIn?: string;
  doseOut?: string;
  [k: string]: unknown;
}

/**
 * Compact curve kept inside a Bloom history record, so history stays small
 * enough for localStorage. Resampled to a fixed step; parallel arrays.
 */
export interface EspressoCurve {
  stepMs: number;
  /** pressure bar, flow ml/s, weight g, temperature °C; null where not recorded */
  p: (number | null)[];
  f: (number | null)[];
  w: (number | null)[];
  c: (number | null)[];
}

/** Link from a Bloom espresso record to the shot on the machine and in the backend. */
export interface MachineShotRef {
  /** stable id for the machine, e.g. its MAC or hostname, chosen by the native link */
  machineId: string;
  shotId: number;
  profileName: string;
}

/**
 * Fields an espresso entry adds to a Bloom history record. The record also
 * carries Bloom's existing common fields (id, createdAt, rating, notes, bag…).
 */
export interface EspressoFields {
  kind: 'espresso';
  doseG: number | null;
  yieldG: number | null;
  timeS: number | null;
  /** yield / dose, null when either is missing */
  ratio: number | null;
  /** grinder setting as the user enters it */
  grind?: string;
  peakPressureBar?: number | null;
  avgTempC?: number | null;
  curve?: EspressoCurve;
  machine?: MachineShotRef;
}
