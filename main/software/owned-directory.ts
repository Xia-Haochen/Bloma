import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

/** Host-selected directory, not an OS sandbox. Reject links in every component
 * we create/manage; never delete or repair a user's replacement directory.
 * Parent/base selection remains the caller's responsibility. */
export function ownedDirectory(base: string, components: string[] = []): string {
  if (!isAbsolute(base) || components.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw Error('OWNED_DIRECTORY_PATH_INVALID')
  const check = (path: string) => {
    try {
      const info = lstatSync(path) // lstat also detects dangling links.
      if (info.isSymbolicLink() || !info.isDirectory()) throw Error('OWNED_DIRECTORY_LINK_OR_TYPE_UNSUPPORTED')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    mkdirSync(path, { recursive: true })
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error('OWNED_DIRECTORY_LINK_OR_TYPE_UNSUPPORTED')
    return realpathSync(path)
  }
  let path = check(base)
  for (const part of components) {
    const parent = path, target = join(parent, part)
    path = check(target)
    const child = relative(parent, path)
    if ((process.platform === 'win32' ? child.toLowerCase() !== part.toLowerCase() : child !== part)) throw Error('OWNED_DIRECTORY_IDENTITY_CHANGED')
  }
  return path
}
