// GTA VI trophy rarity forecaster — gta6-trophy-rarity-forecast-01 (Node 22, stdlib only).
//
// Model: split every trophy's earn rate into its two moving parts,
//   rate = 100 * earners / players_tracked,
// and extrapolate each part in log-time since release.
//
//   * players_tracked N: fit log N against x = ln(1 + hours since release)
//     by least squares over the case's reads. N grows as the game spreads;
//     on launch night it jumped 638 -> 3,868 at the first Exophase refresh.
//   * earners E_i of trophy i: fit log E_i against the same x. Early story
//     trophies gain earners fast as players progress; grindy ones barely move.
//   * median rate at the target = 100 * E_i(target) / N(target), clamped.
//   * spread on the logit scale: a random-walk term growing with sqrt(days),
//     plus the fit's residual scatter, plus an extra term while the history
//     is flat (no refresh seen yet — the first refresh moved every rate).
//     The house baseline's 0.5/sqrt-day spread scored ~1.51 on practice with
//     ~0 coverage, because the refresh shoved every rate outside its band;
//     this entry is deliberately wider, especially on short horizons.
//
// When the history is flat (the practice cases: every read identical), the
// fits have no slope to learn, so priors take over:
//   * N grows with slope 1.8 in log-time (steep: Exophase refreshes catch up
//     hours of real player growth at once, as the 6x launch-night jump shows).
//   * each trophy's earners grow with a slope between 0.3 and 1.2 set by how
//     common it already is (its last rate, 0.63% -> 0.3, 2.04% -> 1.2):
//     common trophies are early/easy, so their earners keep pace best.
// The 100% trophy (id 2) is kept near 100% with a narrow band, as briefed.
//
// Deterministic: pure arithmetic, no randomness, inputs read in name order,
// outputs rounded to 4 decimals. Two runs are byte-identical.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The five levels the contest scores, in row order.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard normal quantiles at those levels.
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
// Logit spread per square-root day of horizon (random-walk term).
const SIGMA_RW = 0.7;
// Extra logit spread while no refresh has been seen in the history.
const SIGMA_UNSEEN_REFRESH = 0.8;
// Small extra spread once refreshes are visible in the history.
const SIGMA_SEEN_REFRESH = 0.15;
// Hard cap on the total logit spread, so bands stay sane on long horizons.
const SIGMA_MAX = 2.5;
// Prior slope of log players-tracked vs log-time, used when history is flat.
const PRIOR_N_SLOPE = 1.8;
// Prior earner-growth slopes by trophy commonness (see header).
const PRIOR_E_SLOPE_LOW = 0.3;
const PRIOR_E_SLOPE_HIGH = 1.2;
// Bounds on fitted slopes, to stop one noisy read from exploding a forecast.
const SLOPE_MIN = -1;
const SLOPE_MAX = 3;
// Bounds on how far a median may move from its last read rate (ratio).
const RATIO_MIN = 0.02;
const RATIO_MAX = 50;

type Trophy = { id: number; tier: string };
type Read = { at: string; players_tracked: number; rates: Array<number | null> };
type CaseFile = {
  id: string;
  at: string;
  horizon_minutes: number;
  target?: string;
  levels: number[];
  game?: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
};

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const sigmoidPct = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/** Least-squares line y = a + b*x; returns null when x barely varies. */
function ols(xs: number[], ys: number[]): { a: number; b: number; residSd: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let j = 0; j < n; j++) {
    sxx += (xs[j] - mx) ** 2;
    sxy += (xs[j] - mx) * (ys[j] - my);
    syy += (ys[j] - my) ** 2;
  }
  // Too little variation on either axis to learn a slope: on launch night
  // every read is byte-identical, so a flat y must fall back to the priors
  // instead of fitting a meaningless slope of 0.
  if (sxx < 0.01 || syy < 1e-12) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let j = 0; j < n; j++) ss += (ys[j] - (a + b * xs[j])) ** 2;
  return { a, b, residSd: Math.sqrt(ss / Math.max(n - 2, 1)) };
}

/** Hours from the release instant to an ISO timestamp. */
function hoursSinceRelease(releaseMs: number, iso: string): number {
  return (Date.parse(iso) - releaseMs) / 3600000;
}

