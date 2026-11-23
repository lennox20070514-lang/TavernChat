import { spawn } from 'node:child_process'

const children = [
  spawn('corepack', ['pnpm', '--filter', '@tavern-chat/server', 'dev'], {
    stdio: 'inherit',
    shell: true,
  }),
  spawn('corepack', ['pnpm', '--filter', '@tavern-chat/web', 'dev'], {
    stdio: 'inherit',
    shell: true,
  }),
]

const shutdown = () => {
  for (const child of children) {
    child.kill()
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
