import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { genKey, sourceKey, sha256hex } from '../core/ids.ts';
import { readJsonlLines } from './jsonl.ts';
import { ingestPolicy, type SourceRootDef } from '../core/config.ts';
import type { ChangeBatch, ConversationUpsert, GenerationInfo, ItemUpsert, QuarantineEntry, ReadBudget } from './types.ts';

export const READER_VERSION = 1;

/** Record types that are session metadata, not messages. Handled or deliberately skipped. */
const META_TYPES = new Set([
  'last-prompt', 'mode', 'permission-mode', 'atis-latch', 'bridge-session', 'queue-operation',
  'file-history-snapshot', 'file-history-delta', 'system', 'pr-link', 'cost-state',
]);

function fingerprintFile(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024);
    const n = readSync(fd, buf, 0, 1024, 0);
    return sha256hex(buf.subarray(0, Math.max(n, 0)));
  } finally {
    closeSync(fd);
  }
}

export function discoverClaudeGenerations(root: SourceRootDef): GenerationInfo[] {
  const projectsDir = join(root.rootPath, 'projects');
  if (!existsSync(projectsDir)) return [];
  const out: GenerationInfo[] = [];

  const addFile = (absPath: string, locator: string) => {
    const st = statSync(absPath);
    if (st.size === 0) return;
    const fp = fingerprintFile(absPath);
    out.push({
      genKey: genKey(root.rootId, locator, fp),
      rootId: root.rootId,
      app: 'claude',
      kind: 'jsonl_file',
      locator,
      fingerprint: fp,
      absPath,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  };

  for (const proj of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const projPath = join(projectsDir, proj.name);
    for (const entry of readdirSync(projPath, { withFileTypes: true })) {
      const entryPath = join(projPath, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        addFile(entryPath, `projects/${proj.name}/${entry.name}`);
      } else if (entry.isDirectory()) {
        const subDir = join(entryPath, 'subagents');
        if (!existsSync(subDir)) continue;
        for (const sub of readdirSync(subDir, { withFileTypes: true })) {
          if (sub.isFile() && sub.name.endsWith('.jsonl')) {
            addFile(join(subDir, sub.name), `projects/${proj.name}/${entry.name}/subagents/${sub.name}`);
          }
        }
      }
    }
  }
  return out;
}

interface ClaudeCursor {
  byte_offset: number;
}

const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path'];

function extractCallFiles(name: string, input: Record<string, unknown> | undefined): { pathDisplay: string; op?: string }[] {
  if (!input) return [];
  const op = name === 'Read' || name === 'Grep' || name === 'Glob' ? 'read' : name === 'Edit' || name === 'Write' || name === 'NotebookEdit' ? 'write' : undefined;
  const files: { pathDisplay: string; op?: string }[] = [];
  for (const key of PATH_INPUT_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 1) files.push({ pathDisplay: v, op });
  }
  return files;
}

function extractResultFiles(toolUseResult: unknown): { pathDisplay: string; op?: string }[] {
  if (!toolUseResult || typeof toolUseResult !== 'object') return [];
  const r = toolUseResult as Record<string, unknown>;
  const files: { pathDisplay: string; op?: string }[] = [];
  if (typeof r.filePath === 'string') files.push({ pathDisplay: r.filePath });
  const file = r.file as Record<string, unknown> | undefined;
  if (file && typeof file.filePath === 'string') files.push({ pathDisplay: file.filePath });
  if (Array.isArray(r.filenames)) {
    for (const f of r.filenames.slice(0, 200)) if (typeof f === 'string') files.push({ pathDisplay: f });
  }
  return files;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      parts.push((b as { text?: string }).text ?? '');
    }
  }
  return parts.join('\n');
}

function compactInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s === undefined ? '' : s;
  } catch {
    return '';
  }
}

