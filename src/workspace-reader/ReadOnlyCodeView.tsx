import { useEffect, useRef } from 'react'
import { Compartment, EditorState, StateEffect } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  lineNumbers
} from '@codemirror/view'
import {
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import type { ResolvedUiTheme } from '../../shared/theme-schema'
import {
  builtInLightTheme,
  getUiThemeRegistry,
  useThemeRegistryVersion
} from '../app/themeRuntime'
import { useSettingsStore } from '../state/settingsStore'

interface ReadOnlyCodeViewProps {
  path: string
  text: string
}

function workspaceEditorTheme(theme: ResolvedUiTheme) {
  const colors = theme.colors
  const highlightStyle = HighlightStyle.define([
    { tag: tags.meta, color: colors['text.muted'] },
    {
      tag: tags.link,
      color: colors['status.working'],
      textDecoration: 'underline'
    },
    {
      tag: tags.heading,
      color: colors['accent.spark'],
      textDecoration: 'underline',
      fontWeight: 'bold'
    },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, color: colors['accent.spark'], fontWeight: 'bold' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    {
      tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
      color: colors['accent.cursor']
    },
    {
      tag: [
        tags.atom,
        tags.bool,
        tags.url,
        tags.contentSeparator,
        tags.labelName
      ],
      color: colors['status.needsYou']
    },
    {
      tag: [tags.literal, tags.inserted, tags.string],
      color: colors['status.done']
    },
    {
      tag: [tags.regexp, tags.escape, tags.special(tags.string)],
      color: colors['accent.flame']
    },
    {
      tag: tags.definition(tags.variableName),
      color: colors['status.working']
    },
    {
      tag: tags.local(tags.variableName),
      color: colors['text.secondary']
    },
    {
      tag: [tags.typeName, tags.namespace, tags.className],
      color: colors['status.needsYou']
    },
    {
      tag: [tags.special(tags.variableName), tags.macroName],
      color: colors['accent.target']
    },
    {
      tag: [tags.definition(tags.propertyName), tags.propertyName],
      color: colors['status.working']
    },
    {
      tag: tags.comment,
      color: colors['text.muted'],
      fontStyle: 'italic'
    },
    {
      tag: [tags.deleted, tags.invalid],
      color: colors['status.error']
    }
  ])

  return [
    syntaxHighlighting(highlightStyle),
    EditorView.theme(
      {
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
        '.cm-activeLineGutter': {
          backgroundColor: 'var(--vib-bg-surface-hover)'
        },
        '&.cm-focused': { outline: 'none' }
      },
      { dark: theme.type === 'dark' }
    )
  ]
}

export default function ReadOnlyCodeView({ path, text }: ReadOnlyCodeViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartmentRef = useRef(new Compartment())
  const uiThemeId = useSettingsStore((state) => state.uiThemeId)
  useThemeRegistryVersion((state) => state.version)
  const uiTheme = getUiThemeRegistry().get(uiThemeId) ?? builtInLightTheme
  const currentThemeRef = useRef(uiTheme)
  currentThemeRef.current = uiTheme

  useEffect(() => {
    if (!hostRef.current) return
    const themeCompartment = themeCompartmentRef.current
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
          themeCompartment.of(workspaceEditorTheme(currentThemeRef.current))
        ]
      })
    })
    viewRef.current = view
    const language = LanguageDescription.matchFilename(languages, path)
    let disposed = false
    if (language) {
      void language.load().then((support) => {
        if (!disposed) view.dispatch({ effects: StateEffect.appendConfig.of(support) })
      })
    }
    return () => {
      disposed = true
      if (viewRef.current === view) viewRef.current = null
      view.destroy()
    }
  }, [path, text])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        workspaceEditorTheme(uiTheme)
      )
    })
  }, [uiTheme])

  return <div ref={hostRef} data-testid="workspace-code-view" className="h-full min-w-0 flex-1 overflow-hidden select-text" />
}
