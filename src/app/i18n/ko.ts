import type { AppStrings } from './zh-CN'

/** 한국어. 프로토타입 영어 마이크로 라벨은 영어 유지(zh-CN 기준과 동일). */
export const ko = {
  titlebar: {
    newSession: '새로 만들기',
    settings: '설정',
    minimize: '최소화',
    maximize: '최대화',
    restore: '복원',
    close: '닫기'
  },
  common: {
    close: '닫기',
    view: '보기',
    cancel: '취소',
    confirm: '확인',
    justNow: '방금',
    minutesAgo: (minutes: number) => `${minutes}분 전`,
    hoursAgo: (hours: number) => `${hours}시간 전`,
    daysAgo: (days: number) => `${days}일 전`
  },
  navigation: {
    home: 'Home',
    newSession: 'New Session',
    sessions: 'Session',
    terminals: 'Terminal',
    settings: '설정',
    emptySessions: '세션 없음',
    emptyTerminals: '터미널 없음',
    expandSidebar: '사이드바 펼치기',
    collapseSidebar: '사이드바 접기',
    closeTerminal: '터미널 닫기',
    closeSession: '세션 닫기',
    closeSessionPrompt: (name: string) =>
      `“${name}” 세션을 닫을까요? CLI 프로세스와 하위 터미널도 함께 종료됩니다.`,
    sessionActions: '세션 작업',
    createChildTerminal: '하위 터미널 만들기',
    cloneSession: '세션 복제',
    childTerminals: '하위 터미널 펼치기 또는 접기',
    renameSession: '이름 바꾸기',
    sessionNameRequired: '세션 이름을 입력하세요'
  },
  sessionStatus: {
    working: '작업 처리 중',
    needsYou: '확인이 필요합니다',
    done: '이번 작업을 완료했습니다',
    error: '실행 중 문제가 발생했습니다',
    idle: '다음 지시를 기다리고 있습니다',
    exited: '세션이 종료되었습니다',
    exitedDetail: (exitCode: number | undefined) =>
      exitCode === undefined
        ? '세션이 종료되었습니다'
        : `세션이 종료되었습니다 · exit code ${exitCode}`
  },
  floating: {
    empty: '활성 세션 없음',
    attention: '확인 필요',
    expand: (count: number) => `세션 ${count}개 모두 보기`,
    collapse: '접기'
  },
  agentDetail: {
    thinking: '작업을 분석하고 다음 단계를 계획하고 있습니다',
    responding: '답변을 정리하고 있어요',
    liveThinking: (seconds: number | undefined, tokens: number | undefined) =>
      ['생각 중', seconds === undefined ? undefined : `${seconds}초`, tokens === undefined ? undefined : `${tokens.toLocaleString('ko-KR')} tokens`].filter(Boolean).join(' · '),
    waitingApproval: (summary: string | undefined) =>
      ['확인이 필요합니다', summary].filter(Boolean).join(' · '),
    waitingInput: (prompt: string | undefined) =>
      ['입력을 기다리고 있습니다', prompt].filter(Boolean).join(' · '),
    runningTool: (name: string | undefined) =>
      name ? `${name} 실행 중` : '도구 실행 중',
    completed: (tokens: number | undefined) =>
      ['이번 작업을 완료했습니다', tokens === undefined ? undefined : `${tokens.toLocaleString('ko-KR')} tokens`].filter(Boolean).join(' · '),
    error: (message: string | undefined) =>
      ['실행 중 문제가 발생했습니다', message].filter(Boolean).join(' · '),
    observerDegraded: (reason: string | undefined) =>
      ['모니터링이 제한됨', reason].filter(Boolean).join(' · '),
    exited: (exitCode: number | undefined) =>
      exitCode === undefined
        ? '세션이 종료되었습니다'
        : `세션이 종료되었습니다 · exit code ${exitCode}`
  },
  terminal: {
    copied: '복사됨',
    newTab: '새 탭',
    closeTab: '탭 닫기',
    exited: '종료됨'
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
    terminal: '터미널',
    freshLabel: 'home · getting started',
    freshTitle: 'Welcome. Pick a CLI and go.',
    freshHint: '아직 세션이 없습니다. 진입점을 고르면 AI CLI 상태가 여기에 모입니다.',
    freshCollect: '실행 후 여기에 모입니다',
    historyStats: '· 기록 이벤트와 전체 통계',
    deskLabel: 'home · session desk',
    waitingApproval: (count: number) => `${count} waiting approval`,
    errors: (count: number) => `${count} errors`,
    live: (count: number) => `${count} live`,
    defaultTerminal: (name: string) => `기본: ${name}`,
    terminalOptions: '터미널 옵션',
    previousLaunchPage: '이전 페이지',
    nextLaunchPage: '다음 페이지',
    attention: '주의 우선',
    allStatuses: '전체',
    emptyAttention: '현재 필터와 일치하는 세션이 없습니다',
    showMore: '더 보기',
    showLess: '접기 ↑',
    showAll: (count: number) => `전체 ${count}개 보기 ↓`,
    recentHistory: '기록 이벤트',
    allTime: '개요',
    emptyHistory: '기록 이벤트가 없습니다',
    stats: {
      sessions: '시작한 세션',
      tools: '도구 호출',
      alerts: '차단 알림',
      approvals: '처리한 승인'
    }
  },
  settings: {
    title: '설정',
    sections: {
      appearance: '외관',
      layout: '레이아웃',
      terminal: '터미널',
      session: '세션'
    },
    uiTheme: 'UI 테마',
    uiThemeHint: '앱 인터페이스에만 영향. 터미널 색상과 독립',
    light: '라이트',
    dark: '다크',
    language: '표시 언어',
    languageHint: '전환 즉시 적용됩니다',
    languages: {
      'zh-CN': '简体中文',
      'zh-TW': '繁體中文',
      en: 'English',
      ja: '日本語',
      ko: '한국어'
    },
    navigationMode: '내비게이션 모드',
    navigationModeHint: '세 상태 중 하나. 상단 탭 모드는 사이드바 없음',
    sidebar: '사이드바 펼침',
    rail: '사이드바 접힘',
    tabs: '상단 탭 바',
    floatingWindow: '플로팅 창',
    floatingWindowHint: '현재 AI CLI 세션 상태를 항상 위에 표시',
    globalShortcut: '전역 단축키',
    globalShortcutHint: 'Ctrl+Alt+V로 창 표시/숨기기 전환',
    attentionPriority: '주의 우선 정렬',
    attentionPriorityHint: '새 활동이 있는 세션을 탐색 목록 맨 위로 이동합니다',
    terminalTheme: '터미널 색상',
    terminalThemeHint: '16색 구성. UI 테마와 독립',
    terminalThemeNames: { dark: 'Dark', light: 'Light' },
    font: '글꼴',
    fontHint: '번들 Maple Mono, 중국어 폴백은 플랫폼별',
    fontPlaceholder: '글꼴 패밀리, 예: "Maple Mono"',
    restoreDefaultFont: '기본값 복원',
    fontSize: '글꼴 크기',
    decreaseFontSize: '글꼴 크기 줄이기',
    increaseFontSize: '글꼴 크기 키우기',
    ligatures: '합자',
    ligaturesHint: '=> !== 같은 연산자를 결합 렌더링',
    terminalRounded: '모서리 둥글게',
    terminalRoundedHint: '콘텐츠 영역을 둥글게 하고 양쪽 여백 추가. 끄면 가장자리 밀착',
    defaultTerminal: '기본 터미널',
    defaultTerminalHint: 'quick launch의 터미널 칩이 이것으로 시작',
    cliDiscovery: 'AI CLI 검색',
    preferences: 'settings · preferences',
    description: '레이아웃과 컨트롤은 확정된 프로토타입을 따르며 설정은 settingsStore에 직접 기록됩니다.',
    mapleMono: 'Maple Mono',
    pixels: (value: number) => `${value}px`,
    themeErrors: '사용자 테마 로드 실패'
  },
  newSession: {
    title: 'New Session',
    terminal: '터미널',
    quickTerminalHint: '시스템 기본값으로 시작',
    chooseTerminal: '터미널 선택',
    chooseTerminalHint: '항목을 클릭하면 시작됩니다',
    configureCli: 'CLI 세션 구성',
    chooseCli: 'AI CLI를 선택해 시작',
    newCli: (name: string) => `새 ${name}`,
    configureThenLaunch: '구성 후 시작',
    sessionName: '이름',
    sessionNamePlaceholder: '세션 이름',
    workspace: '작업 공간',
    chooseWorkspace: '폴더 선택',
    arguments: '시작 인수',
    runtime: '런타임',
    windows: 'Windows',
    windowsHint: '이 Windows 환경',
    wsl: 'WSL',
    wslHint: 'WSL로 시작',
    rememberDefault: '다음에도 이 방식 기본 사용',
    launch: '시작',
    defaultBadge: '기본',
    terminalFallback: '시스템 기본 터미널',
    workspacePlaceholder: '작업 공간 선택',
    argumentsPlaceholder: '--flag value',
    scanningClis: 'Windows 및 WSL 검색 중…',
    noClisFound: '실행 가능한 AI CLI를 찾지 못했습니다',
    refreshClis: '다시 검색',
    clisFound: (count: number) => `AI CLI ${count}개 발견`,
    partialScanErrors: (count: number) => `검증 실패 ${count}건`,
    installation: '설치 위치',
    launching: '실행 중…',
    p2Placeholder: 'CLI 및 실행 환경 옵션은 P3에서 추가'
  },
  workspaceReader: {
    show: '코드 리더 표시',
    hide: '코드 리더 닫기',
    back: '터미널로 돌아가기',
    refresh: '작업 공간 새로 고침',
    resizeReader: '코드 리더 너비 조절',
    resizeTree: '파일 트리 너비 조절',
    loading: '불러오는 중…',
    empty: '작업 공간이 비어 있습니다',
    selectFile: '파일 트리에서 텍스트 파일을 선택하세요',
    selectFileShort: '읽을 파일을 선택하세요',
    unreadable: '이 파일을 표시할 수 없습니다',
    directoryError: '작업 공간을 읽을 수 없습니다',
    openError: '디렉터리를 열 수 없습니다',
    markdownPreview: 'Markdown 미리보기',
    markdownSource: 'Markdown 소스 보기',
    code: '코드'
  },
  shell: {
    homeLabel: 'home · app shell',
    homeTitle: 'Welcome back.',
    homeHint: '홈 콘텐츠는 P3에서 추가. 세 상태 내비게이션과 터미널 라우팅은 사용 가능.',
    settingsHint: 'P2에서는 내비게이션 모드만 제공. 전체 설정은 P3에서 추가.',
    unavailableTerminal: '이 데모 세션에는 열 수 있는 터미널이 없습니다.'
  }
} satisfies AppStrings
