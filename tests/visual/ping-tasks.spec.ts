import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

for (const source of ['metric', 'legacy'] as const) {
  test(`per-task Ping rows keep ${source} values separate`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: source === 'metric' ? 1280 : 390, height: 900 })
    await installKomariFixture(page, { hideEarth: true, dark: source === 'legacy', nodeCardSize: source === 'legacy' ? 'mini' : 'compact' })
    const tasks = [
      { id: 30, name: '福建移动', interval: 60, loss: 0 },
      { id: 10, name: '福建联通', interval: 60, loss: 0 },
      { id: 20, name: '福建电信', interval: 60, loss: 0 },
    ]
    let refreshed = false
    const latency = (id: number) => id === 30 ? (refreshed ? 88 : 166) : 170
    const lost = (id: number, index: number) => id === 20 || (id === 30 && index === 59)
    const time = (index: number) => new Date(Date.parse('2026-07-25T12:00:00Z') - (59 - index) * 60_000).toISOString()
    await page.route('**/rpc2', async (route) => {
      const request = route.request().postDataJSON()
      const uuid = request.params?.entity_id ?? request.params?.uuid ?? '00000000-0000-4000-8000-000000000001'
      let result: unknown
      if (request.method === 'public:getPublicPingTasks') {
        result = tasks
      }
      else if (request.method === 'public:getPingMetricStats') {
        result = { stats: source === 'legacy'
          ? []
          : [...tasks].reverse().map(task => ({
              entity_id: uuid,
              task_id: String(task.id),
              name: task.name,
              tags: { task_id: String(task.id) },
              total: 60,
              valid: task.id === 20 ? 0 : task.id === 30 ? 59 : 60,
              loss: task.id === 20 ? 100 : task.id === 30 ? 100 / 60 : 0,
              loss_approximate: false,
              avg: task.id === 20 ? undefined : latency(task.id),
              latest: task.id === 20 ? -1 : latency(task.id),
            })) }
      }
      else if (request.method === 'public:queryMetrics') {
        result = { series: source === 'legacy'
          ? []
          : [...tasks].reverse().flatMap(task => ['ping.latency_ms', 'ping.loss'].map(metric => ({
              entity_id: uuid,
              metric_key: metric,
              tags: { task_id: String(task.id), task_name: task.name },
              points: Array.from({ length: 60 }, (_, index) => ({
                time: time(index),
                count: 1,
                value: metric === 'ping.loss' ? Number(lost(task.id, index)) : lost(task.id, index) ? null : latency(task.id),
              })),
            }))) }
      }
      else if (request.method === 'public:getPingRecords' || (request.method === 'common:getRecords' && request.params?.type === 'ping')) {
        result = { tasks, records: tasks.flatMap(task => Array.from({ length: 60 }, (_, index) => ({
          client: uuid,
          task_id: task.id,
          time: time(index),
          value: lost(task.id, index) ? -1 : latency(task.id),
        }))) }
      }
      else {
        await route.fallback()
        return
      }
      await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result } })
    })
    await page.clock.install({ time: new Date('2026-07-25T12:00:00Z') })
    await page.goto('/')
    const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
    const rows = card.locator('[data-ping-task-id]')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveAttribute('data-ping-task-id', '30')
    await expect(rows.nth(1)).toHaveAttribute('data-ping-task-id', '10')
    await expect(rows.nth(2)).toHaveAttribute('data-ping-task-id', '20')
    await expect(rows.nth(0).locator('[title="平均延迟"]')).toHaveText('166 ms')
    await expect(rows.nth(0).locator('[title="平均丢包率"]')).toHaveText('1.7%')
    await expect(rows.nth(1).locator('[title="平均延迟"]')).toHaveText('170 ms')
    await expect(rows.nth(1).locator('[title="平均丢包率"]')).toHaveText('0.0%')
    await expect(rows.nth(2).locator('[title="平均延迟"]')).toHaveText('-')
    await expect(rows.nth(2).locator('[title="平均丢包率"]')).toHaveText('100.0%')
    for (const row of await rows.all()) {
      await expect(row.locator('[data-node-ping-bars]')).toHaveCount(2)
      for (const bars of await row.locator('[data-node-ping-bars]').all())
        expect((await bars.boundingBox())?.width).toBeGreaterThan(20)
    }
    // A failed task must have red loss history without contaminating its neighbour.
    await expect(rows.nth(2).locator('[data-node-ping-bars="loss"] .bg-signal-5')).toHaveCount(20)
    await expect(rows.nth(1).locator('[data-node-ping-bars="loss"] .bg-signal-1')).toHaveCount(20)
    expect(await page.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await card.screenshot({ path: testInfo.outputPath(`ping-tasks-${source}.png`) })
    if (source === 'metric') {
      refreshed = true
      await page.clock.fastForward(61_000)
      await expect(rows.nth(0).locator('[title="平均延迟"]')).toHaveText('88 ms')
    }
    await rows.nth(0).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: '主控-洛杉矶 延迟 / 丢包' })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
  })
}