/** Reads one generation (one .jsonl file) from its cursor and normalizes records. */
export function readClaudeBatch(gen: GenerationInfo, cursorJson: string | undefined, budget: ReadBudget): ChangeBatch {
  const parsedCursor = cursorJson ? JSON.parse(cursorJson) : {};
  const cursor: ClaudeCursor = { byte_offset: typeof parsedCursor.byte_offset === 'number' ? parsedCursor.byte_offset : 0 };
  const items: ItemUpsert[] = [];
  const edges: { extId: string; parentExtId?: string }[] = [];
  const quarantine: QuarantineEntry[] = [];

  const subagentMatch = gen.locator.match(/\/([0-9a-f-]{36})\/subagents\/(agent-[0-9a-f]+)\.jsonl$/);
  const mainMatch = gen.locator.match(/\/([0-9a-f-]{36})\.jsonl$/);
  const logicalId = subagentMatch ? `${subagentMatch[1]}/${subagentMatch[2]}` : mainMatch ? mainMatch[1] : gen.locator;

  const conversation: ConversationUpsert = {
    app: 'claude',
    rootId: gen.rootId,
    logicalId,
    kind: subagentMatch ? 'subagent' : 'main',
    genKey: gen.genKey,
  };
  if (subagentMatch) {
    const metaPath = gen.absPath.replace(/\.jsonl$/, '.meta.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        conversation.title = { text: String(meta.description ?? '').slice(0, 200), revision: 0, source: 'ai' };
      } catch { /* descriptor is optional */ }
    }
  }

  let itemBytes = 0;
  let maxEventTs: number | undefined;
  let sawFirstUserTitle = false;
  let endOffset = cursor.byte_offset;
  let eof = false;

  const generator = readJsonlLines(gen.absPath, cursor.byte_offset, { lineCap: ingestPolicy.lineCapBytes });
  while (true) {
    const step = generator.next();
    if (step.done) {
      endOffset = step.value.endOffset;
      eof = true;
      break;
    }
    const line = step.value;
    if (items.length >= budget.maxItems || itemBytes >= budget.maxBytes) {
      endOffset = line.offset;
      break;
    }
    endOffset = line.offset + line.byteLength;
    if (line.overlong) {
      quarantine.push({ position: String(line.offset), reason: 'line_over_cap', excerpt: line.text.slice(0, 500) });
      continue;
    }
    if (line.text.trim() === '') continue;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line.text);
    } catch (e) {
      quarantine.push({ position: String(line.offset), reason: `json_parse: ${String(e).slice(0, 100)}`, excerpt: line.text.slice(0, 500) });
      continue;
    }

    const offset = line.offset;
    const type = rec.type as string;
    if (typeof rec.uuid === 'string') {
      // logicalParentUuid bridges the chain across a /compact boundary (parentUuid is null there)
      const parent = typeof rec.parentUuid === 'string' ? rec.parentUuid
        : typeof rec.logicalParentUuid === 'string' ? rec.logicalParentUuid : undefined;
      edges.push({ extId: rec.uuid, parentExtId: parent });
    }
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : undefined;
    if (ts !== undefined && !Number.isNaN(ts)) {
      maxEventTs = Math.max(maxEventTs ?? 0, ts);
      conversation.startedAt = Math.min(conversation.startedAt ?? Infinity, ts);
      conversation.lastActivityAt = Math.max(conversation.lastActivityAt ?? 0, ts);
    }
    if (typeof rec.cwd === 'string' && !conversation.cwdDisplay) conversation.cwdDisplay = rec.cwd;

    const push = (item: ItemUpsert) => {
      items.push(item);
      itemBytes += item.text.length;
    };
    const key = (blockIndex?: number) =>
      sourceKey(gen.genKey, blockIndex ? `${offset}#${blockIndex}` : String(offset));

    if (type === 'custom-title' && typeof rec.customTitle === 'string') {
      conversation.title = { text: rec.customTitle, revision: offset, source: 'custom' };
      continue;
    }
    if (type === 'ai-title' && typeof rec.aiTitle === 'string') {
      if (conversation.title?.source !== 'custom') {
        conversation.title = { text: rec.aiTitle, revision: offset, source: 'ai' };
      }
      continue;
    }
    if (META_TYPES.has(type)) continue;

    if (type === 'user') {
      const uuid = rec.uuid as string | undefined;
      if (uuid) conversation.headExtId = uuid;
      const message = rec.message as { content?: unknown } | undefined;
      const content = message?.content;

      const toolResults = Array.isArray(content)
        ? content.filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result')
        : [];
      if (toolResults.length) {
        const resultFiles = extractResultFiles(rec.toolUseResult);
        toolResults.forEach((block, i) => {
          const b = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
          push({
            sourceKey: key(i || undefined),
            kind: 'tool_result',
            role: 'tool',
            text: blockText(b.content),
            logicalId: uuid,
            parentExtId: rec.parentUuid as string | undefined,
            callId: b.tool_use_id,
            ordinal: offset,
            ts,
            revision: offset,
            isError: b.is_error === true,
            files: i === 0 ? resultFiles : undefined,
          });
        });
        continue;
      }

      if (rec.isMeta === true) continue;
      const text = blockText(content);
      if (!text) continue;
      if (rec.isCompactSummary === true) {
        push({ sourceKey: key(), kind: 'compact_summary', role: 'user', text, logicalId: uuid, parentExtId: rec.parentUuid as string | undefined, ordinal: offset, ts, revision: offset });
        continue;
      }
      if (rec.isVisibleInTranscriptOnly === true) continue;
      if (!sawFirstUserTitle && !conversation.title && !text.startsWith('<')) {
        conversation.title = { text: text.slice(0, 120), revision: offset, source: 'first_user' };
        sawFirstUserTitle = true;
      }
      push({ sourceKey: key(), kind: 'user', role: 'user', text, logicalId: uuid, parentExtId: rec.parentUuid as string | undefined, ordinal: offset, ts, revision: offset });
      continue;
    }

    if (type === 'assistant') {
      const uuid = rec.uuid as string | undefined;
      if (uuid) conversation.headExtId = uuid;
      const message = rec.message as { content?: unknown; model?: string; usage?: Record<string, unknown>; stop_reason?: string } | undefined;
      const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];

      const toolBlocks = content.filter((b) => b?.type === 'tool_use');
      const reasoningChars = content
        .filter((b) => b?.type === 'thinking')
        .reduce((sum, b) => sum + ((b.thinking as string | undefined)?.length ?? 0), 0);

      content.forEach((block, i) => {
        const blockIndex = i || undefined;
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          const usage = message?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          const meta: Record<string, unknown> = {};
          if (message?.model) meta.model = message.model;
          if (usage?.output_tokens !== undefined) meta.out = usage.output_tokens;
          if (usage?.input_tokens !== undefined) meta.in = usage.input_tokens;
          if (toolBlocks.length) meta.tools = toolBlocks.length;
          if (reasoningChars) meta.rchars = reasoningChars;
          if (rec.isApiErrorMessage === true) meta.apiError = true;
          push({
            sourceKey: key(blockIndex), kind: 'assistant', role: 'assistant', text: block.text as string,
            logicalId: uuid, parentExtId: rec.parentUuid as string | undefined,
            ordinal: offset, ts, revision: offset, meta,
          });
        } else if (block?.type === 'tool_use') {
          const name = String(block.name ?? '');
          push({
            sourceKey: key(blockIndex), kind: 'tool_call', role: 'tool',
            text: `${name} ${compactInput(block.input)}`,
            logicalId: uuid, parentExtId: rec.parentUuid as string | undefined,
            callId: typeof block.id === 'string' ? block.id : undefined,
            ordinal: offset, ts, revision: offset, toolName: name,
            files: extractCallFiles(name, block.input as Record<string, unknown> | undefined),
          });
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          push({
            sourceKey: key(blockIndex), kind: 'reasoning', role: 'reasoning', text: block.thinking as string,
            logicalId: uuid, parentExtId: rec.parentUuid as string | undefined,
            ordinal: offset, ts, revision: offset,
          });
        }
      });
      continue;
    }

    if (type === 'attachment') {
      const attachment = rec.attachment as { filename?: string; displayPath?: string } | undefined;
      const pathDisplay = attachment?.filename ?? attachment?.displayPath;
      if (pathDisplay) {
        push({
          sourceKey: key(), kind: 'attachment', role: 'system', text: '',
          logicalId: rec.uuid as string | undefined, ordinal: offset, ts, revision: offset,
          files: [{ pathDisplay, op: 'read' }],
        });
      }
      continue;
    }

    quarantine.push({ position: String(offset), reason: `unknown_type: ${type}`, excerpt: line.text.slice(0, 300) });
  }
  // a budget break abandons the generator mid-file: run its finally so the fd closes
  generator.return({ endOffset });

  return {
    conversation,
    items,
    edges,
    quarantine,
    cursorAfter: JSON.stringify({ byte_offset: endOffset } satisfies ClaudeCursor),
    maxEventTs,
    eof,
  };
}
