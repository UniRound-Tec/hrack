import { useLayoutEffect, useRef } from 'react'
import MarkdownBody from '../markdown/MarkdownBody'

interface MarkdownPreviewProps {
  text: string
}

export default function MarkdownPreview({ text }: MarkdownPreviewProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)

  useLayoutEffect(() => {
    const node = scrollerRef.current
    if (node) node.scrollTop = scrollTopRef.current
  }, [text])

  return (
    <div
      ref={scrollerRef}
      data-testid="workspace-markdown-preview"
      className="workspace-markdown h-full overflow-auto px-6 py-5 font-pingfang text-[13px] leading-6 text-text-secondary select-text"
      onScroll={(event) => {
        scrollTopRef.current = event.currentTarget.scrollTop
      }}
    >
      <MarkdownBody text={text} />
    </div>
  )
}
