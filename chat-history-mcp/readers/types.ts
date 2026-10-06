/** Reader contract: each source app implements discovery of generations and
 *  incremental reading from a cursor. Readers never write anything anywhere. */

export interface GenerationInfo {
  genKey: string;
  rootId: string;
  app: 'claude' | 'codex' | 'opencode' | 't3';
  kind: 'jsonl_file' | 'sqlite_table' | 'json_file' | 'log_file';
  locator: string;
  fingerprint: string;
  absPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ConversationUpsert {
  app: string;
  rootId: string;
  logicalId: string;
  kind: 'main' | 'subagent';
  genKey: string;
  cwdDisplay?: string;
  /** Higher revision wins; revision = byte offset of the record that set it. */
  title?: { text: string; revision: number; source: 'custom' | 'ai' | 'first_user' };
  startedAt?: number;
  lastActivityAt?: number;
  headExtId?: string;
}

export interface ItemUpsert {
  sourceKey: string;
  kind: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'reasoning' | 'system' | 'compact_summary' | 'attachment' | 'rollback';
  role: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system';
  /** Normalized text before indexing policy is applied. */
  text: string;
  logicalId?: string;
  parentExtId?: string;
  /** tool_use id linking a tool_call to its tool_result. */
  callId?: string;
  ordinal: number;
  ts?: number;
  tsIsCopy?: boolean;
  revision: number;
  toolName?: string;
  isError?: boolean;
  files?: { pathDisplay: string; op?: string }[];
  meta?: Record<string, unknown>;
}

export interface QuarantineEntry {
  position: string;
  reason: string;
  excerpt: string;
}

export interface ChangeBatch {
  conversation: ConversationUpsert;
  items: ItemUpsert[];
  /** Record-chain edges for EVERY uuid-bearing record, including ones that yield no items —
   *  the active-branch walk needs the complete chain. */
  edges: { extId: string; parentExtId?: string }[];
  quarantine: QuarantineEntry[];
  cursorAfter: string;
  /** Newest event timestamp seen in this batch (drives freshness). */
  maxEventTs?: number;
  /** True when the generation is fully consumed up to its current end. */
  eof: boolean;
}

export interface ReadBudget {
  maxItems: number;
  maxBytes: number;
}
