export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  noNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldLabel: string;
  newLabel: string;
  path: string;
  oldSide: string;
  newSide: string;
  hunks: DiffHunk[];
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  notes: string[];
}

export interface ParsedDiff {
  files: DiffFile[];
  notes: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const LABEL = /^(.*?)(?: \(([^()]*)\))?$/;

export interface DiffLabel {
  path: string;
  side: string;
}

export function parseDiffLabel(label: string): DiffLabel {
  if (label === "/dev/null") return { path: "", side: "" };
  const match = LABEL.exec(label);
  if (!match) return { path: label, side: "" };
  return { path: match[1] ?? label, side: match[2] ?? "" };
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  const notes: string[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldNo = 0;
  let newNo = 0;
  let pendingOldMode: string | undefined;
  let pendingNewMode: string | undefined;
  // Git prints mode lines before a content change's labels, but the CLI prints
  // them after a mode-only change's labels.
  let fileFresh = false;

  const finishFile = (): void => {
    if (file) files.push(file);
    file = null;
    hunk = null;
    oldRemaining = 0;
    newRemaining = 0;
  };

  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    // The no-newline marker can follow a hunk's last line, after the counts are
    // spent.
    if (hunk && line.startsWith("\\")) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const inHunk = hunk !== null && (oldRemaining > 0 || newRemaining > 0);
    if (inHunk && hunk) {
      const prefix = line[0] ?? " ";
      const body = line.slice(1);
      if (prefix === "+") {
        hunk.lines.push({ kind: "add", text: body, oldNo: null, newNo });
        newNo += 1;
        newRemaining -= 1;
      } else if (prefix === "-") {
        hunk.lines.push({ kind: "del", text: body, oldNo, newNo: null });
        oldNo += 1;
        oldRemaining -= 1;
      } else {
        hunk.lines.push({
          kind: "context",
          text: prefix === " " ? body : line,
          oldNo,
          newNo,
        });
        oldNo += 1;
        newNo += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      finishFile();
      fileFresh = false;
      const oldLabel = line.slice(4);
      const parsed = parseDiffLabel(oldLabel);
      file = {
        oldLabel,
        newLabel: "",
        path: parsed.path,
        oldSide: parsed.side,
        newSide: "",
        hunks: [],
        binary: false,
        ...(pendingOldMode !== undefined && { oldMode: pendingOldMode }),
        ...(pendingNewMode !== undefined && { newMode: pendingNewMode }),
        notes: [],
      };
      pendingOldMode = undefined;
      pendingNewMode = undefined;
      continue;
    }
    if (file && file.newLabel === "" && line.startsWith("+++ ")) {
      file.newLabel = line.slice(4);
      const parsed = parseDiffLabel(file.newLabel);
      file.newSide = parsed.side;
      if (file.path === "") file.path = parsed.path;
      fileFresh = true;
      continue;
    }
    const oldMode = /^old mode (\d{6})$/.exec(line);
    if (oldMode) {
      if (file && fileFresh) file.oldMode = oldMode[1];
      else pendingOldMode = oldMode[1];
      continue;
    }
    const newMode = /^new mode (\d{6})$/.exec(line);
    if (newMode) {
      if (file && fileFresh) file.newMode = newMode[1];
      else pendingNewMode = newMode[1];
      continue;
    }
    fileFresh = false;
    const header = HUNK_HEADER.exec(line);
    if (header && file) {
      hunk = {
        header: line,
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      file.hunks.push(hunk);
      oldRemaining = hunk.oldCount;
      newRemaining = hunk.newCount;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (line === "Binary files differ" && file) {
      file.binary = true;
      continue;
    }
    if (line.trim().length === 0) continue;
    if (file) file.notes.push(line);
    else notes.push(line);
  }
  finishFile();
  return { files, notes };
}

export interface SideCell {
  no: number | null;
  text: string;
  kind: DiffLineKind;
  noNewline?: boolean;
}

export interface SideRow {
  left: SideCell | null;
  right: SideCell | null;
  changed: boolean;
}

export function sideBySideRows(hunk: DiffHunk): SideRow[] {
  const rows: SideRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    const count = Math.max(dels.length, adds.length);
    for (let index = 0; index < count; index += 1) {
      const del = dels[index];
      const add = adds[index];
      rows.push({
        left: del ? cell(del) : null,
        right: add ? cell(add) : null,
        changed: true,
      });
    }
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "del") {
      dels.push(line);
    } else if (line.kind === "add") {
      adds.push(line);
    } else {
      flush();
      rows.push({ left: cell(line), right: cell(line), changed: false });
    }
  }
  flush();
  return rows;
}

function cell(line: DiffLine): SideCell {
  return {
    no: line.kind === "add" ? line.newNo : line.oldNo,
    text: line.text,
    kind: line.kind,
    ...(line.noNewline && { noNewline: true }),
  };
}

export interface ThreeCell {
  no: number | null;
  text: string;
  kind: "same" | "add" | "del";
}

export interface ThreeRow {
  kind: "line" | "gap";
  installed: ThreeCell | null;
  locked: ThreeCell | null;
  shelf: ThreeCell | null;
}

interface SideIndex {
  base: Map<number, { text: string; deleted: boolean; newNo: number | null }>;
  inserts: Map<number, DiffLine[]>;
}

function indexSide(file: DiffFile | null): SideIndex {
  const index: SideIndex = { base: new Map(), inserts: new Map() };
  if (!file) return index;
  for (const hunk of file.hunks) {
    let anchor = hunk.oldStart - 1;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        const list = index.inserts.get(anchor) ?? [];
        list.push(line);
        index.inserts.set(anchor, list);
        continue;
      }
      if (line.oldNo === null) continue;
      index.base.set(line.oldNo, {
        text: line.text,
        deleted: line.kind === "del",
        newNo: line.newNo,
      });
      anchor = line.oldNo;
    }
  }
  return index;
}

