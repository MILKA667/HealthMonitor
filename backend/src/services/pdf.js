/** PDF export of a patient report (KAN-32). Roboto is embedded so Cyrillic renders correctly. */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PdfPrinter = require('pdfmake')
const vfs = require('pdfmake/build/vfs_fonts.js')

const font = (name) => Buffer.from(vfs[name], 'base64')
const printer = new PdfPrinter({
  Roboto: { normal: font('Roboto-Regular.ttf'), bold: font('Roboto-Medium.ttf'), italics: font('Roboto-Italic.ttf'), bolditalics: font('Roboto-MediumItalic.ttf') },
})

const CONDITION_LABELS = { diabetes_t2: 'Сахарный диабет 2 типа', hypertension: 'Артериальная гипертония', asthma: 'Бронхиальная астма' }
const SEVERITY_LABELS = { critical: 'Критический', warning: 'Отклонение' }
const STATUS_LABELS = { open: 'Открыт', acknowledged: 'Принят', resolved: 'Закрыт' }

const d = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })
const day = (iso) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })
const n = (v) => (v === null || v === undefined ? '—' : String(v).replace('.', ','))

/** Small line chart as SVG (pdfmake renders SVG nodes natively). */
function chartSvg(points, { width = 500, height = 120, bands = [] } = {}) {
  if (points.length < 2) return null
  const xs = points.map((p) => p.t)
  const ys = points.map((p) => p.v).concat(bands.filter((b) => b != null))
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(...ys) * 0.95, Math.max(...ys) * 1.05]
  const sx = (t) => 30 + ((t - x0) / (x1 - x0 || 1)) * (width - 40)
  const sy = (v) => height - 15 - ((v - y0) / (y1 - y0 || 1)) * (height - 25)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ')
  const lines = bands
    .filter((b) => b != null && b >= y0 && b <= y1)
    .map((b) => `<line x1="30" x2="${width - 10}" y1="${sy(b).toFixed(1)}" y2="${sy(b).toFixed(1)}" stroke="#d9534f" stroke-dasharray="4 3" stroke-width="0.8"/><text x="0" y="${(sy(b) + 3).toFixed(1)}" font-size="7" fill="#d9534f">${n(b)}</text>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect x="30" y="5" width="${width - 40}" height="${height - 20}" fill="#f7f8fc" stroke="#ccd" stroke-width="0.5"/>
    ${lines}
    <path d="${path}" fill="none" stroke="#3056d3" stroke-width="1.5"/>
    <text x="30" y="${height - 3}" font-size="7" fill="#666">${day(new Date(x0).toISOString())}</text>
    <text x="${width - 60}" y="${height - 3}" font-size="7" fill="#666">${day(new Date(x1).toISOString())}</text>
  </svg>`
}

export function buildPatientReportDoc(report, measurements) {
  const metricRows = Object.entries(report.metrics).map(([metric, s]) => [
    report.metricInfo[metric]?.label ?? metric,
    report.metricInfo[metric]?.unit ?? '',
    String(s.count),
    n(s.min),
    n(s.avg),
    n(s.max),
    `${s.inRangePct}%`,
  ])
  const charts = []
  for (const metric of ['glucose', 'systolic', 'diastolic', 'peak_flow']) {
    const pts = measurements
      .filter((m) => typeof m.value[metric] === 'number')
      .map((m) => ({ t: new Date(m.measuredAt).getTime(), v: m.value[metric] }))
      .sort((a, b) => a.t - b.t)
    const th = report.thresholds[metric]
    const svg = chartSvg(pts, { bands: th ? [th.warnLow, th.warnHigh] : [] })
    if (svg) charts.push({ text: `${report.metricInfo[metric].label}, ${report.metricInfo[metric].unit}`, style: 'h3' }, { svg, width: 500, margin: [0, 2, 0, 8] })
  }
  const alertRows = report.alerts.items.slice(-40).map((a) => [d(a.createdAt), SEVERITY_LABELS[a.severity], a.message, STATUS_LABELS[a.status], a.reactionMinutes === null ? '—' : `${n(a.reactionMinutes)} мин`])
  return {
    pageSize: 'A4',
    pageMargins: [40, 50, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 9 },
    info: { title: `Отчёт HealthMonitor — ${report.patient.fullName}`, creator: 'HealthMonitor' },
    footer: (page, pages) => ({ text: `HealthMonitor · сформировано ${d(report.generatedAt)} · стр. ${page} из ${pages}`, alignment: 'center', fontSize: 7, color: '#888', margin: [0, 20, 0, 0] }),
    content: [
      { text: 'Отчёт о динамике показателей', style: 'h1' },
      { text: report.patient.fullName, style: 'h2' },
      {
        columns: [
          { text: [{ text: 'Период: ', bold: true }, `${day(report.period.from)} — ${day(report.period.to)} (${report.period.days} дн.)`] },
          { text: [{ text: 'Лечащий врач: ', bold: true }, report.patient.doctorName ?? '—'] },
        ],
        margin: [0, 0, 0, 4],
      },
      { text: [{ text: 'Нозологии: ', bold: true }, report.patient.conditions.map((c) => CONDITION_LABELS[c] ?? c).join(', ') || '—'], margin: [0, 0, 0, 4] },
      {
        text: [
          { text: 'Измерений: ', bold: true }, `${report.measurementsCount} (вручную ${report.bySource.manual}, с устройств ${report.bySource.device}); `,
          { text: 'дней с измерениями: ', bold: true }, `${report.daysWithMeasurements} из ${report.period.days} (${report.adherencePct}%)`,
        ],
        margin: [0, 0, 0, 10],
      },
      { text: 'Сводка по показателям', style: 'h3' },
      metricRows.length
        ? { table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'], body: [['Показатель', 'Ед.', 'Кол-во', 'Мин', 'Сред', 'Макс', 'В пределах'], ...metricRows] }, layout: 'lightHorizontalLines', margin: [0, 0, 0, 10] }
        : { text: 'За период нет измерений', italics: true, margin: [0, 0, 0, 10] },
      ...charts,
      { text: `Алерты за период: ${report.alerts.total} (критических ${report.alerts.critical}, отклонений ${report.alerts.warning})`, style: 'h3' },
      alertRows.length
        ? { table: { headerRows: 1, widths: ['auto', 'auto', '*', 'auto', 'auto'], body: [['Время', 'Уровень', 'Описание', 'Статус', 'Реакция'], ...alertRows] }, layout: 'lightHorizontalLines' }
        : { text: 'Алертов не было', italics: true },
      { text: 'Отчёт содержит сведения о состоянии здоровья (специальная категория ПДн, 152-ФЗ). Документ носит информационный характер и не является медицинским заключением; клиническое решение принимает лечащий врач.', fontSize: 7, color: '#777', margin: [0, 16, 0, 0] },
    ],
    styles: {
      h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] },
      h2: { fontSize: 12, margin: [0, 0, 0, 8] },
      h3: { fontSize: 10, bold: true, margin: [0, 6, 0, 4] },
    },
  }
}

export function renderPdf(docDefinition) {
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDefinition)
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.end()
  })
}
