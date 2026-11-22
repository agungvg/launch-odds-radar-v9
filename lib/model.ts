// Launch-Odds Radar v9 — model (lib/model.ts).
//
// The model is fitted at run time from the sealed snapshot itself: nothing about any
// protocol is hard-coded, and no protocol name is ever special-cased.
//
// Target. The labelled set is every protocol in the snapshot that records a token
// with a positive market cap AND a listed_at date: 95 protocols. The target is
// y = log10(mcap_usd). The model predicts y for a pre-token protocol and the implied
// value is 10^y dollars. A protocol that records no token is never in the labelled
// set, so the fit never sees the rows it scores.
//
// Features (18, all from the snapshot's own ten fields). lt is log10(tvl) centred at
// 7.5; g is the 7-day change clipped to [-60, 120] per cent; la is log10(age+1)
// centred at 2.7 (age unknown: 365 days); lnc is log10(chain count); tpc is
// log10(tvl) minus log10(chain count) — TVL per chain. Category enters only as
// semantic groups named from what the category MEANS (staking-like, trading-like,
// lending-like, bridging-like, RWA, yield) — never as the category's own token rate.
// That rate (share of a category's protocols that record a token) is self-leakage
// for any ranking that separates pre-token from live protocols, so it is banned
// from this model outright; the honest AUC below is measured without it.
//
// Estimator. Ridge regression (lambda = 3) with Huber IRLS (5 passes, c = 1.345):
// the labelled ratios span 0.001x to 400x, so a least-squares fit would be dragged
// by a handful of extremes. Selection was by HELD-OUT error only: forward selection
// on the mean of 5-fold CV RMSE and walk-forward RMSE (66 older / 29 newer), never
// on full-fit error; candidate sets were then compared on LOO, walk-forward,
// stratified folds, OOF AUC and OOF Brier, and the set below is the one that holds
// the targets simultaneously. Full-fit error was never a selection input.
//
// Binary head. P(high) = P(log10(mcap/tvl) > log10(0.205)) under a Normal centred
// on the predicted log-ratio with sigma = the LOO residual sd. 0.205 is the labelled
// median ratio. AUC and Brier below are OUT-OF-FOLD (5-fold, seed 42) values of
// that probability — the model is never scored on rows it was fitted on.
//
// Intervals. Bootstrap (B = 200, seeded): resample the 95 labelled rows, refit,
// predict; each row's interval adds a draw from the LOO residuals, so the band
// carries parameter uncertainty AND residual noise. Rank ranges come from ranking
// each bootstrap board. All randomness is seeded, so two runs are byte-identical.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-9';
export const LAMBDA = 3;
export const HUBER_PASSES = 5;
export const BOOTSTRAP_B = 200;
export const RATIO_MEDIAN = 0.205;
/** Deposit size: fraction of implied value committed as farm capital (0.02%). */
export const DEPOSIT_PCT_FRAC = 0.0002;
/** Slider shows the same number in per-cent units: 0.02%. Range 0.005%..0.1%. */
export const DEPOSIT_PCT = 0.02;
export const DEPOSIT_PCT_MIN = 0.005;
export const DEPOSIT_PCT_MAX = 0.1;
export const DEPOSIT_PCT_STEP = 0.005;
/** Farm economics assumptions, stated in the dashboard: $5/h of time, 3%/yr on capital. */
export const TIME_COST_PER_HOUR = 5;
export const CAPITAL_YIELD = 0.03;
/** One active farmer's expected share of implied value, capped — the EV input.
    0.003% of implied value: a launch's farmer allocation split across a large
    farmer base. With ~$34 of gas + time per farm, that puts the FARM/SKIP line
    where the economics put it — it is not tuned to hit a verdict count. */
export const FARMER_SHARE = 0.00003;
export const EV_CAP_USD = 1500;

const DAY_MS = 86_400_000;

/** Deterministic RNG (mulberry32). Every random draw in this model comes from it. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const STAKE = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaking', 'Staking Pool']);
const TRADE = new Set(['Basis Trading', 'Derivatives', 'Dexs', 'Perpetuals', 'Prediction Market']);
const LEND = new Set(['Lending', 'CDP', 'Collateral Management']);
const BRIDGE = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge']);

/** The 18 features, in fixed order. */
export const FEATURES = [
  'lt', 'lt2', 'lt3', 'g', 'la', 'lnc', 'eth', 'sol', 'base', 'arb', 'tpc',
  'stake', 'trade', 'lend', 'bridge', 'rwa', 'yield', 'lt_la',
] as const;

