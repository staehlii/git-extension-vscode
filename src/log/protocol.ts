// Types shared by the extension host and the Log webview (type-only imports, no runtime code).
import type { ChangedFile } from '../git/changedFiles';
import type { GraphRow } from './graphLayout';

export interface LogCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, unix seconds. */
  date: number;
  subject: string;
}

export interface RefLabel {
  name: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
  /** The checked-out branch. */
  current?: boolean;
}

export interface FilterSummary {
  text: string;
  branch: string;
  user: string;
  date: string;
  path: string;
  active: boolean;
}

export interface CommitDetailsData {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  message: string;
  files: ChangedFile[];
}

export type FilterKind = 'branch' | 'user' | 'date' | 'path';

export type ToWebview =
  | { type: 'loading' }
  | {
      type: 'data';
      commits: LogCommit[];
      graph: GraphRow[] | null;
      maxLanes: number;
      refs: Record<string, RefLabel[]>;
      head: string | null;
      hasMore: boolean;
      filters: FilterSummary;
      repoName: string;
      /** Keep scroll position and selection (refresh/load more) instead of resetting. */
      keepView: boolean;
    }
  | { type: 'details'; sha: string; details: CommitDetailsData }
  | { type: 'multiSelection'; count: number }
  | { type: 'branches'; sha: string; branches: string[] }
  | { type: 'error'; message: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'select'; shas: string[] }
  | { type: 'contextTarget'; sha: string }
  | { type: 'text'; value: string }
  | { type: 'pickFilter'; kind: FilterKind }
  | { type: 'clearFilters' }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  | { type: 'openDiff'; sha: string; path: string };
