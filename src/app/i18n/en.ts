import type { AppStrings } from './zh-CN'

/** English. Prototype English micro-labels stay English (same baseline as zh-CN). */
export const en = {
  titlebar: {
    newSession: 'New',
    settings: 'Settings',
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    close: 'Close'
  },
  common: {
    close: 'Close',
    view: 'View',
    cancel: 'Cancel',
    confirm: 'Confirm',
    justNow: 'just now',
    minutesAgo: (minutes: number) => `${minutes} min ago`,
    hoursAgo: (hours: number) => `${hours} hr ago`,
    daysAgo: (days: number) => `${days} days ago`
  },
  navigation: {
    home: 'Home',
    newSession: 'New Session',
    sessions: 'Session',
    terminals: 'Terminal',
    settings: 'Settings',
    emptySessions: 'No sessions',
    emptyTerminals: 'No terminals',
    expandSidebar: 'Expand sidebar',
    collapseSidebar: 'Collapse sidebar',
    closeTerminal: 'Close terminal',
    closeSession: 'Close session',
    sessionActions: 'Session actions',
    renameSession: 'Rename',
    sessionNameRequired: 'Session name is required'
  },
  sessionStatus: {
    working: 'Working on the task',
    needsYou: 'Needs your confirmation',
    done: 'This turn is complete',
    error: 'Something went wrong',
    idle: 'Waiting for your next instruction',
    exited: 'Session ended',
    exitedDetail: (exitCode: number | undefined) =>
      exitCode === undefined
        ? 'Session ended'
        : `Session ended · exit code ${exitCode}`
  },
  agentDetail: {
    thinking: 'Analyzing the task and planning the next step',
    liveThinking: (seconds: number | undefined, tokens: number | undefined) =>
      ['Thinking', seconds === undefined ? undefined : `${seconds}s`, tokens === undefined ? undefined : `${tokens.toLocaleString('en-US')} tokens`].filter(Boolean).join(' · '),
    waitingApproval: (summary: string | undefined) =>
      ['Needs your confirmation', summary].filter(Boolean).join(' · '),
    waitingInput: (prompt: string | undefined) =>
      ['Waiting for your input', prompt].filter(Boolean).join(' · '),
    runningTool: (name: string | undefined) =>
      name ? `Running ${name}` : 'Running a tool',
    completed: (tokens: number | undefined) =>
      ['This turn is complete', tokens === undefined ? undefined : `${tokens.toLocaleString('en-US')} tokens`].filter(Boolean).join(' · '),
    error: (message: string | undefined) =>
      ['Something went wrong', message].filter(Boolean).join(' · '),
    exited: (exitCode: number | undefined) =>
      exitCode === undefined
        ? 'Session ended'
        : `Session ended · exit code ${exitCode}`
  },
  terminal: {
    copied: 'Copied',
    newTab: 'New tab',
    closeTab: 'Close tab',
    exited: 'Exited'
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
    terminal: 'Terminal',
    freshLabel: 'home · getting started',
    freshTitle: 'Welcome. Pick a CLI and go.',
    freshHint:
      'No sessions yet. Pick an entry point and AI CLI status will collect here.',
    freshCollect: 'This desk will collect',
    historyStats: '· history events and all-time stats',
    deskLabel: 'home · session desk',
    waitingApproval: (count: number) => `${count} waiting approval`,
    errors: (count: number) => `${count} errors`,
    live: (count: number) => `${count} live`,
    defaultTerminal: (name: string) => `Default: ${name}`,
    terminalOptions: 'Terminal options',
    previousLaunchPage: 'Previous page',
    nextLaunchPage: 'Next page',
    attention: 'Attention first',
    allStatuses: 'All',
    emptyAttention: 'No sessions match this filter',
    showMore: 'Show more',
    showLess: 'Collapse ↑',
    showAll: (count: number) => `Show all ${count} ↓`,
    recentHistory: 'History events',
    allTime: 'Overview',
    emptyHistory: 'No history events yet',
    stats: {
      sessions: 'Sessions started',
      tools: 'Tool calls',
      alerts: 'Blocked alerts',
      approvals: 'Approvals handled'
    }
  },
  settings: {
    title: 'Settings',
    sections: {
      appearance: 'Appearance',
      layout: 'Layout',
      terminal: 'Terminal',
      session: 'Sessions'
    },
    uiTheme: 'UI theme',
    uiThemeHint: 'Only affects the app UI, independent of terminal colors',
    light: 'Light',
    dark: 'Dark',
    language: 'Language',
    languageHint: 'Applies immediately',
    languages: {
      'zh-CN': '简体中文',
      'zh-TW': '繁體中文',
      en: 'English',
      ja: '日本語',
      ko: '한국어'
    },
    navigationMode: 'Navigation mode',
    navigationModeHint: 'Three exclusive states; top tab mode hides the sidebar',
    sidebar: 'Expanded sidebar',
    rail: 'Collapsed sidebar',
    tabs: 'Top tab bar',
    floatingWindow: 'Floating window',
    floatingWindowHint: 'Standalone always-on-top window, ships with S3',
    globalShortcut: 'Global shortcut',
    globalShortcutHint: 'Ctrl+Alt+V toggles window visibility',
    terminalTheme: 'Terminal palette',
    terminalThemeHint: '16-color scheme, independent of the UI theme',
    terminalThemeNames: { dark: 'Dark', light: 'Light' },
    font: 'Font',
    fontHint: 'Bundled Maple Mono, CJK fallbacks follow the platform',
    fontPlaceholder: 'Font family, e.g. "Maple Mono"',
    restoreDefaultFont: 'Restore default',
    fontSize: 'Font size',
    decreaseFontSize: 'Decrease font size',
    increaseFontSize: 'Increase font size',
    ligatures: 'Ligatures',
    ligaturesHint: 'Render => !== as combined glyphs',
    terminalRounded: 'Rounded corners',
    terminalRoundedHint:
      'Rounds the content area and pads the terminal; off hugs the edges',
    defaultTerminal: 'Default terminal',
    defaultTerminalHint: 'The Terminal chip on quick launch starts this',
    cliDiscovery: 'AI CLI scan',
    preferences: 'settings · preferences',
    description: 'Layout and controls follow the locked prototype; settings write through.',
    mapleMono: 'Maple Mono',
    pixels: (value: number) => `${value}px`,
    themeErrors: 'User theme load failed'
  },
  newSession: {
    title: 'New Session',
    terminal: 'Terminal',
    quickTerminalHint: 'Start with the system default',
    chooseTerminal: 'Choose a terminal',
    chooseTerminalHint: 'Click one to start',
    configureCli: 'Configure CLI session',
    chooseCli: 'Pick an AI CLI to begin',
    newCli: (name: string) => `New ${name}`,
    configureThenLaunch: 'Configure, then launch',
    sessionName: 'Name',
    sessionNamePlaceholder: 'Session name',
    workspace: 'Workspace',
    chooseWorkspace: 'Choose a folder',
    arguments: 'Arguments',
    runtime: 'Runtime',
    windows: 'Windows',
    windowsHint: 'Local Windows environment',
    wsl: 'WSL',
    wslHint: 'Launch through WSL',
    rememberDefault: 'Use this mode by default next time',
    launch: 'Launch',
    defaultBadge: 'Default',
    terminalFallback: 'System default terminal',
    workspacePlaceholder: 'Choose a workspace',
    argumentsPlaceholder: '--flag value',
    scanningClis: 'Scanning Windows and WSL…',
    noClisFound: 'No launchable AI CLI found',
    refreshClis: 'Scan again',
    clisFound: (count: number) => `${count} AI CLI${count === 1 ? '' : 's'} found`,
    partialScanErrors: (count: number) => `${count} probe${count === 1 ? '' : 's'} failed`,
    installation: 'Installation',
    launching: 'Launching…',
    p2Placeholder: 'CLI and runtime options land in P3'
  },
  shell: {
    homeLabel: 'home · app shell',
    homeTitle: 'Welcome back.',
    homeHint: 'Home content lands in P3; three-state navigation and routing work.',
    settingsHint: 'P2 unlocks navigation mode; full settings land in P3.',
    unavailableTerminal: 'This demo session has no terminal to open.'
  }
} satisfies AppStrings
