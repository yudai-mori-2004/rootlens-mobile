import type { ComponentType } from 'react';

export interface SandboxEntry {
  id: string;
  title: string;
  description: string;
  screen: ComponentType<any>;
}

// Empty until v0.0.1 task 06 (collection-flow on top of sensor-session) lands.
export const sandboxes: SandboxEntry[] = [];