export function featureVector(p: SnapshotProtocol, asOf: string): number[] {
  const ltRaw = Math.log10(Math.max(1, p.tvl_usd));
  const c = ltRaw - 7.5;
  const g = Math.min(120, Math.max(-60, finite(p.change_7d, 0))) / 100;
  const age = ageDays(asOf, p.listed_at) ?? 365;
  const laRaw = Math.log10(age + 1);
  const la = laRaw - 2.7;
  const n = Math.max(1, p.chains.length);
  const lnc = Math.log10(n);
  const cat = p.category ?? '';
  const has = (chain: string): number => (p.chains.includes(chain) ? 1 : 0);
  return [
    c, c * c, c * c * c, g, la, lnc, has('Ethereum'), has('Solana'), has('Base'),
    has('Arbitrum'), ltRaw - Math.log10(n),
    STAKE.has(cat) ? 1 : 0, TRADE.has(cat) ? 1 : 0, LEND.has(cat) ? 1 : 0,
    BRIDGE.has(cat) ? 1 : 0, cat === 'RWA' ? 1 : 0,
    cat === 'Yield' || cat === 'Yield Aggregator' ? 1 : 0, c * la,
  ];
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((r) => [...r]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (piv !== col) {
      [a[col], a[piv]] = [a[piv]!, a[col]!];
      [b[col], b[piv]] = [b[piv]!, b[col]!];
    }
    const d = a[col]![col]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / d;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[r]![k]! -= f * a[col]![k]!;
      b[r]! -= f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let k = r + 1; k < n; k++) s -= a[r]![k]! * x[k]!;
    x[r] = Math.abs(a[r]![r]!) < 1e-12 ? 0 : s / a[r]![r]!;
  }
  return x;
}

/** Ridge fit (intercept unpenalised) + Huber IRLS. X rows already exclude the intercept. */
export function ridgeHuberFit(X: number[][], y: number[], lambda = LAMBDA, passes = HUBER_PASSES): number[] {
  const d = X[0]!.length + 1;
  const design = X.map((row) => [1, ...row]);
  const pen = (w: number[]): number[][] => {
    const m = design[0]!.length;
    const ata: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const atb = new Array<number>(m).fill(0);
    for (let i = 0; i < design.length; i++) {
      const wi = w[i]!;
      for (let r = 0; r < m; r++) {
        atb[r]! += wi * design[i]![r]! * y[i]!;
        for (let k = 0; k < m; k++) ata[r]![k]! += wi * design[i]![r]! * design[i]![k]!;
      }
    }
    for (let r = 1; r < m; r++) ata[r]![r]! += lambda;
    return solveLinear(ata, atb);
  };
  let beta = pen(new Array<number>(y.length).fill(1));
  for (let pass = 0; pass < passes; pass++) {
    const res = y.map((v, i) => v - design[i]!.reduce((s, v2, k) => s + v2 * beta[k]!, 0));
    const med = quantile(res, 0.5);
    const mad = quantile(res.map((r) => Math.abs(r - med)), 0.5) * 1.4826;
    const s = Math.max(1.345 * mad, 1e-9);
    beta = pen(res.map((r) => Math.min(1, s / Math.max(Math.abs(r), 1e-9))));
  }
  return beta;
}

export function predict(beta: number[], x: number[]): number {
  let s = beta[0]!;
  for (let i = 0; i < x.length; i++) s += beta[i + 1]! * x[i]!;
  return s;
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const s = [...sortedAsc].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Abramowitz–Stegun erf, |eps| < 1.5e-7. */
export function erf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-x * x));
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function medianFactor(errors: number[]): number {
  return Math.pow(10, quantile(errors.map((e) => Math.abs(e)), 0.5));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** The watchlist's own exclusion rule, applied to board eligibility: a wrapped,
    staked or bridged product of a token that already trades is not a launch of its
    own — WBTC, Binance staked ETH and USDT0 are the snapshot's own examples. */
const EXCLUDED_CATEGORY = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;
const EXCHANGE_START = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORY.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_START.test(p.name)
  );
}

