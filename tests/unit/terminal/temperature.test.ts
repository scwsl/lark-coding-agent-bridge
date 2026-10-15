import { describe, expect, it, vi } from 'vitest';
import { createTemperatureSampler, parseTemperature } from '../../../src/terminal/temperature';

describe('CPU temperature', () => {
  it('accepts sensor output and rejects missing or invalid readings', () => {
    expect(parseTemperature('56.2°C\n')).toBe(56.2);
    for (const value of ['0.0°C', 'NaN°C', 'error', '56°F', '200°C', '56°C extra']) expect(parseTemperature(value)).toBeNull();
  });
  it('samples at most every five seconds and clears failed readings', async () => {
    const sensor = vi.fn().mockResolvedValueOnce(56.2).mockRejectedValueOnce(new Error('sensor unavailable')).mockResolvedValue(58);
    const sample = createTemperatureSampler(sensor);
    expect(await sample(1000)).toBe(56.2);
    expect(await sample(5999)).toBe(56.2);
    expect(sensor).toHaveBeenCalledTimes(1);
    expect(await sample(6000)).toBeNull();
    expect(await sample(11000)).toBe(58);
  });
});
