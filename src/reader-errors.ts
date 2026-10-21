export function readerErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method ['"](?:open|command|close)-koreader['"]:\s*(?:Error:\s*)?/, '').trim() || '阅读器暂时不可用，请重新打开。'
}
