/* Sample GaggiMate shots for demoing espresso mode without a machine.
   window.BLOOM_SAMPLE_SHOTS: contract `Shot` objects (packages/contract). Samples every 250 ms, ~30 s.
   window.BLOOM_SAMPLE_NOTES: optional parallel MachineShotNotes (what you would have typed on the machine).
   Deterministic (no Math.random) so every load gives the same curves. */
(function () {
  'use strict';
  var STEP = 250;
  var r1 = function (v) { return Math.round(v * 10) / 10; };
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  /* small repeatable wobble in [-1, 1] */
  var wob = function (i, k) { return Math.sin(i * 1.7 + k) * 0.6 + Math.sin(i * 0.43 + k * 2.1) * 0.4; };
  var smooth = function (x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

  /* cfg: n samples, scale on/off, and functions of seconds -> pressure/flow/weight/temp */
  function build(cfg) {
    var samples = [], w = 0, n = cfg.n;
    for (var i = 0; i < n; i++) {
      var t = i * STEP, s = t / 1000;
      var tp = cfg.target(s), cp = Math.max(0, tp + wob(i, 1) * 0.12 * (tp > 1 ? 1 : 0.2));
      var fl = cfg.flow(s) * (cfg.fk || 1) * (1 + wob(i, 3) * 0.04);
      if (cfg.scale && s > cfg.drip) w += Math.max(0, fl * (STEP / 1000) * 0.96);
      var tt = cfg.temp, ct = tt - 0.9 + smooth(s / 4) * 1.1 - Math.max(0, s - 24) * 0.02 + wob(i, 5) * 0.08;
      var smp = { t: t, tt: tt, ct: r1(ct * 10) / 10, tp: r1(tp), cp: r2(cp), fl: r2(Math.max(0, fl)), tf: r2(cfg.tflow ? cfg.tflow(s) : 0),
        pf: r2(Math.max(0, fl * 0.97)), pr: Math.round(40 + s * 3 + wob(i, 7) * 2), si: 1 };
      if (cfg.scale) { smp.v = r1(w); smp.vf = r2(Math.max(0, fl * 0.95)); }
      samples.push(smp);
    }
    return samples;
  }

  function shot(id, startedAt, name, cfg, phases, finalW) {
    var samples = build(cfg);
    return {
      id: id, version: 5, startedAt: startedAt, durationMs: (samples.length - 1) * STEP, sampleIntervalMs: STEP,
      profileId: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), profileName: name, brewDelayMs: 0,
      finalWeightG: cfg.scale ? samples[samples.length - 1].v : null, finalExitReason: 1,
      phases: phases.map(function (p, k) { return { sampleIndex: Math.round(p[0] * 1000 / STEP), tMs: p[0] * 1000, phaseNumber: k, phaseName: p[1], reason: k ? 1 : 0 }; }),
      samples: samples
    };
  }

  /* 1. classic: ~7 s pre-infusion at 2 bar, ramp, hold 9 bar. 31 s, to about 36 g */
  var classic = shot(101, '2026-10-12T07:42:10.000Z', 'Classic 9 bar', {
    n: 125, scale: true, drip: 8.5, temp: 93, fk: 0.82,
    target: function (s) { return s < 7 ? 2 : s < 9 ? 2 + (s - 7) / 2 * 7 : s < 27 ? 9 : Math.max(6.5, 9 - (s - 27) * 1.2); },
    flow: function (s) { return s < 2 ? s * 1.1 : s < 7 ? 1.3 : s < 9 ? 1.3 + (s - 7) * 0.5 : 2.1 - Math.min(0.5, (s - 9) * 0.02); },
    tflow: function (s) { return s < 7 ? 1.3 : 2; }
  }, [[0, 'Pre-infusion'], [7, 'Ramp'], [9, 'Extraction']]);

  /* 2. lever-style decline: 9 bar falling to 5, longer shot, to about 40 g */
  var lever = shot(102, '2026-10-13T08:05:31.000Z', 'Lever decline', {
    n: 133, scale: true, drip: 9.5, temp: 92.5, fk: 0.78,
    target: function (s) { return s < 6 ? 2.5 : s < 8 ? 2.5 + (s - 6) / 2 * 6.5 : s < 12 ? 9 : Math.max(5, 9 - (s - 12) * 0.2); },
    flow: function (s) { return s < 1.5 ? s : s < 6 ? 1.5 : s < 8 ? 1.5 + (s - 6) * 0.45 : 2.4 - (s - 8) * 0.03; }
  }, [[0, 'Pre-infusion'], [6, 'Ramp'], [8, 'Decline']]);

  /* 3. no scale connected: no weight (v, vf) anywhere, finalWeightG null */
  var noScale = shot(103, '2026-10-14T16:20:02.000Z', 'Turbo 6 bar', {
    n: 100, scale: false, temp: 94,
    target: function (s) { return s < 2 ? 1 + s * 2.5 : 6; },
    flow: function (s) { return s < 2 ? s * 1.8 : 4.2 - Math.min(1.2, (s - 2) * 0.05); }
  }, [[0, 'Fill'], [2, 'Extraction']]);

  window.BLOOM_SAMPLE_SHOTS = [classic, lever, noScale];
  window.BLOOM_SAMPLE_NOTES = [
    { rating: 4, doseIn: '18', doseOut: '33.5' },
    { rating: 3, doseIn: '18', doseOut: '35.2' },
    { doseIn: '15' }
  ];
})();
