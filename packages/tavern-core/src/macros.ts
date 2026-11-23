/**
 * SillyTavern 精髓宏替换引擎
 * 支持常用核心宏：
 * {{char}}, {{user}}, {{persona}}, {{scenario}}, {{group}},
 * {{time}}, {{date}}, {{weekday}}, {{random::a::b}}, {{roll:1d20}},
 * {{lastMessage}}, {{lastUserMessage}}, {{lastCharMessage}}
 */

export type MacroContext = {
  charName: string
  userName: string
  persona?: string
  scenario?: string
  groupNames?: string[]
  lastMessage?: string
  lastUserMessage?: string
  lastCharMessage?: string
  now?: Date
  rng?: () => number
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function rollDice(expr: string, rng: () => number): string {
  const match = expr.trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i)
  if (!match) {
    return ''
  }
  const count = Math.min(100, Math.max(1, Number(match[1] || '1')))
  const sides = Math.min(10000, Math.max(1, Number(match[2])))
  const bonus = match[3] ? Number(match[3]) : 0
  let total = bonus
  for (let i = 0; i < count; i++) {
    total += Math.floor(rng() * sides) + 1
  }
  return String(total)
}

export function substituteMacros(input: string, ctx: MacroContext): string {
  if (!input || !input.includes('{{')) {
    return input
  }
  const now = ctx.now ?? new Date()
  const rng = ctx.rng ?? Math.random
  const groupText =
    ctx.groupNames && ctx.groupNames.length > 0 ? ctx.groupNames.join(', ') : ctx.charName

  return input
    .replace(/\{\{random::([^}]+)\}\}/gi, (_match, rawOptions: string) => {
      const options = rawOptions.split('::').filter((s) => s.length > 0)
      if (options.length === 0) return ''
      return options[Math.floor(rng() * options.length)] ?? ''
    })
    .replace(/\{\{roll[:\s]+([^}]+)\}\}/gi, (_match, expr: string) => rollDice(expr, rng))
    .replace(/\{\{char\}\}/gi, ctx.charName)
    .replace(/\{\{user\}\}/gi, ctx.userName)
    .replace(/\{\{persona\}\}/gi, ctx.persona ?? '')
    .replace(/\{\{scenario\}\}/gi, ctx.scenario ?? '')
    .replace(/\{\{group\}\}/gi, groupText)
    .replace(/\{\{time\}\}/gi, formatTime(now))
    .replace(/\{\{date\}\}/gi, formatDate(now))
    .replace(/\{\{weekday\}\}/gi, WEEKDAYS[now.getDay()] ?? '')
    .replace(/\{\{lastMessage\}\}/gi, ctx.lastMessage ?? '')
    .replace(/\{\{lastUserMessage\}\}/gi, ctx.lastUserMessage ?? '')
    .replace(/\{\{lastCharMessage\}\}/gi, ctx.lastCharMessage ?? '')
    .replace(/\{\{trim\}\}/gi, '')
}
