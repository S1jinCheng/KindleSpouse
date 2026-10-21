import { createServer } from 'node:net'

export async function smtpFixture() {
  const messages = [], sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let pending = '', data = false, lines = [], recipient = ''
    socket.setEncoding('utf8')
    socket.write('220 localhost KindleSpouse fixture\r\n')
    socket.on('data', chunk => {
      pending += chunk
      let position
      while ((position = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, position)
        pending = pending.slice(position + 2)
        if (data) {
          if (line === '.') { messages.push({ recipient, data: lines.join('\r\n') }); data = false; lines = []; socket.write('250 2.0.0 Accepted\r\n') }
          else lines.push(line.startsWith('..') ? line.slice(1) : line)
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250-localhost\r\n250 SIZE 40000000\r\n')
        else if (/^MAIL FROM:/.test(line)) socket.write('250 2.1.0 OK\r\n')
        else if (/^RCPT TO:/.test(line)) { recipient = line.slice(8).replace(/[<>]/g, ''); socket.write('250 2.1.5 OK\r\n') }
        else if (line === 'DATA') { data = true; socket.write('354 End with dot\r\n') }
        else if (line === 'QUIT') socket.end('221 Bye\r\n')
        else if (line === 'RSET' || line === 'NOOP') socket.write('250 OK\r\n')
        else socket.write('502 Not implemented\r\n')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, messages, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
