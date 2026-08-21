import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownBodyProps {
  text: string
  /**
   * 紧凑排版：用于更新弹窗等小空间场景（更小的标题、更紧的间距）。
   * 默认保持 workspace 阅读器的常规排版。
   */
  dense?: boolean
}

/**
 * 共享的 Markdown 渲染主体：统一 GFM 语法支持与主题化样式。
 * HTML 一律跳过（skipHtml），链接只展示不导航，避免在 Electron 内跳转。
 */
export default function MarkdownBody({ text, dense = false }: MarkdownBodyProps) {
  return (
    <Markdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1
            className={
              dense
                ? 'mb-2 mt-1 border-b border-border-subtle pb-1 text-[14px] font-semibold text-text-primary'
                : 'mb-4 mt-1 border-b border-border-subtle pb-2 text-xl font-semibold text-text-primary'
            }
          >
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2
            className={
              dense
                ? 'mb-2 mt-4 border-b border-border-subtle pb-1 text-[13px] font-semibold text-text-primary'
                : 'mb-3 mt-6 border-b border-border-subtle pb-1.5 text-lg font-semibold text-text-primary'
            }
          >
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3
            className={
              dense
                ? 'mb-1.5 mt-3 text-[12px] font-semibold text-text-primary'
                : 'mb-2 mt-5 text-base font-semibold text-text-primary'
            }
          >
            {children}
          </h3>
        ),
        h4: ({ children }) => (
          <h4
            className={
              dense
                ? 'mb-1.5 mt-2.5 text-[12px] font-semibold text-text-primary'
                : 'mb-2 mt-4 text-sm font-semibold text-text-primary'
            }
          >
            {children}
          </h4>
        ),
        p: ({ children }) => <p className={dense ? 'my-2' : 'my-3'}>{children}</p>,
        ul: ({ children }) => (
          <ul
            className={
              dense
                ? 'my-2 list-disc space-y-0.5 pl-5'
                : 'my-3 list-disc space-y-1 pl-6'
            }
          >
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol
            className={
              dense
                ? 'my-2 list-decimal space-y-0.5 pl-5'
                : 'my-3 list-decimal space-y-1 pl-6'
            }
          >
            {children}
          </ol>
        ),
        blockquote: ({ children }) => (
          <blockquote
            className={
              dense
                ? 'my-3 border-l-2 border-text-faint pl-3 text-text-muted'
                : 'my-4 border-l-2 border-text-faint pl-4 text-text-muted'
            }
          >
            {children}
          </blockquote>
        ),
        pre: ({ children }) => (
          <pre
            className={
              dense
                ? 'my-3 overflow-auto rounded-lg border border-border-subtle bg-surface-hover p-2.5 font-maple text-[11px] leading-5 text-text-primary'
                : 'my-4 overflow-auto rounded-lg border border-border-subtle bg-surface-hover p-3 font-maple text-[12px] leading-5 text-text-primary'
            }
          >
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
        hr: () => <hr className={dense ? 'my-4 border-border-subtle' : 'my-6 border-border-subtle'} />,
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
          <table
            className={
              dense
                ? 'my-3 w-full border-collapse text-left text-[11px]'
                : 'my-4 w-full border-collapse text-left text-[12px]'
            }
          >
            {children}
          </table>
        ),
        th: ({ children }) => (
          <th className="border border-border-subtle bg-surface-hover px-2 py-1.5 font-semibold text-text-primary">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-border-subtle px-2 py-1.5">{children}</td>
        ),
        input: (props) => <input {...props} disabled className="mr-1.5" />
      }}
    >
      {text}
    </Markdown>
  )
}
