//! The "fable_spread" account choice: an account takes a thread only if its 5-hour
//! window carries it together with the threads already burning there; among such accounts the one whose weekly room
//! would otherwise expire unused wins. A thread moves while its cache is hot only when its account is about to run out.
//!
//! Units: burn in % of a 5-hour window per hour, use in %, times inside the formulas in hours.

use serde_json::{json, Value};

const H: f64 = 3_600_000.0;
const H_MS: u64 = 3_600_000;
/// A thread with no call for this long is not live (T3 closes an idle claude after 30 min).
pub const LIVE_MS: u64 = 30 * 60_000;
/// Calls older than this no longer move the smoothed burn (4 half-lives).
const RECENT_MS: u64 = 2 * H_MS;

// Burn forecast b^ (fitted on recorded threads).
pub const B0_NEW: f64 = 3.9;
const A_OPUS: (f64, f64) = (0.88, 0.65);
const A_FABLE: (f64, f64) = (1.02, 0.40);
const HALF_LIFE: f64 = 0.5 * H;
/// Fable refused to a thread counts for this long, like the models it used (src/main.rs MODEL_MEMORY_MS).
const FABLE_MEMORY_MS: u64 = 24 * H_MS;

// Ranking.
const R_NEW: f64 = 10.0;
pub const R_STAY: f64 = 5.0;
const F_NEED: f64 = 0.2;
const Q: f64 = 1.55;
const MARGIN5: f64 = 10.0;
const LOOK5: f64 = 0.5;
const LOOK7: f64 = 3.0;
const D7: f64 = 1.28;
const DF: f64 = 1.59;
const SD7: f64 = 8.0;
const SDF: f64 = 10.0;
const Z: f64 = 1.0;
const W_P: f64 = 20.0;
const STICK: f64 = 10.0;
const BETA: f64 = 15.0;
const HYST: f64 = 10.0;
const T_COOL_MS: u64 = H_MS;
/// A new thread's ranking loses this much per thread already live on the account.
const W_N: f64 = 10.0;

// Admission of a new claude -p run.
const ADMIT: f64 = 1.0;
/// A held start looks again at least this often.
pub const RECHECK_MS: u64 = 30 * 60_000;
const N_WIN: usize = 3;
/// Share of live threads still running this many hours later (fitted on recorded threads).
const SURV_H: [f64; 8] = [0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 12.0, 24.0];
const SURV_CLI: [f64; 8] = [0.93, 0.40, 0.24, 0.17, 0.12, 0.10, 0.09, 0.08];
const SURV_T3: [f64; 8] = [1.00, 0.84, 0.78, 0.73, 0.66, 0.57, 0.50, 0.37];

/// $ per million tokens, input and output.
fn price(model: &str) -> (f64, f64) {
    let m = model.to_lowercase();
    if m.contains("fable") {
        (10.0, 50.0)
    } else if m.contains("opus-5-5") {
        (4.0, 20.0)
    } else if m.contains("opus") {
        (5.0, 25.0)
    } else if m.contains("sonnet") {
        (2.0, 10.0)
    } else if m.contains("haiku") {
        (1.0, 5.0)
    } else {
        (4.0, 20.0)
    }
}

/// Limit cost of one API call in $, the way the limits count it: input, cache writes (1.25x
/// input for the 5-minute cache, 2x for the 1-hour one) and output at API prices; cache reads count as free.
pub fn call_cost(model: &str, usage: &Value) -> f64 {
    let n = |v: &Value| v.as_f64().unwrap_or(0.0);
    let (pi, po) = price(model);
    let c = &usage["cache_creation"];
    let (w5, w1) = match (c["ephemeral_5m_input_tokens"].as_f64(), c["ephemeral_1h_input_tokens"].as_f64()) {
        (None, None) => (n(&usage["cache_creation_input_tokens"]), 0.0),
        (a, b) => (a.unwrap_or(0.0), b.unwrap_or(0.0)),
    };
    (n(&usage["input_tokens"]) * pi + w5 * pi * 1.25 + w1 * pi * 2.0 + n(&usage["output_tokens"]) * po) / 1e6
}

/// The output part of `call_cost`.
pub fn output_cost(model: &str, tokens: f64) -> f64 {
    tokens * price(model).1 / 1e6
}

