const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const TAB = 9;

export class LineCounter {
  lines = 0;
  private lineHasContent = false;

  feed(bytes: Uint8Array, start = 0, end = bytes.length): void {
    for (let index = start; index < end; index += 1) {
      const byte = bytes[index];
      if (byte === NEWLINE) {
        if (this.lineHasContent) this.lines += 1;
        this.lineHasContent = false;
      } else if (byte !== SPACE && byte !== TAB && byte !== CARRIAGE_RETURN) {
        this.lineHasContent = true;
      }
    }
  }

  finish(): number {
    if (this.lineHasContent) this.lines += 1;
    this.lineHasContent = false;
    return this.lines;
  }
}

export function countLines(text: string): number {
  const counter = new LineCounter();
  counter.feed(new TextEncoder().encode(text));
  return counter.finish();
}