export function threeWayRows(
  installed: DiffFile | null,
  shelf: DiffFile | null,
): ThreeRow[] {
  const left = indexSide(installed);
  const right = indexSide(shelf);
  const keys = new Set<number>([
    ...left.base.keys(),
    ...right.base.keys(),
    ...left.inserts.keys(),
    ...right.inserts.keys(),
  ]);
  const rows: ThreeRow[] = [];
  let previous: number | null = null;
  for (const key of [...keys].sort((a, b) => a - b)) {
    if (previous !== null && key > previous + 1) {
      rows.push({ kind: "gap", installed: null, locked: null, shelf: null });
    }
    previous = key;
    const baseLine = left.base.get(key) ?? right.base.get(key);
    if (baseLine) {
      rows.push({
        kind: "line",
        locked: { no: key, text: baseLine.text, kind: "same" },
        installed: sideCell(left, key, baseLine.text),
        shelf: sideCell(right, key, baseLine.text),
      });
    }
    const leftAdds = left.inserts.get(key) ?? [];
    const rightAdds = right.inserts.get(key) ?? [];
    const count = Math.max(leftAdds.length, rightAdds.length);
    for (let index = 0; index < count; index += 1) {
      const a = leftAdds[index];
      const b = rightAdds[index];
      rows.push({
        kind: "line",
        locked: null,
        installed: a ? { no: a.newNo, text: a.text, kind: "add" } : null,
        shelf: b ? { no: b.newNo, text: b.text, kind: "add" } : null,
      });
    }
  }
  return rows;
}

function sideCell(side: SideIndex, key: number, text: string): ThreeCell {
  const entry = side.base.get(key);
  if (!entry) return { no: null, text, kind: "same" };
  if (entry.deleted) return { no: null, text: "", kind: "del" };
  return { no: entry.newNo, text: entry.text, kind: "same" };
}

export function diffLineCount(diff: ParsedDiff): number {
  let count = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) count += hunk.lines.length;
  }
  return count;
}

export interface DiffFileStat {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  modeChange: string | null;
}

export function fileStats(parsed: ParsedDiff): DiffFileStat[] {
  return parsed.files.map((file) => {
    let added = 0;
    let removed = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") added += 1;
        else if (line.kind === "del") removed += 1;
      }
    }
    return {
      path: file.path,
      added,
      removed,
      binary: file.binary,
      modeChange:
        file.oldMode && file.newMode && file.oldMode !== file.newMode
          ? `${file.oldMode} → ${file.newMode}`
          : null,
    };
  });
}

export interface DiffPreview {
  path: string;
  header: string;
  lines: DiffLine[];
  hiddenChanges: number;
}

export function diffPreview(
  parsed: ParsedDiff,
  limit: number,
): DiffPreview | null {
  const file = parsed.files.find(
    (entry) => !entry.binary && entry.hunks.length > 0,
  );
  const hunk = file?.hunks[0];
  if (!file || !hunk) return null;
  const firstChange = hunk.lines.findIndex((line) => line.kind !== "context");
  const start = Math.max(
    0,
    Math.min(firstChange - 2, hunk.lines.length - limit),
  );
  const lines = hunk.lines.slice(start, start + limit);
  const changes = (rows: readonly DiffLine[]): number =>
    rows.filter((line) => line.kind !== "context").length;
  let total = 0;
  for (const entry of parsed.files) {
    for (const block of entry.hunks) total += changes(block.lines);
  }
  return {
    path: file.path,
    header: hunk.header,
    lines,
    hiddenChanges: total - changes(lines),
  };
}
