import snowball from 'snowball-stemmers';

const ruStem = snowball.newStemmer('russian');
const enStem = snowball.newStemmer('english');

/** Same token splitting as FTS5 unicode61 over our content. */
const WORD = /[a-zа-яё0-9_][a-zа-яё0-9_]{0,39}/g;
const RU = /[а-яё]/;

const STOP = new Set(('и в не на что с как это по для а то же из у о при или но да ну вот так его её их мы вы он она они оно ты я мне тебе нам вам есть был была было были быть будет чтобы если когда где только уже еще ещё можно нужно надо очень тоже там тут здесь через после перед над под без до от за все всё весь вся эти этот эта этого этой них нее неё том тем чем кто чего кого также либо просто пока даже хотя ведь пусть про наш наша наше нашей нашего' +
  ' the a an and or not is are was were be been being to of in on at by for with from as it its this that these those there their they them then than you your we our i he she his her have has had do does did will would can could should may might must about into over under between after all any both each some such very just because while when where why how').split(/\s+/));

export interface ParsedQuery {
  terms: string[];
  stems: string[];
  phrases: string[][];
}

export function stemToken(w: string): string {
  return RU.test(w) ? ruStem.stem(w) : enStem.stem(w);
}

/** Shadow-stem text for the fts text_stem column: every token stemmed, same split as queries.
 *  The cache only speeds up rebuilds (~1.3 ms/doc raw); stemToken is pure, output is identical. */
const stemCache = new Map<string, string>();
export function stemText(text: string): string {
  const out: string[] = [];
  WORD.lastIndex = 0;
  const lower = text.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(lower)) !== null) {
    const w = m[0];
    let s = stemCache.get(w);
    if (s === undefined) {
      s = stemToken(w);
      if (stemCache.size < 100_000) stemCache.set(w, s);
    }
    out.push(s);
  }
  return out.join(' ');
}

/** Free text in — terms and path-ish phrases out. The agent never writes FTS syntax itself. */
export function parseUserQuery(q: string): ParsedQuery {
  const phrases: string[][] = [];
  const rest = q.replace(/[\w\-]+(?:[.\\/][\w\-]+)+/g, (m0) => {
    const sub = m0.toLowerCase().split(/[^a-zа-яё0-9_]+/).filter(Boolean);
    if (sub.length > 1) {
      phrases.push(sub);
      return ' ';
    }
    return m0;
  });
  const terms: string[] = [];
  WORD.lastIndex = 0;
  const lower = rest.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(lower)) !== null) {
    const w = m[0];
    if (w.length < 2 || STOP.has(w)) continue;
    if (!terms.includes(w)) terms.push(w);
  }
  const kept = terms.slice(0, 6);
  return { terms: kept, stems: kept.map(stemToken), phrases: phrases.slice(0, 2) };
}

const esc = (t: string) => `"${t.replaceAll('"', '""')}"`;

/** Match strategy: OR-semantics; any term whose
 *  stem differs also matches the shadow column exactly — morphology stays invisible to the caller. */
export function buildMatch(p: ParsedQuery): string {
  const parts: string[] = [];
  for (let i = 0; i < p.terms.length; i++) {
    const term = p.terms[i];
    const stem = p.stems[i];
    parts.push(stem !== term ? `(${esc(term)} OR text_stem:${esc(stem)})` : esc(term));
  }
  for (const ph of p.phrases) parts.push('"' + ph.join(' ') + '"');
  return parts.join(' OR ');
}
