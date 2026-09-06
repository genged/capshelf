import { describe, expect, test } from "bun:test";
import { LineCounter, countLines } from "./count";

describe("countLines", () => {
  test("counts non-blank lines only", () => {
    expect(countLines("a\nb\n\nc\n")).toBe(3);
    expect(countLines("a\n \n\t\n\r\nb")).toBe(2);
  });

  test("a final line without a newline counts", () => {
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("")).toBe(0);
    expect(countLines("\n\n\n")).toBe(0);
  });

  test("chunk boundaries do not change the count", () => {
    const bytes = new TextEncoder().encode("ab\ncd\n\nef");
    const counter = new LineCounter();
    counter.feed(bytes, 0, 2);
    counter.feed(bytes, 2, 3);
    counter.feed(bytes, 3, 7);
    counter.feed(bytes, 7, bytes.length);
    expect(counter.finish()).toBe(3);
  });
});
