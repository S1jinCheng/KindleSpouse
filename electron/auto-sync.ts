export class AutomaticCloudSync {
  private timer?: ReturnType<typeof setTimeout>
  private operation?: Promise<void>
  private stopped = false
  private attempts = new Map<string, { next: number; failures: number }>()

  constructor(
    private accounts: () => string[],
    private available: () => boolean,
    private sync: (accountId: string) => Promise<void>,
    private now: () => number = Date.now,
  ) {}

  start() {
    if (this.timer || this.operation || this.stopped) return
    this.schedule(8000)
  }

  private schedule(delay: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().finally(() => this.schedule(60000))
    }, delay)
    this.timer.unref()
  }

  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.operation) return this.operation
    this.operation = this.run().finally(() => { this.operation = undefined })
    return this.operation
  }

  private async run() {
    if (!this.available()) return
    const accounts = [...new Set(this.accounts())]
    for (const account of this.attempts.keys()) if (!accounts.includes(account)) this.attempts.delete(account)
    for (const account of accounts) {
      if (this.stopped || !this.available()) return
      const previous = this.attempts.get(account)
      if (previous && previous.next > this.now()) continue
      try {
        await this.sync(account)
        this.attempts.set(account, { next: this.now() + 60000, failures: 0 })
      } catch {
        const failures = Math.min((previous?.failures ?? 0) + 1, 5)
        this.attempts.set(account, { next: this.now() + Math.min(60000 * 2 ** (failures - 1), 900000), failures })
      }
    }
  }

  async close() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    await this.operation
  }
}
