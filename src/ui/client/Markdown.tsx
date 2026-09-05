import type { ComponentChildren } from "preact";
import {
  parseMarkdown,
  safeHref,
  type Block,
  type Inline,
} from "../shared/markdown";
import { highlightLine, languageForPath } from "./highlight";

export function Markdown({ text }: { text: string }): preact.JSX.Element {
  const document = parseMarkdown(text);
  return (
    <div class="markdown">
      {document.frontmatter !== null ? (
        <details class="frontmatter" open>
          <summary>Frontmatter</summary>
          <pre class="mono">{document.frontmatter}</pre>
        </details>
      ) : null}
      {document.blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }): preact.JSX.Element {
  switch (block.type) {
    case "heading": {
      const level = Math.min(6, block.level + 1);
      const children = <Inlines nodes={block.children} />;
      if (level === 2) return <h2>{children}</h2>;
      if (level === 3) return <h3>{children}</h3>;
      if (level === 4) return <h4>{children}</h4>;
      if (level === 5) return <h5>{children}</h5>;
      return <h6>{children}</h6>;
    }
    case "paragraph":
      return (
        <p>
          <Inlines nodes={block.children} />
        </p>
      );
    case "code": {
      const language = languageForPath(block.lang ? `x.${block.lang}` : null);
      return (
        <pre class="mono code-block" data-lang={block.lang || undefined}>
          {block.text.split("\n").map((line, index) => (
            <span key={index} class="code-line">
              {highlightLine(line, language)}
              {"\n"}
            </span>
          ))}
        </pre>
      );
    }
    case "list":
      return block.ordered ? (
        <ol>
          {block.items.map((item, index) => (
            <li key={index}>
              <Inlines nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>
              <Inlines nodes={item} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote>
          <Inlines nodes={block.children} />
        </blockquote>
      );
    case "rule":
      return <hr />;
    case "pre":
      return <pre class="mono">{block.text}</pre>;
  }
}

function Inlines({ nodes }: { nodes: Inline[] }): preact.JSX.Element {
  return <>{nodes.map((node, index) => inlineView(node, index))}</>;
}

function inlineView(node: Inline, key: number): ComponentChildren {
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return (
        <code key={key} class="mono">
          {node.text}
        </code>
      );
    case "strong":
      return (
        <strong key={key}>
          <Inlines nodes={node.children} />
        </strong>
      );
    case "em":
      return (
        <em key={key}>
          <Inlines nodes={node.children} />
        </em>
      );
    case "link": {
      const href = safeHref(node.href);
      if (href === null) {
        return (
          <span key={key}>
            <Inlines nodes={node.children} />
          </span>
        );
      }
      return (
        <a key={key} href={href} rel="noopener noreferrer" target="_blank">
          <Inlines nodes={node.children} />
        </a>
      );
    }
  }
}
