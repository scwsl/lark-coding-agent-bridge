import { expect, it, vi } from 'vitest';
import { createIoSampler, parseMacDisk, parseMacNetwork } from '../../../src/terminal/io';

it('reads physical disk counters and counts each physical network interface once', () => {
  expect(parseMacDisk('"Statistics" = {"Bytes (Read)"=100,"Bytes (Write)"=200}\n"Statistics" = {"Bytes (Read)"=30,"Bytes (Write)"=40}')).toEqual({ read: 130, write: 240 });
  const net = 'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\n' +
    'en0 1500 <Link#4> aa:bb 1 0 1000 1 0 2000 0\n' +
    'en0 1500 10/24 10.0.0.1 1 - 1000 1 - 2000 -\n' +
    'lo0 16384 <Link#1> 1 0 9999 1 0 9999 0\n' +
    'utun0 1500 <Link#2> 1 0 9999 1 0 9999 0\n' +
    'en1 1500 <Link#5> 1 0 300 1 0 400 0';
  expect(parseMacNetwork(net)).toEqual({ read: 1300, write: 2400 });
  expect(parseMacDisk('unavailable')).toBeUndefined();
});

it('uses elapsed time, caches for five seconds, and rejects reset or unavailable counters', async () => {
  const read = vi.fn()
    .mockResolvedValueOnce({ disk: { read: 100, write: 200 }, network: { read: 1000, write: 2000 } })
    .mockResolvedValueOnce({ disk: { read: 10100, write: 5200 }, network: { read: 26000, write: 12000 } })
    .mockResolvedValueOnce({ disk: { read: 1, write: 1 } });
  const sample = createIoSampler(read);
  expect((await sample(1000)).disk).toBeNull();
  await sample(2000);
  expect(read).toHaveBeenCalledTimes(1);
  const next = await sample(6000);
  expect(next.disk).toEqual({ read: 2000, write: 1000 });
  expect(next.network).toEqual({ read: 5000, write: 2000 });
  const reset = await sample(11000);
  expect(reset.disk).toBeNull();
  expect(reset.network).toBeNull();
});
