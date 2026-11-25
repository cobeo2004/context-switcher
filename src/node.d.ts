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
  export function statSync(path: string): { mode: number; size: number; dev: number; ino: number; mtimeMs: number }
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { mode?: number }): void
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