fn hours(later: u64, earlier: u64) -> f64 {
    (later as f64 - earlier as f64) / H
}

/// What a thread has spent, in $ of limit cost. Kept with its session across processes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Burn {
    pub first_ms: u64,
    pub last_ms: u64,
    pub cost: f64,
    pub fable_cost: f64,
    /// $ spent per minute over the last 2 hours: (time of the minute's first call, $).
    pub recent: Vec<(u64, f64)>,
    /// When Fable was last refused to this thread or its agents.
    pub fable_refused_ms: u64,
}

impl Burn {
    pub fn add(&mut self, now: u64, usd: f64, fable: bool) {
        if self.first_ms == 0 {
            self.first_ms = now;
        }
        self.last_ms = self.last_ms.max(now);
        self.cost += usd;
        if fable {
            self.fable_cost += usd;
        }
        match self.recent.last_mut() {
            Some((t, c)) if now.saturating_sub(*t) < 60_000 => *c += usd,
            _ => self.recent.push((now, usd)),
        }
        self.recent.retain(|(t, _)| now.saturating_sub(*t) < RECENT_MS);
    }

    pub fn to_json(&self) -> Value {
        let r6 = |x: f64| (x * 1e6).round() / 1e6;
        json!({
            "first_ms": self.first_ms,
            "last_ms": self.last_ms,
            "cost": r6(self.cost),
            "fable_cost": r6(self.fable_cost),
            "recent": self.recent.iter().map(|(t, c)| json!([t, r6(*c)])).collect::<Vec<_>>(),
            "fable_refused_ms": self.fable_refused_ms,
        })
    }

    pub fn from_json(v: &Value) -> Burn {
        let ms = |k: &str| v[k].as_u64().unwrap_or(0);
        Burn {
            first_ms: ms("first_ms"),
            last_ms: ms("last_ms"),
            cost: v["cost"].as_f64().unwrap_or(0.0),
            fable_cost: v["fable_cost"].as_f64().unwrap_or(0.0),
            recent: v["recent"].as_array().into_iter().flatten().filter_map(|p| Some((p[0].as_u64()?, p[1].as_f64()?))).collect(),
            fable_refused_ms: ms("fable_refused_ms"),
        }
    }
}

/// A T3 chat (stream-json, can move between turns) or a nested `claude -p` run (one process, placed once).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    T3,
    Cli,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::T3 => "t3",
            Kind::Cli => "cli",
        }
    }

    pub fn parse(s: &str) -> Kind {
        if s == "cli" { Kind::Cli } else { Kind::T3 }
    }
}

/// One thread as the strategy sees it.
#[derive(Clone, Debug)]
pub struct Thread {
    pub kind: Kind,
    pub burn: Burn,
    /// Fable is the thread's model, or it or its agents used Fable within 24 h.
    pub fable: bool,
    /// The account it lives on (for a held start: the account it is promised); None: not placed yet.
    pub account: Option<usize>,
    /// Where the strategy last put it: staying there counts for STICK.
    pub home: Option<usize>,
    pub last_move_ms: u64,
    /// A start held by admission: the account, the promised start, the burn counted for it there.
    pub waiting: Option<(usize, u64, f64)>,
}

impl Thread {
    pub fn new(kind: Kind, burn: Burn, fable: bool) -> Thread {
        Thread { kind, burn, fable, account: None, home: None, last_move_ms: 0, waiting: None }
    }

    fn fable_hit(&self, now: u64) -> bool {
        self.burn.fable_refused_ms > 0 && now.saturating_sub(self.burn.fable_refused_ms) <= FABLE_MEMORY_MS
    }

    fn uses_fable(&self, now: u64) -> bool {
        self.fable || self.fable_hit(now)
    }

    /// Share of the thread's burn that is Fable; a thread refused Fable counts as a Fable thread.
    pub fn fable_share(&self, now: u64) -> f64 {
        if !self.uses_fable(now) {
            return 0.0;
        }
        if self.burn.cost > 0.0 {
            let f = self.burn.fable_cost / self.burn.cost;
            return if self.fable_hit(now) && f < 0.2 { 1.0 } else { f };
        }
        1.0
    }

