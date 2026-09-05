/**
 * Syntax color for diff and file lines, from the same language table the
 * terminal preview uses (`src/diff-languages.ts`). Tokens become spans, never
 * markup, so file content cannot inject anything.
 */
import { tokenizeWith } from "@speed-highlight/core/tokenize";
import type { ShjLanguageData, ShjToken } from "@speed-highlight/core/tokenize";
import type { ComponentChildren } from "preact";
import { languageForFileName } from "../../diff-languages";

export function languageForPath(
  path: string | null,
): ShjLanguageData | undefined {
  if (path === null) return undefined;
  const name = path.split("/").pop() ?? path;
  return languageForFileName(name);
}

export function highlightLine(
  text: string,
  language: ShjLanguageData | undefined,
): ComponentChildren {
  if (!language || text.length === 0) return text;
  const parts: ComponentChildren[] = [];
  let index = 0;
  tokenizeWith(text, language, (chunk: string, token: ShjToken | undefined) => {
    parts.push(
      token ? (
        <span key={index} class={`tok tok-${token}`}>
          {chunk}
        </span>
      ) : (
        chunk
      ),
    );
    index += 1;
  });
  return parts;
}
