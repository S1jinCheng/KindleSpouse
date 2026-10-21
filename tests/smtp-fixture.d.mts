export function smtpFixture(): Promise<{ port: number; messages: { recipient: string; data: string }[]; close(): Promise<void> }>
