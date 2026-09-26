import { Fragment, type ReactNode } from "react";

/**
 * Markdown for assistant replies: headings, lists, bold, italic, links, and
 * code. Text is React children, never raw HTML.
 */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2">
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block)}</Fragment>
      ))}
    </div>
  );
}

type ListItem = { text: string; depth: number };
type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "ul" | "ol"; items: ListItem[] }
  | { type: "pre"; text: string };

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { type: "ul" | "ol"; items: ListItem[] } | null = null;
  let fence: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "p", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };

  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith("```")) {
        blocks.push({ type: "pre", text: fence.join("\n") });
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      fence = [];
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "h", level: heading[1].length, text: heading[2] });
      continue;
    }
    const bullet = /^(\s*)(?:[-•])\s+(.+)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
    const item = bullet ?? numbered;
    if (item && line.trim() !== "") {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      const depth = item[1].replace(/\t/g, "  ").length >= 2 ? 1 : 0;
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push({ text: item[2], depth });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (fence) blocks.push({ type: "pre", text: fence.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}

function renderBlock(block: Block): ReactNode {
  if (block.type === "pre") {
    return (
      <pre className="overflow-x-auto rounded-xl bg-black/5 p-3 text-xs">
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.type === "h") {
    const className =
      block.level === 1 ? "text-base font-semibold" : "text-sm font-semibold";
    return <p className={className}>{renderInline(block.text)}</p>;
  }
  if (block.type === "ul" || block.type === "ol") {
    const Tag = block.type === "ul" ? "ul" : "ol";
    return (
      <Tag className={block.type === "ul" ? "list-disc space-y-1 pl-4" : "list-decimal space-y-1 pl-4"}>
        {block.items.map((item, index) => (
          <li key={index} className={item.depth > 0 ? "ml-4" : undefined}>
            {renderInline(item.text)}
          </li>
        ))}
      </Tag>
    );
  }
  if (block.type === "p") return <p>{renderInline(block.text)}</p>;
  return null;
}

function safeUrl(url: string): string | null {
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
  } catch {
    return null;
  }
  return null;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeUrl(link[2]) : null;
      nodes.push(
        href ? (
          <a key={key++} href={href} className="underline">
            {link?.[1]}
          </a>
        ) : (
          token
        )
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key++} className="rounded bg-black/5 px-1 py-0.5 text-[0.9em]">
          {token.slice(1, -1)}
        </code>
      );
    } else {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
