"""Fixed-scope local cache source. No network, shell, model commands or recursive rm.

Not yet registered in the native runtime. The durable TypeScript journal must admit
each mutation. A partial deletion or changed source must be held, never replayed.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import selectors
import time

HOME = Path.home()
DOWNLOADS = {HOME / '.npm/_cacache', HOME / 'Library/Caches/Yarn'}
SUFFIXES = {'.next/cache/webpack', '.next/cache/turbopack', '.next/cache/swc',
            'node_modules/.cache/babel-loader', 'node_modules/.cache/prettier'}
MAX_ENTRIES = 20000
RESERVE = 20 * 1024 ** 3

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def run(args, limit=4 * 1024 * 1024):
    # Fixed executables and typed arguments only; never pass source/model text to a shell.
    if args[0] == '/usr/bin/git':
        args = [args[0], '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'] + args[1:]
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(HOME),
                               'GIT_OPTIONAL_LOCKS': '0', 'LANG': 'C'}) as child:
        try:
            deadline, chunks, size = time.monotonic() + 15, [], 0
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while True:
                    if time.monotonic() > deadline:
                        raise ValueError('Source command timed out')
                    if not selector.select(.1):
                        continue
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > limit:
                        raise ValueError('Source output exceeded bound')
                    chunks.append(chunk)
            child.wait(timeout=max(.01, deadline - time.monotonic()))
            if child.returncode:
                raise ValueError('Source command failed or exceeded output bound')
            return b''.join(chunks).decode('utf8', errors='strict')
        except BaseException:
            child.kill()
            child.wait()
            raise

def scope(path, checkout):
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        raise ValueError('Noncanonical cache path')
    if path in DOWNLOADS:
        if checkout is not None:
            raise ValueError('Download cache cannot name a checkout')
    else:
        if not checkout:
            raise ValueError('Unreviewed cache path')
        checkout = Path(checkout)
        if not str(checkout).startswith(str(HOME) + '/') or any(
                p in ('sources', '.git', 'node_modules') for p in checkout.parts):
            raise ValueError('Unreviewed checkout')
        relative = path.relative_to(checkout).as_posix()
        matched = next((suffix for suffix in SUFFIXES if relative == suffix or relative.endswith('/' + suffix)), None)
        prefix = relative[:-len(matched)].strip('/') if matched else relative
        if not matched or any(part in ('.git', 'sources', 'node_modules') for part in prefix.split('/')):
            raise ValueError('Unreviewed compiler cache')
    return path

def open_directory(path):
    """Traverse every ancestor using directory descriptors and O_NOFOLLOW."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Absolute canonical path required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        return fd
    except BaseException:
        os.close(fd)
        raise

def identity(info):
    return [info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_nlink]

