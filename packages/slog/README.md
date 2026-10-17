# bloom-slog

Parser for GaggiMate `.slog` shot files and `index.bin` / `recent.bin`. Written from the format definition (`shot_log_format.h`); upstream JS parsers are used only as a test oracle (CC BY-NC-SA 4.0, not copied).

## API (`src/index.ts`)
- `parseShot(buf, id = 0, { allowPartial? }) -> Shot` throws `SlogError` (`code`: BAD_MAGIC, TRUNCATED, UNSUPPORTED, CORRUPT). Fields absent from `fieldsMask` are omitted from samples.
- `parseIndex(buf) -> ShotIndexEntry[]` for `index.bin` and `recent.bin` (identical SIDX layout). Deleted rows are included with `deleted: true`.
- `shotToCurve(shot, stepMs = 500)`: p = `cp`, f = `pf ?? fl`, w = `v`, c = `ct`; linear interpolation on grid `0..durationMs`, `null` when a field is never recorded, rounded to 0.1.
- `summarizeShot(shot) -> { timeS, yieldG, peakPressureBar, avgTempC }`. `timeS = durationMs / 1000` (total recorded time, brew delay NOT subtracted: that is what the GaggiMate history UI shows). `avgTempC` is the mean of `ct` over all samples (same as the index aggregate).
- `slogPath(id) -> "/api/history/000123.slog"`.

Units: C, bar, ml/s, g, ms. `si` is the raw bit field, `pr` is raw/100.

## Layout (little-endian)
Header: v1-4 = 128 bytes, v5+ = 512 bytes.

| off | size | field |
|---|---|---|
| 0 | 4 | magic `SHOT` 0x544F4853 |
| 4 | 1 | version |
| 5 | 1 | record size (0 in very old files = unknown) |
| 6 | 2 | headerSize |
| 8 | 2 | sampleInterval ms |
| 12 | 4 | fieldsMask |
| 16 | 4 | sampleCount (0 = unpatched/incomplete) |
| 20 | 4 | durationMs |
| 24 | 4 | startEpoch (s) |
| 28 | 32 | profileId |
| 60 | 48 | profileName |
| 108 | 2 | finalWeight (g*10) |
| 110 | 12x29 | phase transitions (v5+): u16 sampleIndex, u8 phase, u8 reason, char[25] name |
| 458 | 1 | transition count |
| 459 | 1 | finalExitReason |
| 460 | 2 | brewDelayMs |

Samples follow the header. Order: t, tt, ct, tp, cp, fl, tf, pf, vf, v, ev, pr, si, wp (mask bits 0-13), each u16 (fl/tf/pf/vf are i16) except t. Scales: temps and pressures /10, flows /100, weights and wp /10, pr /100.

Record size is derived from the mask (2 bytes per set bit, t is 4 bytes from v6): v1-v5 26 B (mask 0x1FFF, t = u16 sample index * interval), v6 28 B (u32 ms), v7/v8 30 B (adds wp). Legacy "scale v6" (record size 26, mask 0x1FFF) keeps the u16 tick. Unknown mask bits are treated as 2-byte fields and skipped.

Index: 32-byte header (magic `SIDX` 0x58444953, u16 version, u16 entrySize=128, u32 count, u32 nextId) then 128-byte entries: id u32, timestamp u32, duration u32, volume u16 (g*10, 0 = none), rating u8, flags u8 (1 completed, 2 deleted, 4 notes), profileId[32] @16, profileName[48] @48, avgTemp u16 @96, maxPressure u16 @98, avgFlow u16 @100.

## Behaviour notes
- An unpatched file (sampleCount 0, shot still recording or power loss) is accepted; count and duration come from the data. A file with fewer samples than declared throws TRUNCATED unless `allowPartial`. A partial trailing record is ignored.
- `finalWeightG`: header finalWeight if > 0, else last sample `v` if > 0, else null.
- Phase `tMs` is the `t` of the sample at `sampleIndex` (clamped to the last sample).

## Uncertainty
- v1-v4 files: I could not see real ones; their field bits (including any old phase field) are assumed to match the mask table, and unknown bits are skipped. No real-device files were available; fixtures are synthetic. The upstream oracle agrees on all of them.
- A sample-size byte that contradicts the mask is rejected (CORRUPT); firmware would also refuse it.
- Index `volume` already reflects the notes `doseOut` override when set, so `finalWeightG` and `volumeG` are both set to it.

## Dev
`npm test`, `npm run build` (-> `web/vendor/bloom-slog.js`, global `BloomSlog`), `npm run fixtures` (regenerates `test/fixtures`).
