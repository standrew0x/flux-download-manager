import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;
const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertJobId(id) {
  if (typeof id !== 'string' || !JOB_ID_PATTERN.test(id)) {
    throw new TypeError('Invalid download job id');
  }
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Small crash-safe JSON store used by DownloadEngine.
 *
 * All writes are serialized, fsynced, and atomically renamed. The in-memory
 * representation is never returned directly, so callers cannot mutate state
 * without going through save()/settings().
 */
export class DownloadStore {
  constructor({
    rootDir = process.env.FLUXDM_STATE_ROOT || process.env.RDM_DATA_DIR || path.join(process.env.APPDATA || os.homedir(), 'Flux Download Manager'),
    defaultSettings = {},
  } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.statePath = path.join(this.rootDir, 'state.json');
    this.backupPath = path.join(this.rootDir, 'state.backup.json');
    this.stagingRoot = path.join(this.rootDir, 'staging');
    this.defaultSettings = clone(defaultSettings);
    this.state = null;
    this.initialized = false;
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (this.initialized) return this;
    await mkdir(this.stagingRoot, { recursive: true });

    let state;
    try {
      state = await this.#readState(this.statePath);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.name !== 'SyntaxError') throw error;
      try {
        state = await this.#readState(this.backupPath);
      } catch (backupError) {
        if (backupError?.code !== 'ENOENT') {
          throw new Error('Download state is unreadable and its backup could not be recovered', {
            cause: backupError,
          });
        }
      }
    }

    if (state !== undefined) {
      assertPlainObject(state, 'Stored download state');
      if (state.version !== STORE_VERSION || !state.jobs || !state.settings) {
        throw new Error(`Unsupported or malformed download state version: ${state.version ?? 'unknown'}`);
      }
      assertPlainObject(state.jobs, 'Stored jobs');
      assertPlainObject(state.settings, 'Stored settings');
    } else {
      state = {
        version: STORE_VERSION,
        settings: {},
        jobs: {},
        updatedAt: new Date().toISOString(),
      };
    }

    state.settings = { ...this.defaultSettings, ...state.settings };
    this.state = state;
    this.initialized = true;
    await this.#persist();
    return this;
  }

  async load(id) {
    this.#assertInitialized();
    if (id !== undefined && id !== null) {
      assertJobId(id);
      return clone(this.state.jobs[id] ?? null);
    }
    return Object.values(this.state.jobs).map(clone);
  }

  async save(job) {
    this.#assertInitialized();
    assertPlainObject(job, 'Job');
    assertJobId(job.id);
    this.state.jobs[job.id] = clone(job);
    this.state.updatedAt = new Date().toISOString();
    await this.#persist();
    return clone(this.state.jobs[job.id]);
  }

  async remove(id) {
    this.#assertInitialized();
    assertJobId(id);
    const previous = this.state.jobs[id];
    if (previous === undefined) return null;
    delete this.state.jobs[id];
    this.state.updatedAt = new Date().toISOString();
    await this.#persist();
    return clone(previous);
  }

  async settings(patch) {
    this.#assertInitialized();
    if (patch === undefined) return clone(this.state.settings);
    assertPlainObject(patch, 'Settings patch');
    this.state.settings = { ...this.state.settings, ...clone(patch) };
    this.state.updatedAt = new Date().toISOString();
    await this.#persist();
    return clone(this.state.settings);
  }

  stagingDir(id) {
    assertJobId(id);
    return path.join(this.stagingRoot, id);
  }

  async removeStaging(id) {
    const directory = this.stagingDir(id);
    const relative = path.relative(this.stagingRoot, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Refusing to remove staging outside the store root');
    }
    await rm(directory, { recursive: true, force: true });
  }

  #assertInitialized() {
    if (!this.initialized || !this.state) {
      throw new Error('DownloadStore.init() must be called first');
    }
  }

  async #readState(filePath) {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  #persist() {
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    const operation = this.writeChain.then(() => this.#atomicWrite(snapshot));
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async #atomicWrite(contents) {
    await mkdir(this.rootDir, { recursive: true });
    const temporaryPath = path.join(this.rootDir, `.state-${process.pid}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;

      if (await exists(this.statePath)) {
        const backupTemporary = path.join(this.rootDir, `.backup-${process.pid}-${randomUUID()}.tmp`);
        const current = await readFile(this.statePath);
        const backupHandle = await open(backupTemporary, 'wx', 0o600);
        try {
          await backupHandle.writeFile(current);
          await backupHandle.sync();
        } finally {
          await backupHandle.close();
        }
        await rename(backupTemporary, this.backupPath);
      }

      await rename(temporaryPath, this.statePath);
      await this.#syncDirectory();
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async #syncDirectory() {
    let directoryHandle;
    try {
      directoryHandle = await open(this.rootDir, 'r');
      await directoryHandle.sync();
    } catch (error) {
      // Windows and some filesystems do not permit fsync on directory handles.
      if (!['EISDIR', 'EINVAL', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    } finally {
      if (directoryHandle) await directoryHandle.close().catch(() => {});
    }
  }
}

export { STORE_VERSION };
