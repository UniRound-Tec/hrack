import { useEffect, useRef } from 'react'
import { EditorState, StateEffect } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  lineNumbers
} from '@codemirror/view'
import {
  defaultHighlightStyle,
  LanguageDescription,
  syntaxHighlighting
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'

interface ReadOnlyCodeViewProps {
  path: string
  text: string
}

export default function ReadOnlyCodeView({ path, text }: ReadOnlyCodeViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.theme({
            '&': {
              height: '100%',
              backgroundColor: 'transparent',
              color: 'var(--vib-text-primary)',
              fontSize: '12px'
            },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: 'var(--font-maple)'
            },
            '.cm-content': { minHeight: '100%', caretColor: 'transparent' },
            '.cm-gutters': {
              backgroundColor: 'var(--vib-bg-surface)',
              color: 'var(--vib-text-faint)',
              borderRight: '1px solid var(--vib-border-subtle)'
            },
            '.cm-activeLine': { backgroundColor: 'var(--vib-bg-surface-hover)' },
            '.cm-activeLineGutter': { backgroundColor: 'var(--vib-bg-surface-hover)' },
            '&.cm-focused': { outline: 'none' }
          })
        ]
      })
    })
    const language = LanguageDescription.matchFilename(languages, path)
    let disposed = false
    if (language) {
      void language.load().then((support) => {
        if (!disposed) view.dispatch({ effects: StateEffect.appendConfig.of(support) })
      })
    }
    return () => {
      disposed = true
      view.destroy()
    }
  }, [path, text])

  return <div ref={hostRef} data-testid="workspace-code-view" className="h-full min-w-0 flex-1 overflow-hidden select-text" />
}
