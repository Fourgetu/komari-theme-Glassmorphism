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
      { id: 40, name: '福建移动V6', interval: 60, loss: 0 },
      { id: 50, name: '额外线路', interval: 60, loss: 0 },
    ]
    let refreshed = false
    const latency = (id: number) => id === 30 ? (refreshed ? 88 : 166) : 170
    const lost = (id: number, index: number) => id === 20 || (id === 30 && index === 59)
    const time = (index: number) => new Date(Date.parse('2026-07-25T12:00:00Z') - (59 - index) * 60_000).toISOString()
    await page.route('**/rpc2', async (route) => {
      const request = route.request().postDataJSON()
      const uuid = request.params?.entity_id ?? request.params?.uuid ?? '00000000-0000-4000-8000-000000000001'
      const taskCount = [3, 2, 4, 5, 0][Number(uuid.slice(-2)) - 1] ?? 3
      const nodeTasks = tasks.slice(0, taskCount)
      let result: unknown
      if (request.method === 'public:getPublicPingTasks') {
        result = tasks
      }
      else if (request.method === 'public:getPingMetricStats') {
        result = { stats: source === 'legacy'
          ? []
          : [...nodeTasks].reverse().map(task => ({
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
          : [...nodeTasks].reverse().flatMap(task => ['ping.latency_ms', 'ping.loss'].map(metric => ({
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
        result = { tasks, records: nodeTasks.flatMap(task => Array.from({ length: 60 }, (_, index) => ({
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
    // Different task counts must neither resize the cards nor shift label/bar centres.
    const initialCardHeight = (await card.boundingBox())!.height
    for (const [name, count] of [
      ['主控-洛杉矶', 3],
      ['香港边缘节点-超长名称布局测试', 2],
      ['东京-高负载', 4],
      ['新加坡-A100', 4],
      ['法兰克福-2680', 0],
    ] as const) {
      const currentCard = page.getByRole('button', { name: `查看节点 ${name} 详情`, exact: true })
      await currentCard.scrollIntoViewIfNeeded()
      await expect(currentCard.locator('[data-ping-task-id]')).toHaveCount(count)
      const panel = currentCard.locator('[data-node-ping-tasks]')
      expect((await panel.boundingBox())!.height).toBe(96)
      expect(Math.abs((await currentCard.boundingBox())!.height - initialCardHeight)).toBeLessThan(1)
      for (const row of await currentCard.locator('[data-ping-task-id]').all()) {
        const label = (await row.locator('[data-ping-task-name]').boundingBox())!
        const labelCenter = label.y + label.height / 2
        for (const bars of await row.locator('[data-node-ping-bars]').all()) {
          const box = (await bars.boundingBox())!
          expect(Math.abs(box.y + box.height / 2 - labelCenter)).toBeLessThan(1)
        }
      }
    }
    const fourLineCard = page.getByRole('button', { name: '查看节点 东京-高负载 详情', exact: true })
    await fourLineCard.screenshot({ path: testInfo.outputPath(`ping-four-lines-${source}.png`) })
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
