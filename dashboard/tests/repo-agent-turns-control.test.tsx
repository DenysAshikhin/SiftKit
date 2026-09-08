import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { fireEvent, render as renderComponent, screen } from './react-test-environment.js';
import { RepoAgentTurnsControl } from '../src/components/RepoAgentTurnsControl';

function renderControl(options: {
  defaultMaxTurns?: number;
  disabled?: boolean;
  initialValue?: string;
} = {}): string[] {
  const changes: string[] = [];
  function Host(): React.JSX.Element {
    const [value, setValue] = React.useState(options.initialValue ?? '');
    return (
      <RepoAgentTurnsControl
        value={value}
        defaultMaxTurns={options.defaultMaxTurns ?? 100}
        disabled={options.disabled ?? false}
        onChange={(nextValue) => {
          changes.push(nextValue);
          setValue(nextValue);
        }}
      />
    );
  }
  renderComponent(<Host />);
  return changes;
}

test('repo-agent turns control opens, updates, and resets a session-local value', () => {
  const changes = renderControl();
  fireEvent.click(screen.getByRole('button', { name: 'Turns: 100' }));
  fireEvent.change(screen.getByLabelText('Maximum turns'), { target: { value: '10000' } });
  assert.equal(screen.getByLabelText('Maximum turns').getAttribute('value'), '10000');
  assert.ok(screen.getByRole('button', { name: 'Turns: 10000' }));
  assert.deepEqual(changes, ['10000']);

  fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
  assert.ok(screen.getByRole('button', { name: 'Turns: 100' }));
  assert.deepEqual(changes, ['10000', '']);
});

test('repo-agent turns control retains invalid text and explains the validation error', () => {
  renderControl();
  fireEvent.click(screen.getByRole('button', { name: 'Turns: 100' }));
  fireEvent.change(screen.getByLabelText('Maximum turns'), { target: { value: '1k' } });

  const field = screen.getByLabelText('Maximum turns');
  assert.equal(field.getAttribute('value'), '1k');
  assert.equal(field.getAttribute('aria-invalid'), 'true');
  assert.equal(screen.getByRole('button', { name: 'Turns: Invalid' }).textContent, 'Turns: Invalid');
  assert.equal(screen.getByRole('alert').textContent, 'Enter a whole number from 1 to 9007199254740991.');

  fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
  assert.equal(screen.queryByRole('alert'), null);
  assert.ok(screen.getByRole('button', { name: 'Turns: 100' }));
});

test('repo-agent turns control displays a custom preset default', () => {
  renderControl({ defaultMaxTurns: 250 });
  assert.ok(screen.getByRole('button', { name: 'Turns: 250' }));
});

test('repo-agent turns control disables the editor while the session is busy', () => {
  renderControl({ disabled: true });
  const button = screen.getByRole('button', { name: 'Turns: 100' });
  assert.equal(button.hasAttribute('disabled'), true);
  fireEvent.click(button);
  assert.equal(screen.queryByLabelText('Maximum turns'), null);
});

test('repo-agent turns control toggles its editor without changing the value', () => {
  const changes = renderControl({ initialValue: '1000' });
  const button = screen.getByRole('button', { name: 'Turns: 1000' });
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  fireEvent.click(button);
  assert.equal(screen.getByRole('button', { name: 'Turns: 1000' }).getAttribute('aria-expanded'), 'true');
  assert.equal(changes.length, 0);
  fireEvent.click(button);
  assert.equal(screen.queryByLabelText('Maximum turns'), null);
  assert.equal(screen.getByRole('button', { name: 'Turns: 1000' }).getAttribute('aria-expanded'), 'false');
});
