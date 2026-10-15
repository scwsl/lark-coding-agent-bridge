import { expect, it } from 'vitest';
import { monitorFrame } from '../../../src/cli/commands/monitor';

it('replaces the viewport without saving cleared frames to terminal scrollback', () => {
  // iTerm can save an erased screen to history; ED0 only erases the unused tail.
  const screen = ['old', 'old', 'old'];
  const history: string[][] = [];
  let row = 0; let column = 0;
  const apply = (bytes: string) => {
    for (const token of bytes.match(/\x1b\[[0-9]*[HJK]|\r|\n|[^\x1b\r\n]+/g) ?? []) {
      if (token === '\x1b[H') { row = 0; column = 0; }
      else if (token === '\x1b[2J') { history.push([...screen]); screen.fill(''); }
      else if (token === '\x1b[K') screen[row] = screen[row]!.slice(0, column);
      else if (token === '\x1b[J') { screen[row] = screen[row]!.slice(0, column); screen.fill('', row + 1); }
      else if (token === '\r') column = 0;
      else if (token === '\n') row++;
      else { screen[row] = screen[row]!.slice(0, column) + token + screen[row]!.slice(column + token.length); column += token.length; }
    }
  };
  apply(monitorFrame('FIRST\nTASK\nFOOTER'));
  apply(monitorFrame('NEXT\nIDLE'));
  expect(history).toEqual([]);
  expect(screen).toEqual(['NEXT', 'IDLE', '']);
});
