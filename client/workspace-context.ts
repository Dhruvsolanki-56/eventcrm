import { createContext, useContext } from 'react';
import type { SessionData } from '../shared/contracts.js';

export type ToastAction = { label: string; onClick: () => void };

export type WorkspaceContextValue = {
  session: SessionData;
  csrfToken: string;
  refresh: (preferredWorkspaceId?: string) => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  logout: () => Promise<void>;
  notify: (message: string, action?: ToastAction) => void;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace context is missing.');
  return value;
}
