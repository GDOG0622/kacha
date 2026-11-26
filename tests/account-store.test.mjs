import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../account-store.js', import.meta.url), 'utf8');
const { createAccountStore } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function fixture(initial = null) {
    let file = initial;
    let uploads = 0;
    const reads = [];
    let holdUpload;
    let staleReads = false;
    const store = createAccountStore({
        file: 'test.json',
        empty: () => ({ presets: [], looks: {} }),
        validate: value => Array.isArray(value?.presets) && !!value.looks,
        headers: () => ({}),
        encode: bytes => Buffer.from(bytes).toString('base64'),
        fetcher: async (url, options) => {
            if (options.method === 'POST') {
                uploads++;
                if (holdUpload) await holdUpload;
                file = JSON.parse(Buffer.from(JSON.parse(options.body).data, 'base64').toString());
                return { ok: true, status: 200 };
            }
            reads.push({ url, cache: options.cache });
            const result = staleReads ? null : file;
            return result === null ? { status: 404 } : { ok: true, status: 200, json: async () => structuredClone(result) };
        },
    });
    return { store, reads, get uploads() { return uploads; }, set file(value) { file = value; },
        set holdUpload(value) { holdUpload = value; }, set staleReads(value) { staleReads = value; } };
}

test('save is read back, and later loads use fresh URLs', async () => {
    const f = fixture();
    const base = await f.store.load();
    const next = { presets: [{ id: 'a', name: 'test' }], looks: {} };
    await f.store.save(base, next);
    assert.deepEqual(await f.store.load(), next);
    assert.equal(f.uploads, 1);
    assert.ok(f.reads.every(read => read.cache === 'no-store' && read.url.startsWith('/user/files/test.json?kacha=')));
    assert.equal(new Set(f.reads.map(read => read.url)).size, f.reads.length);
});

test('a newer server version blocks an old editor before upload', async () => {
    const f = fixture();
    const base = await f.store.load();
    f.file = { presets: [{ id: 'other-device' }], looks: {} };
    await assert.rejects(f.store.save(base, { presets: [], looks: { char: { prompt: 'test' } } }), /服务器数据已变化/);
    assert.equal(f.uploads, 0);
    assert.equal((await f.store.load()).presets[0].id, 'other-device');
});

test('a previously observed file returning 404 is not treated as an empty library', async () => {
    const f = fixture({ presets: [{ id: 'saved' }], looks: {} });
    const base = await f.store.load();
    f.file = null;
    await assert.rejects(f.store.load(), /暂时不存在/);
    await assert.rejects(f.store.save(base, { presets: [], looks: {} }), /暂时不存在/);
    assert.equal(f.uploads, 0);
});

test('opening while a save is pending waits for the completed write', async () => {
    const f = fixture();
    const base = await f.store.load();
    const next = { presets: [{ id: 'saved' }], looks: {} };
    let release;
    f.holdUpload = new Promise(resolve => { release = resolve; });
    const saving = f.store.save(base, next);
    const opening = f.store.load();
    release();
    await saving;
    assert.deepEqual(await opening, next);
});

test('a successful upload is not reported saved when readback disagrees', async () => {
    const f = fixture();
    const base = await f.store.load();
    f.staleReads = true;
    await assert.rejects(f.store.save(base, { presets: [{ id: 'new' }], looks: {} }), /无法确认服务器数据/);
    assert.equal(f.uploads, 1);
});

test('upload connection failure and timeout are reported distinctly', async () => {
    const empty = () => ({ presets: [], looks: {} });
    for (const timeout of [false, true]) {
        const store = createAccountStore({
            file: 'test.json', empty, validate: () => true, headers: () => ({}),
            encode: bytes => Buffer.from(bytes).toString('base64'), uploadTimeoutMs: 10,
            fetcher: async (_url, options) => {
                if (options.method !== 'POST') return { status: 404 };
                if (!timeout) throw new TypeError('network failure');
                return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
            },
        });
        await assert.rejects(store.save(empty(), { presets: [{ id: 'a' }], looks: {} }), timeout ? /上传超时/ : /上传连接中断/);
    }
});

test('a lost upload response is recovered when the server already stored the data', async () => {
    let file = null;
    const empty = () => ({ presets: [], looks: {} });
    const store = createAccountStore({
        file: 'test.json', empty, validate: () => true, headers: () => ({}),
        encode: bytes => Buffer.from(bytes).toString('base64'),
        fetcher: async (_url, options) => {
            if (options.method === 'POST') {
                file = JSON.parse(Buffer.from(JSON.parse(options.body).data, 'base64').toString());
                throw new TypeError('connection closed after write');
            }
            return file ? { ok: true, status: 200, json: async () => file } : { status: 404 };
        },
    });
    const next = { presets: [{ id: 'saved' }], looks: {} };
    assert.deepEqual(await store.save(empty(), next), next);
});
