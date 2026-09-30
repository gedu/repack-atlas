// Types for the plain-JS script so tests/*.ts can import it under strict mode.
export const COMMIT_TYPES: string[];
export const MAX_HEADER_LENGTH: number;
export const AI_TOOL_NAMES: string[];
export interface Violation {
  rule: string;
  detail: string;
}
export function validateHeader(header: string): Violation[];
export function isAiIdentity(name: string, email: string): boolean;
export function validateMessage(
  message: string,
  options?: { skipHeader?: boolean },
): Violation[];
export function validateIdentity(
  role: 'author' | 'committer',
  name: string,
  email: string,
): Violation[];
export function validateCommit(commit: {
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}): Violation[];