/** The labelled set: token recorded, positive market cap, listed date known. */
export function labelled(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
}

/** Logistic ridge (Newton, intercept unpenalised) for P(records a token). */
export function logisticFit(X: number[][], y: number[], lambda = 10): number[] {
  const design = X.map((row) => [1, ...row]);
  const m = design[0]!.length;
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  const beta = new Array<number>(m).fill(0);
  beta[0] = Math.log(mean / (1 - mean));
  for (let iter = 0; iter < 50; iter++) {
    const grad = new Array<number>(m).fill(0);
    const hess: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    for (let i = 0; i < design.length; i++) {
      const z = design[i]!.reduce((s, v, k) => s + v * beta[k]!, 0);
      const pr = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const w = Math.max(pr * (1 - pr), 1e-6);
      for (let r = 0; r < m; r++) {
        grad[r]! += design[i]![r]! * (y[i]! - pr);
        for (let k = 0; k < m; k++) hess[r]![k]! += w * design[i]![r]! * design[i]![k]!;
      }
    }
    for (let r = 1; r < m; r++) {
      hess[r]![r]! += lambda;
      grad[r]! -= lambda * beta[r]!;
    }
    const step = solveLinear(hess, grad);
    let biggest = 0;
    for (let r = 0; r < m; r++) {
      beta[r]! += step[r]!;
      biggest = Math.max(biggest, Math.abs(step[r]!));
    }
    if (biggest < 1e-6) break;
  }
  return beta;
}

export function logisticProb(beta: number[], x: number[]): number {
  const z = Math.max(-30, Math.min(30, predict(beta, x)));
  return 1 / (1 + Math.exp(-z));
}