    /// Smoothed burn (half-life 30 min), % of a window of `c5` $ per hour.
    fn ewma(&self, now: u64, c5: f64) -> f64 {
        let lam = std::f64::consts::LN_2 / HALF_LIFE;
        let r: f64 = self
            .burn
            .recent
            .iter()
            .filter(|(t, _)| (now as f64 - *t as f64) < 4.0 * HALF_LIFE)
            .map(|(t, c)| c * lam * (-lam * (now as f64 - *t as f64)).exp())
            .sum();
        100.0 * r * H / c5
    }

    /// Forecast of the thread's burn over the next hour, % of a window of `c5` $ per hour.
    pub fn bhat(&self, now: u64, c5: f64) -> f64 {
        if self.burn.cost <= 0.0 {
            return B0_NEW;
        }
        let (a0, a1) = if self.fable_share(now) > 0.5 { A_FABLE } else { A_OPUS };
        let mut b = a0 + a1 * self.ewma(now, c5);
        if now.saturating_sub(self.burn.first_ms) < H_MS {
            b = b.max(B0_NEW);
        }
        if now.saturating_sub(self.burn.last_ms) > H_MS && 100.0 * self.burn.cost / c5 >= 10.0 {
            b = b.max(10.0); // a heavy thread coming back
        }
        b
    }

    /// The burn counted for it in admission: a running thread's forecast, a held start's own figure.
    fn admitted_burn(&self, now: u64, c5: f64) -> f64 {
        self.waiting.map_or_else(|| self.bhat(now, c5), |w| w.2)
    }
}

/// One account as the strategy sees it.
#[derive(Clone, Debug, Default)]
pub struct Acc {
    /// Its login is dead or failing: nothing runs there.
    pub dead: bool,
    /// No quota data: the strategy cannot judge it.
    pub unknown: bool,
    /// % used of the 5-hour window and when it ends (None: no window open).
    pub u5: f64,
    pub w5_end: Option<u64>,
    pub u7: f64,
    pub w7_end: Option<u64>,
    /// % used of the weekly Fable limit (it resets with the week).
    pub uf: f64,
    /// $ of limit cost in a whole 5-hour window, week, Fable week.
    pub cap: [f64; 3],
}

/// How one account ranks for one thread.
#[derive(Clone, Debug)]
pub struct Row {
    pub acc: usize,
    /// Has room for the thread (every limit it needs has at least R left).
    pub feas: bool,
    /// ... and its 5-hour window carries the thread with the others: P5 <= 90%.
    pub safe: bool,
    pub key: f64,
    /// Projected use of the 5-hour window at its end, as a share.
    pub p5: f64,
    /// Hours until the window is used up at the burn of all its threads.
    pub t5: f64,
    /// Burn of the other threads live there.
    pub load: f64,
    pub threads: usize,
    pub h5: f64,
    pub h7: f64,
    pub hf: f64,
    pub tau5: f64,
}

impl Row {
    pub fn to_json(&self, name: &str) -> Value {
        let r2 = |x: f64| (x * 100.0).round() / 100.0;
        json!({"account": name, "feasible": self.feas, "safe": self.safe, "key": r2(self.key), "p5": r2(self.p5 * 100.0),
            "load": r2(self.load), "threads": self.threads, "left": [r2(self.h5), r2(self.h7), r2(self.hf)], "reset5_in_h": r2(self.tau5)})
    }
}

/// What to do with a thread at a turn boundary or when its process starts again.
#[derive(Clone, Debug, PartialEq)]
pub enum Turn {
    Stay(String),
    /// `low`: the account has less than R_STAY left in what the thread needs, or is dead: leave even while
    /// background tasks run. `forced`: it is about to run out (otherwise the cache was cold anyway).
    Move { to: usize, forced: bool, low: bool, why: String },
}

/// Where and when a held start may run.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub at: u64,
    pub acc: usize,
    /// False: no account admits it within N_WIN windows; `at` is the least loaded window looked at.
    pub admitted: bool,
}

fn surv(kind: Kind, h: f64) -> f64 {
    let ys = if kind == Kind::Cli { &SURV_CLI } else { &SURV_T3 };
    if h <= SURV_H[0] {
        return ys[0];
    }
    for i in 1..SURV_H.len() {
        if h <= SURV_H[i] {
            let x = (h - SURV_H[i - 1]) / (SURV_H[i] - SURV_H[i - 1]);
            return ys[i - 1] + x * (ys[i] - ys[i - 1]);
        }
    }
    ys[ys.len() - 1]
}

