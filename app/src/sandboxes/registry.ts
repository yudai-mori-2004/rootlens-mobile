import type { ComponentType } from 'react';
import CollectionFlowScreen from './04-collection-flow/CollectionFlowScreen';

export interface SandboxEntry {
  id: string;
  title: string;
  description: string;
  screen: ComponentType<any>;
}

export const sandboxes: SandboxEntry[] = [
  {
    id: '04-collection-flow',
    title: '04: Collection Flow',
    description: 'タスク選択 → ジェスチャー連動 VLM 開始判定 → 録画 → 終了判定 (統合デモ)',
    screen: CollectionFlowScreen,
  },
];