def snapshot(path, now=None):
    now = time.time() if now is None else now
    entries = {}
    deadline = time.monotonic() + 10
    youngest = float('inf')
    def walk(fd, relative):
        nonlocal youngest
        info = os.fstat(fd)
        entries[relative] = identity(info)
        youngest = min(youngest, now - max(info.st_mtime, info.st_ctime))
        for name in sorted(os.listdir(fd)):
            if len(entries) >= MAX_ENTRIES or time.monotonic() > deadline:
                raise ValueError('Inventory bound exceeded; candidate held')
            rel = relative + '/' + name if relative else name
            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
            youngest = min(youngest, now - max(s.st_mtime, s.st_ctime))
            if stat.S_ISDIR(s.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if identity(os.fstat(child)) != identity(s):
                        raise ValueError('Directory changed during inventory')
                    walk(child, rel)
                finally:
                    os.close(child)
            elif stat.S_ISREG(s.st_mode) and s.st_nlink == 1:
                entries[rel] = identity(s)
            else:
                raise ValueError('Symlink, hard link or special file; candidate held')
    fd = open_directory(path)
    try:
        walk(fd, '')
    finally:
        os.close(fd)
    if youngest < 3600:
        raise ValueError('Recently changing cache')
    return entries, int(youngest * 1000)

def activity(path, checkout):
    import re
    processes = run(['/bin/ps', '-axo', 'comm=,args='])
    if re.search(r'(^|[/\s])(npm|npx|yarn|pnpm|webpack|turbo|rustc|cargo|tsc)(\s|$)', processes, re.M) or re.search(
            r'(^|\s)(next|vite)\s+(dev|build)(\s|$)', processes, re.M):
        raise ValueError('Build or package manager active')
    opened = run(['/usr/sbin/lsof', '-nP', '-Fn'], 16 * 1024 * 1024)
    prefix = str(checkout or path)
    if any(line[1:] == prefix or line[1:].startswith(prefix + '/')
           for line in opened.splitlines() if line.startswith('n/')):
        raise ValueError('Candidate or checkout has open files')

def repository(path, checkout):
    if not checkout:
        return None
    root = run(['/usr/bin/git', '-C', str(checkout), 'rev-parse', '--show-toplevel']).strip()
    if root != str(checkout):
        raise ValueError('Checkout is not its repository root')
    rel = Path(path).relative_to(checkout).as_posix()
    run(['/usr/bin/git', '-C', str(checkout), 'check-ignore', '-q', '--', rel])
    if run(['/usr/bin/git', '-C', str(checkout), 'ls-files', '--', rel]).strip():
        raise ValueError('Tracked cache content')
    return hashlib.sha256(run(['/usr/bin/git', '-C', str(checkout), 'status', '--porcelain=v1', '-uall']).encode()).hexdigest()

def free_bytes():
    s = os.statvfs('/System/Volumes/Data')
    return s.f_bavail * s.f_frsize

def inspect(path, checkout=None):
    path = scope(path, checkout)
    activity(path, checkout)
    status = repository(path, checkout)
    first, age = snapshot(path)
    second, _ = snapshot(path)
    if first != second:
        raise ValueError('Cache changed during inspection')
    proof = dict(path=str(path), measuredAt=int(time.time() * 1000), availableBytes=free_bytes(),
                 snapshotHash=digest(second), oldestChangeAgeMs=age, noSymlinksOrSpecialFiles=True,
                 noOpenFiles=True, noBuildOrPackageProcesses=True, stableSnapshot=True,
                 fileCount=sum(1 for value in second.values() if stat.S_ISREG(value[2])))
    if checkout:
        proof.update(checkout=str(checkout), ignoredAndUntracked=True, repositoryStatusHash=status)
    return proof

def remove_snapshot(path, expected):
    """Unlink only inventoried entries relative to pinned directory descriptors.

    New files are never swept up. Changed entries stop the operation. A replacement
    symlink cannot redirect traversal outside the cache; a partial result is uncertain.
    Keep the cache root (and every empty directory) to avoid racing parent renames.
    """
    fd = open_directory(path)
    try:
        if identity(os.fstat(fd)) != expected['']:
            raise ValueError('Cache root changed')
        def walk(parent, relative):
            prefix = relative + '/' if relative else ''
            names = [p[len(prefix):] for p in expected if p.startswith(prefix)
                     and p != relative and '/' not in p[len(prefix):]]
            if set(os.listdir(parent)) != set(names):
                raise ValueError('Cache contents changed')
            for name in names:
                rel = prefix + name
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if identity(info) != expected[rel]:
                    raise ValueError('Cache entry changed before cleanup')
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    try:
                        if identity(os.fstat(child)) != expected[rel]:
                            raise ValueError('Cache directory replaced')
                        walk(child, rel)
                    finally:
                        os.close(child)
                else:
                    os.unlink(name, dir_fd=parent)
            remaining = {p[len(prefix):] for p, info in expected.items()
                         if p.startswith(prefix) and p != relative and '/' not in p[len(prefix):]
                         and stat.S_ISDIR(info[2])}
            if set(os.listdir(parent)) != remaining:
                raise ValueError('New cache entries appeared; reconciliation required')
        walk(fd, '')
    finally:
        os.close(fd)

def remove(proof):
    path, checkout = proof['path'], proof.get('checkout')
    fresh = inspect(path, checkout)
    if fresh['availableBytes'] >= RESERVE or fresh['snapshotHash'] != proof['snapshotHash'] or fresh.get(
            'repositoryStatusHash') != proof.get('repositoryStatusHash'):
        raise ValueError('Cleanup unnecessary or source changed')
    entries, _ = snapshot(path)
    if digest(entries) != proof['snapshotHash']:
        raise ValueError('Cache changed before mutation')
    activity(path, checkout)
    remove_snapshot(path, entries)
    if repository(path, checkout) != proof.get('repositoryStatusHash'):
        raise ValueError('Repository changed; reconciliation required')
    result = dict(removed=True, repositoryStatusUnchanged=True, afterAvailableBytes=free_bytes(),
                  completedAt=int(time.time() * 1000))
    result['sourceReceiptHash'] = digest(dict(proof=proof, result=result))
    return result

def inventory():
    """Bounded discovery; never follows symlinks or scans installed dependency trees."""
    candidates = [(p, None) for p in sorted(DOWNLOADS) if p.exists()]
    scanned, deadline, complete = 0, time.monotonic() + 10, True
    roots = [HOME / '.codex/.chatgpt-projects', HOME / '.codex/worktrees']
    for base in roots:
        if not base.exists():
            continue
        fd = open_directory(base)
        os.close(fd)
        for current, directories, _ in os.walk(base, followlinks=False):
            scanned += 1
            if scanned > 20000 or time.monotonic() > deadline:
                complete = False
                break
            here = Path(current)
            if len(here.relative_to(base).parts) > 20:
                directories[:] = []
                complete = False
                continue
            if '.next' in directories or 'node_modules' in directories:
                try:
                    checkout = Path(run(['/usr/bin/git', '-C', str(here), 'rev-parse', '--show-toplevel']).strip())
                    for suffix in sorted(SUFFIXES):
                        candidate = here / suffix
                        if candidate.exists():
                            scope(candidate, checkout)
                            candidates.append((candidate, checkout))
                except ValueError:
                    pass  # Non-checkout caches are outside the authorized compiler scope.
            directories[:] = [name for name in directories if name not in
                ('node_modules', '.next', '.git', 'sources', 'artifacts', 'dist', 'target', '.venv')
                and not name.endswith('.app') and not (here / name).is_symlink()]
    return dict(candidates=[dict(path=str(p), checkout=str(r) if r else None) for p, r in candidates[:100]],
                complete=complete and len(candidates) <= 100, scannedDirectories=scanned,
                availableBytes=free_bytes(), measuredAt=int(time.time() * 1000))

if __name__ == '__main__':
    import sys
    try:
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError('Input bound exceeded')
        request = json.loads(raw)
        mode = request.get('mode')
        if mode == 'inventory' and set(request) == {'mode'}:
            value = inventory()
        elif mode == 'inspect' and set(request) <= {'mode', 'path', 'checkout'}:
            value = inspect(request['path'], request.get('checkout'))
        elif mode == 'remove' and set(request) == {'mode', 'proof'}:
            value = remove(request['proof'])
        else:
            raise ValueError('Unknown fixed source operation')
        print(json.dumps(value))
    except Exception:
        # Full filesystem/process output never leaves the fixed source.
        print(json.dumps({'held': True, 'reason': 'Source safety verification failed; no automatic replay.'}))
        sys.exit(1)
