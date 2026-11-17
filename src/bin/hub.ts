#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { startHubServer } from '../hub/standalone.ts'

const [configFile, certFile, keyFile, portValue = '48443', host = '0.0.0.0'] = process.argv.slice(2)
const port = Number(portValue)
if (!configFile || !certFile || !keyFile || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('usage: marshal-hub <hub.json> <server-cert.pem> <server-key.pem> [port] [host]')
  process.exit(1)
}
try {
  const hub = await startHubServer({
    config: JSON.parse(readFileSync(configFile, 'utf8')),
    cert: readFileSync(certFile), key: readFileSync(keyFile), port, host,
  })
  const stop = (): void => { void hub.close().then(() => process.exit(0), () => process.exit(1)) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  // Configuration values and credentials must not enter service logs.
  console.error('marshal: Hub startup failed (' + (error instanceof Error ? error.name : 'unknown') + ')')
  process.exitCode = 1
}
