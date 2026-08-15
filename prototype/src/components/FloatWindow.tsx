import { useState } from 'react'
import { motion } from 'motion/react'
import { ChevronDown, X } from 'lucide-react'
import { statusDot, statusTone, type SessionItem } from '@/types'

/** 收起态只保留最近有事件的前 3 个活跃会话 */
const COLLAPSED_COUNT = 3

/**
 * 独立置顶小窗(always-on-top)的原型 mock:
 * 实现时是第二个 BrowserWindow,主窗最小化仍可见;此处以 fixed 悬浮模拟。
 * 紧凑模式:默认只显示前 3 个活跃会话(按最新事件排序,真实现按 lastEventAt
 * 降序,mock 数组已排好),可展开查看全部活跃会话。
 * v1 只看不操作:点击条目唤起主窗并聚焦对应终端,不提供批准/回答入口。
 */
export default function FloatWindow({
  sessions,
  onClose,
}: {
  sessions: readonly SessionItem[]
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  const active = sessions.filter((s) => s.status !== 'exited')
  const needYou = active.filter(
    (s) => s.status === 'needs-you' || s.status === 'error',
  ).length
  const visible = expanded ? active : active.slice(0, COLLAPSED_COUNT)
  const hasMore = active.length > COLLAPSED_COUNT

  return (
    <motion.aside
      layout
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 14, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.9 }}
      className="fixed right-5 bottom-5 z-[95] w-[248px] overflow-hidden rounded-xl border border-black/10 bg-white/90 shadow-2xl shadow-black/25 backdrop-blur-xl"
    >
      <motion.header
        layout="position"
        title="置顶小窗:按住此处拖动(原型仅演示)"
        className="flex cursor-grab items-center gap-2 px-2.5 pt-2 pb-1 select-none active:cursor-grabbing"
      >
        <span className="font-ammonite text-[13px] leading-none text-neutral-600">
          hrack
        </span>
        {needYou > 0 && (
          <span className="font-maple text-[9px] text-pending">
            {needYou} need you
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭悬浮窗"
          className="cursor-target ml-auto flex size-5 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-200/70 hover:text-neutral-700"
        >
          <X className="size-3" strokeWidth={1.75} />
        </button>
      </motion.header>

      <motion.ul
        layout="position"
        className={[
          'px-1 pb-1',
          expanded ? 'sidebar-scroll max-h-[264px] overflow-y-auto' : '',
        ].join(' ')}
      >
        {/* 收起时多余行立即卸载(无退场动画),高度回落交给 aside 的 layout
            弹簧;若保留逐条淡出,退场期间列表失去 max-h 约束会先撑大窗体 */}
        {visible.map(({ id, cli, Icon, time, status, message }) => (
          <motion.li
            key={id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
            <button
              type="button"
              title={`${cli} · 点击唤起主窗并聚焦对应终端`}
              className="cursor-target flex w-full items-center gap-1.5 rounded-lg px-1.5 py-[5px] text-left font-pingfang transition-colors hover:bg-neutral-100/80"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${statusDot[status]}`}
              />
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                <Icon size={12} className="size-3" />
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[11px] leading-snug font-medium ${statusTone[status]}`}
              >
                {message}
              </span>
              <span className="shrink-0 font-maple text-[9px] text-neutral-400">
                {time}
              </span>
            </button>
          </motion.li>
        ))}
        {active.length === 0 && (
          <li className="px-2 py-1.5 font-pingfang text-[10px] text-neutral-400">
            暂无活跃会话
          </li>
        )}
      </motion.ul>

      {hasMore && (
        <motion.button
          layout="position"
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="cursor-target flex w-full items-center justify-center gap-1 border-t border-black/5 py-1.5 font-pingfang text-[10px] text-neutral-400 transition-colors hover:bg-neutral-100/60 hover:text-neutral-700"
        >
          <ChevronDown
            className={[
              'size-3 transition-transform duration-200',
              expanded ? 'rotate-180' : '',
            ].join(' ')}
            strokeWidth={1.75}
          />
          {expanded ? '收起' : `展开全部 ${active.length} 个活跃会话`}
        </motion.button>
      )}
    </motion.aside>
  )
}
