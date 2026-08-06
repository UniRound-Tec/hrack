import type { AppStrings } from './zh-CN'

/** 繁體中文。原型英文微标签保持英文（与 zh-CN 基准一致）。 */
export const zhTW = {
  titlebar: {
    newSession: '新增',
    settings: '設定',
    minimize: '最小化',
    maximize: '最大化',
    restore: '還原',
    close: '關閉'
  },
  common: {
    close: '關閉',
    view: '檢視',
    cancel: '取消',
    confirm: '確認',
    justNow: '剛剛',
    minutesAgo: (minutes: number) => `${minutes} 分鐘前`,
    hoursAgo: (hours: number) => `${hours} 小時前`,
    daysAgo: (days: number) => `${days} 天前`
  },
  navigation: {
    home: 'Home',
    newSession: 'New Session',
    sessions: 'Session',
    terminals: 'Terminal',
    settings: '設定',
    emptySessions: '暫無工作階段',
    emptyTerminals: '暫無終端機',
    expandSidebar: '展開側欄',
    collapseSidebar: '收合側欄',
    closeTerminal: '關閉終端機',
    closeSession: '關閉工作階段',
    closeSessionPrompt: (name: string) =>
      `確定要關閉「${name}」嗎？CLI 程序及其子終端將一併結束。`,
    sessionActions: '工作階段操作',
    createChildTerminal: '新增子終端',
    cloneSession: '複製工作階段',
    childTerminals: '展開或收合子終端',
    renameSession: '重新命名',
    sessionNameRequired: '工作階段名稱不能為空'
  },
  sessionStatus: {
    working: '正在處理任務',
    needsYou: '需要你的確認',
    done: '本輪任務已完成',
    error: '執行遇到問題',
    idle: '等待你的下一個指令',
    exited: '工作階段已結束',
    exitedDetail: (exitCode: number | undefined) =>
      exitCode === undefined
        ? '工作階段已結束'
        : `工作階段已結束 · exit code ${exitCode}`
  },
  floating: {
    empty: '暫無活躍工作階段',
    attention: '需處理',
    expand: (count: number) => `展開全部 ${count} 個工作階段`,
    collapse: '收合'
  },
  agentDetail: {
    thinking: '正在分析並規劃下一步',
    responding: '正在整理回覆',
    liveThinking: (seconds: number | undefined, tokens: number | undefined) =>
      ['正在思考', seconds === undefined ? undefined : `${seconds}秒`, tokens === undefined ? undefined : `${tokens.toLocaleString('zh-TW')} tokens`].filter(Boolean).join(' · '),
    waitingApproval: (summary: string | undefined) =>
      ['需要你的確認', summary].filter(Boolean).join(' · '),
    waitingInput: (prompt: string | undefined) =>
      ['等待你的輸入', prompt].filter(Boolean).join(' · '),
    runningTool: (name: string | undefined) =>
      name ? `正在執行 ${name}` : '正在執行工具',
    completed: (tokens: number | undefined) =>
      ['本輪任務已完成', tokens === undefined ? undefined : `${tokens.toLocaleString('zh-TW')} tokens`].filter(Boolean).join(' · '),
    error: (message: string | undefined) =>
      ['執行遇到問題', message].filter(Boolean).join(' · '),
    exited: (exitCode: number | undefined) =>
      exitCode === undefined
        ? '工作階段已結束'
        : `工作階段已結束 · exit code ${exitCode}`
  },
  terminal: {
    copied: '已複製',
    newTab: '新增分頁',
    closeTab: '關閉分頁',
    exited: '已結束'
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
    terminal: '終端機',
    freshLabel: 'home · getting started',
    freshTitle: 'Welcome. Pick a CLI and go.',
    freshHint: '還沒有工作階段。選一個入口開始，AI CLI 的狀態與提醒會匯集到這裡。',
    freshCollect: '啟動後這裡會匯集',
    historyStats: '· 歷史事件與 all-time 統計',
    deskLabel: 'home · session desk',
    waitingApproval: (count: number) => `${count} waiting approval`,
    errors: (count: number) => `${count} errors`,
    live: (count: number) => `${count} live`,
    defaultTerminal: (name: string) => `預設：${name}`,
    terminalOptions: '終端機選項',
    previousLaunchPage: '上一頁',
    nextLaunchPage: '下一頁',
    attention: '注意力優先',
    allStatuses: '全部',
    emptyAttention: '目前篩選條件下沒有工作階段',
    showMore: '展開更多',
    showLess: '收起 ↑',
    showAll: (count: number) => `展開全部 ${count} 條 ↓`,
    recentHistory: '歷史事件',
    allTime: '概覽',
    emptyHistory: '暫無歷史事件',
    stats: {
      sessions: '歷史啟動',
      tools: 'Tools 呼叫',
      alerts: '阻塞提醒',
      approvals: '已處理核准'
    }
  },
  settings: {
    title: '設定',
    sections: {
      appearance: '外觀',
      layout: '版面',
      terminal: '終端機',
      session: '工作階段'
    },
    uiTheme: '介面主題',
    uiThemeHint: '只影響應用程式介面，與終端機配色相互獨立',
    light: '淺色',
    dark: '深色',
    language: '介面語言',
    languageHint: '切換後立即生效',
    languages: {
      'zh-CN': '简体中文',
      'zh-TW': '繁體中文',
      en: 'English',
      ja: '日本語',
      ko: '한국어'
    },
    navigationMode: '導覽模式',
    navigationModeHint: '三態互斥；頂部分頁模式無側欄',
    sidebar: '側欄展開',
    rail: '側欄收合',
    tabs: '頂部分頁欄',
    floatingWindow: '浮動視窗',
    floatingWindowHint: '獨立置頂顯示目前 AI CLI 工作階段狀態',
    globalShortcut: '全域快速鍵',
    globalShortcutHint: 'Ctrl+Alt+V 切換視窗顯示 / 隱藏',
    attentionPriority: '注意力優先排序',
    attentionPriorityHint: '開啟後，有新活動的工作階段會移到導覽列表頂部',
    terminalTheme: '終端機配色',
    terminalThemeHint: '16 色方案，獨立於介面主題',
    terminalThemeNames: { dark: 'Dark', light: 'Light' },
    font: '字型',
    fontHint: '內嵌 Maple Mono，中文回退字型隨平台',
    fontPlaceholder: '輸入字型家族，如 "Maple Mono"',
    restoreDefaultFont: '恢復預設',
    fontSize: '字級',
    decreaseFontSize: '減小字級',
    increaseFontSize: '增大字級',
    ligatures: '連字',
    ligaturesHint: '=> !== 等運算子合併顯示',
    terminalRounded: '圓角',
    terminalRoundedHint: '內容區圓角並為終端機加兩側留白；關閉後終端機貼邊顯示',
    defaultTerminal: '預設終端機',
    defaultTerminalHint: 'quick launch 的「終端機」晶片依此啟動',
    cliDiscovery: 'AI CLI 掃描',
    preferences: 'settings · preferences',
    description: '版面與控制項沿用定稿原型；各項設定直讀寫 settingsStore。',
    mapleMono: 'Maple Mono',
    pixels: (value: number) => `${value}px`,
    themeErrors: '使用者主題載入失敗'
  },
  newSession: {
    title: 'New Session',
    terminal: '終端機',
    quickTerminalHint: '以系統預設方式啟動',
    chooseTerminal: '選擇終端機',
    chooseTerminalHint: '點選一項即可啟動',
    configureCli: '設定 CLI 工作階段',
    chooseCli: '選擇一個 AI CLI 開始',
    newCli: (name: string) => `新增 ${name}`,
    configureThenLaunch: '設定工作階段後啟動',
    sessionName: '名稱',
    sessionNamePlaceholder: '工作階段名稱',
    workspace: '工作區',
    chooseWorkspace: '選擇目錄',
    arguments: '啟動參數',
    runtime: '版本',
    windows: 'Windows',
    windowsHint: '本機 Windows 環境',
    wsl: 'WSL',
    wslHint: '透過 WSL 啟動',
    rememberDefault: '下次預設以此方式啟動',
    launch: '啟動',
    defaultBadge: '預設',
    terminalFallback: '系統預設終端機',
    workspacePlaceholder: '請選擇工作區',
    argumentsPlaceholder: '--flag value',
    scanningClis: '正在掃描 Windows 與 WSL…',
    noClisFound: '未發現可啟動的 AI CLI',
    refreshClis: '重新掃描',
    clisFound: (count: number) => `已發現 ${count} 個 AI CLI`,
    partialScanErrors: (count: number) => `${count} 項未通過驗證`,
    installation: '安裝位置',
    launching: '啟動中…',
    p2Placeholder: 'CLI 與執行環境選項將在 P3 接入'
  },
  workspaceReader: {
    show: '顯示程式碼閱讀器',
    hide: '收起程式碼閱讀器',
    back: '返回終端',
    refresh: '重新整理工作區',
    resizeReader: '調整程式碼閱讀器寬度',
    resizeTree: '調整檔案樹寬度',
    loading: '正在讀取…',
    empty: '工作區為空',
    selectFile: '從檔案樹選擇一個文字檔案',
    selectFileShort: '選擇檔案以閱讀',
    unreadable: '無法顯示這個檔案',
    directoryError: '無法讀取工作區',
    openError: '無法展開目錄',
    markdownPreview: 'Markdown 預覽',
    markdownSource: '檢視 Markdown 原始碼',
    code: '程式碼'
  },
  shell: {
    homeLabel: 'home · app shell',
    homeTitle: 'Welcome back.',
    homeHint: '首頁內容將在 P3 接入；三態導覽與終端機路由已可用。',
    settingsHint: 'P2 先開放導覽模式；完整設定項將在 P3 接入。',
    unavailableTerminal: '這個示範工作階段沒有可開啟的終端機。'
  }
} satisfies AppStrings
