import { createServer } from 'node:http'
import { createGatewayHandler } from './gateway.ts'

const port = Number(process.env.PORT ?? 8797)
const host = process.env.HOST ?? '127.0.0.1'

const server = createServer(createGatewayHandler('standalone'))

server.listen(port, host, () => {
  console.log(`[TavernChat Gateway] running on http://${host}:${port}`)
})
