import { toolTextPolicy } from '../core/config.ts';

/** Regexes for file paths and error lines in tool outputs. */
const PATH_RE = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/][\w.\-\\/]{2,200})` +
  String.raw`|(?:~[\\/][\w.\-\\/]{2,200})` +
  String.raw`|(?:(?<![\w.\-/])\/(?:[\w.\-]+\/)+[\w.\-]+)` +
  String.raw`|(?:\b[\w\-]+(?:[\\/][\w.\-]+)+\.[A-Za-z]{1,5}\b)` +
  String.raw`|(?:\b[\w\-]{2,60}\.(?:tsx?|jsx?|py|rs|go|java|c|h|cpp|md|json|jsonl|sqlite|db|toml|ya?ml|txt|log|css|html|exe|dll|ps1|sh|sql|lock|wasm|node)\b)`,
  'g',
);

const ERR_CI = new RegExp(
  String.raw`\b(error|errors|exception|traceback|panic|panicked|fatal|fail|failed|failure|` +
  String.raw`denied|refused|unhandled|uncaught|assert|assertion|stderr|abort|aborted|` +
  String.raw`ошибк\w*|исключени\w*|отказано|паник\w*)\b` +
  String.raw`|npm err!|command not found|no such file|not recognized|cannot find|could not|` +
  String.raw`exit code [1-9]|non-zero exit|timed out|timeout`,
  'i',
);

const ERR_CS = new RegExp(
  String.raw`\bE[A-Z]{3,}\b` +
  String.raw`|^\s+at\s+.+\(.+:\d+(:\d+)?\)` +
  String.raw`|^\s+at\s+[\w.$<>]+\s*\(` +
  String.raw`|^\s*File ".+", line \d+` +
  String.raw`|^\s*(FAIL|ERROR|FATAL|WARN)\b`,
  'm',
);

export function extractPaths(text: string, capBytes = toolTextPolicy.pathsCapBytes): string {
  const found: string[] = [];
  const seen = new Set<string>();
  let size = 0;
  PATH_RE.lastIndex = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0];
    if (seen.has(p)) continue;
    seen.add(p);
    size += p.length + 1;
    if (size > capBytes) break;
    found.push(p);
  }
  return found.join('\n');
}

function extractErrLines(middle: string, capBytes: number): string {
  const out: string[] = [];
  let size = 0;
  for (const lineRaw of middle.split('\n')) {
    const line = lineRaw.length > 400 ? lineRaw.slice(0, 400) : lineRaw;
    if (!ERR_CI.test(line) && !ERR_CS.test(line)) continue;
    size += line.length + 1;
    if (size > capBytes) break;
    out.push(line);
  }
  return out.join('\n');
}

export interface IndexedText {
  /** What goes into FTS (and is used for snippets). */
  textIndex: string;
  /** Newline-joined unique path-like matches — the fuzzy `paths` FTS column. */
  paths: string;
  truncated: boolean;
  fullBytes: number;
}

/** Policy: tool bodies over 6 KB are cut to head 4K + tail 2K + error lines
 *  from the middle; anything cut stays reachable through the full-body archive (deep_search). */
export function buildToolText(fullText: string): IndexedText {
  const p = toolTextPolicy;
  const paths = extractPaths(fullText);
  if (fullText.length <= p.indexThresholdBytes) {
    return { textIndex: fullText, paths, truncated: false, fullBytes: fullText.length };
  }
  const head = fullText.slice(0, p.headBytes);
  const tail = fullText.slice(-p.tailBytes);
  const middle = fullText.slice(p.headBytes, -p.tailBytes);
  const err = extractErrLines(middle, p.errExtractCapBytes);
  const textIndex = err ? `${head}\n…\n${err}\n…\n${tail}` : `${head}\n…\n${tail}`;
  return { textIndex, paths, truncated: true, fullBytes: fullText.length };
}

/** Non-tool text is indexed in full; paths are still extracted for the paths column. */
export function buildPlainText(fullText: string): IndexedText {
  return { textIndex: fullText, paths: extractPaths(fullText), truncated: false, fullBytes: fullText.length };
}