/** log-time coordinate: ln(1 + hours since release), floored at 0. */
function logTime(releaseMs: number, iso: string): number {
  return Math.log(1 + Math.max(hoursSinceRelease(releaseMs, iso), 0));
}

function forecastCase(c: CaseFile): { id: number; q: number[] }[] {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${c.id} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${c.id} has no history`);

  const releaseMs = c.game?.release_date
    ? Date.parse(`${c.game.release_date}T00:00:00Z`)
    : Date.parse(c.history[0].at);
  const last = c.history[c.history.length - 1];
  const xLast = logTime(releaseMs, last.at);
  const targetIso = c.target ?? new Date(Date.parse(c.at) + c.horizon_minutes * 60000).toISOString();
  const xTarget = logTime(releaseMs, targetIso);
  const dx = xTarget - xLast;
  const days = c.horizon_minutes / 1440;

  // --- players tracked: fit log N vs log-time, else the prior slope. ---
  const nXs: number[] = [];
  const nYs: number[] = [];
  for (const h of c.history) {
    if (h.players_tracked > 0) {
      nXs.push(logTime(releaseMs, h.at));
      nYs.push(Math.log(h.players_tracked));
    }
  }
  const nFit = ols(nXs, nYs);
  const nSlope = nFit ? Math.min(SLOPE_MAX, Math.max(0, nFit.b)) : PRIOR_N_SLOPE;
  const historyFlat = nFit === null;
  const nGrowth = Math.min(200, Math.max(1, Math.exp(nSlope * dx)));

  // --- per-trophy earners: fit log E vs log-time, else a commonness prior. ---
  const rows: { id: number; q: number[] }[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const trophy = c.trophies[i];
    // Most recent non-null rate for this trophy (the last read normally).
    let lastRate: number | null = null;
    for (let j = c.history.length - 1; j >= 0; j--) {
      if (c.history[j].rates[i] != null) {
        lastRate = c.history[j].rates[i] as number;
        break;
      }
    }
    if (lastRate === null) lastRate = 1.0;

    // The trophy every tracked player already has: keep it near 100%.
    if (lastRate >= 99.99) {
      rows.push({ id: trophy.id, q: [96, 98.5, 99.5, 99.8, 99.95] });
      continue;
    }

    const eXs: number[] = [];
    const eYs: number[] = [];
    for (const h of c.history) {
      const r = h.rates[i];
      if (r != null && r > 0 && h.players_tracked > 0) {
        eXs.push(logTime(releaseMs, h.at));
        eYs.push(Math.log((r / 100) * h.players_tracked));
      }
    }
    const eFit = ols(eXs, eYs);
    let eSlope: number;
    let residSd = 0;
    if (eFit) {
      eSlope = Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, eFit.b));
      residSd = Math.min(eFit.residSd, 1.5);
    } else {
      // Prior: common trophies are early/easy, their earners grow fastest.
      const s = clamp01(
        (logit(lastRate) - logit(0.63)) / (logit(2.04) - logit(0.63)),
      );
      eSlope = PRIOR_E_SLOPE_LOW + (PRIOR_E_SLOPE_HIGH - PRIOR_E_SLOPE_LOW) * s;
    }

    // Median: rate moves by (earner growth) / (player growth).
    const eGrowth = Math.min(200, Math.max(0.01, Math.exp(eSlope * dx)));
    const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, eGrowth / nGrowth));
    const median = clampPct(lastRate * ratio);

    // Spread: random walk in horizon + fit scatter + refresh risk.
    const refreshTerm = historyFlat ? SIGMA_UNSEEN_REFRESH : SIGMA_SEEN_REFRESH;
    const sigma = Math.min(
      SIGMA_MAX,
      Math.sqrt((SIGMA_RW * Math.sqrt(days)) ** 2 + residSd ** 2 + refreshTerm ** 2),
    );
    const l = logit(median);
    let prev = -Infinity;
    const q = Z.map((z) => {
      const v = round4(clampPct(sigmoidPct(l + z * sigma)));
      const m = Math.max(v, prev); // keep the row non-decreasing after rounding
      prev = m;
      return m;
    });
    rows.push({ id: trophy.id, q });
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${c.id}.out`), `${JSON.stringify({ trophies })}\n`);
}
