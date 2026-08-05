import type { AppStrings } from './zh-CN'

/** 日本語。プロトタイプの英文マイクロラベルは英語のまま（zh-CN 基準と同一）。 */
export const ja = {
  titlebar: {
    newSession: '新規',
    settings: '設定',
    minimize: '最小化',
    maximize: '最大化',
    restore: '元に戻す',
    close: '閉じる'
  },
  common: {
    close: '閉じる',
    view: '表示',
    cancel: 'キャンセル',
    confirm: '確認',
    justNow: 'たった今',
    minutesAgo: (minutes: number) => `${minutes} 分前`,
    hoursAgo: (hours: number) => `${hours} 時間前`,
    daysAgo: (days: number) => `${days} 日前`
  },
  navigation: {
    home: 'Home',
    newSession: 'New Session',
    sessions: 'Session',
    terminals: 'Terminal',
    settings: '設定',
    emptySessions: 'セッションなし',
    emptyTerminals: 'ターミナルなし',
    expandSidebar: 'サイドバーを展開',
    collapseSidebar: 'サイドバーを折りたたむ',
    closeTerminal: 'ターミナルを閉じる',
    closeSession: 'セッションを閉じる',
    sessionActions: 'セッション操作',
    renameSession: '名前を変更',
    sessionNameRequired: 'セッション名を入力してください'
  },
  sessionStatus: {
    working: 'タスクを処理中',
    needsYou: '確認が必要です',
    done: '今回のタスクが完了しました',
    error: '実行中に問題が発生しました',
    idle: '次の指示を待っています',
    exited: 'セッションは終了しました',
    exitedDetail: (exitCode: number | undefined) =>
      exitCode === undefined
        ? 'セッションは終了しました'
        : `セッションは終了しました · exit code ${exitCode}`
  },
  floating: {
    empty: 'アクティブなセッションはありません',
    attention: '要対応',
    expand: (count: number) => `${count} 件すべて表示`,
    collapse: '折りたたむ'
  },
  agentDetail: {
    thinking: 'タスクを分析して次の手順を計画しています',
    responding: '回答をまとめています',
    liveThinking: (seconds: number | undefined, tokens: number | undefined) =>
      ['思考中', seconds === undefined ? undefined : `${seconds}秒`, tokens === undefined ? undefined : `${tokens.toLocaleString('ja-JP')} tokens`].filter(Boolean).join(' · '),
    waitingApproval: (summary: string | undefined) =>
      ['確認が必要です', summary].filter(Boolean).join(' · '),
    waitingInput: (prompt: string | undefined) =>
      ['入力を待っています', prompt].filter(Boolean).join(' · '),
    runningTool: (name: string | undefined) =>
      name ? `${name} を実行中` : 'ツールを実行中',
    completed: (tokens: number | undefined) =>
      ['今回のタスクが完了しました', tokens === undefined ? undefined : `${tokens.toLocaleString('ja-JP')} tokens`].filter(Boolean).join(' · '),
    error: (message: string | undefined) =>
      ['実行中に問題が発生しました', message].filter(Boolean).join(' · '),
    exited: (exitCode: number | undefined) =>
      exitCode === undefined
        ? 'セッションは終了しました'
        : `セッションは終了しました · exit code ${exitCode}`
  },
  terminal: {
    copied: 'コピーしました',
    newTab: '新しいタブ',
    closeTab: 'タブを閉じる',
    exited: '終了'
  },
  home: {
    greetings: [
      { text: 'Hi! Ready to coding?', keywords: ['coding'] },
      { text: 'Welcome back, builder.', keywords: ['builder'] },
      { text: 'Let’s ship something today.', keywords: ['ship'] },
      { text: 'Your agents are standing by.', keywords: ['agents'] },
      { text: 'Coffee first, then commits.', keywords: ['commits'] },
      { text: 'One more session won’t hurt.', keywords: ['session'] },
      { text: 'Good timing. Let’s vibe.', keywords: ['vibe'] },
      { text: 'Pick a CLI and go.', keywords: ['CLI'] }
    ],
    quickLaunch: 'quick launch',
    terminal: 'ターミナル',
    freshLabel: 'home · getting started',
    freshTitle: 'Welcome. Pick a CLI and go.',
    freshHint: 'セッションはまだありません。エントリを選ぶと AI CLI の状態がここに集まります。',
    freshCollect: '起動後、ここに集まります',
    historyStats: '· 履歴イベントと累計統計',
    deskLabel: 'home · session desk',
    waitingApproval: (count: number) => `${count} waiting approval`,
    errors: (count: number) => `${count} errors`,
    live: (count: number) => `${count} live`,
    defaultTerminal: (name: string) => `デフォルト：${name}`,
    terminalOptions: 'ターミナルオプション',
    previousLaunchPage: '前のページ',
    nextLaunchPage: '次のページ',
    attention: '注意優先',
    allStatuses: 'すべて',
    emptyAttention: 'このフィルターに一致するセッションはありません',
    showMore: 'さらに表示',
    showLess: '折りたたむ ↑',
    showAll: (count: number) => `すべて表示 ${count} 件 ↓`,
    recentHistory: '履歴イベント',
    allTime: '概要',
    emptyHistory: '履歴イベントはまだありません',
    stats: {
      sessions: '起動セッション',
      tools: 'ツール呼び出し',
      alerts: 'ブロック通知',
      approvals: '処理済みの承認'
    }
  },
  settings: {
    title: '設定',
    sections: {
      appearance: '外観',
      layout: 'レイアウト',
      terminal: 'ターミナル',
      session: 'セッション'
    },
    uiTheme: 'UI テーマ',
    uiThemeHint: 'アプリ UI のみに影響。ターミナルの配色とは独立',
    light: 'ライト',
    dark: 'ダーク',
    language: '表示言語',
    languageHint: '切り替え後すぐに反映されます',
    languages: {
      'zh-CN': '简体中文',
      'zh-TW': '繁體中文',
      en: 'English',
      ja: '日本語',
      ko: '한국어'
    },
    navigationMode: 'ナビゲーションモード',
    navigationModeHint: '三状態の排他切替。上部タブモードではサイドバーなし',
    sidebar: 'サイドバー展開',
    rail: 'サイドバー折りたたみ',
    tabs: '上部タブバー',
    floatingWindow: 'フローティングウィンドウ',
    floatingWindowHint: 'AI CLI セッションの状態を常に手前に表示',
    globalShortcut: 'グローバルショートカット',
    globalShortcutHint: 'Ctrl+Alt+V でウィンドウの表示 / 非表示を切替',
    terminalTheme: 'ターミナル配色',
    terminalThemeHint: '16 色スキーム。UI テーマとは独立',
    terminalThemeNames: { dark: 'Dark', light: 'Light' },
    font: 'フォント',
    fontHint: '同梱の Maple Mono。中国語のフォールバックはプラットフォーム依存',
    fontPlaceholder: 'フォントファミリー（例："Maple Mono"）',
    restoreDefaultFont: 'デフォルトに戻す',
    fontSize: 'フォントサイズ',
    decreaseFontSize: 'フォントサイズを小さく',
    increaseFontSize: 'フォントサイズを大きく',
    ligatures: '合字',
    ligaturesHint: '=> !== などの演算子を結合して表示',
    terminalRounded: '角丸',
    terminalRoundedHint: 'コンテンツ領域を角丸にして両側に余白。オフで端まで表示',
    defaultTerminal: 'デフォルトターミナル',
    defaultTerminalHint: 'quick launch の「ターミナル」チップがこれで起動します',
    cliDiscovery: 'AI CLI スキャン',
    preferences: 'settings · preferences',
    description: 'レイアウトとコントロールは確定プロトタイプに準拠。設定は settingsStore に直書き。',
    mapleMono: 'Maple Mono',
    pixels: (value: number) => `${value}px`,
    themeErrors: 'ユーザーテーマの読み込みに失敗'
  },
  newSession: {
    title: 'New Session',
    terminal: 'ターミナル',
    quickTerminalHint: 'システム既定で起動',
    chooseTerminal: 'ターミナルを選択',
    chooseTerminalHint: 'クリックすると起動します',
    configureCli: 'CLI セッションを設定',
    chooseCli: 'AI CLI を選んで開始',
    newCli: (name: string) => `新規 ${name}`,
    configureThenLaunch: '設定してから起動',
    sessionName: '名前',
    sessionNamePlaceholder: 'セッション名',
    workspace: 'ワークスペース',
    chooseWorkspace: 'フォルダを選択',
    arguments: '起動引数',
    runtime: 'ランタイム',
    windows: 'Windows',
    windowsHint: 'この Windows 環境',
    wsl: 'WSL',
    wslHint: 'WSL 経由で起動',
    rememberDefault: '次回もこの方式を既定にする',
    launch: '起動',
    defaultBadge: '既定',
    terminalFallback: 'システム既定のターミナル',
    workspacePlaceholder: 'ワークスペースを選択',
    argumentsPlaceholder: '--flag value',
    scanningClis: 'Windows と WSL をスキャン中…',
    noClisFound: '起動可能な AI CLI が見つかりません',
    refreshClis: '再スキャン',
    clisFound: (count: number) => `${count} 個の AI CLI を検出`,
    partialScanErrors: (count: number) => `${count} 件の検証に失敗`,
    installation: 'インストール先',
    launching: '起動中…',
    p2Placeholder: 'CLI と実行環境のオプションは P3 で追加'
  },
  workspaceReader: {
    show: 'コードリーダーを表示',
    hide: 'コードリーダーを閉じる',
    back: 'ターミナルに戻る',
    refresh: 'ワークスペースを更新',
    resizeReader: 'コードリーダーの幅を調整',
    resizeTree: 'ファイルツリーの幅を調整',
    loading: '読み込み中…',
    empty: 'ワークスペースは空です',
    selectFile: 'ファイルツリーからテキストファイルを選択',
    selectFileShort: 'ファイルを選択してください',
    unreadable: 'このファイルは表示できません',
    directoryError: 'ワークスペースを読み込めません',
    openError: 'ディレクトリを開けません',
    code: 'コード'
  },
  shell: {
    homeLabel: 'home · app shell',
    homeTitle: 'Welcome back.',
    homeHint: 'ホーム内容は P3 で追加。三状態ナビゲーションとターミナルルーティングは利用可。',
    settingsHint: 'P2 ではナビゲーションモードのみ解放。完全な設定は P3 で追加。',
    unavailableTerminal: 'このデモセッションには開けるターミナルがありません。'
  }
} satisfies AppStrings
