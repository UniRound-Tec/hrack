(() => {
  const api = window.hrackFloating
  const buddy = document.querySelector('#buddy')
  const mascot = document.querySelector('#mascot')
  const headline = document.querySelector('#headline')
  const summary = document.querySelector('#summary')
  const moodLabel = document.querySelector('#mood-label')
  const badge = document.querySelector('#attention-badge')
  const list = document.querySelector('#session-list')
  const expandButton = document.querySelector('#expand')
  const closeButton = document.querySelector('#close')
  const focusPrimary = document.querySelector('#focus-primary')
  const shapeCanvas = document.querySelector('#shape-canvas')

  const dictionaries = {
    'zh-CN': {
      headlines: {
        idle: '我在这儿等你',
        working: '我正帮你盯着呢',
        'needs-you': '轮到你做决定啦',
        done: '搞定啦！',
        error: '这里需要看一下'
      },
      empty: '启动一个 AI CLI，我会替你盯住它。',
      sessions: (count) => `${count} 个会话`,
      more: (count) => `+${count}`,
      collapse: '收起',
      open: '去看看',
      close: '关闭悬浮窗'
    },
    'zh-TW': {
      headlines: {
        idle: '我在這裡等你',
        working: '我正幫你盯著呢',
        'needs-you': '輪到你做決定啦',
        done: '完成啦！',
        error: '這裡需要看一下'
      },
      empty: '啟動一個 AI CLI，我會替你盯著它。',
      sessions: (count) => `${count} 個工作階段`,
      more: (count) => `+${count}`,
      collapse: '收合',
      open: '去看看',
      close: '關閉浮動視窗'
    },
    en: {
      headlines: {
        idle: 'I’m ready when you are',
        working: 'I’m keeping an eye on it',
        'needs-you': 'Your decision is needed',
        done: 'All done!',
        error: 'This needs a closer look'
      },
      empty: 'Start an AI CLI and I’ll keep watch.',
      sessions: (count) => `${count} session${count === 1 ? '' : 's'}`,
      more: (count) => `+${count}`,
      collapse: 'Less',
      open: 'Open',
      close: 'Close floating window'
    },
    ja: {
      headlines: {
        idle: 'ここで待っています',
        working: 'しっかり見守っています',
        'needs-you': 'あなたの判断が必要です',
        done: '完了しました！',
        error: '確認が必要です'
      },
      empty: 'AI CLI を起動したら、代わりに見守ります。',
      sessions: (count) => `${count} 件のセッション`,
      more: (count) => `+${count}`,
      collapse: '閉じる',
      open: '開く',
      close: 'フローティングウィンドウを閉じる'
    },
    ko: {
      headlines: {
        idle: '여기서 기다리고 있어요',
        working: '제가 지켜보고 있어요',
        'needs-you': '결정이 필요해요',
        done: '완료했어요!',
        error: '확인이 필요해요'
      },
      empty: 'AI CLI를 시작하면 제가 지켜볼게요.',
      sessions: (count) => `${count}개 세션`,
      more: (count) => `+${count}`,
      collapse: '접기',
      open: '열기',
      close: '플로팅 창 닫기'
    }
  }

  const statePriority = {
    'needs-you': 5,
    error: 4,
    working: 3,
    done: 2,
    idle: 1,
    exited: 0
  }
  const collapsedCount = 3
  let currentSnapshot = null
  let currentPrimary = null
  let expanded = false
  let initialized = false
  let seenAttentionSequence = 0
  let burstTimer = 0
  let shapeFrame = 0

  function dictionary(locale) {
    if (Object.hasOwn(dictionaries, locale)) return dictionaries[locale]
    if (locale.startsWith('zh')) return dictionaries['zh-CN']
    return dictionaries.en
  }

  function applyAppearance(appearance) {
    const root = document.documentElement
    root.lang = appearance.locale
    root.dataset.theme = appearance.themeType
    const colors = appearance.colors || {}
    const set = (name, token) => {
      const value = colors[token]
      if (typeof value === 'string') root.style.setProperty(name, value)
    }
    set('--host-text', 'text.primary')
    set('--host-muted', 'text.muted')
    set('--host-faint', 'text.faint')
  }

  function dominantSession(sessions) {
    return [...sessions].sort((left, right) =>
      (statePriority[right.status] || 0) - (statePriority[left.status] || 0) ||
      right.lastActivityAt - left.lastActivityAt
    )[0]
  }

  function pushBlock(rects, element, padding = 6) {
    if (element.hidden || getComputedStyle(element).display === 'none') return
    const rect = element.getBoundingClientRect()
    rects.push({
      x: Math.max(0, Math.floor(rect.left - padding)),
      y: Math.max(0, Math.floor(rect.top - padding)),
      width: Math.ceil(rect.width + padding * 2),
      height: Math.ceil(rect.height + padding * 2)
    })
  }

  function mascotShape(rects) {
    if (!mascot.complete || mascot.naturalWidth === 0) return
    const rect = mascot.getBoundingClientRect()
    const step = 2
    const width = Math.max(1, Math.ceil(rect.width / step))
    const height = Math.max(1, Math.ceil(rect.height / step))
    shapeCanvas.width = width
    shapeCanvas.height = height
    const context = shapeCanvas.getContext('2d', { willReadFrequently: true })
    if (!context) return
    context.clearRect(0, 0, width, height)
    context.drawImage(mascot, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height).data

    for (let y = 0; y < height; y++) {
      let runStart = -1
      for (let x = 0; x <= width; x++) {
        const alpha = x < width ? pixels[(y * width + x) * 4 + 3] : 0
        if (alpha > 22 && runStart < 0) runStart = x
        if ((alpha <= 22 || x === width) && runStart >= 0) {
          // Keep a small halo so the breathing/waving animations never clip.
          const left = Math.max(0, Math.floor(rect.left + runStart * step - 10))
          const right = Math.ceil(rect.left + x * step + 10)
          rects.push({
            x: left,
            y: Math.max(0, Math.floor(rect.top + y * step - 12)),
            width: Math.max(1, right - left),
            height: step + 24
          })
          runStart = -1
        }
      }
    }
  }

  function updateNativeShape() {
    if (!api || typeof api.setShape !== 'function') return
    const rects = []
    mascotShape(rects)
    document.querySelectorAll('.shape-block').forEach((element) =>
      pushBlock(rects, element)
    )
    api.setShape(rects).catch(() => {})
  }

  function scheduleShape() {
    window.cancelAnimationFrame(shapeFrame)
    shapeFrame = window.requestAnimationFrame(updateNativeShape)
  }

  function restartCompletionBurst() {
    window.clearTimeout(burstTimer)
    buddy.classList.remove('attention-burst')
    void buddy.offsetWidth
    buddy.classList.add('attention-burst')
    scheduleShape()
    burstTimer = window.setTimeout(() => {
      buddy.classList.remove('attention-burst')
      scheduleShape()
    }, 2_000)
  }

  function sessionChip(session) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    const dot = document.createElement('span')
    const copy = document.createElement('span')
    const name = document.createElement('span')
    const detail = document.createElement('span')

    button.type = 'button'
    button.className = 'session-chip shape-block'
    button.dataset.sessionId = session.sessionId
    button.addEventListener('click', () => api.focusSession(session.sessionId))
    dot.className = 'session-status'
    dot.dataset.status = session.status
    copy.className = 'session-copy'
    name.className = 'session-name'
    name.textContent = session.name || session.adapterId
    detail.className = 'session-detail'
    detail.textContent = session.detail || session.status
    copy.append(name, detail)
    button.append(dot, copy)
    item.append(button)
    return item
  }

  function render(snapshot) {
    currentSnapshot = snapshot
    applyAppearance(snapshot.appearance)
    const strings = dictionary(snapshot.appearance.locale)
    const sessions = [...snapshot.sessions].sort(
      (left, right) => right.lastActivityAt - left.lastActivityAt
    )
    const primary = dominantSession(sessions)
    currentPrimary = primary || null
    const mood = primary?.status === 'exited' ? 'idle' : primary?.status || 'idle'
    const attentionCount = sessions.filter(
      (session) => session.status === 'needs-you' || session.status === 'error'
    ).length

    buddy.dataset.mood = mood
    buddy.dataset.effects = snapshot.attentionEffectEnabled ? 'on' : 'off'
    headline.textContent = strings.headlines[mood] || strings.headlines.idle
    moodLabel.textContent = sessions.length ? strings.sessions(sessions.length) : 'HRack'
    summary.textContent = primary
      ? `${primary.name || primary.adapterId} · ${primary.detail || primary.status}`
      : strings.empty
    badge.hidden = attentionCount === 0
    badge.textContent = attentionCount > 9 ? '9+' : String(attentionCount || '!')
    closeButton.ariaLabel = strings.close
    focusPrimary.hidden = !primary
    focusPrimary.textContent = strings.open

    const hiddenCount = Math.max(0, sessions.length - collapsedCount)
    const visibleSessions = expanded ? sessions : sessions.slice(0, collapsedCount)
    list.replaceChildren(...visibleSessions.map(sessionChip))
    expandButton.hidden = hiddenCount === 0
    expandButton.textContent = expanded ? strings.collapse : strings.more(hiddenCount)

    const signal = snapshot.attention
    if (!initialized) {
      seenAttentionSequence = signal?.sequence || 0
      initialized = true
    } else if (signal && signal.sequence > seenAttentionSequence) {
      seenAttentionSequence = signal.sequence
      if (snapshot.attentionEffectEnabled && signal.kind === 'done') {
        restartCompletionBurst()
      }
    }
    if (!snapshot.attentionEffectEnabled) {
      buddy.classList.remove('attention-burst')
      window.clearTimeout(burstTimer)
    }

    Promise.resolve(api.resizeToContent(430)).finally(scheduleShape)
  }

  if (!api) {
    headline.textContent = 'Sunny Buddy'
    summary.textContent = 'This renderer must run inside HRack.'
    return
  }

  expandButton.addEventListener('click', () => {
    expanded = !expanded
    if (currentSnapshot) render(currentSnapshot)
  })
  closeButton.addEventListener('click', () => api.disable())
  focusPrimary.addEventListener('click', () => {
    if (currentPrimary) api.focusSession(currentPrimary.sessionId)
  })

  mascot.addEventListener('load', scheduleShape, { once: true })
  if (mascot.complete) scheduleShape()
  const resizeObserver = new ResizeObserver(scheduleShape)
  resizeObserver.observe(buddy)

  const unsubscribe = api.onSnapshot(render)
  api.getSnapshot().then(render).catch((error) => {
    buddy.dataset.mood = 'error'
    headline.textContent = 'Sunny Buddy'
    summary.textContent = error instanceof Error ? error.message : String(error)
    scheduleShape()
  })
  window.addEventListener('pagehide', () => {
    unsubscribe()
    resizeObserver.disconnect()
    window.cancelAnimationFrame(shapeFrame)
    window.clearTimeout(burstTimer)
  }, { once: true })
})()
