// ponytail: the few Node built-ins this plugin uses, typed by hand so `tsc -p .` passes without
// @types/node (no dependencies in this repo). Add a signature here when code starts using one.

declare module 'node:sqlite' {
  type SqlValue = null | number | bigint | string | Uint8Array
  export class StatementSync {
    get(...params: SqlValue[]): unknown
    all(...params: SqlValue[]): unknown[]
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean })
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}

declare module 'node:fs' {
  export function chmodSync(path: string, mode: number): void
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined
  export function mkdtempSync(prefix: string): string
  export function symlinkSync(target: string, path: string): void
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function statSync(path: string): { mode: number; size: number; dev: number; ino: number; mtimeMs: number }
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { mode?: number }): void
}

// Read-only on purpose: `open` takes only 'r' and the handle has no write method (E3, src/sources/sessionSource.ts).
declare module 'node:fs/promises' {
  interface FileHandle {
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
    stat(): Promise<{ size: number }>
    close(): Promise<void>
  }
  export function open(path: string, flags: 'r'): Promise<FileHandle>
  export function readdir(path: string): Promise<string[]>
  export function readdir(path: string, options: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean }[]>
  export function stat(path: string): Promise<{ size: number; mtimeMs: number; dev: number; ino: number }>
}

declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:crypto' {
  export function randomUUID(): string
  export function createHash(algorithm: 'md5'): { update(data: string): { digest(encoding: 'hex'): string } }
}

declare module 'node:child_process' {
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: { encoding: 'utf8'; env?: Record<string, string | undefined> }
  ): { status: number | null; stdout: string; stderr: string }
}

declare var process: {
  env: Record<string, string | undefined>
  readonly version: string
  readonly execPath: string
}