/// Everything the strategy looks at: the accounts, which of them may take the thread, the other live threads.
pub struct World<'a> {
    pub accs: &'a [Acc],
    pub allowed: &'a [usize],
    pub others: &'a [Thread],
    pub now: u64,
}

impl World<'_> {
    fn on(&self, a: usize) -> impl Iterator<Item = &Thread> {
        self.others.iter().filter(move |x| x.account == Some(a))
    }

    fn load(&self, a: usize) -> f64 {
        let c5 = self.accs[a].cap[0];
        self.on(a).map(|x| x.bhat(self.now, c5)).sum()
    }

    fn load_fable(&self, a: usize) -> f64 {
        let c5 = self.accs[a].cap[0];
        self.on(a).map(|x| x.fable_share(self.now) * x.bhat(self.now, c5)).sum()
    }

    /// Every account's row for this thread (+ the per-thread penalty for a thread not placed yet).
    pub fn rows(&self, me: &Thread, b_i: f64, r: f64, exclude: Option<usize>) -> Vec<Row> {
        let now = self.now;
        let f = me.fable_share(now);
        let n = self.accs.len() as f64;
        let mut out = Vec::new();
        for &a in self.allowed.iter().filter(|&&a| Some(a) != exclude) {
            let v = &self.accs[a];
            let (h5, h7, hf) = (100.0 - v.u5, 100.0 - v.u7, 100.0 - v.uf);
            let hm = if f > F_NEED { h5.min(h7).min(hf) } else { h5.min(h7) };
            let feas = !v.dead && !v.unknown && hm >= r;
            let tau5 = v.w5_end.map_or(5.0, |e| hours(e, now));
            let u5 = if v.w5_end.is_some() { v.u5 } else { 0.0 };
            let load = self.load(a);
            let p5 = (u5 + (load + Q * b_i) * tau5) / 100.0;
            let t5 = h5 / (load + b_i).max(1e-6);
            // An unknown weekly reset is taken as a week away: the least slack.
            let tau7 = v.w7_end.map_or(168.0, |e| hours(e, now));
            let spread = Z * (tau7.max(0.0) / 24.0).sqrt();
            let s7 = h7 - D7 / n * tau7 - SD7 * spread;
            let sf = hf - DF / n * tau7 - SDF * spread;
            let slack = if f > 0.9 {
                s7.min(sf)
            } else if f > 0.2 {
                s7.min(sf + (1.0 - f) * 50.0)
            } else {
                s7
            };
            let threads = self.on(a).count();
            let mut key = slack - W_P * p5;
            if me.home == Some(a) {
                key += STICK;
            }
            if f <= 0.2 && sf < 0.0 {
                key += BETA;
            }
            if me.account.is_none() {
                key -= W_N * threads as f64;
            }
            out.push(Row { acc: a, feas, safe: feas && p5 <= 1.0 - MARGIN5 / 100.0, key, p5, t5, load, threads, h5, h7, hf, tau5 });
        }
        out
    }

    /// The best key among accounts whose window carries the thread; else the account whose window
    /// lasts longest among those with room; else none.
    pub fn choose(&self, me: &Thread, b_i: f64, r: f64, exclude: Option<usize>) -> (Option<usize>, Vec<Row>) {
        let rows = self.rows(me, b_i, r, exclude);
        let w7 = |a: usize| self.accs[a].w7_end.unwrap_or(u64::MAX);
        let round6 = |x: f64| (x * 1e6).round();
        let mut best: Option<&Row> = None;
        for row in rows.iter().filter(|r| r.safe) {
            let better = match best {
                None => true,
                Some(b) => {
                    let (k, kb) = (round6(row.key), round6(b.key));
                    k > kb || (k == kb && (w7(row.acc) < w7(b.acc) || (w7(row.acc) == w7(b.acc) && row.p5 < b.p5)))
                }
            };
            if better {
                best = Some(row);
            }
        }
        if best.is_none() {
            for row in rows.iter().filter(|r| r.feas) {
                if best.is_none_or(|b| row.t5 > b.t5) {
                    best = Some(row);
                }
            }
        }
        (best.map(|r| r.acc), rows)
    }

    /// When the account can take the thread at the earliest (u64::MAX: never, as far as the data shows).
    pub fn t_usable(&self, a: usize, me: &Thread) -> u64 {
        let v = &self.accs[a];
        if v.dead || v.unknown {
            return u64::MAX;
        }
        let mut t = self.now;
        if v.u7 >= 100.0 - R_STAY || (me.fable_share(self.now) > F_NEED && v.uf >= 100.0 - R_STAY) {
            t = t.max(v.w7_end.unwrap_or(u64::MAX));
        }
        if v.u5 >= 100.0 - R_STAY {
            if let Some(e) = v.w5_end {
                t = t.max(e);
            }
        }
        t
    }

    /// The account that frees up first and when (the retry when nothing has room).
    pub fn first_usable(&self, me: &Thread) -> Option<(usize, u64)> {
        let mut best: Option<(usize, u64)> = None;
        for &a in self.allowed {
            let t = self.t_usable(a, me);
            if t != u64::MAX && best.is_none_or(|b| t < b.1) {
                best = Some((a, t));
            }
        }
        best
    }

    /// A new T3 chat (`choose` with the per-thread penalty); None: no account can be judged.
    pub fn place(&self, me: &Thread) -> Option<(usize, String, Vec<Row>)> {
        let (a, rows) = self.choose(me, B0_NEW, R_NEW, None);
        match a {
            Some(a) => {
                let r = rows.iter().find(|r| r.acc == a).unwrap();
                let why = if r.safe { "its 5-hour window carries the new thread and it ranks best" } else { "no window is safe for it, this one lasts longest" };
                Some((a, format!("{why} (key {:.1}, window {:.0}% at its end, {} other threads)", r.key, r.p5 * 100.0, r.threads), rows))
            }
            None => self.first_usable(me).map(|(a, t)| (a, format!("no account has room, this one frees up first (in {:.1} h)", hours(t, self.now).max(0.0)), rows)),
        }
    }

    /// The decision for a thread on `me.account`, idle this long (0 right after a turn): leave when the
    /// account is about to run out, or when the cache is cold anyway and another account is clearly better.
    pub fn at_turn(&self, me: &Thread, idle_ms: u64) -> Turn {
        let Some(a) = me.account else { return Turn::Stay("not placed".into()) };
        let now = self.now;
        let v = &self.accs[a];
        let b_i = me.bhat(now, v.cap[0]);
        let f = me.fable_share(now);
        let rows = self.rows(me, b_i, R_STAY, None);
        let Some(cur) = rows.iter().find(|r| r.acc == a) else {
            // The account is no longer allowed here.
            let (tgt, _) = self.choose(me, b_i, R_STAY, Some(a));
            return match tgt {
                Some(t) => Turn::Move { to: t, forced: true, low: true, why: "the account is not allowed for this folder".into() },
                None => Turn::Stay("the account is not allowed for this folder, and no other has room".into()),
            };
        };
        if v.unknown && !v.dead {
            return Turn::Stay("no quota data for this account".into());
        }
        let b = cur.load + b_i;
        let (kap, kapf) = (v.cap[0] / v.cap[1], v.cap[0] / v.cap[2]);
        let bf = self.load_fable(a) + f * b_i;
        let t7 = cur.h7 / (kap * b).max(1e-9);
        let tf = cur.hf / (kapf * bf).max(1e-9);
        let tau7 = v.w7_end.map_or(168.0, |e| hours(e, now));
        // The limit resets within 20 min (5 h) or before the account runs out (week, Fable): waiting is cheaper
        // than a hot move.
        let forced5 = (cur.h5 < R_STAY || (cur.t5 < cur.tau5 && cur.t5 < LOOK5)) && cur.tau5 > 1.0 / 3.0;
        let forced7 = (cur.h7 < R_STAY || t7 < LOOK7) && t7 < tau7;
        let forced_f = ((f > F_NEED && cur.hf < R_STAY) || (f > 0.2 && tf < LOOK7)) && tf < tau7;
        if v.dead || forced5 || forced7 || forced_f {
            let why = if v.dead {
                "the account's login is failing".to_string()
            } else if forced5 {
                format!("the 5-hour window runs out ({:.0}% left, {:.1} h at {:.1}%/h, resets in {:.1} h)", cur.h5, cur.t5, b, cur.tau5)
            } else if forced7 {
                format!("the weekly limit runs out ({:.0}% left, {:.1} h)", cur.h7, t7)
            } else {
                format!("the Fable limit runs out ({:.0}% left, {:.1} h)", cur.hf, tf)
            };
            let (tgt, _) = self.choose(me, b_i, R_STAY, Some(a));
            let Some(tgt) = tgt else { return Turn::Stay(format!("{why}, but no other account has room")) };
            let hmin = cur.h5.min(cur.h7).min(if f > F_NEED { cur.hf } else { 100.0 });
            return Turn::Move { to: tgt, forced: true, low: v.dead || hmin < R_STAY, why };
        }
        if idle_ms >= H_MS && now.saturating_sub(me.last_move_ms) > T_COOL_MS {
            let (tgt, rows2) = self.choose(me, b_i, R_NEW, None);
            let key = |x: usize| rows2.iter().find(|r| r.acc == x).map(|r| r.key);
            if let (Some(t), Some(k_here)) = (tgt, key(a)) {
                let k_there = key(t).unwrap_or(f64::MIN);
                if t != a && k_there >= k_here + HYST {
                    let why = format!("idle {:.1} h, the cache is cold, and it ranks {:.1} above this account", idle_ms as f64 / H, k_there - k_here);
                    return Turn::Move { to: t, forced: false, low: false, why };
                }
            }
        }
        Turn::Stay(format!("window {:.0}% at its end, {:.0}% left of the 5-hour window", cur.p5 * 100.0, cur.h5))
    }

    /// Projected use of the 5-hour window of `a` open at `t` (or opening then), as a share at its end, with the
    /// thread starting at `t`.
    fn p5_at(&self, a: usize, t: u64, b_i: f64) -> f64 {
        let v = &self.accs[a];
        let now = self.now;
        let c5 = v.cap[0];
        let run = || self.others.iter().filter(move |x| x.waiting.is_none() && x.account == Some(a));
        let promised = || self.others.iter().filter_map(move |x| x.waiting.filter(|w| w.0 == a).map(|w| (x, w.1)));
        if let Some(w5) = v.w5_end.filter(|&w| w > t) {
            let mut u = v.u5 + run().map(|x| x.admitted_burn(now, c5)).sum::<f64>() * hours(w5, now);
            u += promised().map(|(x, tp)| x.admitted_burn(now, c5) * hours(w5, now.max(tp)).max(0.0)).sum::<f64>();
            return (u + Q * b_i * hours(w5, t)) / 100.0;
        }
        let end = t + 5 * H_MS;
        let mut u: f64 = run().map(|x| x.admitted_burn(now, c5) * 5.0 * surv(x.kind, hours(t + 5 * H_MS / 2, now))).sum();
        for (x, tp) in promised() {
            if tp < end {
                let st = t.max(tp);
                u += x.admitted_burn(now, c5) * hours(end, st) * surv(x.kind, ((st + end) as f64 / 2.0 - tp as f64) / H);
            }
        }
        (u + Q * b_i * 5.0) / 100.0
    }

    /// Admission of a start: for every account the first of N_WIN moments (now or when it frees
    /// up, its window's reset, then every 5 h) whose window carries the start with the threads running there and the
    /// starts promised there; the earliest wins, on a tie the better key. None: no account can be judged.
    pub fn plan(&self, me: &Thread) -> Option<(Plan, Vec<Row>)> {
        // A thread too heavy for any window still fits an empty fresh one, or it would wait forever.
        let b_i = me.waiting.map_or(B0_NEW, |w| w.2).min(0.999 * 100.0 * ADMIT / (5.0 * Q));
        let rows = self.rows(me, b_i, R_STAY, None);
        let key = |a: usize| rows.iter().find(|r| r.acc == a).map_or(f64::MIN, |r| r.key);
        let mut best: Option<(u64, bool, f64, usize)> = None;
        let mut least: Option<(f64, u64, usize)> = None;
        for &a in self.allowed {
            let v = &self.accs[a];
            let mut t = self.t_usable(a, me);
            if t == u64::MAX {
                continue;
            }
            t = t.max(self.now);
            for _ in 0..N_WIN {
                let p5 = self.p5_at(a, t, b_i);
                if p5 <= ADMIT {
                    let cand = (t, Some(a) != me.account, -key(a), a);
                    let earlier = |b: &(u64, bool, f64, usize)| (cand.0, cand.1).cmp(&(b.0, b.1)).then(cand.2.total_cmp(&b.2)).then(cand.3.cmp(&b.3)).is_lt();
                    if best.as_ref().is_none_or(earlier) {
                        best = Some(cand);
                    }
                    break;
                }
                if least.is_none_or(|l| (p5, t) < (l.0, l.1)) {
                    least = Some((p5, t, a));
                }
                t = match v.w5_end {
                    Some(w) if w > t => w,
                    _ => t + 5 * H_MS,
                };
            }
        }
        let plan = match best {
            Some((at, _, _, acc)) => Plan { at, acc, admitted: true },
            None => {
                let (_, at, acc) = least?;
                Plan { at, acc, admitted: false }
            }
        };
        Some((plan, rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_cost_counts_writes_and_output_but_not_reads() {
        let usage = json!({"input_tokens": 1000, "cache_creation_input_tokens": 3000, "cache_read_input_tokens": 900000,
            "cache_creation": {"ephemeral_5m_input_tokens": 1000, "ephemeral_1h_input_tokens": 2000}, "output_tokens": 500});
        // Opus 5.5: 4 $ in, 20 $ out per million.
        let want = (1000.0 * 4.0 + 1000.0 * 4.0 * 1.25 + 2000.0 * 4.0 * 2.0 + 500.0 * 20.0) / 1e6;
        assert!((call_cost("claude-opus-5-5", &usage) - want).abs() < 1e-12);
        // Without the split all writes count as the 5-minute kind.
        let plain = json!({"input_tokens": 0, "cache_creation_input_tokens": 1000, "output_tokens": 0});
        assert!((call_cost("claude-fable-5-1", &plain) - 1000.0 * 10.0 * 1.25 / 1e6).abs() < 1e-12);
    }

    #[test]
    fn burn_keeps_two_hours_by_the_minute() {
        let mut b = Burn::default();
        b.add(1_000, 1.0, false);
        b.add(31_000, 2.0, true);
        b.add(70_000, 0.5, false);
        assert_eq!(b.recent, vec![(1_000, 3.0), (70_000, 0.5)]);
        assert_eq!((b.first_ms, b.last_ms, b.cost, b.fable_cost), (1_000, 70_000, 3.5, 2.0));
        b.add(70_000 + RECENT_MS, 1.0, false);
        assert_eq!(b.recent, vec![(70_000 + RECENT_MS, 1.0)]);
        assert_eq!(Burn::from_json(&b.to_json()), b);
    }

    #[test]
    fn survival_is_interpolated_and_clamped() {
        assert!((surv(Kind::Cli, 0.5) - 0.665).abs() < 1e-12);
        assert_eq!(surv(Kind::T3, 30.0), 0.37);
        assert_eq!(surv(Kind::T3, -1.0), 1.0);
    }

    fn thread(v: &Value) -> Thread {
        let idx = |k: &str| v[k].as_u64().map(|x| x as usize);
        Thread {
            kind: Kind::parse(v["kind"].as_str().unwrap()),
            burn: Burn::from_json(&v["burn"]),
            fable: v["fable"].as_bool().unwrap(),
            account: idx("account"),
            home: idx("home"),
            last_move_ms: v["last_move_ms"].as_u64().unwrap(),
            waiting: v["waiting"].as_array().map(|w| (w[0].as_u64().unwrap() as usize, w[1].as_u64().unwrap(), w[2].as_f64().unwrap())),
        }
    }

    /// The same inputs through an independent Python model of these rules (its answers are in strategy_golden.json).
    #[test]
    fn golden_cases_match_the_reference_model() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("strategy_golden.json")).unwrap();
        assert!(cases.len() >= 100);
        let close = |x: f64, y: &Value, what: &str, i: usize| {
            let y = y.as_f64().unwrap();
            assert!((x - y).abs() <= 1e-6 * y.abs().max(1.0), "case {i}: {what} {x} != {y}");
        };
        let same_rows = |rows: &[Row], want: &Value, what: &str, i: usize| {
            let want = want.as_array().unwrap();
            assert_eq!(rows.len(), want.len(), "case {i}: {what} count");
            for (r, w) in rows.iter().zip(want) {
                assert_eq!(r.acc as u64, w["acc"].as_u64().unwrap(), "case {i}: {what} order");
                assert_eq!((r.feas, r.safe), (w["feas"].as_bool().unwrap(), w["safe"].as_bool().unwrap()), "case {i}: {what} acc {}", r.acc);
                close(r.key, &w["key"], &format!("{what} acc {} key", r.acc), i);
                close(r.p5, &w["p5"], &format!("{what} acc {} p5", r.acc), i);
                close(r.t5, &w["t5"], &format!("{what} acc {} t5", r.acc), i);
                close(r.load, &w["load"], &format!("{what} acc {} load", r.acc), i);
            }
        };
        let plan_json = |p: Option<(Plan, Vec<Row>)>| p.map(|(p, _)| json!([p.at, p.acc, p.admitted])).unwrap_or(Value::Null);
        for (i, c) in cases.iter().enumerate() {
            let now = c["now"].as_u64().unwrap();
            let accs: Vec<Acc> = c["accs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| Acc {
                    dead: a["dead"].as_bool().unwrap(),
                    unknown: false,
                    u5: a["u5"].as_f64().unwrap(),
                    w5_end: a["w5_end"].as_u64(),
                    u7: a["u7"].as_f64().unwrap(),
                    w7_end: a["w7_end"].as_u64(),
                    uf: a["uf"].as_f64().unwrap(),
                    cap: [0, 1, 2].map(|k| a["cap"][k].as_f64().unwrap()),
                })
                .collect();
            let allowed: Vec<usize> = (0..accs.len()).collect();
            let others: Vec<Thread> = c["others"].as_array().unwrap().iter().map(thread).collect();
            let world = World { accs: &accs, allowed: &allowed, others: &others, now };
            let e = &c["expect"];
            let (me_run, me_new, me_cli, me_wake) = (thread(&c["me_run"]), thread(&c["me_new"]), thread(&c["me_cli"]), thread(&c["me_wake"]));

            let own = me_run.account.unwrap();
            close(me_run.bhat(now, accs[own].cap[0]), &e["bhat_me"], "bhat me", i);
            for (k, x) in others.iter().enumerate() {
                close(x.bhat(now, accs[x.account.unwrap()].cap[0]), &e["bhat_others"][k], &format!("bhat other {k}"), i);
            }

            let (got, rows) = world.choose(&me_new, B0_NEW, R_NEW, None);
            same_rows(&rows, &e["rows_new"], "new", i);
            assert_eq!(got.map(|a| a as u64), e["choose_new"].as_u64(), "case {i}: choose new");
            match world.place(&me_new) {
                Some((a, _, _)) => assert_eq!(Some(a as u64), e["place_new"].as_u64(), "case {i}: place"),
                None => assert!(accs.iter().all(|a| a.dead), "case {i}: place found nothing"),
            }

            same_rows(&world.rows(&me_run, me_run.bhat(now, accs[own].cap[0]), R_STAY, None), &e["rows_run"], "run", i);
            let to = match world.at_turn(&me_run, c["idle_ms"].as_u64().unwrap()) {
                Turn::Stay(_) => own,
                Turn::Move { to, .. } => to,
            };
            assert_eq!(Some(to as u64), e["at_turn"].as_u64(), "case {i}: at_turn");

            assert_eq!(plan_json(world.plan(&me_cli)), e["plan_start"], "case {i}: plan of a start");
            assert_eq!(plan_json(world.plan(&me_wake)), e["plan_wake"], "case {i}: plan at wake");
            for w in e["p5_at"].as_array().unwrap() {
                let (a, t) = (w[0].as_u64().unwrap() as usize, w[1].as_u64().unwrap());
                close(world.p5_at(a, t, B0_NEW), &w[2], &format!("p5_at acc {a} at {t}"), i);
            }
        }
    }
}
