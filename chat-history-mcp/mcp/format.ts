import type { SearchHit, ChatPage, SourceFreshness } from '../search/engine.ts';

function day(ts: number | null): string {
  if (!ts) return '????-??-??';
  return new Date(ts).toISOString().slice(0, 10);
}

function hhmm(ts: number | null): string {
  if (!ts) return '--:--';
  return new Date(ts).toISOString().slice(11, 16);
}

function ago(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Compact match-card, ~2 lines per hit. */
export function formatHits(hits: SearchHit[], nextCursor?: string): string {
  if (!hits.length) return 'ничего не найдено';
  const out: string[] = [];
  hits.forEach((h, i) => {
    const flags = [
      h.occurrences > 1 ? `×${h.occurrences}` : '',
      h.truncated ? 't:1' : '',
      h.branchState === 'abandoned' ? '[ветка]' : '',
    ].filter(Boolean).join(' ');
    const title = h.convTitle ? `«${h.convTitle.slice(0, 60)}»` : '';
    out.push(`${i + 1}. p:${h.itemPublicId} ${h.src}/${h.kind} ${day(h.ts)} · ${title} c:${h.convPublicId}${flags ? ' ' + flags : ''}`);
    out.push(`   ${h.snippet.slice(0, 500)}`);
  });
  if (nextCursor) out.push(`next: cursor=${nextCursor}`);
  return out.join('\n');
}

export function formatChatPage(page: ChatPage): string {
  const out: string[] = [];
  const header = [
    `чат c:${page.convPublicId}`,
    page.title ? `«${page.title.slice(0, 80)}»` : '',
    `${page.src}/${page.rootId}`,
    page.cwd ?? '',
    `${day(page.startedAt)}–${day(page.lastActivityAt)}`,
    `${page.totalItems} сообщений`,
  ].filter(Boolean).join(' · ');
  out.push(header);
  for (const line of page.lines) {
    const meta: string[] = [];
    const m = line.meta ?? {};
    if (typeof m.tools === 'number') meta.push(`tools: ${m.tools}`);
    if (typeof m.rchars === 'number') meta.push(`reasoning: ~${Math.round((m.rchars as number) / 3.5 / 100) / 10}k tok`);
    if (typeof m.model === 'string') meta.push(String(m.model).replace('claude-', ''));
    const branch = line.branchState === 'abandoned' ? ' [ветка]' : '';
    const kind = line.kind === 'compact_summary' ? 'compact' : line.role;
    out.push(`[p:${line.itemPublicId}] ${kind} ${hhmm(line.ts)}${meta.length ? ' · ' + meta.join(', ') : ''}${branch} — ${line.text}`);
  }
  if (page.nextOrdinal !== undefined) out.push(`next: cursor=${page.nextOrdinal}`);
  return out.join('\n');
}

/** One-line freshness footer appended to every search/read answer.
 *  Escalates via the model-client: stale data must be impossible to miss. */
export function formatFreshness(sources: SourceFreshness[], heartbeat: { beatAt: number } | null, now = Date.now()): string {
  if (!sources.length) return 'freshness: индекс пуст — запусти ingest';
  const parts = sources.map((s) => {
    const lag = s.lastIngestedEventTs ? ago(now - s.lastIngestedEventTs) : 'never';
    return `${s.source} ${lag}`;
  });
  const hb = heartbeat ? `writer ok (hb ${ago(now - heartbeat.beatAt)})` : 'writer: не запускался';
  const line = `freshness: ${parts.join(' | ')} · ${hb}`;

  const worstLag = Math.max(...sources.map((s) => (s.lastScanAt ? now - s.lastScanAt : Infinity)));
  if (worstLag > 72 * 3600 * 1000) {
    return `⚠️ ИНДЕКС УСТАРЕЛ (>72ч без сканирования) — скажи пользователю запустить: node ops/cli.ts ingest\n${line}`;
  }
  if (worstLag > 24 * 3600 * 1000) {
    return `предупреждение: индекс не обновлялся >24ч\n${line}`;
  }
  return line;
}
