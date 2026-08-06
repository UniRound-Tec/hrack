import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownPreviewProps {
  text: string
}

export default function MarkdownPreview({ text }: MarkdownPreviewProps) {
  return (
    <div
      data-testid="workspace-markdown-preview"
      className="workspace-markdown h-full overflow-auto px-6 py-5 font-pingfang text-[13px] leading-6 text-text-secondary select-text"
    >
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-4 mt-1 border-b border-border-subtle pb-2 text-xl font-semibold text-text-primary">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-6 border-b border-border-subtle pb-1.5 text-lg font-semibold text-text-primary">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-5 text-base font-semibold text-text-primary">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-2 mt-4 text-sm font-semibold text-text-primary">
              {children}
            </h4>
          ),
          p: ({ children }) => <p className="my-3">{children}</p>,
          ul: ({ children }) => (
            <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-text-faint pl-4 text-text-muted">
              {children}
            </blockquote>
          ),
          pre: ({ children }) => (
            <pre className="my-4 overflow-auto rounded-lg border border-border-subtle bg-surface-hover p-3 font-maple text-[12px] leading-5 text-text-primary">
              {children}
            </pre>
          ),
          code: ({ children, className }) => (
            <code
              className={`${className ?? ''} rounded bg-surface-hover px-1 py-0.5 font-maple text-[0.92em] text-text-primary`}
            >
              {children}
            </code>
          ),
          hr: () => <hr className="my-6 border-border-subtle" />,
          a: ({ children, href }) => (
            <span
              title={href}
              className="cursor-default text-accent underline decoration-accent/40 underline-offset-2"
            >
              {children}
            </span>
          ),
          img: ({ alt }) => (
            <span className="my-3 block rounded-md border border-border-subtle px-3 py-2 text-text-faint">
              {alt || 'Image'}
            </span>
          ),
          table: ({ children }) => (
            <table className="my-4 w-full border-collapse text-left text-[12px]">
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th className="border border-border-subtle bg-surface-hover px-2 py-1.5 font-semibold text-text-primary">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border-subtle px-2 py-1.5">
              {children}
            </td>
          ),
          input: (props) => <input {...props} disabled className="mr-1.5" />
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
