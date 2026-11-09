import { describe, it, expect } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { isInspectorHeld } from './inspectorHold';

describe('isInspectorHeld', () => {
  it('holds while a pointer is over or pressing the panel, releases on leave/cancel', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    expect(isInspectorHeld(panel)).toBe(false); // first call wires it
    fireEvent.pointerEnter(panel);
    expect(isInspectorHeld(panel)).toBe(true);
    fireEvent.pointerLeave(panel);
    expect(isInspectorHeld(panel)).toBe(false);
    fireEvent.pointerDown(panel);
    expect(isInspectorHeld(panel)).toBe(true);
    fireEvent.pointerCancel(panel);
    expect(isInspectorHeld(panel)).toBe(false);
    panel.remove();
  });
});
