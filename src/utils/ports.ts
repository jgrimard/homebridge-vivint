import { createServer } from 'node:net';

/**
 * Returns a free UDP/TCP port assigned by the OS, or verifies a specific port is free.
 */
function getFreePort(port?: number): Promise<number | undefined> {
  return new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.on('error', () => resolve(undefined));
    server.listen(port ?? 0, () => {
      const address = server.address();
      const found = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => resolve(found));
    });
  });
}

/**
 * Reserves `count` consecutive free ports. ffmpeg uses the next port up for
 * RTCP by default, so consecutive availability matters.
 */
export async function reservePorts(count = 1, attemptsLeft = 10): Promise<number[]> {
  if (attemptsLeft <= 0) {
    throw new Error('Unable to reserve a block of consecutive free ports');
  }
  const first = await getFreePort();
  if (first === undefined) {
    return reservePorts(count, attemptsLeft - 1);
  }
  const ports = [first];
  for (let i = 1; i < count; i++) {
    const next = await getFreePort(first + i);
    if (next !== first + i) {
      return reservePorts(count, attemptsLeft - 1);
    }
    ports.push(next);
  }
  return ports;
}
