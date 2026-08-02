import { useEffect, useRef } from 'react'
import type { WindowPositionPayload } from '../../shared/ipc-contract'

/**
 * 窗口镶边环境渐变（Codex 风格）：把一张"显示器大小"的虚拟渐变画布锚定在
 * 屏幕上，本层显示窗口当前位置对应的切片（偏移 = 窗口位置 + 元素在窗口内
 * 的位置）。挂在 app-shell 根节点、以负 z 垫在所有内容之下：标题栏/侧栏/
 * 内容区圆角缺口共享同一张画布，天然连续；内容面板用自己的不透明底色盖住。
 * 窗口移动时主进程推送新坐标；颜色来自主题 token sidebar.tint.a/b。
 */
export default function SidebarTint() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const api = window.windowApi
    if (!ref.current || !api?.getPosition || !api.onPositionChange) return
    let disposed = false
    const apply = (position: WindowPositionPayload): void => {
      const el = ref.current
      if (disposed || !el) return
      const rect = el.getBoundingClientRect()
      const canvasWidth = Math.max(position.screenWidth, 1)
      const canvasHeight = Math.max(position.screenHeight, 1)
      // 窗口可能略微超出显示器边缘，把切片钳制在画布内
      const offsetX = Math.min(Math.max(position.x + rect.left, 0), canvasWidth)
      const offsetY = Math.min(Math.max(position.y + rect.top, 0), canvasHeight)
      el.style.backgroundSize = `${canvasWidth}px ${canvasHeight}px`
      el.style.backgroundPosition = `${-offsetX}px ${-offsetY}px`
      el.style.opacity = '1'
    }
    void api.getPosition().then(apply)
    const unsubscribe = api.onPositionChange(apply)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return (
    <div
      ref={ref}
      aria-hidden
      data-testid="sidebar-tint"
      className="pointer-events-none absolute inset-0"
      style={{
        zIndex: -1,
        backgroundImage:
          'radial-gradient(85% 70% at 12% 6%, var(--vib-sidebar-tint-a), transparent 72%), radial-gradient(95% 85% at 88% 94%, var(--vib-sidebar-tint-b), transparent 72%)',
        backgroundRepeat: 'no-repeat',
        // 首个位置包到达前保持隐形，避免错位闪一下
        opacity: 0,
        transition: 'background-position 160ms ease-out'
      }}
    />
  )
}
