// The only module that runs processes (E3): execFile with an argument array, never a shell.
import { execFile } from 'node:child_process'

export type Run = (file: string, args: readonly string[]) => Promise<string>

export const run: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error instanceof Error ? error : new Error(`${file} failed`))
      else resolve(stdout)
    })
  })