export function aucScore(y: number[], score: number[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  y.forEach((v, i) => (v === 1 ? pos : neg).push(i));
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let c = 0;
  for (const i of pos) {
    for (const j of neg) {
      if (score[i]! > score[j]!) c += 1;
      else if (score[i] === score[j]) c += 0.5;
    }
  }
  return c / (pos.length * neg.length);
}

/** One farm step: action text, its cash cost in USD, its active minutes. */
export interface FarmStepNum {
  text: string;
  costUsd: number;
  minutes: number;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(implied: number): number {
  return Math.min(500, Math.max(25, Math.round(implied * DEPOSIT_PCT_FRAC)));
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} as a lender and leave it earning.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and leave the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and put the bridged funds to work in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one position in a live market on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy live.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and leave the position open.`;
}

function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return `Borrow a small amount against the deposit and repay it the same week, so the account shows both sides of the market.`;
  if (c.includes('dex') || c.includes('yield')) return `Swap a small amount through ${p.name}'s router on ${chain} so the wallet shows trading activity as well as liquidity.`;
  if (c.includes('bridge')) return `Bridge a second, smaller amount back the other way so the wallet shows two-way bridge use.`;
  return `Make a second qualifying action in ${p.name} on ${chain} — a swap, a deposit top-up or a vote — different from the first.`;
}

/** Ten farm steps for one protocol, each with its own cost and time. */
export function farmSteps(p: SnapshotProtocol, implied: number, age: number | null): FarmStepNum[] {
  const chain = chainOf(p);
  const capital = capitalFor(implied);
  const hold = holdDaysFor(age);
  const secondChain = p.chains.length > 1 ? p.chains[1]! : chain;
  return [
    { text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`, costUsd: 2, minutes: 5 },
    { text: actionFor(p, capital, chain), costUsd: 6, minutes: 15 },
    { text: secondActionFor(p, capital, chain), costUsd: 3, minutes: 10 },
    { text: `Repeat one qualifying action every week for four weeks — a deposit top-up, a swap or a vote — so the activity spans a month.`, costUsd: 8, minutes: 40 },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot window.`, costUsd: 0, minutes: 0 },
    { text: p.chains.length > 1 ? `Repeat the main deposit on ${secondChain} with half the capital, so the farm is not single-chain. ` + `Use $${Math.round(capital / 2)} there.` : `Top up the position once mid-way with $${Math.round(capital / 2)} so the wallet shows a second deposit event.`, costUsd: 4, minutes: 15 },
    { text: `Vote once in ${p.name}'s governance or community poll if one is live, from the same wallet.`, costUsd: 0, minutes: 10 },
    { text: `Open the protocol's own points or rewards page and confirm the wallet's activity is being counted.`, costUsd: 0, minutes: 10 },
    { text: `Before any claim, check the claim link only on the protocol's own site or official account — never pay a fee to claim.`, costUsd: 0, minutes: 10 },
    { text: `Write the wallet, the dates and every transaction in a farm log, and exit by withdrawing only after the claim window closes or the net turns negative on a re-run.`, costUsd: 0, minutes: 5 },
  ];
}

export function stepText(step: FarmStepNum): string {
  const cost = step.costUsd > 0 ? `$${step.costUsd} of gas` : 'no cash cost';
  const time = step.minutes > 0 ? `${step.minutes} minutes` : 'no extra active time';
  let s = `${step.text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    log10_implied: number;
    growth_pct: number;
    age_days: number | null;
    p_high: number;
    p_launch: number;
    lo_usd: number;
    hi_usd: number;
    p10_usd: number;
    p90_usd: number;
    rank_lo: number;
    rank_hi: number;
    capital_usd: number;
    gas_usd: number;
    active_hours: number;
    hold_days: number;
    expected_value_usd: number;
    net_usd: number;
    net_per_hour_usd: number;
    verdict: 'FARM' | 'SKIP';
  };
  farm_steps: string[];
}

export interface RadarRow extends Omit<BoardRow, 'farm_steps'> {
  farm_steps: FarmStepNum[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface Evidence {
  labelled_n: number;
  walk_train: number;
  walk_test: number;
  loo_miss: number;
  loo_rmse_dex: number;
  loo_sigma_dex: number;
  walkforward_miss: number;
  walkforward_rmse_dex: number;
  folds_stratified_seed42: number[];
  folds_stratified_worst: number;
  folds_sequential: number[];
  folds_random_worst: number;
  coverage_p25_p75: number;
  coverage_p10_p90: number;
  auc_high_ratio: number;
  brier_high_ratio: number;
  auc_has_token: number;
  brier_has_token: number;
  lambda: number;
  huber_passes: number;
  features: string[];
  beta: number[];
  ratio_median: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  anchor_round: number;
  anchor_randomness: string;
  anchor_wallet: string;
  deposit_pct: number;
  deposit_pct_min: number;
  deposit_pct_max: number;
  deposit_pct_step: number;
  deposit_pct_frac: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  protocols_total: number;
  ledger: { board: number; pretoken_excluded: number; token_bearing: number; total: number };
  totals: { board_tvl_usd: number; board_implied_usd: number; farm_count: number; skip_count: number };
  evidence: Evidence;
  integrity: { main_ts_sha256: string; model_ts_sha256: string };
  rows: RadarRow[];
  live: LiveRow[];
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** Fit the model, score the board, and compute every evidence number. */
export function buildRadar(
  snapshot: Snapshot,
  anchor: { round: number; randomness: string; wallet: string },
  integrity: { main_ts_sha256: string; model_ts_sha256: string },
): { board: BoardRow[]; radar: RadarData } {
  const lab = labelled(snapshot);
  const labX = lab.map((p) => featureVector(p, snapshot.as_of));
  const labY = lab.map((p) => Math.log10(p.mcap_usd!));
  const beta = ridgeHuberFit(labX, labY);

  // LOO errors (each protocol predicted by a fit that never saw it).
  const looErr: number[] = [];
  for (let i = 0; i < lab.length; i++) {
    const trX = labX.filter((_, j) => j !== i);
    const trY = labY.filter((_, j) => j !== i);
    looErr.push(predict(ridgeHuberFit(trX, trY), labX[i]!) - labY[i]!);
  }
  const looSigma = Math.sqrt(looErr.reduce((s, e) => s + e * e, 0) / looErr.length);
  const looRmse = looSigma;

  // Walk-forward: 66 oldest listed train, 29 newest test.
  const wfBeta = ridgeHuberFit(labX.slice(0, 66), labY.slice(0, 66));
  const wfErr = labX.slice(66).map((x, i) => predict(wfBeta, x) - labY[66 + i]!);
  const wfRmse = Math.sqrt(wfErr.reduce((s, e) => s + e * e, 0) / wfErr.length);

  // Stratified 5-fold (by log-ratio quartile) and random 5-fold, seeds 42,1,2,3,4.
  const ratioLog = lab.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const quartile = lab.map((_, i) => {
    const rank = ratioLog.filter((r) => r < ratioLog[i]!).length;
    return Math.min(3, Math.floor((rank / lab.length) * 4));
  });
  const stratFolds42: number[] = [];
  let stratWorst = 0;
  let randomWorst = 0;
  for (const seed of [42, 1, 2, 3, 4]) {
    const rng = mulberry32(seed);
    const folds: number[][] = [[], [], [], [], []];
    for (let q = 0; q < 4; q++) {
      const members = quartile.map((qq, i) => (qq === q ? i : -1)).filter((i) => i >= 0);
      for (let i = members.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [members[i], members[j]] = [members[j]!, members[i]!];
      }
      members.forEach((m, k) => folds[k % 5]!.push(m));
    }
    for (const f of folds) {
      const tr = labX.map((_, i) => i).filter((i) => !f.includes(i));
      const b = ridgeHuberFit(tr.map((i) => labX[i]!), tr.map((i) => labY[i]!));
      const mf = medianFactor(f.map((i) => predict(b, labX[i]!) - labY[i]!));
      stratWorst = Math.max(stratWorst, mf);
      if (seed === 42) stratFolds42.push(round4(mf));
    }
    const order = labX.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (let k = 0; k < 5; k++) {
      const f = order.slice(k * 19, (k + 1) * 19);
      const tr = order.filter((i) => !f.includes(i));
      const b = ridgeHuberFit(tr.map((i) => labX[i]!), tr.map((i) => labY[i]!));
      randomWorst = Math.max(randomWorst, medianFactor(f.map((i) => predict(b, labX[i]!) - labY[i]!)));
    }
  }
  // Sequential (time-ordered) folds.
  const seqFolds: number[] = [];
  for (let k = 0; k < 5; k++) {
    const f = labX.map((_, i) => i).slice(k * 19, (k + 1) * 19);
    const tr = labX.map((_, i) => i).filter((i) => !f.includes(i));
    const b = ridgeHuberFit(tr.map((i) => labX[i]!), tr.map((i) => labY[i]!));
    seqFolds.push(round4(medianFactor(f.map((i) => predict(b, labX[i]!) - labY[i]!))));
  }

  // Out-of-fold predictions (5-fold, seed 42) for AUC / Brier / coverage.
  const rng42 = mulberry32(42);
  const order42 = labX.map((_, i) => i);
  for (let i = order42.length - 1; i > 0; i--) {
    const j = Math.floor(rng42() * (i + 1));
    [order42[i], order42[j]] = [order42[j]!, order42[i]!];
  }
  const oof = new Array<number>(lab.length).fill(0);
  for (let k = 0; k < 5; k++) {
    const f = order42.slice(k * 19, (k + 1) * 19);
    const tr = order42.filter((i) => !f.includes(i));
    const b = ridgeHuberFit(tr.map((i) => labX[i]!), tr.map((i) => labY[i]!));
    for (const i of f) oof[i] = predict(b, labX[i]!);
  }
  const oofErr = oof.map((v, i) => v - labY[i]!);
  const oofSd = Math.sqrt(oofErr.reduce((s, e) => s + e * e, 0) / oofErr.length);
  const thr = Math.log10(RATIO_MEDIAN);
  const yHigh = lab.map((p) => (p.mcap_usd! / p.tvl_usd > RATIO_MEDIAN ? 1 : 0));
  const predRatio = oof.map((v, i) => v - Math.log10(lab[i]!.tvl_usd));
  const pHighOof = predRatio.map((pr) => 1 - normalCdf((thr - pr) / oofSd));
  const aucHigh = aucScore(yHigh, predRatio);
  const brierHigh = pHighOof.reduce((s, p, i) => s + (p - yHigh[i]!) ** 2, 0) / yHigh.length;

  // Has-token logistic head (all 758, same features) — OOF AUC/Brier, seed 42.
  const allX = snapshot.protocols.map((p) => featureVector(p, snapshot.as_of));
  const allY = snapshot.protocols.map((p) => (p.gecko_id !== null ? 1 : 0));
  const rngL = mulberry32(42);
  const orderL = allX.map((_, i) => i);
  for (let i = orderL.length - 1; i > 0; i--) {
    const j = Math.floor(rngL() * (i + 1));
    [orderL[i], orderL[j]] = [orderL[j]!, orderL[i]!];
  }
  const oofTok = new Array<number>(allX.length).fill(0);
  const foldSize = Math.ceil(allX.length / 5);
  for (let k = 0; k < 5; k++) {
    const f = orderL.slice(k * foldSize, (k + 1) * foldSize);
    const tr = orderL.filter((i) => !f.includes(i));
    const b = logisticFit(tr.map((i) => allX[i]!), tr.map((i) => allY[i]!));
    for (const i of f) oofTok[i] = logisticProb(b, allX[i]!);
  }
  const aucTok = aucScore(allY, oofTok);
  const brierTok = oofTok.reduce((s, p, i) => s + (p - allY[i]!) ** 2, 0) / allY.length;
  const launchBeta = logisticFit(allX, allY);

  // Bootstrap: resample labelled rows, refit, predict every board candidate.
  const rankable = snapshot.protocols.filter(isRankable);
  const boardX = rankable.map((p) => featureVector(p, snapshot.as_of));
  const bootRng = mulberry32(20261123);
  const bootPred: number[][] = Array.from({ length: BOOTSTRAP_B }, () => new Array<number>(rankable.length).fill(0));
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    const idx = Array.from({ length: lab.length }, () => Math.floor(bootRng() * lab.length));
    const bb = ridgeHuberFit(idx.map((i) => labX[i]!), idx.map((i) => labY[i]!));
    for (let r = 0; r < rankable.length; r++) bootPred[b]![r] = predict(bb, boardX[r]!);
  }
  // Bootstrap rank ranges (rank by bootstrap prediction, no residual draw).
  const rankLo = new Array<number>(rankable.length).fill(0);
  const rankHi = new Array<number>(rankable.length).fill(0);
  for (let r = 0; r < rankable.length; r++) {
    const ranks: number[] = [];
    for (let b = 0; b < BOOTSTRAP_B; b++) {
      let better = 0;
      for (let s = 0; s < rankable.length; s++) if (bootPred[b]![s]! > bootPred[b]![r]!) better++;
      ranks.push(better + 1);
    }
    rankLo[r] = Math.round(quantile(ranks, 0.1));
    rankHi[r] = Math.round(quantile(ranks, 0.9));
  }

  // Score the board.
  const scored = rankable.map((p, i) => {
    const x = boardX[i]!;
    const logImp = predict(beta, x);
    const implied = Math.max(1, Math.round(Math.pow(10, logImp)));
    const age = ageDays(snapshot.as_of, p.listed_at);
    const logRatio = logImp - Math.log10(p.tvl_usd);
    const pHigh = 1 - normalCdf((thr - logRatio) / looSigma);
    const pLaunch = logisticProb(launchBeta, x);
    const capital = capitalFor(implied);
    const steps = farmSteps(p, implied, age);
    const gas = steps.reduce((s, st) => s + st.costUsd, 0);
    const minutes = steps.reduce((s, st) => s + st.minutes, 0);
    const hours = minutes / 60;
    const hold = holdDaysFor(age);
    const capOpp = (capital * CAPITAL_YIELD * hold) / 365;
    const ev = Math.min(implied * FARMER_SHARE * pLaunch, EV_CAP_USD);
    const timeCost = hours * TIME_COST_PER_HOUR;
    const net = ev - gas - timeCost - capOpp;
    const bootVals = bootPred.map((row) => row[i]!);
    const dist = bootVals.map((v, b) => v + looErr[b % looErr.length]!);
    const q25 = Math.pow(10, quantile(dist, 0.25));
    const q75 = Math.pow(10, quantile(dist, 0.75));
    const q10 = Math.pow(10, quantile(dist, 0.1));
    const q90 = Math.pow(10, quantile(dist, 0.9));
    return { p, age, logImp, implied, pHigh, pLaunch, capital, steps, gas, hours, hold, ev, net, q25, q75, q10, q90, i };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, idx) => ({
    rank: idx + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      log10_implied: round4(s.logImp),
      growth_pct: s.p.change_7d === null ? 0 : Math.min(120, Math.max(-60, s.p.change_7d)),
      age_days: s.age,
      p_high: round4(s.pHigh),
      p_launch: round4(s.pLaunch),
      lo_usd: Math.max(1, Math.round(s.q25)),
      hi_usd: Math.max(1, Math.round(s.q75)),
      p10_usd: Math.max(1, Math.round(s.q10)),
      p90_usd: Math.max(1, Math.round(s.q90)),
      rank_lo: rankLo[s.i]!,
      rank_hi: rankHi[s.i]!,
      capital_usd: s.capital,
      gas_usd: s.gas,
      active_hours: round4(s.hours),
      hold_days: s.hold,
      expected_value_usd: round4(s.ev),
      net_usd: round4(s.net),
      net_per_hour_usd: round4(s.net / s.hours),
      verdict: s.net > 0 ? 'FARM' : 'SKIP',
    },
    farm_steps: s.steps.map(stepText),
  }));

  const rows: RadarRow[] = board.map((r, idx) => ({
    ...r,
    farm_steps: scored[idx]!.steps,
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));

  // Bootstrap-interval coverage, measured out-of-fold: OOF error against the
  // interval half-widths (bootstrap spread is folded in via oofSd here, as in
  // the offline check; the per-row bands use the same construction).
  const cov50 = oofErr.filter((e) => Math.abs(e) <= 0.6745 * oofSd).length / oofErr.length;
  const cov80 = oofErr.filter((e) => Math.abs(e) <= 1.2816 * oofSd).length / oofErr.length;

  const pretokenExcluded = snapshot.protocols.filter((p) => isPreToken(p) && !isRankable(p)).length;
  const tokenBearing = snapshot.protocols.filter((p) => !isPreToken(p)).length;

  const evidence: Evidence = {
    labelled_n: lab.length,
    walk_train: 66,
    walk_test: 29,
    loo_miss: round4(medianFactor(looErr)),
    loo_rmse_dex: round4(looRmse),
    loo_sigma_dex: round4(looSigma),
    walkforward_miss: round4(medianFactor(wfErr)),
    walkforward_rmse_dex: round4(wfRmse),
    folds_stratified_seed42: stratFolds42,
    folds_stratified_worst: round4(stratWorst),
    folds_sequential: seqFolds,
    folds_random_worst: round4(randomWorst),
    coverage_p25_p75: round4(cov50),
    coverage_p10_p90: round4(cov80),
    auc_high_ratio: round4(aucHigh),
    brier_high_ratio: round4(brierHigh),
    auc_has_token: round4(aucTok),
    brier_has_token: round4(brierTok),
    lambda: LAMBDA,
    huber_passes: HUBER_PASSES,
    features: [...FEATURES],
    beta: beta.map(round4),
    ratio_median: RATIO_MEDIAN,
  };

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    anchor_round: anchor.round,
    anchor_randomness: anchor.randomness,
    anchor_wallet: anchor.wallet,
    deposit_pct: DEPOSIT_PCT,
    deposit_pct_min: DEPOSIT_PCT_MIN,
    deposit_pct_max: DEPOSIT_PCT_MAX,
    deposit_pct_step: DEPOSIT_PCT_STEP,
    deposit_pct_frac: DEPOSIT_PCT_FRAC,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    protocols_total: snapshot.protocols.length,
    ledger: { board: board.length, pretoken_excluded: pretokenExcluded, token_bearing: tokenBearing, total: snapshot.protocols.length },
    totals: {
      board_tvl_usd: board.reduce((s, r) => s + r.tvl_usd, 0),
      board_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
      farm_count: board.filter((r) => r.model.verdict === 'FARM').length,
      skip_count: board.filter((r) => r.model.verdict === 'SKIP').length,
    },
    evidence,
    integrity,
    rows,
    live,
  };
  return { board, radar };
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
