/**
 * zh-CN 是类型基准：`AppStrings = typeof zhCN`，其余 locale 以
 * `satisfies AppStrings` 保证 key 完整性（含函数型条目逐语言实现）。
 * 原型英文微标签（home · getting started / quick launch / sessions 等）
 * 属设计元素，各语言下保持英文。
 */
export const zhCN = {
  titlebar: {
    newSession: '新建',
    settings: '设置',
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    close: '关闭'
  },
  common: {
    close: '关闭',
    view: '查看',
    cancel: '取消',
    confirm: '确认',
    justNow: '刚刚',
    minutesAgo: (minutes: number) => `${minutes} 分钟前`,
    hoursAgo: (hours: number) => `${hours} 小时前`,
    daysAgo: (days: number) => `${days} 天前`
  },
  navigation: {
    home: 'Home',
    newSession: 'New Session',
    sessions: 'Session',
    terminals: 'Terminal',
    settings: '设置',
    emptySessions: '暂无会话',
    emptyTerminals: '暂无终端',
    expandSidebar: '展开侧栏',
    collapseSidebar: '收起侧栏',
    closeTerminal: '关闭终端',
    closeSession: '关闭会话',
    closeSessionPrompt: (name: string) =>
      `确定要关闭“${name}”吗？CLI 进程及其子终端会一并结束。`,
    sessionActions: '会话操作',
    createChildTerminal: '新建子终端',
    cloneSession: '克隆会话',
    childTerminals: '展开或收起子终端',
    renameSession: '重命名',
    sessionNameRequired: '会话名称不能为空'
  },
  sessionStatus: {
    working: '正在处理任务',
    needsYou: '需要你的确认',
    done: '本轮任务已完成',
    error: '执行遇到问题',
    idle: '等待你的下一条指令',
    exited: '会话已结束',
    exitedDetail: (exitCode: number | undefined) =>
      exitCode === undefined
        ? '会话已结束'
        : `会话已结束 · exit code ${exitCode}`
  },
  floating: {
    empty: '暂无活跃会话',
    attention: '需处理',
    expand: (count: number) => `展开全部 ${count} 个会话`,
    collapse: '收起'
  },
  agentDetail: {
    thinking: '正在分析并规划下一步',
    responding: '正在整理回复',
    liveThinking: (seconds: number | undefined, tokens: number | undefined) =>
      ['正在思考', seconds === undefined ? undefined : `${seconds}秒`, tokens === undefined ? undefined : `${tokens.toLocaleString('zh-CN')} tokens`].filter(Boolean).join(' · '),
    waitingApproval: (summary: string | undefined) =>
      ['需要你的确认', summary].filter(Boolean).join(' · '),
    waitingInput: (prompt: string | undefined) =>
      ['等待你的输入', prompt].filter(Boolean).join(' · '),
    runningTool: (name: string | undefined) =>
      name ? `正在执行 ${name}` : '正在执行工具',
    completed: (tokens: number | undefined) =>
      ['本轮任务已完成', tokens === undefined ? undefined : `${tokens.toLocaleString('zh-CN')} tokens`].filter(Boolean).join(' · '),
    error: (message: string | undefined) =>
      ['执行遇到问题', message].filter(Boolean).join(' · '),
    observerDegraded: (reason: string | undefined) =>
      ['监听已降级', reason].filter(Boolean).join(' · '),
    exited: (exitCode: number | undefined) =>
      exitCode === undefined
        ? '会话已结束'
        : `会话已结束 · exit code ${exitCode}`
  },
  terminal: {
    copied: '已复制',
    newTab: '新建标签页',
    closeTab: '关闭标签页',
    exited: '已退出'
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
    terminal: '终端',
    freshLabel: 'home · getting started',
    freshTitle: 'Welcome. Pick a CLI and go.',
    freshHint: '还没有会话。选一个入口开始，AI CLI 的状态与提醒会汇聚到这里。',
    freshCollect: '启动后这里会汇聚',
    historyStats: '· 历史事件与 all-time 统计',
    deskLabel: 'home · session desk',
    waitingApproval: (count: number) => `${count} waiting approval`,
    errors: (count: number) => `${count} errors`,
    live: (count: number) => `${count} live`,
    defaultTerminal: (name: string) => `默认：${name}`,
    terminalOptions: '终端选项',
    previousLaunchPage: '上一页',
    nextLaunchPage: '下一页',
    attention: '注意力优先',
    allStatuses: '全部',
    emptyAttention: '当前筛选下没有会话',
    showMore: '展开更多',
    showLess: '收起 ↑',
    showAll: (count: number) => `展开全部 ${count} 条 ↓`,
    recentHistory: '历史事件',
    allTime: '概览',
    emptyHistory: '暂无历史事件',
    stats: {
      sessions: '历史启动',
      tools: 'Tools 调用',
      alerts: '阻塞提醒',
      approvals: '已处理批准'
    }
  },
  settings: {
    title: '设置',
    sections: {
      appearance: '外观',
      layout: '布局',
      terminal: '终端',
      session: '会话'
    },
    uiTheme: '界面主题',
    uiThemeHint: '只影响应用界面，与终端配色相互独立',
    light: '浅色',
    dark: '深色',
    language: '界面语言',
    languageHint: '切换后即时生效',
    languages: {
      'zh-CN': '简体中文',
      'zh-TW': '繁體中文',
      en: 'English',
      ja: '日本語',
      ko: '한국어'
    },
    navigationMode: '导航模式',
    navigationModeHint: '三态互斥；顶部 Tab 模式无侧栏',
    sidebar: '侧栏展开',
    rail: '侧栏收起',
    tabs: '顶部 Tab 栏',
    floatingWindow: '悬浮窗',
    floatingWindowHint: '独立置顶显示当前 AI CLI 会话状态',
    globalShortcut: '全局快捷键',
    globalShortcutHint: 'Ctrl+Alt+V 切换窗口显示 / 隐藏',
    attentionPriority: '注意力优先排序',
    attentionPriorityHint: '开启后，有新活动的会话会移动到导航列表顶部',
    terminalTheme: '终端配色',
    terminalThemeHint: '16 色方案，独立于界面主题',
    terminalThemeNames: { dark: 'Dark', light: 'Light' },
    font: '字体',
    fontHint: '内嵌 Maple Mono，中文回退栈随平台',
    fontPlaceholder: '输入字体家族，如 "Maple Mono"',
    restoreDefaultFont: '恢复默认',
    fontSize: '字号',
    decreaseFontSize: '减小字号',
    increaseFontSize: '增大字号',
    ligatures: '连字',
    ligaturesHint: '=> !== 等操作符合并渲染',
    terminalRounded: '圆角',
    terminalRoundedHint: '内容区圆角并为终端加两侧留白；关闭后终端贴边显示',
    defaultTerminal: '默认终端',
    defaultTerminalHint: 'quick launch 的「终端」芯片按此启动',
    cliDiscovery: 'AI CLI 扫描',
    preferences: 'settings · preferences',
    description: '布局与控件沿用定稿原型；各项设置直读写 settingsStore。',
    mapleMono: 'Maple Mono',
    pixels: (value: number) => `${value}px`,
    themeErrors: '用户主题加载失败'
  },
  newSession: {
    title: 'New Session',
    terminal: '终端',
    quickTerminalHint: '按系统默认方式启动',
    chooseTerminal: '选择终端',
    chooseTerminalHint: '点击一项即可启动',
    configureCli: '配置 CLI 会话',
    chooseCli: '选择一个 AI CLI 开始',
    newCli: (name: string) => `新建 ${name}`,
    configureThenLaunch: '配置会话后启动',
    sessionName: '名称',
    sessionNamePlaceholder: '会话名称',
    workspace: '工作区',
    chooseWorkspace: '选择目录',
    arguments: '启动参数',
    runtime: '版本',
    windows: 'Windows',
    windowsHint: '本机 Windows 环境',
    wsl: 'WSL',
    wslHint: '通过 WSL 启动',
    rememberDefault: '下次默认以该方式启动',
    launch: '启动',
    defaultBadge: '默认',
    terminalFallback: '系统默认终端',
    workspacePlaceholder: '请选择工作区',
    argumentsPlaceholder: '--flag value',
    scanningClis: '正在扫描 Windows 与 WSL…',
    noClisFound: '未发现可启动的 AI CLI',
    refreshClis: '重新扫描',
    clisFound: (count: number) => `已发现 ${count} 个 AI CLI`,
    partialScanErrors: (count: number) => `${count} 项未通过验证`,
    installation: '安装位置',
    launching: '启动中…',
    p2Placeholder: 'CLI 与运行环境选项将在 P3 接入'
  },
  workspaceReader: {
    show: '显示代码阅读器',
    hide: '收起代码阅读器',
    back: '返回终端',
    refresh: '刷新工作区',
    resizeReader: '调整代码阅读器宽度',
    resizeTree: '调整文件树宽度',
    loading: '正在读取…',
    empty: '工作区为空',
    selectFile: '从文件树选择一个文本文件',
    selectFileShort: '选择文件以阅读',
    unreadable: '无法显示这个文件',
    directoryError: '无法读取工作区',
    openError: '无法展开目录',
    markdownPreview: 'Markdown 预览',
    markdownSource: '查看 Markdown 源码',
    code: '代码'
  },
  shell: {
    homeLabel: 'home · app shell',
    homeTitle: 'Welcome back.',
    homeHint: '首页内容将在 P3 接入；三态导航与终端路由已可用。',
    settingsHint: 'P2 先开放导航模式；完整设置项将在 P3 接入。',
    unavailableTerminal: '这个演示会话没有可打开的终端。'
  }
}

export type AppStrings = typeof zhCN
