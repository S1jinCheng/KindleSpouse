export type PageTurnStyle = 'paper' | 'soft' | 'none'
export type PageTurnDirection = -1 | 0 | 1

export function drawPageTurn(context: CanvasRenderingContext2D, previous: HTMLImageElement, next: HTMLImageElement, progress: number, direction: PageTurnDirection, style: PageTurnStyle) {
  const { width, height } = context.canvas
  const position = Math.max(0, Math.min(1, progress))
  const draw = (image: HTMLImageElement) => {
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight)
    const fittedWidth = image.naturalWidth * scale, fittedHeight = image.naturalHeight * scale
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, (width - fittedWidth) / 2, (height - fittedHeight) / 2, fittedWidth, fittedHeight)
  }
  context.clearRect(0, 0, width, height)
  draw(next)
  if (position >= 1) return
  if (style !== 'paper' || !direction) {
    context.globalAlpha = 1 - position
    draw(previous)
    context.globalAlpha = 1
    return
  }
  const edge = width * (1 - position)
  const fold = width * .13 * Math.sin(Math.PI * position)
  const bow = fold * .4
  context.save()
  if (direction < 0) { context.translate(width, 0); context.scale(-1, 1) }
  const shadow = context.createLinearGradient(edge - fold * .2, 0, edge + fold * 1.7 + 1, 0)
  shadow.addColorStop(0, '#17141100')
  shadow.addColorStop(.3, '#17141125')
  shadow.addColorStop(1, '#17141100')
  context.fillStyle = shadow
  context.fillRect(edge - fold * .2, 0, fold * 1.9 + 1, height)
  context.save()
  context.beginPath()
  context.moveTo(0, 0)
  context.lineTo(edge, 0)
  context.bezierCurveTo(edge - bow, height * .3, edge - bow, height * .7, edge, height)
  context.lineTo(0, height)
  context.closePath()
  context.clip()
  if (direction < 0) { context.translate(width, 0); context.scale(-1, 1) }
  draw(previous)
  context.restore()
  const paper = context.createLinearGradient(edge - bow, 0, edge + fold, 0)
  paper.addColorStop(0, '#dedbd4')
  paper.addColorStop(.22, '#f4f2ed')
  paper.addColorStop(.6, '#fffefa')
  paper.addColorStop(1, '#e8e5dd')
  context.beginPath()
  context.moveTo(edge, 0)
  context.bezierCurveTo(edge - bow, height * .3, edge - bow, height * .7, edge, height)
  context.lineTo(edge + fold, height)
  context.bezierCurveTo(edge + fold - bow * .3, height * .7, edge + fold - bow * .3, height * .3, edge + fold, 0)
  context.closePath()
  context.fillStyle = paper
  context.fill()
  context.restore()
}
