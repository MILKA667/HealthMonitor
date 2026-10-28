/**
 * Device simulator: sends readings the way a vendor bridge/webhook would (KAN-34, KAN-35).
 *
 *   node scripts/simulate-devices.js --adapter glucometer-v1 --serial GL100-PILOT-01 --key hmd_... [--url http://localhost:4000] [--critical]
 */
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    adapter: { type: 'string' },
    serial: { type: 'string' },
    key: { type: 'string' },
    url: { type: 'string', default: process.env.HM_API_URL || 'http://localhost:4000' },
    count: { type: 'string', default: '3' },
    critical: { type: 'boolean', default: false },
  },
})
if (!values.adapter || !values.serial || !values.key) {
  console.error('usage: simulate-devices.js --adapter <glucometer-v1|tonometer-v1> --serial <serial> --key <device key> [--url] [--count] [--critical]')
  process.exit(1)
}

const n = Number(values.count)
const now = Date.now()
const at = (i) => new Date(now - (n - i) * 15 * 60_000).toISOString()
let body
if (values.adapter === 'glucometer-v1') {
  body = { serial: values.serial, readings: Array.from({ length: n }, (_, i) => ({ timestamp: at(i), glucose: values.critical && i === n - 1 ? 310 : 100 + Math.round(Math.random() * 60), unit: 'mg/dL', mealFlag: i === 0 ? 'F' : 'A' })) }
} else if (values.adapter === 'tonometer-v1') {
  body = { deviceSerial: values.serial, measurements: Array.from({ length: n }, (_, i) => (values.critical && i === n - 1 ? { dateTime: at(i), sys: 195, dia: 118, pulse: 98 } : { dateTime: at(i), sys: 120 + Math.round(Math.random() * 20), dia: 75 + Math.round(Math.random() * 10), pulse: 60 + Math.round(Math.random() * 20) })) }
} else {
  console.error('unsupported adapter for the simulator')
  process.exit(1)
}

const res = await fetch(`${values.url}/api/integrations/${values.adapter}/readings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': values.key }, body: JSON.stringify(body) })
console.log(res.status, JSON.stringify(await res.json(), null, 2))
process.exit(res.ok ? 0 : 1)
