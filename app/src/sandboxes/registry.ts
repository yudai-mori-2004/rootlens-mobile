import type { ComponentType } from 'react';
import SensorSessionTestScreen from './04-sensor-session/SensorSessionTestScreen';

export interface SandboxEntry {
  id: string;
  title: string;
  description: string;
  screen: ComponentType<any>;
}

export const sandboxes: SandboxEntry[] = [
  {
    id: '04-sensor-session',
    title: '04: SensorSession',
    description: 'Camera + IMU 同時取得 + mp4 出力 (raw signals for server-side VIO)',
    screen: SensorSessionTestScreen,
  },
];
