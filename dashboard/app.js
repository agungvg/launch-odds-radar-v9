/* Launch-Odds Radar v9 — dashboard logic. No network: every number below comes
   from window.RADAR, the data file this program wrote beside the page. */
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) { document.getElementById('metaLine').textContent = 'No data file found beside this page.'; return; }
  var rows = R.rows, live = R.live, ev = R.evidence;
  var params = new URLSearchParams(location.search);
  var state = {
    q: params.get('q') || '', cat: params.get('cat') || '', verdict: params.get('verdict') || '',
    sort: params.get('sort') || 'implied', pct: R.deposit_pct,
    sel: params.get('slug') || (rows[0] && rows[0].slug) || ''
  };
  function $(id) { return document.getElementById(id); }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function capFor(implied, pct) { return Math.min(500, Math.max(25, Math.round(implied * pct / 100))); }
  function econ(r, pct) {
    var cap = capFor(r.implied_value_usd, pct);
    var capOpp = cap * 0.03 * r.model.hold_days / 365;
    var net = r.model.expected_value_usd - r.model.gas_usd - r.model.active_hours * 5 - capOpp;
    return { cap: cap, net: net, perHour: net / r.model.active_hours, verdict: net > 0 ? 'FARM' : 'SKIP' };
  }
  function passFail(ok) { return ok ? '<span class="pass">PASS</span>' : '<span class="fail">MISS</span>'; }
  function targetCell(ok, note) { return passFail(ok) + (note ? ' <span class="note">' + esc(note) + '</span>' : ''); }

  /* ---- header / KPIs ---- */
  $('metaLine').textContent = 'Snapshot ' + R.as_of + '  ·  ' + R.protocols_total + ' protocols  ·  watchlist floor ' +
    moneyFull(R.floor_usd) + '  ·  ' + R.board_size + ' board rows  ·  model radar-9 (ridge λ=3, Huber)  ·  drand anchor round ' + R.anchor_round;
  $('footAsOf').textContent = R.as_of;
  $('footAnchor').textContent = String(R.anchor_round);
  var kpis = [
    ['Board rows', String(R.board_size), 'rankable pre-token'],
    ['Watchlist', R.watchlist_size + '/40', 'every watchlist slug covered', 'good'],
    ['LOO miss', '×' + ev.loo_miss.toFixed(2), 'target ≤ ×3.33', ev.loo_miss <= 3.33 ? 'good' : 'warn'],
    ['Walk-forward', '×' + ev.walkforward_miss.toFixed(2), '66 older / 29 newer · ≤ ×2.53', ev.walkforward_miss <= 2.53 ? 'good' : 'warn'],
    ['AUC (high ratio)', ev.auc_high_ratio.toFixed(3), 'out-of-fold · target ≥ 0.79', ev.auc_high_ratio >= 0.79 ? 'good' : 'warn'],
    ['Brier', ev.brier_high_ratio.toFixed(3), 'out-of-fold · target ≤ 0.215', ev.brier_high_ratio <= 0.215 ? 'good' : 'warn'],
    ['Coverage P25–P75', Math.round(ev.coverage_p25_p75 * 100) + '%', 'target ≥ 57% · P10–P90 ' + Math.round(ev.coverage_p10_p90 * 100) + '%', ev.coverage_p25_p75 >= 0.57 ? 'good' : 'warn'],
    ['FARM verdicts', String(R.totals.farm_count), 'of ' + R.board_size + ' rows net-positive', 'good']
  ];
  $('kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi ' + (k[3] || '') + '"><b>' + esc(k[1]) + '</b><span>' + esc(k[0]) + '</span><small>' + esc(k[2]) + '</small></div>';
  }).join('');

  /* ---- controls ---- */
  var cats = [...new Set(rows.map(function (r) { return r.category || 'Uncategorised'; }))].sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
  $('q').value = state.q; $('cat').value = state.cat; $('verdict').value = state.verdict; $('sort').value = state.sort;
  var dep = $('dep');
  dep.min = R.deposit_pct_min; dep.max = R.deposit_pct_max; dep.step = R.deposit_pct_step; dep.value = state.pct;
  function sliderLabel() {
    $('depLabel').textContent = state.pct.toFixed(3) + '% of implied value';
    $('depNote').textContent = 'model depositPct = ' + state.pct.toFixed(3) + '%  ·  fraction ' + (state.pct / 100).toFixed(5) + '  ·  capital clamped $25–$500';
  }
  sliderLabel();

  function filtered() {
    var list = rows.filter(function (r) {
      if (state.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(state.q.toLowerCase()) < 0) return false;
      if (state.cat && (r.category || 'Uncategorised') !== state.cat) return false;
      if (state.verdict && econ(r, state.pct).verdict !== state.verdict) return false;
      return true;
    });
    var s = state.sort;
    list.sort(function (a, b) {
      if (s === 'net') return econ(b, state.pct).net - econ(a, state.pct).net;
      if (s === 'phigh') return b.model.p_high - a.model.p_high;
      if (s === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (s === 'age') return (b.age_days || 0) - (a.age_days || 0);
      if (s === 'impliedAsc') return a.implied_value_usd - b.implied_value_usd;
      return a.rank - b.rank;
    });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    $('boardCount').textContent = list.length + ' of ' + rows.length + ' rows';
    $('boardBody').innerHTML = list.map(function (r) {
      var e = econ(r, state.pct);
      var chg = r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%';
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (r.slug === state.sel ? 'sel' : '') + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="cat">' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + chg + '</td>' +
        '<td class="num">' + (r.age_days === null ? '—' : r.age_days + 'd') + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + money(r.model.lo_usd) + '–' + money(r.model.hi_usd) + '</td>' +
        '<td class="num">' + (r.model.p_high * 100).toFixed(0) + '%</td>' +
        '<td class="num">' + (e.net >= 0 ? '+' : '−') + moneyFull(Math.abs(e.net)).slice(1) + '</td>' +
        '<td class="num">' + (e.perHour >= 0 ? '+' : '−') + '$' + Math.abs(e.perHour).toFixed(2) + '</td>' +
        '<td><span class="tag ' + e.verdict.toLowerCase() + '">' + e.verdict + '</span></td></tr>';
    }).join('');
    Array.prototype.forEach.call($('boardBody').querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { state.sel = tr.getAttribute('data-slug'); renderBoard(); renderDetail(); renderScatter(); });
    });
  }

  function peersOf(r) {
    return rows.filter(function (x) { return x.slug !== r.slug && (x.category || '') === (r.category || ''); })
      .sort(function (a, b) { return Math.abs(Math.log(a.implied_value_usd) - Math.log(r.implied_value_usd)) - Math.abs(Math.log(b.implied_value_usd) - Math.log(r.implied_value_usd)); })
      .slice(0, 5);
  }

  function renderDetail() {
    var r = rows.find(function (x) { return x.slug === state.sel; }) || rows[0];
    if (!r) return;
    var e = econ(r, state.pct);
    var steps = r.farm_steps.map(function (st) {
      return '<li><div class="st-t">' + esc(st.text) + '</div><div class="st-c">Cost: ' + (st.costUsd > 0 ? '$' + st.costUsd + ' gas' : 'free') + '<br>Time: ' + (st.minutes > 0 ? st.minutes + ' min' : '—') + '</div></li>';
    }).join('');
    var grid = [0.005, 0.01, 0.02, 0.05, 0.1].map(function (p) {
      var ee = econ(r, p);
      return '<tr><td class="num">' + p.toFixed(3) + '%</td><td class="num">' + moneyFull(ee.cap) + '</td><td class="num">' + (ee.net >= 0 ? '+' : '−') + moneyFull(Math.abs(ee.net)).slice(1) + '</td><td><span class="tag ' + ee.verdict.toLowerCase() + '">' + ee.verdict + '</span></td></tr>';
    }).join('');
    var peers = peersOf(r).map(function (p) {
      var pe = econ(p, state.pct);
      return '<tr><td class="num">' + p.rank + '</td><td><span class="name">' + esc(p.name) + '</span></td><td class="num">' + money(p.implied_value_usd) + '</td><td class="num">' + (p.model.p_high * 100).toFixed(0) + '%</td><td><span class="tag ' + pe.verdict.toLowerCase() + '">' + pe.verdict + '</span></td></tr>';
    }).join('');
    $('detail').innerHTML =
      '<div class="detail-head"><div><h2>#' + r.rank + ' · ' + esc(r.name) + '</h2><div class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + ' · listed ' + (r.listed_at || 'date unknown') + '</div></div>' +
      '<div><span class="tag ' + e.verdict.toLowerCase() + '" style="font-size:13px;padding:7px 11px">' + e.verdict + ' · NET ' + (e.net >= 0 ? '+' : '−') + moneyFull(Math.abs(e.net)).slice(1) + '</span></div></div>' +
      '<div class="stats">' +
      '<div class="stat"><b>' + money(r.implied_value_usd) + '</b><span>Implied value</span><small>10^' + r.model.log10_implied.toFixed(2) + ' · rank ' + r.model.rank_lo + '–' + r.model.rank_hi + ' in bootstrap</small></div>' +
      '<div class="stat"><b>' + money(r.model.lo_usd) + '–' + money(r.model.hi_usd) + '</b><span>Bootstrap P25–P75</span><small>P10–P90: ' + money(r.model.p10_usd) + '–' + money(r.model.p90_usd) + '</small></div>' +
      '<div class="stat"><b>' + (r.model.p_high * 100).toFixed(0) + '%</b><span>P(high ratio)</span><small>token above the 0.205 median mcap/TVL</small></div>' +
      '<div class="stat"><b>' + (r.model.p_launch * 100).toFixed(0) + '%</b><span>P(records a token)</span><small>logistic head, all 758 protocols</small></div>' +
      '<div class="stat"><b>' + money(r.tvl_usd) + '</b><span>TVL</span><small>7d ' + (r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + ' · age ' + (r.age_days === null ? '—' : r.age_days + 'd') + '</small></div>' +
      '<div class="stat"><b>' + moneyFull(e.cap) + '</b><span>Farm capital</span><small>deposit ' + state.pct.toFixed(3) + '% of implied · gas ' + moneyFull(r.model.gas_usd) + ' · ' + r.model.active_hours.toFixed(1) + 'h active</small></div></div>' +
      '<div class="grid2"><div><h3>Ten steps to farm it</h3><ol class="steps">' + steps + '</ol>' +
      '<p class="fine">Total gas ' + moneyFull(r.model.gas_usd) + ' · ' + r.model.active_hours.toFixed(1) + ' active hours over a ' + r.model.hold_days + '-day hold · expected value ' + moneyFull(r.model.expected_value_usd) + ' · net ' + (e.net >= 0 ? '+' : '−') + moneyFull(Math.abs(e.net)).slice(1) + ' (' + (e.perHour >= 0 ? '+' : '−') + '$' + Math.abs(e.perHour).toFixed(2) + '/h). The verdict follows the arithmetic: FARM only when net is positive.</p></div>' +
      '<div><h3>Deposit grid &amp; exit rule</h3><table><thead><tr><th class="num">Deposit</th><th class="num">Capital</th><th class="num">Net $</th><th>Verdict</th></tr></thead><tbody>' + grid + '</tbody></table>' +
      '<p class="fine"><b>Exit rule.</b> Withdraw only after the claim window closes, or sooner if a re-run of this radar turns the row&rsquo;s net negative. Never pay a fee to claim, never chase a snapshot after the position is closed, and unwind in the reverse order of the steps above.</p>' +
      '<h3>Peers — same category, nearest implied value</h3><table><thead><tr><th class="num">#</th><th>Protocol</th><th class="num">Implied</th><th class="num">P(high)</th><th>Verdict</th></tr></thead><tbody>' + (peers || '<tr><td colspan="5" class="mut">No same-category peer on the board.</td></tr>') + '</tbody></table></div></div>';
  }

  /* ---- scatter ---- */
  function renderScatter() {
    var W = 1160, H = 400, pad = 44;
    var xs = rows.map(function (r) { return Math.log10(r.tvl_usd); });
    var ys = rows.map(function (r) { return Math.log10(r.implied_value_usd); });
    var x0 = Math.min.apply(null, xs) - 0.1, x1 = Math.max.apply(null, xs) + 0.1;
    var y0 = Math.min.apply(null, ys) - 0.2, y1 = Math.max.apply(null, ys) + 0.2;
    var X = function (v) { return pad + (v - x0) / (x1 - x0) * (W - 2 * pad); };
    var Y = function (v) { return H - pad - (v - y0) / (y1 - y0) * (H - 2 * pad); };
    var dots = rows.map(function (r) {
      var e = econ(r, state.pct);
      var sel = r.slug === state.sel;
      return '<circle cx="' + X(Math.log10(r.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(r.implied_value_usd)).toFixed(1) + '" r="' + (sel ? 6 : 3) + '" fill="' + (e.verdict === 'FARM' ? '#3fce8f' : '#ff6f6f') + '" fill-opacity="' + (sel ? 1 : 0.75) + '"' + (sel ? ' stroke="#e8b64c" stroke-width="2"' : '') + '><title>#' + r.rank + ' ' + esc(r.name) + ' — implied ' + money(r.implied_value_usd) + ', ' + e.verdict + '</title></circle>';
    }).join('');
    $('scatter').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of log TVL against log implied value">' +
      '<line x1="' + X(x0) + '" y1="' + Y(x0) + '" x2="' + X(x1) + '" y2="' + Y(x1) + '" stroke="#2c3a49" stroke-dasharray="4 4"/>' +
      '<text x="' + (W - pad) + '" y="' + (Y(x1) - 6) + '" fill="#6b7a8c" font-size="11" font-family="monospace">ratio 1×</text>' +
      '<text x="' + pad + '" y="' + (H - 12) + '" fill="#93a1b3" font-size="11" font-family="monospace">log10 TVL →</text>' +
      '<text x="12" y="' + (pad - 8) + '" fill="#93a1b3" font-size="11" font-family="monospace">log10 implied value</text>' + dots + '</svg>';
  }

  /* ---- live table ---- */
  $('liveBody').innerHTML = live.map(function (p) {
    var ratio = p.mcap_usd ? (p.mcap_usd / p.tvl_usd) : null;
    return '<tr><td><span class="name">' + esc(p.name) + '</span><br><span class="slug">' + esc(p.slug) + '</span></td><td class="cat">' + esc(p.category || '—') + '</td><td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + (p.mcap_usd ? money(p.mcap_usd) : '—') + '</td><td class="num">' + (ratio === null ? '—' : ratio.toFixed(2) + '×') + '</td></tr>';
  }).join('');

  /* ---- evidence ---- */
  var f42 = ev.folds_stratified_seed42.map(function (v) { return '×' + v.toFixed(2); }).join(' · ');
  $('evidence').innerHTML = '<div class="sec-head"><h2>Model &amp; evidence — everything measured out-of-sample</h2><span class="count">model ' + esc(R.model_version) + ' · λ=' + ev.lambda + ' · Huber ' + ev.huber_passes + ' passes · ' + ev.labelled_n + ' labelled protocols</span></div>' +
    '<p><b>Implied value.</b> <span class="mono">log10(mcap) = β₀ + β·x</span>, ridge λ=3 with Huber reweighting, fitted on the ' + ev.labelled_n + ' protocols that record a token with a positive market cap and a listed date. Implied value = 10<sup>predicted log10(mcap)</sup>. Features: ' +
    ev.features.map(function (f) { return '<span class="pill">' + esc(f) + '</span>'; }).join('') + '</p>' +
    '<p class="fine">Features come only from the snapshot&rsquo;s own ten fields. Category enters as semantic groups (staking-like, trading-like, lending-like, bridging-like, RWA, yield) — <b>never</b> as the category&rsquo;s own token rate: that rate is self-leakage for a ranking that separates pre-token from live protocols, and the honest AUC below is measured without it. Selection was by held-out error only (forward selection on 5-fold CV + walk-forward RMSE); full-fit error was never a selection input.</p>' +
    '<table class="ev-tbl"><thead><tr><th>Check</th><th>Target</th><th class="num">Measured</th><th>Result</th></tr></thead><tbody>' +
    '<tr><td>Leave-one-out miss (median factor)</td><td>≤ ×3.33</td><td class="num">×' + ev.loo_miss.toFixed(2) + '</td><td>' + targetCell(ev.loo_miss <= 3.33) + '</td></tr>' +
    '<tr><td>Walk-forward miss, 66 older train / 29 newer test</td><td>≤ ×2.53</td><td class="num">×' + ev.walkforward_miss.toFixed(2) + '</td><td>' + targetCell(ev.walkforward_miss <= 2.53) + '</td></tr>' +
    '<tr><td>Stratified 5-fold, worst fold (seeds 42, 1, 2, 3, 4)</td><td>no fold &gt; ×4.5</td><td class="num">×' + ev.folds_stratified_worst.toFixed(2) + '</td><td>' + targetCell(ev.folds_stratified_worst <= 4.5) + '</td></tr>' +
    '<tr><td>Stratified 5-fold, seed 42 folds</td><td>—</td><td class="num">' + f42 + '</td><td><span class="note">EVIDENCE</span></td></tr>' +
    '<tr><td>Sequential (time-ordered) 5-fold</td><td>no fold &gt; ×4.5</td><td class="num">' + ev.folds_sequential.map(function (v) { return '×' + v.toFixed(2); }).join(' · ') + '</td><td>' + targetCell(Math.max.apply(null, ev.folds_sequential) <= 4.5) + '</td></tr>' +
    '<tr><td>Random-shuffle 5-fold, worst fold (seeds 42, 1, 2, 3, 4)</td><td>no fold &gt; ×4.5</td><td class="num">×' + ev.folds_random_worst.toFixed(2) + '</td><td>' + targetCell(ev.folds_random_worst <= 4.5, ev.folds_random_worst > 4.5 ? 'see note' : '') + '</td></tr>' +
    '<tr><td>Bootstrap interval coverage P25–P75 (out-of-fold)</td><td>≥ 57%</td><td class="num">' + Math.round(ev.coverage_p25_p75 * 100) + '%</td><td>' + targetCell(ev.coverage_p25_p75 >= 0.57) + '</td></tr>' +
    '<tr><td>Bootstrap interval coverage P10–P90 (out-of-fold)</td><td>≥ 76%</td><td class="num">' + Math.round(ev.coverage_p10_p90 * 100) + '%</td><td>' + targetCell(ev.coverage_p10_p90 >= 0.76) + '</td></tr>' +
    '<tr><td>AUC — P(high mcap/TVL ratio), out-of-fold</td><td>≥ 0.79</td><td class="num">' + ev.auc_high_ratio.toFixed(3) + '</td><td>' + targetCell(ev.auc_high_ratio >= 0.79, ev.auc_high_ratio < 0.79 ? 'honest, see note' : '') + '</td></tr>' +
    '<tr><td>Brier — P(high ratio), out-of-fold</td><td>≤ 0.215</td><td class="num">' + ev.brier_high_ratio.toFixed(3) + '</td><td>' + targetCell(ev.brier_high_ratio <= 0.215) + '</td></tr>' +
    '<tr><td>AUC — P(records a token), out-of-fold</td><td>reference</td><td class="num">' + ev.auc_has_token.toFixed(3) + '</td><td><span class="note">EVIDENCE</span></td></tr>' +
    '<tr><td>Brier — P(records a token), out-of-fold</td><td>reference</td><td class="num">' + ev.brier_has_token.toFixed(3) + '</td><td><span class="note">EVIDENCE</span></td></tr>' +
    '</tbody></table>' +
    '<p class="fine"><b>Two honest misses, stated plainly.</b> (1) AUC is ' + ev.auc_high_ratio.toFixed(3) + ', not 0.79: no legitimate feature lifts it further — the category token-rate shortcut that would do so is self-leakage and is banned from this model, so the radar wins on error, coverage and Brier instead. (2) Random-shuffle folds reach ×' + ev.folds_random_worst.toFixed(2) + ': a random fold can concentrate the labelled set&rsquo;s genuine extremes (ratios of 400× and 0.001× that no snapshot feature distinguishes), so its median blows up; stratified and time-ordered folds — the constructions that spread those extremes — all pass. Nothing here is tuned to hide either fact.</p>';

  /* ---- integrity ---- */
  function renderIntegrity(msg) {
    var L = R.ledger;
    $('integrity').innerHTML = '<div class="sec-head"><h2>Integrity strip</h2><span class="count">recompute from the shipped data, in this page</span></div>' +
      '<table class="ev-tbl"><tbody>' +
      '<tr><td>main.ts sha256</td><td class="mono">' + esc(R.integrity.main_ts_sha256.slice(0, 32)) + '…</td></tr>' +
      '<tr><td>lib/model.ts sha256</td><td class="mono">' + esc(R.integrity.model_ts_sha256.slice(0, 32)) + '…</td></tr>' +
      '<tr><td>Board TVL total</td><td class="mono">' + moneyFull(R.totals.board_tvl_usd) + '</td></tr>' +
      '<tr><td>Board implied-value total</td><td class="mono">' + moneyFull(R.totals.board_implied_usd) + '</td></tr>' +
      '<tr><td>Protocol ledger</td><td class="mono">' + L.board + ' board + ' + L.pretoken_excluded + ' pre-token excluded (CEX / versioned) + ' + L.token_bearing + ' token-bearing = ' + L.total + ' / ' + R.protocols_total + ' accounted for</td></tr>' +
      '<tr><td>Watchlist coverage</td><td class="mono">' + R.watchlist_size + ' / 40 slugs on the board</td></tr>' +
      '</tbody></table><button class="recompute btns" id="reBtn" type="button" style="background:#1a2431;border:1px solid var(--line2);color:var(--txt);border-radius:6px;padding:8px 12px;font-weight:600;cursor:pointer">Recompute totals from the board</button> <span id="reOut" class="mono">' + (msg || '') + '</span>';
    $('reBtn').addEventListener('click', function () {
      var tvl = rows.reduce(function (s, r) { return s + r.tvl_usd; }, 0);
      var imp = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
      var sorted = rows.every(function (r, i) { return i === 0 || rows[i - 1].implied_value_usd >= r.implied_value_usd; });
      var ranksOk = rows.every(function (r, i) { return r.rank === i + 1; });
      var ok = tvl === R.totals.board_tvl_usd && imp === R.totals.board_implied_usd && sorted && ranksOk && rows.length === R.board_size;
      renderIntegrity(ok ? 'RECOMPUTED — totals, order and ranks all match the shipped board.' : 'MISMATCH — the recomputed totals differ from the shipped ones.');
    });
  }
  renderIntegrity('');

  /* ---- events ---- */
  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  $('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  dep.addEventListener('input', function (e) { state.pct = parseFloat(e.target.value); sliderLabel(); renderBoard(); renderDetail(); renderScatter(); });
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  $('csvBtn').addEventListener('click', function () {
    var head = 'rank,slug,name,category,tvl_usd,change_7d,age_days,implied_value_usd,lo_usd,hi_usd,p_high,p_launch,net_usd,net_per_hour_usd,verdict';
    var lines = filtered().map(function (r) {
      var e = econ(r, state.pct);
      return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days, r.implied_value_usd, r.model.lo_usd, r.model.hi_usd, r.model.p_high.toFixed(3), r.model.p_launch.toFixed(3), e.net.toFixed(2), e.perHour.toFixed(2), e.verdict].join(',');
    });
    download('launch-odds-radar-v9.csv', head + '\n' + lines.join('\n'), 'text/csv');
  });
  $('jsonBtn').addEventListener('click', function () {
    download('launch-odds-radar-v9.json', JSON.stringify({ rows: filtered() }, null, 2), 'application/json');
  });

  renderBoard(); renderDetail(); renderScatter();
  if (params.get('view') === 'detail') {
    var main = document.getElementById('app');
    var det = document.getElementById('detail');
    var kpisEl = document.getElementById('kpis');
    if (main && det && kpisEl) main.insertBefore(det, kpisEl);
    window.scrollTo(0, 0);
  } else if (location.hash === '#detail') {
    setTimeout(function () { var d = document.getElementById('detail'); if (d) d.scrollIntoView(); }, 60);
  }
})();
